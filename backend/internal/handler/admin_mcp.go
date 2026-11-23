package handler

import (
	"context"
	"strconv"

	"github.com/gin-gonic/gin"

	"video-canvas/internal/middleware"
	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/response"
)

// MCPProjectAPI 是后台「MCP 接入」页依赖的业务，由 *service.MCPProjectService 实现。
type MCPProjectAPI interface {
	// List 列出全部项目，带令牌数量与最近使用时间。
	List(ctx context.Context) ([]*model.MCPProjectView, error)
	// Create 新建项目。
	Create(ctx context.Context, adminID uint64, req *model.MCPProjectReq) (*model.MCPProjectView, error)
	// Update 修改项目（含启停）。
	Update(ctx context.Context, adminID, projectID uint64, req *model.MCPProjectReq) (*model.MCPProjectView, error)
	// Delete 删除项目与它的令牌。
	Delete(ctx context.Context, adminID, projectID uint64) error
	// ListTokens 列出项目的令牌（不含明文）。
	ListTokens(ctx context.Context, projectID uint64) ([]*model.MCPTokenView, error)
	// IssueToken 签发令牌，明文只返回这一次。
	IssueToken(ctx context.Context, adminID, projectID uint64, req *model.MCPTokenIssueReq) (*model.MCPIssuedToken, error)
	// RevokeToken 注销令牌。
	RevokeToken(ctx context.Context, adminID, projectID, tokenID uint64) error
	// TokenSecret 取回令牌明文（列表里「复制」用）。
	TokenSecret(ctx context.Context, callerID, projectID, tokenID uint64) (string, error)
}

// MCPAdminHandler 是后台「MCP 接入」接口。
type MCPAdminHandler struct {
	svc MCPProjectAPI
}

// NewMCPAdminHandler 创建后台 MCP 接入 handler。
func NewMCPAdminHandler(svc MCPProjectAPI) *MCPAdminHandler { return &MCPAdminHandler{svc: svc} }

// List 返回全部项目。
func (h *MCPAdminHandler) List(c *gin.Context) {
	items, err := h.svc.List(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"items": items})
}

// Create 新建项目。
func (h *MCPAdminHandler) Create(c *gin.Context) {
	var req model.MCPProjectReq
	if !BindJSON(c, &req) {
		return
	}
	v, err := h.svc.Create(c.Request.Context(), adminID(c), &req)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, v)
}

// Update 修改项目。
func (h *MCPAdminHandler) Update(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	var req model.MCPProjectReq
	if !BindJSON(c, &req) {
		return
	}
	v, err := h.svc.Update(c.Request.Context(), adminID(c), id, &req)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, v)
}

// Delete 删除项目。
func (h *MCPAdminHandler) Delete(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	if err := h.svc.Delete(c.Request.Context(), adminID(c), id); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, nil)
}

// ListTokens 列出项目的令牌。
func (h *MCPAdminHandler) ListTokens(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	items, err := h.svc.ListTokens(c.Request.Context(), id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"items": items})
}

// IssueToken 签发令牌；明文只在这个响应里出现一次。
func (h *MCPAdminHandler) IssueToken(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	var req model.MCPTokenIssueReq
	if !BindJSON(c, &req) {
		return
	}
	v, err := h.svc.IssueToken(c.Request.Context(), adminID(c), id, &req)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, v)
}

// RevokeToken 注销令牌。
func (h *MCPAdminHandler) RevokeToken(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	tokenID, ok := tokenPathID(c)
	if !ok {
		return
	}
	if err := h.svc.RevokeToken(c.Request.Context(), adminID(c), id, tokenID); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, nil)
}

// TokenSecret 取回令牌明文：只给未注销、未过期、当初存了密文的令牌。
func (h *MCPAdminHandler) TokenSecret(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	tokenID, ok := tokenPathID(c)
	if !ok {
		return
	}
	token, err := h.svc.TokenSecret(c.Request.Context(), adminID(c), id, tokenID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"token": token})
}

// adminID 取当前管理员 id：这些接口都挂在管理员中间件后面。
func adminID(c *gin.Context) uint64 { return uint64(middleware.GetUserID(c)) }

// tokenPathID 解析路径里的令牌 :tokenId。
func tokenPathID(c *gin.Context) (uint64, bool) {
	id, err := strconv.ParseUint(c.Param("tokenId"), 10, 64)
	if err != nil || id == 0 {
		response.Fail(c, errcode.ErrInvalidParams.WithMsg("令牌 id 必须是正整数"))
		return 0, false
	}
	return id, true
}
