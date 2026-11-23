package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	. "video-canvas/internal/service"

	"video-canvas/internal/model"
	"video-canvas/internal/repository"
)

// fakeCanvasNodeRepo 是回写用的最小画布存储：内存里保存 payload 与 revision，可以让前 N 次写入返回冲突。
type fakeCanvasNodeRepo struct {
	payload      []byte
	revision     uint64
	dramaID      *uint64
	conflictOnce int
	writes       int
}

func (f *fakeCanvasNodeRepo) GetByID(_ context.Context, _, _ uint64) (*model.CanvasProject, error) {
	if f.payload == nil {
		return nil, repository.ErrNotFound
	}
	return &model.CanvasProject{
		UserID: 1, DramaID: f.dramaID, PayloadJSON: f.payload, Revision: f.revision,
	}, nil
}

func (f *fakeCanvasNodeRepo) Update(_ context.Context, _, _ uint64, revision uint64, fields map[string]any) (*model.CanvasProject, error) {
	if f.conflictOnce > 0 {
		f.conflictOnce--
		return nil, repository.ErrRevisionConflict
	}
	if revision != f.revision {
		return nil, repository.ErrRevisionConflict
	}
	raw, _ := fields["payload_json"].([]byte)
	if raw == nil {
		return nil, errors.New("payload_json 不是字节")
	}
	f.payload = raw
	f.revision++
	f.writes++
	return &model.CanvasProject{UserID: 1, Revision: f.revision}, nil
}

