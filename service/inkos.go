package service

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const inkosConfigLimit = 1 << 20
const inkosTicketLimit = 4096

var (
	ErrInkosDisabled = errors.New("Inkos integration is unavailable")
	ErrInkosDenied   = errors.New("Inkos access is not granted")
	ErrInkosToken    = errors.New("Inkos requires an own enabled finite token with model limits and available quota")
	ErrInkosTicket   = errors.New("Inkos ticket is invalid or expired")
	ErrInkosCapacity = errors.New("Inkos ticket capacity reached")
)

// InkosIdentity deliberately preserves the ORIGINAL dashboard session versions.
// Do not reconstruct these from current rows during introspection.
type InkosIdentity struct {
	UserID          int    `json:"user_id"`
	SessionID       string `json:"session_id"`
	UserAuthVersion int64  `json:"user_auth_version"`
	SessionVersion  int64  `json:"session_version"`
}

func InkosIdentityFromAuth(identity AuthIdentity) InkosIdentity {
	return InkosIdentity{identity.UserID, identity.SessionID, identity.UserAuthVersion, identity.SessionVersion}
}

func (identity InkosIdentity) AuthIdentity() (AuthIdentity, error) {
	if identity.UserID <= 0 || identity.SessionID == "" || len(identity.SessionID) > 64 || identity.UserAuthVersion <= 0 || identity.SessionVersion <= 0 {
		return AuthIdentity{}, ErrLoginSessionInvalid
	}
	return AuthIdentity{UserID: identity.UserID, SessionID: identity.SessionID, UserAuthVersion: identity.UserAuthVersion, SessionVersion: identity.SessionVersion}, nil
}

type InkosGrant struct {
	UserID  int  `json:"user_id"`
	Allowed bool `json:"allowed"`
	TokenID int  `json:"token_id"`
}

type inkosFileConfig struct {
	Version int          `json:"version"`
	Grants  []InkosGrant `json:"grants"`
}

type InkosStatus struct {
	Enabled bool   `json:"enabled"`
	Allowed bool   `json:"allowed"`
	Origin  string `json:"origin"`
	UserID  int    `json:"user_id"`
	TokenID int    `json:"token_id"`
}

type InkosTokenView struct {
	ID                 int    `json:"id"`
	Name               string `json:"name"`
	RemainQuota        int    `json:"remain_quota"`
	ModelLimitsEnabled bool   `json:"model_limits_enabled"`
	ModelLimits        string `json:"model_limits"`
}

type InkosTicketView struct {
	Ticket    string `json:"ticket"`
	ExpiresAt int64  `json:"expires_at"`
	Origin    string `json:"origin"`
}

type InkosContext struct {
	UserID    int   `json:"user_id"`
	ExpiresAt int64 `json:"expires_at"`
	TokenID   int   `json:"token_id"`
}

type InkosExchange struct {
	InkosContext
	Identity InkosIdentity `json:"identity"`
}

type InkosRelayContext struct {
	UserID      int      `json:"user_id"`
	TokenID     int      `json:"token_id"`
	APIKey      string   `json:"api_key"`
	Models      []string `json:"models"`
	RemainQuota int      `json:"remain_quota"`
}

type inkosTicket struct {
	Identity  InkosIdentity
	State     string
	Audience  string
	ExpiresAt int64
}

// Single-replica file storage: reads are live on every decision and writes are
// serialized, atomic and durable. Tickets live only in bounded process memory.
type InkosIntegration struct {
	mu      sync.Mutex
	tickets map[[32]byte]inkosTicket
	now     func() time.Time
}

func NewInkosIntegration(now func() time.Time) *InkosIntegration {
	return &InkosIntegration{tickets: make(map[[32]byte]inkosTicket), now: now}
}

