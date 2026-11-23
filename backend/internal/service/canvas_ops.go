package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"gorm.io/datatypes"

	"video-canvas/internal/agent/canvasgraph"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/repository"
)

// CanvasOpsReq 是一次节点级编辑：一批 canvasgraph 操作，外加可选的删除节点 id。
//
// Revision 必须由调用方显式给出，且必须是它「看到并确认过」的那个版本：
// 服务端只在这个版本仍然成立时写入，否则返回 409。这样人确认的差异与实际落库的差异
// 不会因为并发修改而对不上。
type CanvasOpsReq struct {
	Revision      uint64
	Ops           json.RawMessage
	DeleteNodeIDs []string
}

// CanvasOpsResult 是节点级编辑的结果：新版本、逐项改动、提醒与临时 id 映射。
type CanvasOpsResult struct {
	Revision uint64               `json:"revision"`
	Changes  []canvasgraph.Change `json:"changes"`
	Warnings []string             `json:"warnings,omitempty"`
	IDMap    map[string]string    `json:"id_map,omitempty"`
}

// ApplyOps 在服务端执行一批节点级操作。
//
// 语义只有一份：全部走 canvasgraph（与 Agent 的 canvas_apply_ops 同一套规则），
// CLI 不自己拼图、也不自己判断连线合法性。素材类操作（assetId）在 CLI 这条路上不支持，
// 因为素材归属无法在这里校验；需要参考素材时用连线。
func (s *CanvasProjectService) ApplyOps(ctx context.Context, userID, id uint64, req *CanvasOpsReq) (*CanvasOpsResult, error) {
	if req.Revision == 0 {
		return nil, errcode.ErrInvalidParams.WithMsg("必须带 revision：节点级修改只在你看过的版本上生效")
	}
	hasOps := len(bytes.TrimSpace(req.Ops)) > 0
	if !hasOps && len(req.DeleteNodeIDs) == 0 {
		return nil, errcode.ErrInvalidParams.WithMsg("ops 与 deleteNodeIds 至少给一个")
	}

	cv, err := s.repo.GetByID(ctx, userID, id)
	if errors.Is(err, repository.ErrNotFound) {
		return nil, errcode.ErrCanvasNotFound
	}
	if err != nil {
		return nil, err
	}
	g, err := canvasgraph.Parse(cv.PayloadJSON)
	if err != nil {
		return nil, errcode.ErrCanvasPayload
	}

	out := &CanvasOpsResult{IDMap: map[string]string{}}
	changed := false

	if hasOps {
		ops, err := canvasgraph.ParseOps(req.Ops)
		if err != nil {
			return nil, errcode.ErrInvalidParams.WithMsg(err.Error())
		}
		for _, op := range ops {
			if op.AssetID != "" {
				return nil, errcode.ErrInvalidParams.WithMsg("不支持按 assetId 建节点：素材归属不在这里校验，请改用连线引用已有节点")
			}
		}
		res, err := canvasgraph.Apply(g, ops, canvasgraph.Options{})
		if err != nil {
			return nil, errcode.ErrInvalidParams.WithMsg(err.Error())
		}
		g = res.Graph
		out.Changes = append(out.Changes, res.Changes...)
		out.Warnings = append(out.Warnings, res.Warnings...)
		for k, v := range res.IDMap {
			out.IDMap[k] = v
		}
		changed = changed || len(res.Changes) > 0
	}

	if len(req.DeleteNodeIDs) > 0 {
		res, err := canvasgraph.DeleteNodes(g, req.DeleteNodeIDs)
		if err != nil {
			return nil, errcode.ErrInvalidParams.WithMsg(err.Error())
		}
		g = res.Graph
		out.Changes = append(out.Changes, res.Changes...)
		changed = changed || len(res.Changes) > 0
	}

	// 没有任何实际改动就不写库：避免为了空操作把 revision 顶上去，让前端白刷一次。
	if !changed {
		out.Revision = cv.Revision
		return out, nil
	}

	payload, err := g.Marshal()
	if err != nil {
		return nil, err
	}
	saved, err := s.repo.Update(ctx, userID, id, req.Revision, map[string]any{
		"payload_json": datatypes.JSON(payload),
	})
	switch {
	case errors.Is(err, repository.ErrNotFound):
		return nil, errcode.ErrCanvasNotFound
	case errors.Is(err, repository.ErrRevisionConflict):
		return nil, errcode.ErrCanvasConflict
	case err != nil:
		return nil, err
	}
	out.Revision = saved.Revision
	return out, nil
}
