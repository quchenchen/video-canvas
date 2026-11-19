package plugin_test

import (
	"context"
	"net/http"
	"testing"

	"video-canvas/internal/provider"
	"video-canvas/internal/provider/plugin"
	"video-canvas/internal/provider/pluginrunner"
	"video-canvas/plugins"
)

// 本文件测试真人库备案素材的替换：插件在文件引用上写 filed: true，宿主把备案可用的图片换成 asset://<方舟素材 ID>。

// filedResolver 模拟真人库：只有 (用户, 素材, 渠道) 都对上才返回 asset://。
type filedResolver struct {
	userID  uint64
	channel string
	uris    map[uint64]string
	calls   int
}

func (r *filedResolver) FiledAssetURI(_ context.Context, userID, assetID uint64, channel provider.ChannelSnapshot) (string, bool) {
	r.calls++
	if userID != r.userID || channel.Key != r.channel {
		return "", false
	}
	uri, ok := r.uris[assetID]
	return uri, ok
}

func newFiledDoubaovideoEnv(t *testing.T, resolver provider.FiledAssetResolver) *doubaovideoEnv {
	t.Helper()
	env := newDoubaovideoEnv(t)
	src, _ := plugins.Source("doubao-video")
	runner := plugin.NewInProcessRunnerClient(pluginrunner.NewServer(pluginrunner.Options{}).Handler())
	env.exec = plugin.New(plugin.Options{
		Runner: runner, Codes: codeStore{"code": string(src)}, Secrets: secretResolver{value: "ark-key"},
		Assets:      &fakeAssets{userID: 9, files: map[uint64][]byte{1: []byte("a"), 2: []byte("b"), 3: []byte("c")}},
		FiledAssets: resolver, IPAllowed: allowLoopback,
	})
	return env
}

// 备案可用的图片换成 asset://，没备案的照常用签名地址；视频、音频参考不参与替换。
func TestDoubaovideoFiledAssetURI(t *testing.T) {
	srv, up := doubaovideoServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"t1"}`))
	})
	resolver := &filedResolver{userID: 9, channel: "doubao-video-main", uris: map[uint64]string{1: "asset://asset-1", 2: "asset://asset-2"}}
	env := newFiledDoubaovideoEnv(t, resolver)
	_, err := env.exec.Submit(context.Background(), env.snapshot(srv.URL, "video", "doubao-seedance-2-0-260128"), provider.SubmitInput{
		Task:  provider.TaskRef{ID: 1, UserID: 9},
		Input: map[string]any{"prompt": "p", "op": "omni", "images": []uint64{1, 3}, "videos": []uint64{2}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var urls []string
	for _, it := range up.last().Body["content"].([]any) {
		m := it.(map[string]any)
		for _, k := range []string{"image_url", "video_url"} {
			if v, ok := m[k].(map[string]any); ok {
				urls = append(urls, k+"="+v["url"].(string))
			}
		}
	}
	want := []string{"image_url=asset://asset-1", "image_url=" + doubaovideoRefURL, "video_url=" + doubaovideoRefURL}
	if len(urls) != len(want) {
		t.Fatalf("素材地址 = %v，期望 %v", urls, want)
	}
	for i := range want {
		if urls[i] != want[i] {
			t.Fatalf("素材地址 = %v，期望 %v", urls, want)
		}
	}
}

// 没有配置真人库（resolver 为空）时一律用签名地址，行为与之前一致。
func TestDoubaovideoFiledAssetWithoutResolver(t *testing.T) {
	srv, up := doubaovideoServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"t1"}`))
	})
	env := newFiledDoubaovideoEnv(t, nil)
	_, err := env.exec.Submit(context.Background(), env.snapshot(srv.URL, "video", "doubao-seedance-2-0-260128"), provider.SubmitInput{
		Task: provider.TaskRef{ID: 1, UserID: 9}, Input: map[string]any{"prompt": "p", "op": "i2v", "images": []uint64{1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	img := up.last().Body["content"].([]any)[1].(map[string]any)
	if u := img["image_url"].(map[string]any)["url"]; u != doubaovideoRefURL {
		t.Fatalf("没有 resolver 时应是签名地址：%v", u)
	}
}
