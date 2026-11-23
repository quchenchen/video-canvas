package handler_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/datatypes"

	. "video-canvas/internal/handler"
	"video-canvas/internal/middleware"
	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/idcodec"
	"video-canvas/internal/service"
)

// newCanvasOpsRouter 只挂节点级编辑端点，鉴权用测试中间件注入用户 1。
func newCanvasOpsRouter() (*gin.Engine, *fakeCanvasRepo) {
	repo := &fakeCanvasRepo{items: map[uint64]*model.CanvasProject{}}
	h := NewCanvasOpsHandler(service.NewCanvasProjectService(repo))
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set(middleware.CtxUserIDKey, uint(1)); c.Next() })
	r.POST("/api/v1/canvas/:id/ops", h.Apply)
	return r, repo
}

func opsCanvas(t *testing.T, repo *fakeCanvasRepo, payload string) {
	t.Helper()
	repo.items[1] = &model.CanvasProject{
		BaseModel: model.BaseModel{ID: 1}, UserID: 1, Title: "画布",
		PayloadJSON: datatypes.JSON(payload), Revision: 3,
	}
}

func TestCanvasOps_AddNode(t *testing.T) {
	r, repo := newCanvasOpsRouter()
	opsCanvas(t, repo, `{"nodes":[],"edges":[]}`)

	status, resp := canvasCall(t, r, http.MethodPost, "/api/v1/canvas/"+idcodec.Encode(1)+"/ops",
		`{"revision":3,"ops":[{"op":"create_node","tempId":"a","kind":"script","label":"新旁白","prompt":"第一句"}]}`)
	if status != http.StatusOK {
		t.Fatalf("创建节点失败：%d %v", status, resp)
	}
	data := resp["data"].(map[string]any)
	if data["revision"] != float64(4) {
		t.Fatalf("revision 应 +1：%v", data["revision"])
	}
	if len(data["changes"].([]any)) == 0 {
		t.Fatal("应返回改动差异，供人确认")
	}
	if repo.items[1].Revision != 4 {
		t.Fatal("画布未落库")
	}
}

func TestCanvasOps_RevisionConflict(t *testing.T) {
	r, repo := newCanvasOpsRouter()
	opsCanvas(t, repo, `{"nodes":[],"edges":[]}`)

	status, resp := canvasCall(t, r, http.MethodPost, "/api/v1/canvas/"+idcodec.Encode(1)+"/ops",
		`{"revision":2,"ops":[{"op":"create_node","tempId":"a","kind":"script","label":"x"}]}`)
	if status != http.StatusConflict || resp["code"] != float64(errcode.ErrCanvasConflict.Code) {
		t.Fatalf("版本过期应 409：%d %v", status, resp)
	}
	if repo.items[1].Revision != 3 {
		t.Fatal("冲突时不能改动画布")
	}
}

func TestCanvasOps_DeleteNode(t *testing.T) {
	r, repo := newCanvasOpsRouter()
	opsCanvas(t, repo, `{"nodes":[
		{"id":"n_v","type":"canvas","data":{"kind":"video"}},
		{"id":"n_cp","type":"canvas","data":{"kind":"compose","composeOrder":["n_v"]}}
	],"edges":[{"id":"e1","source":"n_v","target":"n_cp"}]}`)

	status, resp := canvasCall(t, r, http.MethodPost, "/api/v1/canvas/"+idcodec.Encode(1)+"/ops",
		`{"revision":3,"deleteNodeIds":["n_v"]}`)
	if status != http.StatusOK {
		t.Fatalf("删除失败：%d %v", status, resp)
	}
	var payload struct {
		Nodes []map[string]any `json:"nodes"`
		Edges []map[string]any `json:"edges"`
	}
	if err := json.Unmarshal(repo.items[1].PayloadJSON, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Nodes) != 1 || len(payload.Edges) != 0 {
		t.Fatalf("节点与连线都应清理：%+v", payload)
	}
	if _, ok := payload.Nodes[0]["data"].(map[string]any)["composeOrder"]; ok {
		t.Fatal("成片顺序里的被删节点应清掉")
	}
}

func TestCanvasOps_RejectsAssetAndEmpty(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"按素材建节点", `{"revision":3,"ops":[{"op":"create_node","kind":"image","assetId":"911"}]}`},
		{"空操作", `{"revision":3}`},
		{"缺版本号", `{"ops":[{"op":"create_node","kind":"script","label":"x"}]}`},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			r, repo := newCanvasOpsRouter()
			opsCanvas(t, repo, `{"nodes":[],"edges":[]}`)
			status, resp := canvasCall(t, r, http.MethodPost,
				"/api/v1/canvas/"+idcodec.Encode(1)+"/ops", tt.body)
			if status != http.StatusBadRequest {
				t.Fatalf("应 400：%d %v", status, resp)
			}
			if repo.items[1].Revision != 3 {
				t.Fatal("拒绝的请求不能改动画布")
			}
		})
	}
}