// InkosNonceValid rejects padded/noncanonical encodings as well as wrong sizes.
func InkosNonceValid(value string) bool {
	if len(value) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func readInkosFile(path string, limit int64, private bool) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit || (private && info.Mode().Perm() != 0600) {
		return nil, ErrInkosDisabled
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrInkosDisabled
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() || (private && opened.Mode().Perm() != 0600) {
		return nil, ErrInkosDisabled
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, ErrInkosDisabled
	}
	return data, nil
}

func loadInkosSettings() (string, string, inkosFileConfig, []byte, error) {
	origin, path := os.Getenv("INKOS_ORIGIN"), os.Getenv("INKOS_CONFIG_FILE")
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" || parsed.String() != origin || path == "" || !filepath.IsAbs(path) {
		return "", "", inkosFileConfig{}, nil, ErrInkosDisabled
	}
	keyPath := os.Getenv("INKOS_SERVICE_KEY_FILE")
	if keyPath == "" || !filepath.IsAbs(keyPath) {
		return "", "", inkosFileConfig{}, nil, ErrInkosDisabled
	}
	key, err := readInkosFile(keyPath, 4096, false)
	key = bytes.TrimSpace(key)
	if err != nil || len(key) == 0 || bytes.ContainsAny(key, "\r\n\t ") {
		return "", "", inkosFileConfig{}, nil, ErrInkosDisabled
	}
	data, err := readInkosFile(path, inkosConfigLimit, true)
	if err != nil {
		return "", "", inkosFileConfig{}, nil, ErrInkosDisabled
	}
	var config inkosFileConfig
	if common.DecodeJsonStrict(bytes.NewReader(data), &config) != nil || config.Version != 1 || config.Grants == nil {
		return "", "", inkosFileConfig{}, nil, ErrInkosDisabled
	}
	seen := make(map[int]bool)
	for _, grant := range config.Grants {
		if grant.UserID <= 0 || grant.TokenID < 0 || seen[grant.UserID] || (!grant.Allowed && grant.TokenID != 0) {
			return "", "", inkosFileConfig{}, nil, ErrInkosDisabled
		}
		seen[grant.UserID] = true
	}
	return origin, path, config, key, nil
}

func (integration *InkosIntegration) AuthenticateService(provided string) bool {
	integration.mu.Lock()
	defer integration.mu.Unlock()
	_, _, _, key, err := loadInkosSettings()
	if err != nil || provided == "" || len(provided) > 4096 {
		return false
	}
	// Hash first so the constant-time comparison always has equal-size inputs.
	expectedHash, providedHash := sha256.Sum256(key), sha256.Sum256([]byte(provided))
	return subtle.ConstantTimeCompare(expectedHash[:], providedHash[:]) == 1
}

func (integration *InkosIntegration) Status(userID int) InkosStatus {
	integration.mu.Lock()
	defer integration.mu.Unlock()
	status := InkosStatus{UserID: userID}
	origin, _, config, _, err := loadInkosSettings()
	if err != nil {
		return status
	}
	status.Enabled, status.Origin = true, origin
	for _, grant := range config.Grants {
		if grant.UserID == userID {
			status.Allowed, status.TokenID = grant.Allowed, grant.TokenID
			break
		}
	}
	return status
}

func (integration *InkosIntegration) Grants() ([]InkosGrant, error) {
	integration.mu.Lock()
	defer integration.mu.Unlock()
	_, _, config, _, err := loadInkosSettings()
	if err != nil {
		return nil, err
	}
	slices.SortFunc(config.Grants, func(a, b InkosGrant) int { return a.UserID - b.UserID })
	return config.Grants, nil
}

