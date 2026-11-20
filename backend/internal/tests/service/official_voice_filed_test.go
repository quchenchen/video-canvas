package service_test

import (
	"context"
	"testing"

	. "video-canvas/internal/service"

	"video-canvas/internal/model"
	"video-canvas/internal/provider"
)

// fakeOfficialSource 实现官方素材查询：按 assetID 返回素材，查不到返回 ok=false。
type fakeOfficialSource struct {
	assets map[uint64]*model.Asset
}

func (f *fakeOfficialSource) OfficialAsset(_ context.Context, id uint64) (*model.Asset, bool) {
	a, ok := f.assets[id]
	return a, ok
}

// ch 组一个渠道快照：voiceScope 是渠道上显式声明的资源域，空表示按 base_url 推断。
func ch(key, baseURL, voiceScope string) provider.ChannelSnapshot {
	return provider.ChannelSnapshot{Key: key, BaseURL: baseURL, VoiceScope: voiceScope}
}

const (
	arkCN    = "https://ark.cn-beijing.volces.com"
	bytePlus = "https://ark.ap-southeast.bytepluses.com"
	proxy    = "https://gateway.example.com" // 自建代理：域名推断不出资源域
)

// 双轨核心：公开音色在所属资源域内走 asset://，跨域或来源不明时回退音频文件 URL。
// 公开音色是全平台公共素材，不受 userID 与真人库备案限制；但 asset-xxx 只在同一资源域有效。
func TestFiledAssetResolver_OfficialVoice(t *testing.T) {
	vh := newVHEnv(t)
	resolver := NewFiledAssetResolver(vh.repo)
	resolver.WithOfficialAssets(&fakeOfficialSource{assets: map[uint64]*model.Asset{
		100: {
			ID:              100,
			Source:          model.AssetSourceOfficial,
			OfficialAssetID: "asset-official-1",
			OfficialScope:   provider.ScopeArkCN,
		},
		101: {ID: 101, Source: model.AssetSourceUpload}, // 普通上传：没有官方 ID
	}})

	// 没声明、按域名推断为方舟国内站 → asset://
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 100, ch("seedance-ark-cn", arkCN, "")); !ok || uri != "asset://asset-official-1" {
		t.Fatalf("同域公开音色应返回 asset://，得到 %q ok=%v", uri, ok)
	}

	// 同域的另一条渠道（换 key 甚至重建渠道）仍然可用：判定看资源域，不看渠道行
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 100, ch("another-ark-channel", arkCN, "")); !ok || uri != "asset://asset-official-1" {
		t.Fatalf("同域换渠道仍应返回 asset://，得到 %q ok=%v", uri, ok)
	}

	// 跨域（国内音色发给 BytePlus）→ 不命中，回退文件 URL，否则上游报 asset not found
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 100, ch("seedance", bytePlus, "")); ok || uri != "" {
		t.Fatalf("跨域公开音色不该返回 asset://，得到 %q ok=%v", uri, ok)
	}

	// 来源未知（老数据没回填资源域）→ 一律不命中，宁可退化成文件 URL
	legacy := NewFiledAssetResolver(vh.repo)
	legacy.WithOfficialAssets(&fakeOfficialSource{assets: map[uint64]*model.Asset{
		102: {ID: 102, Source: model.AssetSourceOfficial, OfficialAssetID: "asset-official-2"},
	}})
	if uri, ok := legacy.FiledAssetURI(context.Background(), 42, 102, ch("seedance-ark-cn", arkCN, "")); ok || uri != "" {
		t.Fatalf("资源域未知的公开音色不该返回 asset://，得到 %q ok=%v", uri, ok)
	}

	// 普通音频 → 不命中，由执行器回退到签名 URL
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 101, ch("seedance-ark-cn", arkCN, "")); ok || uri != "" {
		t.Fatalf("普通素材不该命中 filed，得到 %q ok=%v", uri, ok)
	}
}

// 渠道显式声明资源域时以声明为准：自建代理把域名换成内网地址，照样能用上公开音色的 asset://。
func TestFiledAssetResolver_ChannelDeclaredScope(t *testing.T) {
	vh := newVHEnv(t)
	resolver := NewFiledAssetResolver(vh.repo)
	resolver.WithOfficialAssets(&fakeOfficialSource{assets: map[uint64]*model.Asset{
		100: {ID: 100, Source: model.AssetSourceOfficial, OfficialAssetID: "asset-official-1", OfficialScope: provider.ScopeArkCN},
	}})

	// 代理地址 + 声明 ark-cn → 命中（域名推断不出来，靠声明）
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 100, ch("ark-proxy", proxy, provider.ScopeArkCN)); !ok || uri != "asset://asset-official-1" {
		t.Fatalf("声明与音色同域时应返回 asset://，得到 %q ok=%v", uri, ok)
	}

	// 代理地址 + 声明 byteplus → 与国内音色跨域，回退
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 100, ch("bp-proxy", proxy, provider.ScopeBytePlus)); ok || uri != "" {
		t.Fatalf("声明为另一资源域时不该返回 asset://，得到 %q ok=%v", uri, ok)
	}

	// 声明与能推断出的域名冲突（改了 base_url 没改声明）→ 谁也不信，回退，不发错地址
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 100, ch("stale", bytePlus, provider.ScopeArkCN)); ok || uri != "" {
		t.Fatalf("声明与域名冲突时不该返回 asset://，得到 %q ok=%v", uri, ok)
	}

	// 声明了未知取值 → 按不可用处理
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 100, ch("typo", proxy, "ark-cn-beijing")); ok || uri != "" {
		t.Fatalf("未知资源域声明不该返回 asset://，得到 %q ok=%v", uri, ok)
	}
}

// 没接官方来源时（兼容老调用），公开音色也不会被误判成 asset://——保持原有行为。
func TestFiledAssetResolver_NoOfficialSourceKeepsOldBehavior(t *testing.T) {
	vh := newVHEnv(t)
	resolver := NewFiledAssetResolver(vh.repo)
	if uri, ok := resolver.FiledAssetURI(context.Background(), 42, 100, ch("any-channel", arkCN, "")); ok || uri != "" {
		t.Fatalf("未接官方来源时应保持原行为，得到 %q ok=%v", uri, ok)
	}
}
