package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"video-canvas/internal/pkg/outbound"
)

// 虚拟人像库（资产库）OpenAPI 客户端：方舟国内站与 BytePlus 国际站是两套独立域名。
// 事实来源：ark_seedance2.0_quickstart_package/docs/CN_EN_BYTEPLUS_DEVELOPMENT_PLAN.md:94-101
//   - 推理域名 ark.ap-southeast.bytepluses.com 与管理域名 ark.ap-southeast-1.byteplusapi.com 不可机械拼接；
//   - 管理接口签名 region：国内 cn-beijing，BytePlus ap-southeast-1。
//
// 签名用标准火山引擎/BytePlus V4（两者同构）。
const (
	arkFilingService = "ark"
	arkFilingVersion = "2024-01-01"

	filingSiteArkCN      = "ark_cn"
	filingSiteBytePlus   = "byteplus"
	filingHostArkCN      = "ark.cn-beijing.volcengineapi.com"
	filingRegionArkCN    = "cn-beijing"
	filingHostBytePlus   = "ark.ap-southeast-1.byteplusapi.com"
	filingRegionBytePlus = "ap-southeast-1"
)

// filingSite 返回站点对应的管理域名与签名 region；未知/空值按 BytePlus（生产 seedance 走国际站）。
func filingSite(site string) (host, region string) {
	if site == filingSiteArkCN {
		return filingHostArkCN, filingRegionArkCN
	}
	return filingHostBytePlus, filingRegionBytePlus
}

// arkFilingClient 调虚拟人像库接口。AK/SK 从调用方传入，不持有、不落日志。
// 无站点状态：host/region 由每次调用的 site 参数决定（不同模型可配不同站点）。
type arkFilingClient struct {
	http *http.Client
	now  func() time.Time
}

func newArkFilingClient() *arkFilingClient {
	// 统一出站客户端：外部 HTTP 必须在 outbound 里登记，日志和计数由它统一处理（架构测试 E9/E10）。
	// base 传 nil 用默认传输；超时在 call 里用 context.WithTimeout 控制（不在业务代码里构造 http.Client）。
	return &arkFilingClient{
		http: outbound.Client("filing.ark", nil),
		now:  time.Now,
	}
}

// arkAssetResult 是从 CreateAsset/GetAsset 响应里抽取的统一字段。
type arkAssetResult struct {
	ID     string
	Status string
	URL    string
}

// CreateAsset 创建素材资产（异步），返回方舟 Asset ID。URL 必须是可公网抓取的地址。
func (c *arkFilingClient) CreateAsset(ctx context.Context, site, ak, sk, groupID, imageURL, name, projectName string) (*arkAssetResult, error) {
	body := map[string]any{
		"GroupId":     groupID,
		"URL":         imageURL,
		"AssetType":   "Image",
		"Name":        name,
		"ProjectName": projectName,
	}
	resp, err := c.call(ctx, site, "CreateAsset", body, ak, sk)
	if err != nil {
		return nil, err
	}
	id := nestedString(resp, "Id")
	if id == "" {
		raw, _ := json.Marshal(resp)
		return nil, fmt.Errorf("CreateAsset 响应缺少 Id: %s", truncateForLog(string(raw), 200))
	}
	return &arkAssetResult{ID: id}, nil
}

// GetAsset 查询素材状态：Status 为 Active 表示备案完成。
func (c *arkFilingClient) GetAsset(ctx context.Context, site, ak, sk, assetID, projectName string) (*arkAssetResult, error) {
	body := map[string]any{"Id": assetID, "ProjectName": projectName}
	resp, err := c.call(ctx, site, "GetAsset", body, ak, sk)
	if err != nil {
		return nil, err
	}
	result := resp
	if nested, ok := resp["Result"].(map[string]any); ok {
		result = nested
	}
	return &arkAssetResult{
		ID:     stringOf(result["Id"]),
		Status: stringOf(result["Status"]),
		URL:    stringOf(result["URL"]),
	}, nil
}

