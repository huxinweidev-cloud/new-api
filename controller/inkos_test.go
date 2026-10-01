package controller

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const inkosTestOrigin = "https://inkos.example.com"
const inkosTestServiceKey = "inkos-test-only-service-key-not-a-real-credential"

type inkosFixture struct {
	router              *gin.Engine
	root, user, other   *model.User
	access              map[int]string
	identities          map[int]service.InkosIdentity
	token               *model.Token
	configPath, keyPath string
	now                 time.Time
}

func setupInkosTest(t *testing.T) *inkosFixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	oldDB, oldLog := model.DB, model.LOG_DB
	oldMain, oldLogType := common.MainDatabaseType(), common.LogDatabaseType()
	oldRedis, oldSecret, oldIntegration := common.RedisEnabled, common.SessionSecret, inkosIntegration
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "inkos.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.Token{}, &model.AuditLog{}))
	model.DB, model.LOG_DB = db, db
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	common.SessionSecret = "inkos-tests-only-dashboard-secret"
	fixture := &inkosFixture{access: make(map[int]string), identities: make(map[int]service.InkosIdentity), now: time.Now()}
	inkosIntegration = service.NewInkosIntegration(func() time.Time { return fixture.now })
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLog
		common.SetDatabaseTypes(oldMain, oldLogType)
		common.RedisEnabled, common.SessionSecret, inkosIntegration = oldRedis, oldSecret, oldIntegration
		connection, err := db.DB()
		if err == nil {
			_ = connection.Close()
		}
	})
	directory := t.TempDir()
	fixture.configPath, fixture.keyPath = filepath.Join(directory, "config.json"), filepath.Join(directory, "key")
	require.NoError(t, os.WriteFile(fixture.configPath, []byte(`{"version":1,"grants":[]}`), 0600))
	require.NoError(t, os.WriteFile(fixture.keyPath, []byte(inkosTestServiceKey+"\n"), 0400))
	t.Setenv("INKOS_ORIGIN", inkosTestOrigin)
	t.Setenv("INKOS_CONFIG_FILE", fixture.configPath)
	t.Setenv("INKOS_SERVICE_KEY_FILE", fixture.keyPath)
	for index, role := range []int{common.RoleRootUser, common.RoleCommonUser, common.RoleCommonUser} {
		pat := fmt.Sprintf("%032d", index+1)
		user := &model.User{Username: fmt.Sprintf("inkos-user-%d", index), Password: "unused-test-hash", AccessToken: &pat, AffCode: fmt.Sprintf("inkos-%d", index), Role: role, Status: common.UserStatusEnabled, AuthVersion: 1, Quota: 1000, Group: "default"}
		require.NoError(t, db.Create(user).Error)
		bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "inkos-test")
		require.NoError(t, err)
		identity, err := service.ParseAccessToken(bundle.AccessToken)
		require.NoError(t, err)
		fixture.access[user.Id], fixture.identities[user.Id] = bundle.AccessToken, service.InkosIdentityFromAuth(identity)
		switch index {
		case 0:
			fixture.root = user
		case 1:
			fixture.user = user
		case 2:
			fixture.other = user
		}
	}
	fixture.token = &model.Token{UserId: fixture.user.Id, Key: "inkos-test-model-key", Name: "Own finite token", Status: common.TokenStatusEnabled, ExpiredTime: -1, RemainQuota: 100, ModelLimitsEnabled: true, ModelLimits: "model-a,model-b"}
	require.NoError(t, db.Create(fixture.token).Error)
	var version string
	require.NoError(t, db.Raw("SELECT sqlite_version()").Scan(&version).Error)
	t.Logf("real SQLite %s", version)
	router := gin.New()
	inkos := router.Group("/api/inkos", InkosNoStore)
	browser := inkos.Group("", middleware.UserAuth(), InkosSessionOnly)
	browser.GET("/status", GetInkosStatus)
	browser.GET("/tokens", GetInkosTokens)
	browser.PUT("/token", PutInkosToken)
	browser.POST("/ticket", PostInkosTicket)
	root := inkos.Group("", middleware.RootAuth(), InkosSessionOnly)
	root.GET("/grants", GetInkosGrants)
	root.PUT("/grants/:userId", PutInkosGrant)
	private := inkos.Group("/internal", InkosPrivateAuth)
	private.POST("/exchange", PostInkosExchange)
	private.POST("/introspect", PostInkosIntrospect)
	private.POST("/relay-context", PostInkosRelayContext)
	fixture.router = router
	return fixture
}

