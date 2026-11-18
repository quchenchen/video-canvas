package handler

import (
	"strings"

	"github.com/gin-gonic/gin"

	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/idcodec"
	"video-canvas/internal/pkg/response"
	"video-canvas/internal/service"
)

// FilingHandler 虚拟人像库接口：归集条目的增删改查与备案提交 / 状态刷新。
type FilingHandler struct {
	svc *service.FilingService
}

// NewFilingHandler 组装虚拟人像库接口（归集、提交备案、状态刷新）。
func NewFilingHandler(svc *service.FilingService) *FilingHandler {
	return &FilingHandler{svc: svc}
}

type collectFilingReq struct {
	SourceType string `json:"source_type" binding:"required"`
	SourceRef  string `json:"source_ref" binding:"required"`
	Name       string `json:"name"`
	AssetID    string `json:"asset_id"`
	// URL 可省略：给了 asset_id 时由后端从素材库取可访问地址，前端不需要自己拼。
	URL string `json:"url"`
}

// List 当前用户归集的全部虚拟人像条目。
// 带 `?refresh=pending` 时先让后端把所有审核中的条目去方舟查一遍再返回——页面轮询走这条，
// 否则前端「自动刷新」只是重读数据库，pending 永远不会自己变成 active。
func (h *FilingHandler) List(c *gin.Context) {
	if c.Query("refresh") == "pending" {
		// 刷新失败不影响列表本身：拿到的仍是当前库里的状态，下一轮轮询会再试。
		_, _ = h.svc.RefreshPending(c.Request.Context(), currentUserID(c))
	}
	rows, err := h.svc.List(c.Request.Context(), currentUserID(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	if rows == nil {
		rows = []model.VirtualAvatar{}
	}
	response.OK(c, rows)
}

// Collect 把一张角色图片归集进虚拟人像库。
func (h *FilingHandler) Collect(c *gin.Context) {
	var req collectFilingReq
	if !BindJSON(c, &req) {
		return
	}
	row, err := h.svc.Collect(c.Request.Context(), currentUserID(c), service.CollectInput{
		SourceType: strings.TrimSpace(req.SourceType),
		SourceRef:  strings.TrimSpace(req.SourceRef),
		Name:       strings.TrimSpace(req.Name),
		AssetID:    strings.TrimSpace(req.AssetID),
		URL:        strings.TrimSpace(req.URL),
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.Created(c, row)
}

// filingURI 从 :id 取十六进制编码的归集条目 ID。
type filingURI struct {
	ID string `uri:"id" binding:"required"`
}

func (h *FilingHandler) pathID(c *gin.Context) (uint64, bool) {
	var uri filingURI
	if !bindURI(c, &uri) {
		return 0, false
	}
	id, ok := idcodec.Decode(uri.ID)
	if !ok {
		response.Fail(c, errcode.ErrInvalidParams.WithMsg("id 格式错误"))
		return 0, false
	}
	return id, true
}

// Remove 从虚拟人像库移除（已备案的会同时删方舟资产）。
func (h *FilingHandler) Remove(c *gin.Context) {
	id, ok := h.pathID(c)
	if !ok {
		return
	}
	if err := h.svc.Remove(c.Request.Context(), currentUserID(c), id); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, nil)
}

type submitFilingReq struct {
	ModelKey string `json:"model_key"`
}

// Submit 提交备案：调方舟 CreateAsset。
func (h *FilingHandler) Submit(c *gin.Context) {
	id, ok := h.pathID(c)
	if !ok {
		return
	}
	var req submitFilingReq
	if !BindJSON(c, &req) {
		return
	}
	row, err := h.svc.Submit(c.Request.Context(), currentUserID(c), id, strings.TrimSpace(req.ModelKey))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, row)
}

// Refresh 刷新一条备案的状态（调方舟 GetAsset）。
func (h *FilingHandler) Refresh(c *gin.Context) {
	id, ok := h.pathID(c)
	if !ok {
		return
	}
	row, err := h.svc.Refresh(c.Request.Context(), currentUserID(c), id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, row)
}
