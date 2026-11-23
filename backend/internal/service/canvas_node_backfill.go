package service

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"video-canvas/internal/agent/canvasgraph"
	"video-canvas/internal/model"
	"video-canvas/internal/pkg/logger"
	"video-canvas/internal/pkg/ws"
	"video-canvas/internal/repository"
)

// CanvasNodeBackfillRepo 是写回节点要的最小存储：读画布、按 revision 原子写回。
// 只用 canvas_projects 单表更新，不碰其它业务表，所以给仓储的两个方法就够。
type CanvasNodeBackfillRepo interface {
	GetByID(ctx context.Context, userID, id uint64) (*model.CanvasProject, error)
	Update(ctx context.Context, userID, id, revision uint64, fields map[string]any) (*model.CanvasProject, error)
}

// CanvasNodeBackfiller 由生成任务服务在任务落终态后调用。
type CanvasNodeBackfiller interface {
	BackfillNode(ctx context.Context, task *model.GenerationTask, outputs []model.TaskOutput) error
}

// CanvasNodeBackfill 把生成任务的终态写回它所属画布上的普通节点（图片 / 视频 / 音频 / 文本）。
//
// 为什么需要它：浏览器这一端只在收到 task.updated 时把产物补进节点（utils/tasks/backfill.ts），
// 产物落不落画布取决于有没有人开着页面。命令行、MCP 与无人值守的批量出片提交完就断线，
// 节点永远是空的——服务端把同一件事做一遍，任务跑完即写，不依赖任何客户端在线。
//
// 写入语义刻意与前端 applyBackfill 对齐，避免两边写出不同结果：
// 成功时追加产物（按素材 id 去重）并把首个新产物设为当前版本；已有结果的节点不因失败被打回
// error；取消回到 idle。版本冲突沿用画布的 CAS：重读重放三次，仍冲突就放弃（下一次任务变化再说），
// 绝不覆盖用户同时保存的内容。
//
// 不认领的任务：短剧画布（DramaID 非空，由片段服务写）、营销与短剧片段的节点前缀
// （各自的观察者已经写过）、试跑任务、没有画布归属或没有节点 id 的任务。
type CanvasNodeBackfill struct {
	repo CanvasNodeBackfillRepo
	bc   ws.Broadcaster
}

// NewCanvasNodeBackfill 构造回写观察者；bc 为 nil 时只写不推。
func NewCanvasNodeBackfill(repo CanvasNodeBackfillRepo, bc ws.Broadcaster) *CanvasNodeBackfill {
	return &CanvasNodeBackfill{repo: repo, bc: bc}
}

var _ CanvasNodeBackfiller = (*CanvasNodeBackfill)(nil)

// nodeWrite 记录一次写回的结果：revision 前后的值与改动，用于推 canvas.patch。
type nodeWrite struct {
	before   uint64
	revision uint64
	changes  []canvasgraph.Change
}

// BackfillNode 把任务终态写进节点。任何失败只返回错误，由调用方记账，不影响已经结算的任务。
func (s *CanvasNodeBackfill) BackfillNode(ctx context.Context, task *model.GenerationTask, outputs []model.TaskOutput) error {
	if s == nil || s.repo == nil || task == nil || task.IsTest || task.CanvasProjectID == nil || task.NodeID == "" {
		return nil
	}
	if !model.IsTerminalStatus(task.Status) {
		return nil
	}
	// 营销脚本与短剧片段的节点 id 是带前缀的虚拟节点，各自的观察者负责写回。
	if strings.HasPrefix(task.NodeID, model.MarketingNodePrefix) || strings.HasPrefix(task.NodeID, "seg:") {
		return nil
	}
	canvasID := *task.CanvasProjectID

	out, err := s.write(ctx, task, outputs, canvasID)
	if err != nil {
		return err
	}
	if len(out.changes) > 0 {
		PublishCanvasPatch(ctx, s.bc, task.UserID, CanvasPatch{
			CanvasID: canvasID, Kind: string(task.Kind),
			RevisionBefore: out.before, RevisionAfter: out.revision, Changes: out.changes,
		})
	}
	return nil
}

// write 在最新画布上重读重放，最多三次；每次都用最新的 revision 做 CAS。
func (s *CanvasNodeBackfill) write(
	ctx context.Context, task *model.GenerationTask, outputs []model.TaskOutput, canvasID uint64,
) (nodeWrite, error) {
	var zero nodeWrite
	for range 3 {
		cv, err := s.repo.GetByID(ctx, task.UserID, canvasID)
		if errors.Is(err, repository.ErrNotFound) {
			return zero, nil // 画布被删了，没什么可写
		}
		if err != nil {
			return zero, err
		}
		if cv.DramaID != nil {
			return zero, nil // 短剧画布由片段服务写回
		}
		g, err := canvasgraph.Parse(cv.PayloadJSON)
		if err != nil {
			return zero, err
		}
		out := nodeWrite{before: cv.Revision, revision: cv.Revision}

		// 先深拷贝：Node.Data() 返回底层 map 的引用，直接改会让 Diff 恒为空。
		g2 := g.Clone()
		node := g2.Node(task.NodeID)
		if node == nil {
			return zero, nil // 节点已被删除
		}
		if !applyTaskToNode(node.Data(), task, outputs, time.Now().UnixMilli()) {
			return out, nil
		}
		out.changes = canvasgraph.Diff(g, g2)
		if len(out.changes) == 0 {
			return out, nil
		}
		payload, err := g2.Marshal()
		if err != nil {
			return zero, err
		}
		if _, err := s.repo.Update(ctx, task.UserID, canvasID, cv.Revision, map[string]any{"payload_json": payload}); err != nil {
			if errors.Is(err, repository.ErrRevisionConflict) {
				continue // 读-改-写重放
			}
			return zero, err
		}
		out.revision = cv.Revision + 1
		return out, nil
	}
	// 三次都撞上用户的保存：放弃这次写回，不能覆盖别人刚存的内容。
	logger.Warn("写回画布节点放弃：版本连续冲突", logger.GenRun(task.ID), zap.String("node", task.NodeID))
	return zero, nil
}