func (fixture *inkosFixture) request(t *testing.T, method, path string, body any, credential string, private bool) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	data, err := common.Marshal(body)
	require.NoError(t, err)
	request := httptest.NewRequest(method, "/api/inkos"+path, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	if private {
		request.Header.Set("X-Inkos-Service-Key", credential)
	} else if credential != "" {
		request.Header.Set("Authorization", "Bearer "+credential)
	}
	response := httptest.NewRecorder()
	fixture.router.ServeHTTP(response, request)
	var envelope map[string]any
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	return response, envelope
}

func (fixture *inkosFixture) authorize(t *testing.T) {
	t.Helper()
	response, envelope := fixture.request(t, "PUT", fmt.Sprintf("/grants/%d", fixture.user.Id), gin.H{"allowed": true}, fixture.access[fixture.root.Id], false)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, true, envelope["success"])
	response, envelope = fixture.request(t, "PUT", "/token", gin.H{"token_id": fixture.token.Id}, fixture.access[fixture.user.Id], false)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, true, envelope["success"])
}

func inkosState(value byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, 32))
}

func (fixture *inkosFixture) ticket(t *testing.T) string {
	t.Helper()
	response, envelope := fixture.request(t, "POST", "/ticket", gin.H{"state": inkosState(1)}, fixture.access[fixture.user.Id], false)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, true, envelope["success"])
	data := envelope["data"].(map[string]any)
	assert.Equal(t, inkosTestOrigin, data["origin"])
	assert.EqualValues(t, fixture.now.Unix()+60, data["expires_at"])
	return data["ticket"].(string)
}

func TestInkosDefaultDenySessionOnlyAndGrants(t *testing.T) {
	fixture := setupInkosTest(t)
	for _, user := range []*model.User{fixture.user, fixture.root} {
		response, envelope := fixture.request(t, "GET", "/status", nil, fixture.access[user.Id], false)
		require.Equal(t, http.StatusOK, response.Code)
		assert.Equal(t, gin.H{"enabled": true, "allowed": false, "origin": inkosTestOrigin, "user_id": float64(user.Id), "token_id": float64(0)}, gin.H(envelope["data"].(map[string]any)))
		response, envelope = fixture.request(t, "GET", "/tokens", nil, fixture.access[user.Id], false)
		assert.Equal(t, http.StatusForbidden, response.Code)
		assert.Equal(t, "INKOS_DENIED", envelope["code"])
	}
	for _, endpoint := range []struct {
		method, path string
		body         any
	}{{"GET", "/status", nil}, {"GET", "/tokens", nil}, {"PUT", "/token", gin.H{"token_id": fixture.token.Id}}, {"POST", "/ticket", gin.H{"state": inkosState(1)}}, {"GET", "/grants", nil}, {"PUT", fmt.Sprintf("/grants/%d", fixture.user.Id), gin.H{"allowed": true}}} {
		response, envelope := fixture.request(t, endpoint.method, endpoint.path, endpoint.body, *fixture.root.AccessToken, false)
		assert.Equal(t, http.StatusUnauthorized, response.Code, endpoint.path)
		assert.Equal(t, "INKOS_SESSION_REQUIRED", envelope["code"])
	}
	response, _ := fixture.request(t, "GET", "/status", nil, "", false)
	assert.Equal(t, http.StatusUnauthorized, response.Code)
	response, _ = fixture.request(t, "GET", "/grants", nil, fixture.access[fixture.user.Id], false)
	assert.Equal(t, http.StatusForbidden, response.Code)
	fixture.authorize(t)
	response, envelope := fixture.request(t, "GET", "/grants", nil, fixture.access[fixture.root.Id], false)
	require.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, []any{map[string]any{"user_id": float64(fixture.user.Id), "allowed": true, "token_id": float64(fixture.token.Id)}}, envelope["data"])
	info, err := os.Stat(fixture.configPath)
	require.NoError(t, err)
	assert.EqualValues(t, 0600, info.Mode().Perm())
	data, err := os.ReadFile(fixture.configPath)
	require.NoError(t, err)
	assert.NotContains(t, string(data), fixture.token.Key)
	assert.NotContains(t, string(data), fixture.identities[fixture.user.Id].SessionID)
	inkosIntegration = service.NewInkosIntegration(time.Now)
	assert.Equal(t, fixture.token.Id, inkosIntegration.Status(fixture.user.Id).TokenID)
	response, _ = fixture.request(t, "PUT", fmt.Sprintf("/grants/%d", fixture.user.Id), gin.H{"allowed": false}, fixture.access[fixture.root.Id], false)
	require.Equal(t, http.StatusOK, response.Code)
	assert.False(t, inkosIntegration.Status(fixture.user.Id).Allowed)
	assert.Zero(t, inkosIntegration.Status(fixture.user.Id).TokenID)
	var audits []model.AuditLog
	require.NoError(t, model.LOG_DB.Where("action = ?", "inkos.grant_update").Find(&audits).Error)
	require.Len(t, audits, 2)
	for _, audit := range audits {
		assert.Equal(t, fixture.root.Id, audit.UserId)
		assert.True(t, audit.Success)
		assert.NotContains(t, audit.Content, inkosTestServiceKey)
		assert.NotContains(t, audit.Content, fixture.token.Key)
	}
}

