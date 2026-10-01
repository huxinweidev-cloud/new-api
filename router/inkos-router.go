package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func registerInkosRoutes(api *gin.RouterGroup) {
	inkos := api.Group("/inkos", controller.InkosNoStore)
	browser := inkos.Group("", middleware.UserAuth(), controller.InkosSessionOnly)
	browser.GET("/status", controller.GetInkosStatus)
	browser.GET("/tokens", controller.GetInkosTokens)
	browser.PUT("/token", controller.PutInkosToken)
	browser.POST("/ticket", middleware.UserCriticalRateLimit("inkos-ticket"), controller.PostInkosTicket)

	root := inkos.Group("", middleware.RootAuth(), controller.InkosSessionOnly)
	root.GET("/grants", controller.GetInkosGrants)
	root.PUT("/grants/:userId", controller.PutInkosGrant)

	private := inkos.Group("/internal", controller.InkosPrivateAuth)
	private.POST("/exchange", controller.PostInkosExchange)
	private.POST("/introspect", controller.PostInkosIntrospect)
	private.POST("/relay-context", controller.PostInkosRelayContext)
}
