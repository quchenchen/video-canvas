package handler

import (
	"errors"
	"io"

	"github.com/gin-gonic/gin"

	"video-canvas/internal/middleware"
	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/response"
	"video-canvas/internal/service"
)

// CLIDeviceHandler 处理命令行设备授权：申请、轮询换令牌、网页确认。
type CLIDeviceHandler struct {
	svc *service.CLIDeviceService
}

func NewCLIDeviceHandler(svc *service.CLIDeviceService) *CLIDeviceHandler {
	return &CLIDeviceHandler{svc: svc}
}

// Start 申请设备授权（POST /auth/cli/device，无需登录）。client_name 可省略。
func (h *CLIDeviceHandler) Start(c *gin.Context) {
	var req model.CLIDeviceStartReq
	// 不带请求体也算合法：body 为空时 ShouldBindJSON 返回 EOF，不是参数错误。
	if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, io.EOF) {
		response.Fail(c, errcode.ErrInvalidParams)
		return
	}
	view, err := h.svc.Start(c.Request.Context(), req.ClientName)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, view)
}

// Poll 用设备码换令牌（POST /auth/cli/token，无需登录）。状态写在 data.status 里。
func (h *CLIDeviceHandler) Poll(c *gin.Context) {
	var req model.CLIDevicePollReq
	if !BindJSON(c, &req) {
		return
	}
	view, err := h.svc.Poll(c.Request.Context(), req.DeviceCode)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, view)
}

// Describe 给授权页读取设备信息（GET /auth/cli/device?code=，需登录）。
func (h *CLIDeviceHandler) Describe(c *gin.Context) {
	code := c.Query("code")
	if code == "" {
		response.Fail(c, errcode.ErrCLIDeviceUserCode)
		return
	}
	view, err := h.svc.Describe(c.Request.Context(), code)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, view)
}

// Approve 确认授权（POST /auth/cli/device/approve，需登录）。
func (h *CLIDeviceHandler) Approve(c *gin.Context) {
	var req model.CLIDeviceApproveReq
	if !BindJSON(c, &req) {
		return
	}
	if err := h.svc.Approve(c.Request.Context(), uint64(middleware.GetUserID(c)), req.UserCode); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, nil)
}

// Deny 拒绝授权（POST /auth/cli/device/deny，需登录）。
func (h *CLIDeviceHandler) Deny(c *gin.Context) {
	var req model.CLIDeviceApproveReq
	if !BindJSON(c, &req) {
		return
	}
	if err := h.svc.Deny(c.Request.Context(), req.UserCode); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, nil)
}
