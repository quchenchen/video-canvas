package plugin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"video-canvas/internal/provider"
	"video-canvas/internal/provider/modelcfg"
	"video-canvas/internal/provider/plugin"
)

// fakeAssetURIs 模拟虚拟人像库：只有登记过的素材才返回资产 URI，其余落回普通 URL。
type fakeAssetURIs struct {
	known map[uint64]string
	calls int
}

func (f *fakeAssetURIs) AssetURI(_ context.Context, userID, assetID uint64, modelKey string) (string, bool) {
	f.calls++
	if userID != 9 || modelKey != "test-model" {
		return "", false
	}
	uri, ok := f.known[assetID]
	return uri, ok
}

const refPlugin = `
module.exports = {
  buildSubmitRequest: function(ctx) {
    return {method: "POST", path: "/run", json: {images: ctx.input.images.map(function(ref) {
      return {type: "image_url", image_url: {url: {__fileRef: ref, as: "url"}}};
    })}};
  },
  parseSubmitResponse: function(ctx) { return {immediate: {status: "succeeded", outputs: [{type: "url", url: ctx.channel.baseUrl + "/o.png"}]}}; }
};`

func filedSnap(baseURL string, enabled bool) *provider.Snapshot {
	snap := imageSnap(baseURL, refPlugin)
	snap.Model.Capabilities.Filing = &modelcfg.FilingSpec{Enabled: enabled, GroupID: "group-1", ProjectName: "zhongzuo"}
	return snap
}

// 已备案素材在开启了备案能力的模型上换成 asset:// 引用；其余素材、未开备案的模型仍走普通 URL。
func TestFilingAssetURIReplacesOnlyFiledAssets(t *testing.T) {
	var got map[string][]map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	assets := &fakeAssets{userID: 9, files: map[uint64][]byte{5: []byte("A"), 6: []byte("B")}}
	uris := &fakeAssetURIs{known: map[uint64]string{5: "asset://asset-20261118161117-drkx8"}}
	exec := execWith(refPlugin, func(o *plugin.Options) { o.Assets = assets; o.AssetURIs = uris })

	submitImages := func(snap *provider.Snapshot) []map[string]any {
		got = nil
		if _, err := exec.Submit(context.Background(), snap, provider.SubmitInput{
			Task:  provider.TaskRef{ID: 1, UserID: 9},
			Input: map[string]any{"prompt": "x", "op": "i2i", "images": []uint64{5, 6}},
		}); err != nil {
			t.Fatal(err)
		}
		return got["images"]
	}

	urlOf := func(item map[string]any) string {
		inner, _ := item["image_url"].(map[string]any)
		return inner["url"].(string)
	}

	// 开备案：素材 5 已备案 → asset://；素材 6 没备案 → 普通 URL；命中时不打开文件（省一次读取）。
	items := submitImages(filedSnap(upstream.URL, true))
	if len(items) != 2 || urlOf(items[0]) != "asset://asset-20261118161117-drkx8" || urlOf(items[1]) != "https://cdn.example.com/a.png" {
		t.Fatalf("已备案素材应换成 asset://，未备案仍用 URL：%v", items)
	}

	// 关备案：即使素材登记过也不能换成 asset://（模型的素材体系不同）。
	uris.calls = 0
	items = submitImages(filedSnap(upstream.URL, false))
	if len(items) != 2 || urlOf(items[0]) != "https://cdn.example.com/a.png" || urlOf(items[1]) != "https://cdn.example.com/a.png" {
		t.Fatalf("未开备案能力时不应注入 asset://：%v", items)
	}
	if uris.calls != 0 {
		t.Fatalf("未开备案能力时不该查询备案：calls=%d", uris.calls)
	}
}

// 宿主没配备案服务（AssetURIs 为空）时行为与改动前一致，所有引用都是普通 URL。
func TestFilingAssetURIAbsentKeepsURL(t *testing.T) {
	var got map[string][]map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	assets := &fakeAssets{userID: 9, files: map[uint64][]byte{5: []byte("A")}}
	exec := execWith(refPlugin, func(o *plugin.Options) { o.Assets = assets })
	if _, err := exec.Submit(context.Background(), filedSnap(upstream.URL, true), provider.SubmitInput{
		Task:  provider.TaskRef{ID: 1, UserID: 9},
		Input: map[string]any{"prompt": "x", "op": "i2i", "images": []uint64{5}},
	}); err != nil {
		t.Fatal(err)
	}
	inner, _ := got["images"][0]["image_url"].(map[string]any)
	if inner["url"] != "https://cdn.example.com/a.png" {
		t.Fatalf("没配备案服务应保持 URL：%v", inner["url"])
	}
}