func TestInkosBindingConstraintsAndPrivateProjection(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		mutation gin.H
	}{
		{"other owner", gin.H{"user_id": 3}}, {"disabled", gin.H{"status": common.TokenStatusDisabled}}, {"expired", gin.H{"expired_time": time.Now().Unix()}}, {"unlimited", gin.H{"unlimited_quota": true}}, {"empty quota", gin.H{"remain_quota": 0}}, {"models disabled", gin.H{"model_limits_enabled": false}}, {"models empty", gin.H{"model_limits": ""}}, {"empty model entry", gin.H{"model_limits": "model-a,"}}, {"IP restricted", gin.H{"allow_ips": "127.0.0.1"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := setupInkosTest(t)
			_, err := inkosIntegration.SetGrant(fixture.user.Id, true)
			require.NoError(t, err)
			require.NoError(t, model.DB.Model(fixture.token).Updates(map[string]any(scenario.mutation)).Error)
			response, envelope := fixture.request(t, "PUT", "/token", gin.H{"token_id": fixture.token.Id}, fixture.access[fixture.user.Id], false)
			assert.Equal(t, http.StatusForbidden, response.Code)
			assert.Equal(t, "INKOS_TOKEN_INVALID", envelope["code"])
			assert.Zero(t, inkosIntegration.Status(fixture.user.Id).TokenID)
		})
	}
	t.Run("projection and ready Authorization", func(t *testing.T) {
		fixture := setupInkosTest(t)
		fixture.authorize(t)
		other := &model.Token{UserId: fixture.other.Id, Key: "test-other-model-key", Status: common.TokenStatusEnabled, ExpiredTime: -1, RemainQuota: 100, ModelLimitsEnabled: true, ModelLimits: "model-a"}
		require.NoError(t, model.DB.Create(other).Error)
		response, envelope := fixture.request(t, "GET", "/tokens", nil, fixture.access[fixture.user.Id], false)
		require.Equal(t, http.StatusOK, response.Code)
		views := envelope["data"].([]any)
		require.Len(t, views, 1)
		assert.Equal(t, map[string]any{"id": float64(fixture.token.Id), "name": fixture.token.Name, "remain_quota": float64(100), "model_limits_enabled": true, "model_limits": "model-a,model-b"}, views[0])
		assert.NotContains(t, response.Body.String(), fixture.token.Key)
		for _, key := range []string{"inkos-test-model-key", "sk-inkos-test-model-key"} {
			require.NoError(t, model.DB.Model(fixture.token).Update("key", key).Error)
			response, envelope = fixture.request(t, "POST", "/internal/relay-context", gin.H{"identity": fixture.identities[fixture.user.Id]}, inkosTestServiceKey, true)
			require.Equal(t, http.StatusOK, response.Code)
			assert.Equal(t, map[string]any{"user_id": float64(fixture.user.Id), "token_id": float64(fixture.token.Id), "api_key": "sk-inkos-test-model-key", "models": []any{"model-a", "model-b"}, "remain_quota": float64(100)}, envelope["data"])
		}
	})
}

