package canvasgraph

import "fmt"

// DeleteNodes 删除若干普通节点，并清理指向它们的连线、分镜挂接与成片段落顺序。
//
// 语义与前端删除节点一致：节点没了，连着它的线不会留下；分镜表里指向它的
// imageNodeId / videoNodeId 一并清空，成片节点的 composeOrder 里也去掉它。
// 否则会留下「指向不存在节点的字段」，成片与生成都会踩空。
//
// 组不在这里删：组里可能还有成员，一次删除会静默拆散整组；需要时先移出成员再删。
func DeleteNodes(g *Graph, ids []string) (*Result, error) {
	if len(ids) == 0 {
		return nil, fmt.Errorf("deleteNodeIds 不能为空")
	}
	after := g.Clone()
	drop := make(map[string]bool, len(ids))
	for _, id := range ids {
		n := after.Node(id)
		if n == nil {
			return nil, fmt.Errorf("节点不存在：%s", id)
		}
		if n.IsGroup() {
			return nil, fmt.Errorf("不能删除组 %s：先把成员移出组，或在前端删除", id)
		}
		drop[id] = true
	}

	nodes := make([]Node, 0, len(after.Nodes))
	for _, n := range after.Nodes {
		if drop[n.ID()] {
			continue
		}
		nodes = append(nodes, n)
	}
	after.Nodes = nodes

	edges := make([]Edge, 0, len(after.Edges))
	for _, e := range after.Edges {
		if drop[e.Source()] || drop[e.Target()] {
			continue
		}
		edges = append(edges, e)
	}
	after.Edges = edges

	// 剩下的节点里可能还引用了被删的节点：分镜挂接与成片顺序都要跟着清。
	for _, n := range after.Nodes {
		clearShotRefs(n, drop)
		clearComposeOrder(n, drop)
	}
	return finish(g, after, nil), nil
}

// clearShotRefs 清掉分镜表里指向被删节点的挂接字段。
func clearShotRefs(n Node, drop map[string]bool) {
	board, ok := n.Data()["storyboard"].(map[string]any)
	if !ok {
		return
	}
	shots, ok := board["shots"].([]any)
	if !ok {
		return
	}
	for _, raw := range shots {
		shot, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"imageNodeId", "videoNodeId"} {
			if id, _ := shot[key].(string); id != "" && drop[id] {
				delete(shot, key)
			}
		}
	}
}

// clearComposeOrder 把被删的视频从成片段落顺序里去掉；全被删完就不再写这个字段。
func clearComposeOrder(n Node, drop map[string]bool) {
	order, ok := n.Data()["composeOrder"].([]any)
	if !ok {
		return
	}
	kept := make([]any, 0, len(order))
	for _, raw := range order {
		if id, _ := raw.(string); drop[id] {
			continue
		}
		kept = append(kept, raw)
	}
	if len(kept) == 0 {
		delete(n.Data(), "composeOrder")
		return
	}
	n.Data()["composeOrder"] = kept
}