// DeleteAsset 从资产库删除素材。
func (c *arkFilingClient) DeleteAsset(ctx context.Context, site, ak, sk, assetID, projectName string) error {
	body := map[string]any{"Id": assetID, "ProjectName": projectName}
	_, err := c.call(ctx, site, "DeleteAsset", body, ak, sk)
	return err
}

// call 发一次带 V4 签名的请求。返回解析后的 JSON；非 200 或业务 Error 都转成错误（已脱敏）。
func (c *arkFilingClient) call(ctx context.Context, site, action string, body map[string]any, ak, sk string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	host, _ := filingSite(site)
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	query := map[string]string{"Action": action, "Version": arkFilingVersion}
	headers := c.sign(site, query, string(bodyBytes), ak, sk)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+host+"/", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	q := req.URL.Query()
	for k, v := range query {
		q.Set(k, v)
	}
	req.URL.RawQuery = q.Encode()

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("方舟 %s 请求失败: %w", action, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("方舟 %s 返回 HTTP %d: %s", action, resp.StatusCode, truncateForLog(string(raw), 200))
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("方舟 %s 响应不是合法 JSON: %w", action, err)
	}
	// 方舟业务错误嵌在 ResponseMetadata.Error 里
	if meta, ok := obj["ResponseMetadata"].(map[string]any); ok {
		if e, ok := meta["Error"].(map[string]any); ok {
			return nil, fmt.Errorf("方舟 %s 业务错误: %s %s", action,
				stringOf(e["Code"]), truncateForLog(stringOf(e["Message"]), 200))
		}
	}
	return obj, nil
}

// sign 生成 V4 签名的请求头（火山引擎与 BytePlus 同构），host/region 按站点取。
func (c *arkFilingClient) sign(site string, query map[string]string, body, ak, sk string) map[string]string {
	xDate := c.now().UTC().Format("20060102T150405Z")
	shortDate := xDate[:8]
	contentHash := sha256Hex(body)
	host, region := filingSite(site)

	q := make(map[string]string, len(query)+1)
	for k, v := range query {
		q[k] = v
	}
	// 签名用的规范化 query 必须和 URL 里的一模一样；call 里用 url.Values.Encode，这里也按同样方式编码后参与规范化。
	canonicalQuery := canonicalQueryString(q)

	signedHeaders := "content-type;host;x-content-sha256;x-date"
	canonicalRequest := strings.Join([]string{
		http.MethodPost,
		"/",
		canonicalQuery,
		strings.Join([]string{
			"content-type:application/json",
			"host:" + host,
			"x-content-sha256:" + contentHash,
			"x-date:" + xDate,
		}, "\n"),
		"",
		signedHeaders,
		contentHash,
	}, "\n")

	credentialScope := strings.Join([]string{shortDate, region, arkFilingService, "request"}, "/")
	stringToSign := strings.Join([]string{
		"HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest),
	}, "\n")

	kDate := hmacSHA256([]byte(sk), shortDate)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, arkFilingService)
	kSigning := hmacSHA256(kService, "request")
	signature := hex.EncodeToString(hmacSHA256(kSigning, stringToSign))

	authorization := fmt.Sprintf("HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		ak, credentialScope, signedHeaders, signature)

	return map[string]string{
		"Content-Type":     "application/json",
		"Host":             host,
		"X-Content-Sha256": contentHash,
		"X-Date":           xDate,
		"Authorization":    authorization,
	}
}

// canonicalQueryString 与 net/url.Values.Encode 的编码保持一致（键排序、空格转 +）。
func canonicalQueryString(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, url.QueryEscape(k)+"="+url.QueryEscape(params[k]))
	}
	return strings.Join(parts, "&")
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, content string) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write([]byte(content))
	return h.Sum(nil)
}

// nestedString 取 resp["Result"][field]（兼容直接在顶层的形态）。
func nestedString(resp map[string]any, field string) string {
	if v, ok := resp["Result"].(map[string]any); ok {
		if s := stringOf(v[field]); s != "" {
			return s
		}
	}
	return stringOf(resp[field])
}

func stringOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func truncateForLog(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > limit {
		return s[:limit] + "…"
	}
	return s
}
