package provider

import (
	"net/url"
	"strings"
)

// 公开素材的资源域。方舟国内站与 BytePlus 国际站各自维护一套公开音色/素材库：
// 同一域内 asset-xxx 通用，跨域直接报 "The specified asset ... is not found"。
const (
	ScopeArkCN    = "ark-cn"   // 方舟国内站（ark.cn-beijing.volces.com）
	ScopeBytePlus = "byteplus" // BytePlus 国际站（ark.ap-southeast.bytepluses.com）
)

// ValidScope 判断是不是已知的公开素材资源域（不区分大小写）。空串合法：表示该渠道不使用 asset:// 引用。
func ValidScope(scope string) bool {
	switch strings.ToLower(strings.TrimSpace(scope)) {
	case "", ScopeArkCN, ScopeBytePlus:
		return true
	}
	return false
}

// ChannelScope 按渠道 base_url 推断它落在哪个公开素材资源域；推断不出来的返回空串。
// 只作兜底：渠道上显式声明了 voice_scope 时以声明为准（见 ResolveChannelScope）。
// 用域名而不是渠道 key：渠道行可以删了重建，资源域不会变；也让同一域下的多条渠道共享一套公开素材。
// 认不出来的地址（自建代理、私有网关）一律返回空串，调用方按“不可用 asset://”处理，安全退化。
func ChannelScope(baseURL string) string {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return ""
	}
	switch {
	case strings.Contains(host, "bytepluses.com"):
		return ScopeBytePlus
	case strings.Contains(host, "ark.cn-beijing.volces.com"):
		return ScopeArkCN
	}
	return ""
}

// ResolveChannelScope 决议任务渠道用的公开素材资源域：
//   - 渠道显式声明了 voice_scope：以声明为准（自建代理把域名换掉了也能用）；
//   - 没声明：按 base_url 推断，老数据不填也能照旧跑；
//   - 声明与域名都明确却对不上：返回空串。这是运营改了 base_url 却没改声明的配置冲突，
//     宁可让公开音色退化成音频文件地址，也不要把 asset:// 发到用不了它的域上（上游会直接失败）。
func ResolveChannelScope(declared, baseURL string) string {
	declared = strings.ToLower(strings.TrimSpace(declared))
	if declared == "" {
		return ChannelScope(baseURL)
	}
	if !ValidScope(declared) || declared == "" {
		return "" // 未知取值：按不可用处理
	}
	if byURL := ChannelScope(baseURL); byURL != "" && byURL != declared {
		return "" // 配置冲突
	}
	return declared
}

// ScopeConflict 判断渠道声明的资源域与 base_url 推断的值是否冲突（两者都明确且不同）。
// 冲突时 ResolveChannelScope 退化成空串，调用方用它决定要不要记一条日志提醒运营。
func ScopeConflict(declared, baseURL string) bool {
	declared = strings.ToLower(strings.TrimSpace(declared))
	if declared == "" || !ValidScope(declared) {
		return false
	}
	byURL := ChannelScope(baseURL)
	return byURL != "" && byURL != declared
}