func TestInkosTicketStateAudienceExpiryAndReplay(t *testing.T) {
	for _, scenario := range []string{"success", "wrong state", "wrong audience", "expired", "concurrent consume"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := setupInkosTest(t)
			fixture.authorize(t)
			ticket := fixture.ticket(t)
			assert.True(t, service.InkosNonceValid(ticket))
			state, audience := inkosState(1), inkosTestOrigin
			switch scenario {
			case "wrong state":
				state = inkosState(2)
			case "wrong audience":
				audience += "/"
			case "expired":
				fixture.now = fixture.now.Add(60 * time.Second)
			case "concurrent consume":
				results := make(chan error, 2)
				var group sync.WaitGroup
				for range 2 {
					group.Go(func() { _, err := inkosIntegration.Exchange(ticket, state, audience); results <- err })
				}
				group.Wait()
				close(results)
				successes := 0
				for err := range results {
					if err == nil {
						successes++
					}
				}
				assert.Equal(t, 1, successes)
				return
			}
			response, envelope := fixture.request(t, "POST", "/internal/exchange", gin.H{"ticket": ticket, "state": state, "audience": audience}, inkosTestServiceKey, true)
			if scenario == "success" {
				require.Equal(t, http.StatusOK, response.Code)
				data := envelope["data"].(map[string]any)
				identity := fixture.identities[fixture.user.Id]
				assert.Equal(t, map[string]any{"user_id": float64(identity.UserID), "session_id": identity.SessionID, "user_auth_version": float64(identity.UserAuthVersion), "session_version": float64(identity.SessionVersion)}, data["identity"])
				assert.EqualValues(t, fixture.token.Id, data["token_id"])
				assert.NotContains(t, response.Body.String(), fixture.token.Key)
				assert.NotContains(t, response.Body.String(), fixture.access[fixture.user.Id])
			} else {
				assert.Equal(t, http.StatusUnauthorized, response.Code)
				assert.Equal(t, false, envelope["success"])
			}
			response, _ = fixture.request(t, "POST", "/internal/exchange", gin.H{"ticket": ticket, "state": inkosState(1), "audience": inkosTestOrigin}, inkosTestServiceKey, true)
			assert.Equal(t, http.StatusUnauthorized, response.Code)
		})
	}
	t.Run("canonical state", func(t *testing.T) {
		fixture := setupInkosTest(t)
		fixture.authorize(t)
		for _, state := range []string{"", strings.Repeat("a", 42), strings.Repeat("a", 44), inkosState(1) + "=", inkosState(1)[:42] + "B", strings.Repeat("!", 43)} {
			response, envelope := fixture.request(t, "POST", "/ticket", gin.H{"state": state}, fixture.access[fixture.user.Id], false)
			assert.Equal(t, http.StatusUnauthorized, response.Code)
			assert.Equal(t, "INKOS_TICKET_INVALID", envelope["code"])
		}
	})
}

