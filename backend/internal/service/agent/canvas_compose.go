package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"video-canvas/internal/agent/canvasgraph"
	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/idcodec"
)

// 合成的等待策略：提交后在这个上限内等成品，超时就把「还在合成」交给模型，让它过一会儿再查。
// 不下发 longWait：工具调用走的是 Agent 服务的普通 /tools 请求，一次等太久会撞上它的请求超时。
const (
	composeWait = 2 * time.Minute
	composePoll = 2 * time.Second
)

// AgentCompose 是画布成片合成能力：提交、按 id 查任务、查节点上的活跃 / 最近任务。
// *service.CanvasComposeService 实现它。
type AgentCompose interface {
	Submit(ctx context.Context, userID, canvasID uint64, req *model.CanvasComposeReq) (*model.CanvasComposeResp, error)
	Job(ctx context.Context, userID, jobID uint64) (*model.CanvasComposeResp, error)
	Active(ctx context.Context, userID, canvasID uint64, nodeID string, currentAssetIDs []string) (*model.CanvasComposeResp, error)
}

// ComposePlan 算一个节点现在要拼什么：成片节点看连进来的视频，分镜表看镜头行序绑定的视频。
// 顺序规则与界面同源（composeOrder 优先，其余按画布位置），模型不用也不该自己算素材 id。
func (s *AgentCanvasService) ComposePlan(ctx context.Context, run *model.AgentRun, nodeID string) (*canvasgraph.ComposePlan, error) {
	g, _, err := s.load(ctx, run)
	if err != nil {
		return nil, err
	}
	return canvasgraph.ComposePlanOf(g, nodeID)
}

// toolCompose 把成片节点（或分镜表）里的视频拼成一条 mp4 并挂回节点。
// 素材序列由画布现算：模型看不到素材 id，也不该由它拼。
func (b *AgentBridge) toolCompose(ctx context.Context, tc *toolCall) (*toolOut, error) {
	var a struct {
		NodeID string `json:"nodeId"`
		Action string `json:"action"`
	}
	if err := json.Unmarshal(tc.args, &a); err != nil {
		return nil, fail("参数格式不对：%v", err)
	}
	if b.d.Compose == nil || b.d.Canvas == nil {
		return nil, fail("暂时不能合成成片")
	}
	if a.NodeID == "" {
		return nil, fail("需要 nodeId：成片合成节点（kind 为 compose）或分镜表的节点 id")
	}
	plan, err := b.d.Canvas.ComposePlan(ctx, tc.run, a.NodeID)
	if err != nil {
		return nil, fail("%v", err)
	}
	ids := plan.AssetIDs()
	if a.Action == "check" {
		return b.composeCheck(ctx, tc, plan, ids)
	}
	if len(ids) == 0 {
		return nil, fail("这个节点还没有可拼的视频：%d 段全部没出片", len(plan.Segments))
	}
	// 同一节点已经有任务在跑就直接等它；同样素材、同样顺序已经出过片就不重复合成
	if cur, err := b.d.Compose.Active(ctx, tc.run.UserID, tc.run.CanvasID, plan.NodeID, ids); err == nil && cur != nil {
		switch cur.Status {
		case model.ComposeJobQueued, model.ComposeJobRunning:
			return b.composeWaitFor(ctx, tc, cur, plan)
		case model.ComposeJobSucceeded:
			if cur.Stale != nil && !*cur.Stale {
				return b.composeOut(cur, plan, true)
			}
		}
	}
	mode := "compose"
	if plan.Kind == canvasgraph.KindStoryboard {
		mode = "storyboard"
	}
	job, err := b.d.Compose.Submit(ctx, tc.run.UserID, tc.run.CanvasID, &model.CanvasComposeReq{
		NodeID: plan.NodeID, AssetIDs: ids, Mode: mode,
	})
	if err != nil {
		var ec *errcode.Error
		if errors.As(err, &ec) && ec.Code == errcode.ErrCanvasComposeBusy.Code {
			// 刚好被用户在界面上抢了先：转成等待那条任务，不重复提交
			cur, aerr := b.d.Compose.Active(ctx, tc.run.UserID, tc.run.CanvasID, plan.NodeID, ids)
			if aerr == nil && cur != nil {
				return b.composeWaitFor(ctx, tc, cur, plan)
			}
		}
		return nil, fail("%v", err)
	}
	return b.composeWaitFor(ctx, tc, job, plan)
}