// nodeOf 取出写回后节点里的 map。
func nodeOf(t *testing.T, payload []byte, id string) map[string]any {
	t.Helper()
	var doc struct {
		Nodes []struct {
			ID   string         `json:"id"`
			Data map[string]any `json:"data"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatalf("解析画布失败: %v", err)
	}
	for _, n := range doc.Nodes {
		if n.ID == id {
			return n.Data
		}
	}
	t.Fatalf("节点 %s 不存在", id)
	return nil
}

func imageTask(status string) (*model.GenerationTask, uint64) {
	canvasID := uint64(7)
	return &model.GenerationTask{
		ID: 42, UserID: 1, CanvasProjectID: &canvasID, NodeID: "n1",
		Kind: model.KindImage, Status: status, ModelKey: "img-model",
	}, canvasID
}

func imageOutputs() []model.TaskOutput {
	return []model.TaskOutput{{AssetID: 933, URL: "https://x/933.png", MediaType: "image", Width: 2624, Height: 1472}}
}

func newRepoWithNode() *fakeCanvasNodeRepo {
	return &fakeCanvasNodeRepo{
		revision: 1,
		payload:  []byte(`{"nodes":[{"id":"n1","data":{"kind":"image","label":"S01"}}],"edges":[]}`),
	}
}

// 成功：产物落进节点，当前版本指向它，taskId 写下来（前端据此认领，不再重复推演）。
func TestBackfillNodeWritesOutputs(t *testing.T) {
	repo := newRepoWithNode()
	bf := NewCanvasNodeBackfill(repo, nil)
	task, _ := imageTask(model.TaskSucceeded)

	if err := bf.BackfillNode(context.Background(), task, imageOutputs()); err != nil {
		t.Fatalf("回写失败: %v", err)
	}
	d := nodeOf(t, repo.payload, "n1")
	if d["assetId"] != "933" || d["activeOutputId"] != "933" {
		t.Fatalf("当前版本不对: %v", d)
	}
	if d["status"] != "done" || d["taskId"] != "42" {
		t.Fatalf("状态或任务号不对: %v", d)
	}
	if outs, ok := d["outputs"].([]any); !ok || len(outs) != 1 {
		t.Fatalf("产物版本没有写进节点: %v", d["outputs"])
	}
	if repo.revision != 2 {
		t.Fatalf("revision 应 +1，实际 %d", repo.revision)
	}
}

// 幂等：同一个任务再来一次不重复追加，也不再写库。
func TestBackfillNodeIsIdempotent(t *testing.T) {
	repo := newRepoWithNode()
	bf := NewCanvasNodeBackfill(repo, nil)
	task, _ := imageTask(model.TaskSucceeded)

	if err := bf.BackfillNode(context.Background(), task, imageOutputs()); err != nil {
		t.Fatalf("第一次回写失败: %v", err)
	}
	before := repo.revision
	if err := bf.BackfillNode(context.Background(), task, imageOutputs()); err != nil {
		t.Fatalf("第二次回写失败: %v", err)
	}
	if repo.revision != before {
		t.Fatalf("重复回写不该再写库：%d → %d", before, repo.revision)
	}
	if outs := nodeOf(t, repo.payload, "n1")["outputs"].([]any); len(outs) != 1 {
		t.Fatalf("产物被重复追加: %d", len(outs))
	}
}

// 已有结果的节点不因任务失败被打回 error（同前端规则）。
func TestBackfillNodeKeepsDoneOnFailure(t *testing.T) {
	repo := newRepoWithNode()
	bf := NewCanvasNodeBackfill(repo, nil)
	ok, _ := imageTask(model.TaskSucceeded)
	if err := bf.BackfillNode(context.Background(), ok, imageOutputs()); err != nil {
		t.Fatalf("回写失败: %v", err)
	}
	bad, _ := imageTask(model.TaskFailed)
	bad.ErrorMessage = "上游限流"
	if err := bf.BackfillNode(context.Background(), bad, nil); err != nil {
		t.Fatalf("失败回写报错: %v", err)
	}
	if d := nodeOf(t, repo.payload, "n1"); d["status"] != "done" || d["error"] != nil {
		t.Fatalf("已有结果被改写: %v", d)
	}
}

// 失败写原因；取消回 idle 并清掉 taskId。
func TestBackfillNodeFailureAndCancel(t *testing.T) {
	repo := newRepoWithNode()
	bf := NewCanvasNodeBackfill(repo, nil)
	bad, _ := imageTask(model.TaskFailed)
	bad.ErrorMessage = "上游限流"
	if err := bf.BackfillNode(context.Background(), bad, nil); err != nil {
		t.Fatalf("失败回写报错: %v", err)
	}
	if d := nodeOf(t, repo.payload, "n1"); d["status"] != "error" || d["error"] != "上游限流" {
		t.Fatalf("失败状态没写对: %v", d)
	}

	canceled, _ := imageTask(model.TaskCanceled)
	if err := bf.BackfillNode(context.Background(), canceled, nil); err != nil {
		t.Fatalf("取消回写报错: %v", err)
	}
	d := nodeOf(t, repo.payload, "n1")
	if d["status"] != "idle" {
		t.Fatalf("取消后应是 idle: %v", d)
	}
	if _, has := d["taskId"]; has {
		t.Fatalf("取消后应清掉 taskId: %v", d)
	}
}

// 短剧画布由片段服务写回，这里必须让路，否则同一节点会被写两遍。
func TestBackfillNodeSkipsDramaCanvas(t *testing.T) {
	repo := newRepoWithNode()
	dramaID := uint64(9)
	repo.dramaID = &dramaID
	bf := NewCanvasNodeBackfill(repo, nil)
	task, _ := imageTask(model.TaskSucceeded)

	if err := bf.BackfillNode(context.Background(), task, imageOutputs()); err != nil {
		t.Fatalf("回写报错: %v", err)
	}
	if repo.writes != 0 {
		t.Fatalf("短剧画布不该被写，实际写了 %d 次", repo.writes)
	}
}

// 撞上用户保存：重读重放后仍能写进去，不覆盖别人的内容。
func TestBackfillNodeRetriesOnConflict(t *testing.T) {
	repo := newRepoWithNode()
	repo.conflictOnce = 1
	bf := NewCanvasNodeBackfill(repo, nil)
	task, _ := imageTask(model.TaskSucceeded)

	if err := bf.BackfillNode(context.Background(), task, imageOutputs()); err != nil {
		t.Fatalf("回写报错: %v", err)
	}
	if repo.writes != 1 {
		t.Fatalf("冲突后应重放成功，实际写入 %d 次", repo.writes)
	}
	if d := nodeOf(t, repo.payload, "n1"); d["assetId"] != "933" {
		t.Fatalf("重放后产物没写进去: %v", d)
	}
}

// 节点已被删除：不写库，也不报错。
func TestBackfillNodeMissingNode(t *testing.T) {
	repo := newRepoWithNode()
	bf := NewCanvasNodeBackfill(repo, nil)
	task, _ := imageTask(model.TaskSucceeded)
	task.NodeID = "gone"

	if err := bf.BackfillNode(context.Background(), task, imageOutputs()); err != nil {
		t.Fatalf("回写报错: %v", err)
	}
	if repo.writes != 0 {
		t.Fatalf("节点不存在时不该写库，实际 %d 次", repo.writes)
	}
}