func persistInkosConfig(path string, config inkosFileConfig) error {
	data, err := common.Marshal(config)
	if err != nil || len(data) > inkosConfigLimit {
		return ErrInkosDisabled
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return ErrInkosDisabled
	}
	defer directory.Close()
	file, err := os.CreateTemp(filepath.Dir(path), ".inkos-*")
	if err != nil {
		return ErrInkosDisabled
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err = file.Chmod(0600); err != nil {
		return ErrInkosDisabled
	}
	if _, err = file.Write(data); err != nil {
		return ErrInkosDisabled
	}
	if file.Sync() != nil || file.Close() != nil || os.Rename(file.Name(), path) != nil || directory.Sync() != nil {
		return ErrInkosDisabled
	}
	return nil
}

func (integration *InkosIntegration) SetGrant(userID int, allowed bool) (InkosGrant, error) {
	user, err := model.GetUserById(userID, false)
	if err != nil || userID <= 0 || user.Status != common.UserStatusEnabled {
		return InkosGrant{}, ErrInkosDenied
	}
	integration.mu.Lock()
	defer integration.mu.Unlock()
	_, path, config, _, err := loadInkosSettings()
	if err != nil {
		return InkosGrant{}, err
	}
	grant := InkosGrant{UserID: userID, Allowed: allowed}
	index := slices.IndexFunc(config.Grants, func(item InkosGrant) bool { return item.UserID == userID })
	if index >= 0 {
		if allowed {
			grant.TokenID = config.Grants[index].TokenID
		}
		config.Grants[index] = grant
	} else {
		config.Grants = append(config.Grants, grant)
	}
	if err := persistInkosConfig(path, config); err != nil {
		return InkosGrant{}, err
	}
	if !allowed {
		for digest, ticket := range integration.tickets {
			if ticket.Identity.UserID == userID {
				delete(integration.tickets, digest)
			}
		}
	}
	return grant, nil
}

// Ownership always comes from GetTokenByIds, never a client-supplied user ID or
// key. Redis may have a newer balance; it cannot relax the DB's token policy.
func validInkosToken(tokenID, userID int) (*model.Token, []string, error) {
	token, err := model.GetTokenByIds(tokenID, userID)
	if err != nil || token.Status != common.TokenStatusEnabled || token.UnlimitedQuota || token.RemainQuota <= 0 || (token.ExpiredTime != -1 && token.ExpiredTime <= time.Now().Unix()) || !token.ModelLimitsEnabled || len(token.GetIpLimits()) > 0 {
		return nil, nil, ErrInkosToken
	}
	models := token.GetModelLimits()
	if len(models) == 0 || len(models) > 256 {
		return nil, nil, ErrInkosToken
	}
	seenModels := make(map[string]bool, len(models))
	for _, name := range models {
		if name == "" || len(name) > 256 || strings.TrimSpace(name) != name || strings.ContainsAny(name, "\r\n	") || seenModels[name] {
			return nil, nil, ErrInkosToken
		}
		seenModels[name] = true
	}
	key := strings.TrimPrefix(token.Key, "sk-")
	if key == "" || strings.HasPrefix(key, "sk-") || strings.ContainsAny(key, " \r\n\t") {
		return nil, nil, ErrInkosToken
	}
	if common.RedisEnabled {
		current, err := model.GetTokenByKey(token.Key, false)
		if err != nil || current.Id != token.Id || current.UserId != userID || current.Status != common.TokenStatusEnabled || current.RemainQuota <= 0 {
			return nil, nil, ErrInkosToken
		}
		token.RemainQuota = min(token.RemainQuota, current.RemainQuota)
	}
	return token, models, nil
}

func (integration *InkosIntegration) Tokens(userID int) ([]InkosTokenView, error) {
	status := integration.Status(userID)
	if !status.Enabled {
		return nil, ErrInkosDisabled
	}
	if !status.Allowed {
		return nil, ErrInkosDenied
	}
	tokens, err := model.GetAllUserTokens(userID, 0, -1)
	if err != nil {
		return nil, ErrInkosToken
	}
	views := make([]InkosTokenView, 0, len(tokens))
	for _, item := range tokens {
		token, _, err := validInkosToken(item.Id, userID)
		if err == nil {
			views = append(views, InkosTokenView{token.Id, token.Name, token.RemainQuota, token.ModelLimitsEnabled, token.ModelLimits})
		}
	}
	return views, nil
}

func (integration *InkosIntegration) BindToken(userID, tokenID int) error {
	integration.mu.Lock()
	defer integration.mu.Unlock()
	_, path, config, _, err := loadInkosSettings()
	if err != nil {
		return err
	}
	index := slices.IndexFunc(config.Grants, func(item InkosGrant) bool { return item.UserID == userID && item.Allowed })
	if index < 0 {
		return ErrInkosDenied
	}
	if _, _, err := validInkosToken(tokenID, userID); err != nil {
		return err
	}
	config.Grants[index].TokenID = tokenID
	return persistInkosConfig(path, config)
}

func (integration *InkosIntegration) Introspect(identity InkosIdentity) (InkosContext, error) {
	auth, err := identity.AuthIdentity()
	if err != nil {
		return InkosContext{}, ErrLoginSessionInvalid
	}
	session, _, err := ValidateLoginSession(auth)
	if err != nil {
		return InkosContext{}, ErrLoginSessionInvalid
	}
	status := integration.Status(identity.UserID)
	if !status.Enabled {
		return InkosContext{}, ErrInkosDisabled
	}
	if !status.Allowed {
		return InkosContext{}, ErrInkosDenied
	}
	return InkosContext{identity.UserID, session.ExpiresAt, status.TokenID}, nil
}

func (integration *InkosIntegration) RelayContext(identity InkosIdentity) (InkosRelayContext, error) {
	context, err := integration.Introspect(identity)
	if err != nil {
		return InkosRelayContext{}, err
	}
	token, models, err := validInkosToken(context.TokenID, context.UserID)
	if err != nil {
		return InkosRelayContext{}, err
	}
	quota, err := model.GetUserQuota(context.UserID, false)
	if err != nil || quota <= 0 {
		return InkosRelayContext{}, ErrInkosToken
	}
	return InkosRelayContext{context.UserID, token.Id, "sk-" + strings.TrimPrefix(token.Key, "sk-"), models, token.RemainQuota}, nil
}

func (integration *InkosIntegration) IssueTicket(identity InkosIdentity, state string) (InkosTicketView, error) {
	if !InkosNonceValid(state) {
		return InkosTicketView{}, ErrInkosTicket
	}
	context, err := integration.Introspect(identity)
	if err != nil {
		return InkosTicketView{}, err
	}
	if _, _, err := validInkosToken(context.TokenID, context.UserID); err != nil {
		return InkosTicketView{}, err
	}
	integration.mu.Lock()
	defer integration.mu.Unlock()
	origin, _, config, _, err := loadInkosSettings()
	if err != nil {
		return InkosTicketView{}, err
	}
	if !slices.ContainsFunc(config.Grants, func(grant InkosGrant) bool {
		return grant.UserID == context.UserID && grant.Allowed && grant.TokenID == context.TokenID
	}) {
		return InkosTicketView{}, ErrInkosDenied
	}
	now := integration.now().Unix()
	for digest, ticket := range integration.tickets {
		if ticket.ExpiresAt <= now {
			delete(integration.tickets, digest)
		}
	}
	if len(integration.tickets) >= inkosTicketLimit {
		return InkosTicketView{}, ErrInkosCapacity
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return InkosTicketView{}, ErrInkosTicket
	}
	ticket := base64.RawURLEncoding.EncodeToString(secret)
	expires := min(now+60, context.ExpiresAt)
	integration.tickets[sha256.Sum256([]byte(ticket))] = inkosTicket{identity, state, origin, expires}
	return InkosTicketView{ticket, expires, origin}, nil
}

func (integration *InkosIntegration) Exchange(ticket, state, audience string) (InkosExchange, error) {
	if !InkosNonceValid(ticket) || !InkosNonceValid(state) {
		return InkosExchange{}, ErrInkosTicket
	}
	integration.mu.Lock()
	origin, _, _, _, err := loadInkosSettings()
	digest := sha256.Sum256([]byte(ticket))
	record, exists := integration.tickets[digest]
	// A known ticket is consumed even on mismatch: it can never be retried.
	delete(integration.tickets, digest)
	integration.mu.Unlock()
	if err != nil || !exists || record.ExpiresAt <= integration.now().Unix() || audience != origin || record.Audience != audience || subtle.ConstantTimeCompare([]byte(record.State), []byte(state)) != 1 {
		return InkosExchange{}, ErrInkosTicket
	}
	context, err := integration.Introspect(record.Identity)
	if err != nil {
		return InkosExchange{}, err
	}
	if _, _, err := validInkosToken(context.TokenID, context.UserID); err != nil {
		return InkosExchange{}, err
	}
	return InkosExchange{InkosContext: context, Identity: record.Identity}, nil
}