// composeCheck 查节点上的合成状态：进行中的优先，没有就报最近一次。
func (b *AgentBridge) composeCheck(ctx context.Context, tc *toolCall, plan *canvasgraph.ComposePlan, ids []string) (*toolOut, error) {
	cur, err := b.d.Compose.Active(ctx, tc.run.UserID, tc.run.CanvasID, plan.NodeID, ids)
	if err != nil {
		return nil, err
	}
	if cur == nil {
		return nil, fail("这个节点还没有合成过成片")
	}
	return b.composeOut(cur, plan, false)
}

// composeWaitFor 等到任务落终态或超时；超时不是失败，把进行中的状态如实回给模型。
func (b *AgentBridge) composeWaitFor(ctx context.Context, tc *toolCall, job *model.CanvasComposeResp, plan *canvasgraph.ComposePlan) (*toolOut, error) {
	id, ok := idcodec.Decode(job.ID)
	if !ok {
		return nil, fail("合成任务 id 不对：%q", job.ID)
	}
	cur := job
	deadline := time.Now().Add(composeWait)
	for composeActive(cur.Status) {
		if time.Now().After(deadline) {
			return b.composeOut(cur, plan, false)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(composePoll):
		}
		next, err := b.d.Compose.Job(ctx, tc.run.UserID, id)
		if err != nil {
			return nil, fail("查合成任务失败：%v", err)
		}
		if next != nil {
			cur = next
		}
	}
	return b.composeOut(cur, plan, false)
}

// composeActive 判断任务是不是还没落终态。
func composeActive(status string) bool {
	return status == model.ComposeJobQueued || status == model.ComposeJobRunning
}

// composeOut 把任务状态转成给模型看的结果：只说状态、段数、时长和没出片的段号，
// 素材 id 和地址是用户的私有资源，不进模型上下文。
func (b *AgentBridge) composeOut(job *model.CanvasComposeResp, plan *canvasgraph.ComposePlan, reused bool) (*toolOut, error) {
	out := map[string]any{
		"status":   job.Status,
		"segments": job.SegmentCount,
		"node_id":  job.NodeID,
	}
	if job.DurationMS > 0 {
		out["duration_ms"] = job.DurationMS
		out["seconds"] = float64(job.DurationMS) / 1000
	}
	if len(plan.Missing) > 0 {
		out["skipped"] = plan.Missing // 段号从 0 起：没出片、这次跳过的段
	}
	if job.Error != "" {
		out["error"] = job.Error
	}
	if reused {
		out["reused"] = true // 同样素材同样顺序已经有成片，没有重新拼
	}
	content, err := jsonOut(out)
	if err != nil {
		return nil, err
	}
	summary := "合成成片：" + job.Status
	switch job.Status {
	case model.ComposeJobSucceeded:
		summary = fmt.Sprintf("合成成片完成（%d 段 %s）", job.SegmentCount, composeSeconds(job.DurationMS))
	case model.ComposeJobFailed:
		summary = "合成成片失败"
	case model.ComposeJobQueued, model.ComposeJobRunning:
		summary = "合成成片中"
	}
	return &toolOut{content: content, summary: summary, extra: map[string]any{"node_ids": []string{job.NodeID}}}, nil
}

// composeSeconds 把毫秒说成「33 秒」这种给人看的时长，工具摘要用。
func composeSeconds(ms int64) string {
	if ms <= 0 {
		return "0 秒"
	}
	return fmt.Sprintf("%.1f 秒", float64(ms)/1000)
}
