package controller

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

var inkosIntegration = service.NewInkosIntegration(time.Now)

// InkosSessionOnly intentionally follows UserAuth/RootAuth: PAT credentials
// cannot become browser sessions even if the PAT belongs to root.
func InkosSessionOnly(c *gin.Context) {
	identity, ok := middleware.GetSessionAuthIdentity(c)
	if !ok {
		inkosFailure(c, http.StatusUnauthorized, "INKOS_SESSION_REQUIRED", "A live dashboard session is required")
		return
	}
	if _, _, err := service.ValidateLoginSession(identity); err != nil {
		inkosFailure(c, http.StatusUnauthorized, "INKOS_SESSION_INVALID", "Dashboard session is invalid")
		return
	}
	c.Next()
}

// InkosNoStore also applies to auth failures, not just successful handlers.
func InkosNoStore(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("Pragma", "no-cache")
	c.Header("Referrer-Policy", "no-referrer")
	c.Next()
}

func InkosPrivateAuth(c *gin.Context) {
	values := c.Request.Header.Values("X-Inkos-Service-Key")
	if len(values) != 1 || !inkosIntegration.AuthenticateService(values[0]) {
		inkosFailure(c, http.StatusUnauthorized, "INKOS_SERVICE_UNAUTHORIZED", "Service authentication failed")
		return
	}
	c.Next()
}

func inkosFailure(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"success": false, "code": code, "message": message, "data": nil})
}

func inkosServiceFailure(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrInkosDisabled):
		inkosFailure(c, http.StatusServiceUnavailable, "INKOS_DISABLED", "Inkos integration is unavailable")
	case errors.Is(err, service.ErrInkosDenied):
		inkosFailure(c, http.StatusForbidden, "INKOS_DENIED", "Inkos access is not granted")
	case errors.Is(err, service.ErrInkosToken):
		inkosFailure(c, http.StatusForbidden, "INKOS_TOKEN_INVALID", "An own enabled finite token with model limits and available quota is required")
	case errors.Is(err, service.ErrInkosCapacity):
		inkosFailure(c, http.StatusTooManyRequests, "INKOS_TICKET_CAPACITY", "Ticket capacity reached")
	case errors.Is(err, service.ErrInkosTicket):
		inkosFailure(c, http.StatusUnauthorized, "INKOS_TICKET_INVALID", "Ticket is invalid or expired")
	default:
		// Never relay DB/decoder/filesystem errors or credential-bearing values.
		inkosFailure(c, http.StatusUnauthorized, "INKOS_SESSION_INVALID", "Dashboard session is invalid")
	}
}

func decodeInkosBody(c *gin.Context, value any) bool {
	mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || mediaType != "application/json" {
		inkosFailure(c, http.StatusUnsupportedMediaType, "INKOS_JSON_REQUIRED", "JSON content type is required")
		return false
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
	if err := common.DecodeJsonStrict(c.Request.Body, value); err != nil {
		var limitError *http.MaxBytesError
		if errors.As(err, &limitError) {
			inkosFailure(c, http.StatusRequestEntityTooLarge, "INKOS_BODY_TOO_LARGE", "Request body is too large")
		} else {
			inkosFailure(c, http.StatusBadRequest, "INKOS_INVALID_JSON", "Invalid request body")
		}
		return false
	}
	return true
}

func GetInkosStatus(c *gin.Context) {
	identity, _ := middleware.GetSessionAuthIdentity(c)
	common.ApiSuccess(c, inkosIntegration.Status(identity.UserID))
}

func GetInkosTokens(c *gin.Context) {
	identity, _ := middleware.GetSessionAuthIdentity(c)
	tokens, err := inkosIntegration.Tokens(identity.UserID)
	if err != nil {
		inkosServiceFailure(c, err)
		return
	}
	common.ApiSuccess(c, tokens)
}

func PutInkosToken(c *gin.Context) {
	var request struct {
		TokenID int `json:"token_id"`
	}
	if !decodeInkosBody(c, &request) {
		return
	}
	if request.TokenID <= 0 {
		inkosFailure(c, http.StatusBadRequest, "INKOS_TOKEN_INVALID", "A positive token_id is required")
		return
	}
	identity, _ := middleware.GetSessionAuthIdentity(c)
	if err := inkosIntegration.BindToken(identity.UserID, request.TokenID); err != nil {
		inkosServiceFailure(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"token_id": request.TokenID})
}

func PostInkosTicket(c *gin.Context) {
	var request struct {
		State string `json:"state"`
	}
	if !decodeInkosBody(c, &request) {
		return
	}
	identity, _ := middleware.GetSessionAuthIdentity(c)
	ticket, err := inkosIntegration.IssueTicket(service.InkosIdentityFromAuth(identity), request.State)
	if err != nil {
		inkosServiceFailure(c, err)
		return
	}
	common.ApiSuccess(c, ticket)
}

func GetInkosGrants(c *gin.Context) {
	grants, err := inkosIntegration.Grants()
	if err != nil {
		inkosServiceFailure(c, err)
		return
	}
	common.ApiSuccess(c, grants)
}

func PutInkosGrant(c *gin.Context) {
	userID, err := strconv.Atoi(c.Param("userId"))
	if err != nil || userID <= 0 || strconv.Itoa(userID) != c.Param("userId") {
		inkosFailure(c, http.StatusBadRequest, "INKOS_USER_INVALID", "A positive user ID is required")
		return
	}
	var request struct {
		Allowed *bool `json:"allowed"`
	}
	if !decodeInkosBody(c, &request) {
		return
	}
	if request.Allowed == nil {
		inkosFailure(c, http.StatusBadRequest, "INKOS_GRANT_INVALID", "allowed must be a boolean")
		return
	}
	grant, err := inkosIntegration.SetGrant(userID, *request.Allowed)
	if err != nil {
		inkosServiceFailure(c, err)
		return
	}
	model.RecordAuditLog(c, model.AuditLog{
		UserId: c.GetInt("id"), ActorRole: c.GetInt("role"), Category: model.AuditCategorySecurity,
		Action: "inkos.grant_update", Success: true, Status: http.StatusOK,
		Content: fmt.Sprintf("Inkos grant updated: user_id=%d allowed=%t", userID, *request.Allowed),
	})
	common.SetContextKey(c, constant.ContextKeyAuditLogged, true)
	common.ApiSuccess(c, grant)
}

func PostInkosExchange(c *gin.Context) {
	var request struct {
		Ticket   string `json:"ticket"`
		State    string `json:"state"`
		Audience string `json:"audience"`
	}
	if !decodeInkosBody(c, &request) {
		return
	}
	exchange, err := inkosIntegration.Exchange(request.Ticket, request.State, request.Audience)
	if err != nil {
		inkosServiceFailure(c, err)
		return
	}
	common.ApiSuccess(c, exchange)
}

func PostInkosIntrospect(c *gin.Context) {
	var request struct {
		Identity service.InkosIdentity `json:"identity"`
	}
	if !decodeInkosBody(c, &request) {
		return
	}
	context, err := inkosIntegration.Introspect(request.Identity)
	if err != nil {
		inkosServiceFailure(c, err)
		return
	}
	common.ApiSuccess(c, context)
}

func PostInkosRelayContext(c *gin.Context) {
	var request struct {
		Identity service.InkosIdentity `json:"identity"`
	}
	if !decodeInkosBody(c, &request) {
		return
	}
	context, err := inkosIntegration.RelayContext(request.Identity)
	if err != nil {
		inkosServiceFailure(c, err)
		return
	}
	common.ApiSuccess(c, context)
}
