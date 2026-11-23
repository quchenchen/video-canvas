package handler

import (
	"encoding/json"

	"github.com/gin-gonic/gin"

	"video-canvas/internal/pkg/response"
	"video-canvas/internal/service"
)

// CanvasOpsHandler 处理节点级编辑：一批 canvasgraph 操作 + 可选删除的节点 id。
//
// 与 PUT /canvas/:id 的分工：PUT 是前端整图保存；这里是「只提交差异」，
// 由服务端用 canvasgraph 应用，规则与 Agent 的 canvas_apply_ops 完全一致。
type CanvasOpsHandler struct {
	svc *service.CanvasProjectService
}

func NewCanvasOpsHandler(svc *service.CanvasProjectService) *CanvasOpsHandler {
	return &CanvasOpsHandler{svc: svc}
}

type canvasOpsReq struct {
	// Revision 必填：只在这个版本仍然成立时写入，避免把人确认过的差异写到别人改过的画布上。
	Revision      uint64          `json:"revision" binding:"required" label:"基础版本号"`
	Ops           json.RawMessage `json:"ops"`
	DeleteNodeIDs []string        `json:"deleteNodeIds"`
}

// Apply POST /canvas/:id/ops
func (h *CanvasOpsHandler) Apply(c *gin.Context) {
	id, ok := CanvasPathID(c)
	if !ok {
		return
	}
	var req canvasOpsReq
	if !BindJSON(c, &req) {
		return
	}
	res, err := h.svc.ApplyOps(c.Request.Context(), currentUserID(c), id, &service.CanvasOpsReq{
		Revision:      req.Revision,
		Ops:           req.Ops,
		DeleteNodeIDs: req.DeleteNodeIDs,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, res)
}