func TestInkosLiveRevocationAndOriginalVersions(t *testing.T) {
	for _, scenario := range []string{"logout", "disabled user", "user auth version", "session version", "session expiry", "grant revoked", "token disabled", "token expired", "token exhausted", "models removed", "token deleted", "user quota exhausted"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := setupInkosTest(t)
			fixture.authorize(t)
			ticket := fixture.ticket(t)
			identity := fixture.identities[fixture.user.Id]
			response, _ := fixture.request(t, "POST", "/internal/introspect", gin.H{"identity": identity}, inkosTestServiceKey, true)
			require.Equal(t, http.StatusOK, response.Code)
			auth, err := identity.AuthIdentity()
			require.NoError(t, err)
			identityRevoked := true
			switch scenario {
			case "logout":
				_, err = model.RevokeUserSession(fixture.user.Id, identity.SessionID, "logout")
			case "disabled user":
				err = model.DB.Model(fixture.user).Update("status", common.UserStatusDisabled).Error
			case "user auth version":
				_, err = model.BumpUserAuthVersion(fixture.user.Id)
			case "session version":
				_, err = service.AdvanceCurrentSessionSecurity(auth, "test-security-change")
			case "session expiry":
				err = model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("expires_at", time.Now().Unix()).Error
			case "grant revoked":
				_, err = inkosIntegration.SetGrant(fixture.user.Id, false)
			case "token disabled":
				identityRevoked = false
				err = model.DB.Model(fixture.token).Update("status", common.TokenStatusDisabled).Error
			case "token expired":
				identityRevoked = false
				err = model.DB.Model(fixture.token).Update("expired_time", time.Now().Unix()).Error
			case "token exhausted":
				identityRevoked = false
				err = model.DB.Model(fixture.token).Update("remain_quota", 0).Error
			case "models removed":
				identityRevoked = false
				err = model.DB.Model(fixture.token).Update("model_limits_enabled", false).Error
			case "token deleted":
				identityRevoked = false
				err = fixture.token.Delete()
			case "user quota exhausted":
				identityRevoked = false
				err = model.DB.Model(fixture.user).Update("quota", 0).Error
			}
			require.NoError(t, err)
			response, _ = fixture.request(t, "POST", "/internal/introspect", gin.H{"identity": identity}, inkosTestServiceKey, true)
			if identityRevoked {
				assert.NotEqual(t, http.StatusOK, response.Code)
			} else {
				assert.Equal(t, http.StatusOK, response.Code)
			}
			response, envelope := fixture.request(t, "POST", "/internal/relay-context", gin.H{"identity": identity}, inkosTestServiceKey, true)
			assert.NotEqual(t, http.StatusOK, response.Code)
			assert.Equal(t, false, envelope["success"])
			assert.NotContains(t, response.Body.String(), fixture.token.Key)
			response, _ = fixture.request(t, "POST", "/internal/exchange", gin.H{"ticket": ticket, "state": inkosState(1), "audience": inkosTestOrigin}, inkosTestServiceKey, true)
			if scenario != "user quota exhausted" {
				assert.NotEqual(t, http.StatusOK, response.Code)
			}
		})
	}
	t.Run("current binding", func(t *testing.T) {
		fixture := setupInkosTest(t)
		fixture.authorize(t)
		otherToken := &model.Token{UserId: fixture.user.Id, Key: "inkos-test-new-binding", Status: common.TokenStatusEnabled, ExpiredTime: -1, RemainQuota: 12, ModelLimitsEnabled: true, ModelLimits: "model-c"}
		require.NoError(t, model.DB.Create(otherToken).Error)
		require.NoError(t, inkosIntegration.BindToken(fixture.user.Id, otherToken.Id))
		response, envelope := fixture.request(t, "POST", "/internal/relay-context", gin.H{"identity": fixture.identities[fixture.user.Id]}, inkosTestServiceKey, true)
		require.Equal(t, http.StatusOK, response.Code)
		data := envelope["data"].(map[string]any)
		assert.EqualValues(t, otherToken.Id, data["token_id"])
		assert.Equal(t, "sk-"+otherToken.Key, data["api_key"])
		assert.Equal(t, []any{"model-c"}, data["models"])
	})
}

func TestInkosPrivateAuthStrictJSONAndBounds(t *testing.T) {
	fixture := setupInkosTest(t)
	fixture.authorize(t)
	for _, key := range []string{"", "wrong-key", inkosTestServiceKey + " ", strings.Repeat("a", 4097)} {
		response, envelope := fixture.request(t, "POST", "/internal/relay-context", gin.H{"identity": fixture.identities[fixture.user.Id]}, key, true)
		assert.Equal(t, http.StatusUnauthorized, response.Code)
		assert.Equal(t, "INKOS_SERVICE_UNAUTHORIZED", envelope["code"])
		assert.NotContains(t, response.Body.String(), fixture.token.Key)
	}
	identityBytes, err := common.Marshal(gin.H{"identity": fixture.identities[fixture.user.Id]})
	require.NoError(t, err)
	for _, scenario := range []struct {
		name, body, contentType string
		status                  int
	}{
		{"unknown", `{"identity":{},"unexpected":1}`, "application/json", 400},
		{"duplicate", `{"identity":{},"identity":{}}`, "application/json", 400},
		{"nested duplicate", `{"identity":{"user_id":1,"user_id":2}}`, "application/json", 400},
		{"trailing", string(identityBytes) + ` {}`, "application/json", 400},
		{"legacy identity field", `{"identity":{"auth_version":1}}`, "application/json", 400},
		{"null", `null`, "application/json", 401},
		{"not JSON", string(identityBytes), "text/plain", 415},
		{"oversized", string(identityBytes) + strings.Repeat(" ", 16<<10), "application/json", 413},
		{"exact bound", string(identityBytes) + strings.Repeat(" ", (16<<10)-len(identityBytes)), "application/json", 200},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/api/inkos/internal/introspect", strings.NewReader(scenario.body))
			request.Header.Set("X-Inkos-Service-Key", inkosTestServiceKey)
			request.Header.Set("Content-Type", scenario.contentType)
			response := httptest.NewRecorder()
			fixture.router.ServeHTTP(response, request)
			assert.Equal(t, scenario.status, response.Code)
			assert.NotContains(t, response.Body.String(), inkosTestServiceKey)
		})
	}
	request := httptest.NewRequest("POST", "/api/inkos/internal/introspect", bytes.NewReader(identityBytes))
	request.Header.Add("X-Inkos-Service-Key", inkosTestServiceKey)
	request.Header.Add("X-Inkos-Service-Key", inkosTestServiceKey)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	fixture.router.ServeHTTP(response, request)
	assert.Equal(t, http.StatusUnauthorized, response.Code)
	for _, body := range []any{gin.H{}, gin.H{"allowed": nil}, gin.H{"allowed": "true"}} {
		response, _ := fixture.request(t, "PUT", fmt.Sprintf("/grants/%d", fixture.user.Id), body, fixture.access[fixture.root.Id], false)
		assert.Equal(t, http.StatusBadRequest, response.Code)
	}
	for _, userID := range []string{"0", "-1", "01", "+1", "9999"} {
		response, _ := fixture.request(t, "PUT", "/grants/"+userID, gin.H{"allowed": true}, fixture.access[fixture.root.Id], false)
		assert.NotEqual(t, http.StatusOK, response.Code)
	}
}