// applyTaskToNode 按任务终态改节点，返回是否真的改了。
// 规则与前端 utils/tasks/backfill.ts 的 planMediaBackfill 保持一致，两边不能各写一套。
func applyTaskToNode(d map[string]any, task *model.GenerationTask, outputs []model.TaskOutput, now int64) bool {
	taskKey := strconv.FormatUint(task.ID, 10)
	switch task.Status {
	case model.TaskSucceeded:
		fresh := taskNodeOutputs(task, outputs, now)
		if len(fresh) == 0 {
			return false // 没有可用产物：不回填，也不把节点标成成功
		}
		existing, known := readNodeOutputs(d)
		added := make([]any, 0, len(fresh))
		for _, item := range fresh {
			if known[str(item["id"])] {
				continue
			}
			added = append(added, item)
		}
		changed := false
		if len(added) > 0 {
			d["outputs"] = append(existing, added...)
			first := added[0].(map[string]any)
			// 节点还没有当前版本时，首个新产物成为当前版本；已有版本的只进历史，不改用户的选择。
			if str(d["assetId"]) == "" {
				d["src"] = first["src"]
				d["assetId"] = first["id"]
				d["activeOutputId"] = first["id"]
				d["mediaType"] = first["mediaType"]
				d["mediaAspect"] = first["mediaAspect"]
			}
			d["status"] = "done"
			d["error"] = nil
			d["uploaded"] = false
			changed = true
		}
		if str(d["taskId"]) != taskKey {
			d["taskId"] = taskKey // 让前端下次打开画布时能认领这个任务，不再重复推演
			changed = true
		}
		return changed

	case model.TaskFailed, model.TaskExpired:
		if str(d["status"]) == "done" {
			return false // 已经有结果：不把节点打回失败态（同前端）
		}
		msg := task.ErrorMessage
		if msg == "" {
			if task.Status == model.TaskExpired {
				msg = "生成超时"
			} else {
				msg = "生成失败"
			}
		}
		if str(d["status"]) == "error" && str(d["error"]) == msg && str(d["taskId"]) == taskKey {
			return false
		}
		d["status"] = "error"
		d["error"] = msg
		d["taskId"] = taskKey
		return true

	case model.TaskCanceled:
		if str(d["status"]) == "done" {
			return false
		}
		if str(d["status"]) == "idle" && d["taskId"] == nil {
			return false
		}
		d["status"] = "idle"
		d["error"] = nil
		delete(d, "taskId")
		return true
	}
	return false
}

// taskNodeOutputs 把任务产物转成节点里的版本条目；缺素材 id 或地址的成员跳过（同前端）。
func taskNodeOutputs(task *model.GenerationTask, outputs []model.TaskOutput, now int64) []map[string]any {
	out := make([]map[string]any, 0, len(outputs))
	for _, o := range outputs {
		if o.AssetID == 0 || o.URL == "" {
			continue
		}
		id := strconv.FormatUint(o.AssetID, 10)
		mediaType := o.MediaType
		if mediaType == "" {
			mediaType = string(task.Kind)
		}
		item := map[string]any{
			"id": id, "assetId": id, "src": o.URL,
			"mediaType": mediaType, "taskId": strconv.FormatUint(task.ID, 10),
			"model": task.ModelKey, "createdAt": now,
		}
		if o.Width > 0 && o.Height > 0 {
			item["width"] = o.Width
			item["height"] = o.Height
			item["mediaAspect"] = float64(o.Width) / float64(o.Height)
		}
		if o.DurationMs > 0 {
			item["durationMs"] = o.DurationMs
		}
		out = append(out, item)
	}
	return out
}

// readNodeOutputs 读出节点已有的版本列表与它们的 id 集合，用于去重。
// 画布内容来自 JSON 解析，数组元素是 map[string]any；老节点可能只有 src + assetId，这里不造版本。
func readNodeOutputs(d map[string]any) ([]any, map[string]bool) {
	known := map[string]bool{}
	raw, ok := d["outputs"].([]any)
	if !ok {
		return nil, known
	}
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if id := str(m["id"]); id != "" {
			known[id] = true
		}
	}
	return raw, known
}

// str 取 map 里的字符串值，非字符串一律当空串。
func str(v any) string {
	s, _ := v.(string)
	return s
}
