package provider_test

import (
	"testing"

	"video-canvas/internal/provider"
)

// 公开素材按资源域划分：国内方舟与 BytePlus 各一套，认不出来的一律空串（安全退化）。
func TestChannelScope(t *testing.T) {
	cases := []struct {
		baseURL string
		want    string
	}{
		{"https://ark.cn-beijing.volces.com", provider.ScopeArkCN},
		{"https://ark.cn-beijing.volces.com/", provider.ScopeArkCN},
		{"https://ark.ap-southeast.bytepluses.com", provider.ScopeBytePlus},
		{"https://ARK.AP-SOUTHEAST.BYTEPLUSES.COM", provider.ScopeBytePlus},
		{"https://apihub.agnes-ai.com", ""},
		{"https://goapi.gptnb.ai", ""},
		{"http://127.0.0.1:8787/proxy", ""},
		{"", ""},
		{"not a url", ""},
	}
	for _, c := range cases {
		if got := provider.ChannelScope(c.baseURL); got != c.want {
			t.Errorf("ChannelScope(%q) = %q, want %q", c.baseURL, got, c.want)
		}
	}
}

// 渠道声明优先，域名推断兜底：自建代理声明了资源域照样能用；声明与域名冲突、声明取值不认识时一律退化。
func TestResolveChannelScope(t *testing.T) {
	const arkCN = "https://ark.cn-beijing.volces.com"
	const bytePlus = "https://ark.ap-southeast.bytepluses.com"
	const proxy = "https://gateway.example.com"
	cases := []struct {
		declared, baseURL, want string
	}{
		{"", arkCN, provider.ScopeArkCN},                        // 没声明：按域名推断，老数据不变
		{"", proxy, ""},                                         // 没声明且推断不出：退化
		{provider.ScopeArkCN, proxy, provider.ScopeArkCN},       // 声明优先：代理也能用
		{provider.ScopeBytePlus, proxy, provider.ScopeBytePlus}, // 同上
		{provider.ScopeArkCN, arkCN, provider.ScopeArkCN},       // 声明与域名一致
		{provider.ScopeArkCN, bytePlus, ""},                     // 声明与域名冲突：谁也不信
		{" Ark-CN ", proxy, provider.ScopeArkCN},                // 声明不区分大小写、忽略首尾空白
		{"ark-cn-beijing", proxy, ""},                           // 认不出的取值：按不可用处理
	}
	for _, c := range cases {
		if got := provider.ResolveChannelScope(c.declared, c.baseURL); got != c.want {
			t.Errorf("ResolveChannelScope(%q, %q) = %q, want %q", c.declared, c.baseURL, got, c.want)
		}
	}
}

func TestScopeConflict(t *testing.T) {
	const arkCN = "https://ark.cn-beijing.volces.com"
	const proxy = "https://gateway.example.com"
	cases := []struct {
		declared, baseURL string
		want              bool
	}{
		{provider.ScopeArkCN, arkCN, false},   // 一致
		{provider.ScopeBytePlus, arkCN, true}, // 冲突
		{provider.ScopeArkCN, proxy, false},   // 推断不出来，不算冲突
		{"", arkCN, false},                    // 没声明
		{"unknown", arkCN, false},             // 认不出的取值交给 ValidScope 管
	}
	for _, c := range cases {
		if got := provider.ScopeConflict(c.declared, c.baseURL); got != c.want {
			t.Errorf("ScopeConflict(%q, %q) = %v, want %v", c.declared, c.baseURL, got, c.want)
		}
	}
}