func TestInkosConfigurationFailClosedAndStrictPersistence(t *testing.T) {
	for _, scenario := range []string{"missing config", "missing key", "empty key", "unsafe permissions", "unknown config field", "duplicate config field", "duplicate users", "negative user", "unsupported version", "null grants", "trailing JSON", "symlink config", "invalid origin"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := setupInkosTest(t)
			fixture.authorize(t)
			switch scenario {
			case "missing config":
				require.NoError(t, os.Remove(fixture.configPath))
			case "missing key":
				require.NoError(t, os.Remove(fixture.keyPath))
			case "empty key":
				require.NoError(t, os.Chmod(fixture.keyPath, 0600))
				require.NoError(t, os.WriteFile(fixture.keyPath, []byte("\n"), 0600))
			case "unsafe permissions":
				require.NoError(t, os.Chmod(fixture.configPath, 0644))
			case "unknown config field":
				require.NoError(t, os.WriteFile(fixture.configPath, []byte(`{"version":1,"grants":[],"default_allow":true}`), 0600))
			case "duplicate config field":
				require.NoError(t, os.WriteFile(fixture.configPath, []byte(`{"version":1,"version":1,"grants":[]}`), 0600))
			case "duplicate users":
				require.NoError(t, os.WriteFile(fixture.configPath, []byte(`{"version":1,"grants":[{"user_id":1,"allowed":true,"token_id":0},{"user_id":1,"allowed":true,"token_id":0}]}`), 0600))
			case "negative user":
				require.NoError(t, os.WriteFile(fixture.configPath, []byte(`{"version":1,"grants":[{"user_id":-1,"allowed":true,"token_id":0}]}`), 0600))
			case "unsupported version":
				require.NoError(t, os.WriteFile(fixture.configPath, []byte(`{"version":2,"grants":[]}`), 0600))
			case "null grants":
				require.NoError(t, os.WriteFile(fixture.configPath, []byte(`{"version":1,"grants":null}`), 0600))
			case "trailing JSON":
				require.NoError(t, os.WriteFile(fixture.configPath, []byte(`{"version":1,"grants":[]} {}`), 0600))
			case "symlink config":
				target := fixture.configPath + ".target"
				require.NoError(t, os.Rename(fixture.configPath, target))
				require.NoError(t, os.Symlink(target, fixture.configPath))
			case "invalid origin":
				t.Setenv("INKOS_ORIGIN", inkosTestOrigin+"/")
			}
			response, envelope := fixture.request(t, "GET", "/status", nil, fixture.access[fixture.user.Id], false)
			require.Equal(t, http.StatusOK, response.Code)
			data := envelope["data"].(map[string]any)
			assert.Equal(t, false, data["enabled"])
			assert.Equal(t, false, data["allowed"])
			assert.EqualValues(t, 0, data["token_id"])
			response, _ = fixture.request(t, "POST", "/internal/introspect", gin.H{"identity": fixture.identities[fixture.user.Id]}, inkosTestServiceKey, true)
			assert.Equal(t, http.StatusUnauthorized, response.Code)
			response, _ = fixture.request(t, "PUT", fmt.Sprintf("/grants/%d", fixture.user.Id), gin.H{"allowed": true}, fixture.access[fixture.root.Id], false)
			assert.Equal(t, http.StatusServiceUnavailable, response.Code)
		})
	}
}
