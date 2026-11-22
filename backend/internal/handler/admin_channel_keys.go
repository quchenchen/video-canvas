package handler

import (
	"github.com/gin-gonic/gin"

	"video-canvas/internal/pkg/response"
	"video-canvas/internal/service"
)

// 渠道多 Key 的管理接口（仅 super_admin，由路由挂中间件）：列出槽位（只回显末四位）、新增、改备注 / 启停、删除。
// 明文只写不读：新增请求体里的 value 只在这条链路上存在，入库前加密，任何接口都不会读回。

// channelSlotURI 是 /:key/keys/:slot 的路径参数。
type channelSlotURI struct {
	Key  string `uri:"key" binding:"required,max=128" label:"key"`
	Slot int    `uri:"slot" binding:"required,min=1" label:"slot"`
}

// addChannelKeyReq 是新增一把 Key 的请求体。
type addChannelKeyReq struct {
	Value  string `json:"value" binding:"required,max=4096" label:"API Key"`
	Remark string `json:"remark" binding:"max=64" label:"备注"`
}

// updateChannelKeyReq 修改一把 Key：不传的字段表示不改。
type updateChannelKeyReq struct {
	// 指针 + omitempty：只改启停时不传备注，不能让校验把 nil 当成超长
	Remark  *string `json:"remark" binding:"omitempty,max=64" label:"备注"`
	Enabled *bool   `json:"enabled"` // 停用后不再被轮转选中；不允许停用最后一把启用的 Key
}

// ListKeys 返回渠道的 Key 槽位（末四位、备注、启停），不含明文。
func (h *AdminChannelHandler) ListKeys(c *gin.Context) {
	key, ok := pathKey(c)
	if !ok {
		return
	}
	list, err := h.svc.ListKeys(c.Request.Context(), key)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, list)
}

// AddKey 给渠道新增一把 API Key。只写：响应只返回槽位与末四位。
func (h *AdminChannelHandler) AddKey(c *gin.Context) {
	key, ok := pathKey(c)
	if !ok {
		return
	}
	var req addChannelKeyReq
	if !BindJSON(c, &req) {
		return
	}
	view, err := h.svc.AddKey(c.Request.Context(), currentUserID(c), key, service.ChannelKeyInput{
		Value: req.Value, Remark: req.Remark,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, view)
}

// UpdateKey 修改一把 Key 的备注 / 启停。
func (h *AdminChannelHandler) UpdateKey(c *gin.Context) {
	var uri channelSlotURI
	if !bindURI(c, &uri) {
		return
	}
	var req updateChannelKeyReq
	if !BindJSON(c, &req) {
		return
	}
	view, err := h.svc.UpdateKey(c.Request.Context(), currentUserID(c), uri.Key, uri.Slot, req.Remark, req.Enabled)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, view)
}

// DeleteKey 删除一把 Key（连加密后的密文一起删）。
func (h *AdminChannelHandler) DeleteKey(c *gin.Context) {
	var uri channelSlotURI
	if !bindURI(c, &uri) {
		return
	}
	if err := h.svc.DeleteKey(c.Request.Context(), currentUserID(c), uri.Key, uri.Slot); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, nil)
}
