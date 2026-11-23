package canvasgraph_test

import (
	"strings"
	"testing"

	"video-canvas/internal/agent/canvasgraph"
)

// deleteGraph 一张带分镜挂接、成片顺序和组的画布：删一个视频节点要同时清理三处引用。
func deleteGraph(t *testing.T) *canvasgraph.Graph {
	t.Helper()
	raw := `{
		"nodes":[
			{"id":"n_sb","type":"canvas","data":{"kind":"storyboard","storyboard":{"shots":[
				{"scene":"风机全景","videoNodeId":"n_v1","imageNodeId":"n_i1"},
				{"scene":"升压站","videoNodeId":"n_v2"}
			]}}},
			{"id":"n_v1","type":"canvas","data":{"kind":"video","label":"镜头1"}},
			{"id":"n_v2","type":"canvas","data":{"kind":"video","label":"镜头2"}},
			{"id":"n_i1","type":"canvas","data":{"kind":"image","label":"关键帧1"}},
			{"id":"n_cp","type":"canvas","data":{"kind":"compose","composeOrder":["n_v2","n_v1"]}},
			{"id":"g1","type":"group","data":{}}
		],
		"edges":[
			{"id":"e1","source":"n_v1","target":"n_cp"},
			{"id":"e2","source":"n_v2","target":"n_cp"},
			{"id":"e3","source":"n_sb","target":"n_v1"}
		]
	}`
	g, err := canvasgraph.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestDeleteNodesCleansEdgesShotsAndComposeOrder(t *testing.T) {
	g := deleteGraph(t)
	res, err := canvasgraph.DeleteNodes(g, []string{"n_v1"})
	if err != nil {
		t.Fatal(err)
	}
	after := res.Graph

	if after.Node("n_v1") != nil {
		t.Fatal("被删节点还在图上")
	}
	if len(after.Nodes) != 5 {
		t.Fatalf("节点数应为 5，实际 %d", len(after.Nodes))
	}
	// 只留下 n_v2 → n_cp 那条；另两条一头挂着被删节点
	if len(after.Edges) != 1 || after.Edges[0].ID() != "e2" {
		t.Fatalf("连线未正确清理：%v", after.Edges)
	}

	shots, _ := after.Node("n_sb").Data()["storyboard"].(map[string]any)["shots"].([]any)
	first, _ := shots[0].(map[string]any)
	if _, ok := first["videoNodeId"]; ok {
		t.Fatal("分镜第一行的 videoNodeId 应被清空")
	}
	if first["imageNodeId"] != "n_i1" {
		t.Fatalf("无关的 imageNodeId 不该被动：%v", first["imageNodeId"])
	}
	second, _ := shots[1].(map[string]any)
	if second["videoNodeId"] != "n_v2" {
		t.Fatalf("其它镜头的挂接不该被动：%v", second["videoNodeId"])
	}

	order, _ := after.Node("n_cp").Data()["composeOrder"].([]any)
	if len(order) != 1 || order[0] != "n_v2" {
		t.Fatalf("成片顺序未清理：%v", order)
	}

	// 差异必须能报到调用方：这正是给用户确认的那份改动
	var deleted int
	for _, c := range res.Changes {
		if c.Op == canvasgraph.ChangeDelete {
			deleted++
		}
	}
	if deleted != 3 { // 1 个节点 + 2 条连线
		t.Fatalf("删除项应为 3，实际 %d：%+v", deleted, res.Changes)
	}
	// 原图不能被改：CLI 在确认前后都可能重新读它
	if g.Node("n_v1") == nil || len(g.Edges) != 3 {
		t.Fatal("DeleteNodes 修改了入参图")
	}
}

func TestDeleteNodesRejectsMissingAndGroup(t *testing.T) {
	if _, err := canvasgraph.DeleteNodes(deleteGraph(t), []string{"n_nope"}); err == nil ||
		!strings.Contains(err.Error(), "节点不存在") {
		t.Fatalf("删不存在的节点应报错：%v", err)
	}
	if _, err := canvasgraph.DeleteNodes(deleteGraph(t), []string{"g1"}); err == nil ||
		!strings.Contains(err.Error(), "不能删除组") {
		t.Fatalf("删组应被拒绝：%v", err)
	}
	if _, err := canvasgraph.DeleteNodes(deleteGraph(t), nil); err == nil {
		t.Fatal("空 id 列表应报错")
	}
}

func TestDeleteNodesToleratesUnexpectedShotShape(t *testing.T) {
	// 手工编辑过的画布里 shots 可能不是数组；删除不能因此 panic
	g, err := canvasgraph.Parse([]byte(`{"nodes":[
		{"id":"a","type":"canvas","data":{"kind":"video"}},
		{"id":"b","type":"canvas","data":{"kind":"storyboard","storyboard":{"shots":"oops"}}}
	],"edges":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := canvasgraph.DeleteNodes(g, []string{"a"}); err != nil {
		t.Fatalf("结构异常时不应报错：%v", err)
	}
}
