package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/idcodec"
	"video-canvas/internal/provider"
	"video-canvas/internal/repository"
)

// 模型配置正文 capabilities.filing 段：管理员在「能力与参数」页签里开关、选站点、填素材组与项目名。
// AK/SK 不写在正文里（正文会被审计/pull 带出去），只存 ai_secrets。
type modelFilingConfig struct {
	Enabled     bool   `json:"enabled"`
	Site        string `json:"site"`         // ark_cn（默认）/ byteplus，预留；当前都走方舟 V4 签名
	GroupID     string `json:"group_id"`     // 方舟素材组 ID，CreateAsset 必填
	ProjectName string `json:"project_name"` // 方舟项目名，空则用 default
}

// FilingService 是虚拟人像库的归集与备案编排：归集 CRUD + 提交方舟备案 + 状态轮询 + 删除。
type FilingService struct {
	avatars  *repository.VirtualAvatarRepository
	catalog  *repository.AIConfigRepository
	secrets  secretReader         // 读 AK/SK 明文（复用 AIConfigService，它实现 SecretIsSet/Get）
	channels channelBaseURLLookup // 查渠道 base_url，据此推断备案站点
	assets   assetOpener          // 归集时按素材 id 补图片地址（方舟 CreateAsset 要真实可访问的 URL）
	ark      *arkFilingClient
	audit    AIAuditWriter

	// 批量刷新的节流表：前端每个打开的画布页都在轮询，不挡一下会把方舟 GetAsset 打成攻击自己。
	refreshMu   sync.Mutex
	lastRefresh map[uint64]time.Time
}

// pendingRefreshMinInterval 同一用户两次批量刷新的最小间隔；前端轮询 1~2 秒一次，这里收成 3 秒。
const pendingRefreshMinInterval = 3 * time.Second

// assetOpener 只取素材的可访问地址；与生成任务用的是同一条地址，方舟能直接下载。
type assetOpener interface {
	Open(ctx context.Context, userID, assetID uint64) (*provider.AssetFile, error)
}

// secretReader 只取 filing service 需要的凭证能力，便于单测替换。
type secretReader interface {
	SecretIsSet(ctx context.Context, name string) (bool, error)
	Get(ctx context.Context, name string) (string, error)
}

// channelBaseURLLookup 只取渠道 base_url：备案站点由 seedance 模型所用渠道的 base_url 自动推断。
type channelBaseURLLookup interface {
	GetChannel(ctx context.Context, key string) (*model.AIChannel, error)
}

// NewFilingService 组装备案服务：仓储、模型配置、凭据、渠道、素材与审计。
// ark 客户端内部自建，不从这里传，避免调用方拿到签名能力。
func NewFilingService(
	avatars *repository.VirtualAvatarRepository,
	catalog *repository.AIConfigRepository,
	secrets secretReader,
	audit AIAuditWriter,
	channels channelBaseURLLookup,
	assets assetOpener,
) *FilingService {
	return &FilingService{
		avatars: avatars, catalog: catalog, secrets: secrets,
		ark: newArkFilingClient(), audit: audit, channels: channels, assets: assets,
	}
}

// filingConfigOf 读某个视频模型的 filing 配置；模型不存在或未发布返回 ErrNotFound。
func (s *FilingService) filingConfigOf(ctx context.Context, modelKey string) (*modelFilingConfig, error) {
	pub, err := s.catalog.PublishedModelByKey(ctx, modelKey)
	if err != nil {
		return nil, err
	}
	var body struct {
		Capabilities struct {
			Filing modelFilingConfig `json:"filing"`
		} `json:"capabilities"`
		// 兼容早期写在顶层的 filing（若将来有人手工放过）；优先用 capabilities.filing。
		FilingTop modelFilingConfig `json:"filing"`
		Channels  []struct {
			Channel string `json:"channel"`
		} `json:"channels"`
	}
	if len(pub.Body) > 0 {
		if err := json.Unmarshal(pub.Body, &body); err != nil {
			return nil, fmt.Errorf("模型 %s 配置不是合法 JSON: %w", modelKey, err)
		}
	}
	cfg := body.Capabilities.Filing
	if !cfg.Enabled && (cfg.GroupID == "" || cfg.Site == "") && body.FilingTop.Enabled {
		cfg = body.FilingTop
	}
	// 备案站点由模型所用渠道的 base_url 自动推断：方舟国内域名→ark_cn，BytePlus 域名→byteplus。
	// body 里的 site 只是历史兼容字段，不作为依据，避免 base_url 与站点选错导致签名域名不匹配。
	if s.channels != nil && len(body.Channels) > 0 && body.Channels[0].Channel != "" {
		if ch, err := s.channels.GetChannel(ctx, body.Channels[0].Channel); err == nil && ch != nil {
			cfg.Site = filingSiteFromBaseURL(ch.BaseURL)
		}
	}
	return &cfg, nil
}

// filingSiteFromBaseURL 按推理渠道 base_url 判断备案站点。
// 国内方舟推理域名 ark.cn-beijing.volces.com；BytePlus 国际站 ark.ap-southeast.bytepluses.com。
// 未识别的域名按 BytePlus（与 filingSite 的默认一致），避免把海外请求错误地签成国内域名。
func filingSiteFromBaseURL(baseURL string) string {
	u := strings.ToLower(baseURL)
	if strings.Contains(u, "byteplus") {
		return filingSiteBytePlus
	}
	if strings.Contains(u, "volces.com") || strings.Contains(u, "volcengineapi.com") || strings.Contains(u, "cn-beijing") {
		return filingSiteArkCN
	}
	return filingSiteBytePlus
}

// AssetURI 把用户某张已备案生效的素材换成方舟资产 URI（asset://asset-xxx），供生成任务引用。
//
// 方舟 Seedance 2.0/2.5 不接受含真人人脸的普通图片 URL，只有已授权真人素材以资产 URI 引用才不会触发
// 输入风控；这里就是「备案结果回流到生成链路」的唯一入口：
//   - 只认 filing_status=active 且已有 ark_asset_id 的条目，未备案/审核中/失败一律返回 false；
//   - 审核中的条目会顺手同步查一次方舟状态：用户提交备案后立刻开拍时，方舟往往已经通过，
//     不能因为本地还没刷新就退回普通 URL 去撞风控；
//   - 只支持国内方舟（ark_cn）：BytePlus 的素材库与国内不是同一套资产体系，跨站 asset:// 引用会 404。
func (s *FilingService) AssetURI(ctx context.Context, userID, assetID uint64, modelKey string) (string, bool) {
	if assetID == 0 || modelKey == "" {
		return "", false
	}
	cfg, err := s.filingConfigOf(ctx, modelKey)
	if err != nil || !cfg.Enabled || cfg.Site != filingSiteArkCN {
		return "", false
	}
	row, err := s.avatars.FindByAsset(ctx, userID, assetID)
	if err != nil || row == nil || row.ArkAssetID == "" {
		return "", false
	}
	switch row.FilingStatus {
	case model.FilingActive:
		return "asset://" + row.ArkAssetID, true
	case model.FilingPending:
		return "asset://" + row.ArkAssetID, s.activatePending(ctx, row)
	}
	return "", false
}

// activatePending 给一条审核中的条目同步查一次方舟状态，通过就落库并返回 true。
// 查询失败（网络、凭据、模型下线）一律当没通过：宁可这次不用 asset://，也不要拿没通过的素材去生成。
// 超时设短一些——它挂在生成提交的关键路径上，不能把用户卡在这里。
func (s *FilingService) activatePending(ctx context.Context, row *model.VirtualAvatar) bool {
	if row.FilingModelKey == "" {
		return false
	}
	cfg, err := s.filingConfigOf(ctx, row.FilingModelKey)
	if err != nil || !cfg.Enabled {
		return false
	}
	ak, sk, err := s.credentials(ctx, row.FilingModelKey)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	status, err := s.refreshRow(ctx, row, cfg, ak, sk)
	return err == nil && status == model.FilingActive
}

// List 列出用户的全部归集条目。
func (s *FilingService) List(ctx context.Context, userID uint64) ([]model.VirtualAvatar, error) {
	return s.avatars.List(ctx, userID)
}

// Collect 归集一条角色图片。同来源重复返回 ErrFilingExists。
// sourceType 必须是 drama_character / library_asset；sourceRef、assetID 由调用方从来源取好。
// url 可以省略：给了 assetID 时由后端从素材库取可访问地址，避免前端为了凑一个必填字段而传空串。
func (s *FilingService) Collect(ctx context.Context, actorID uint64, in CollectInput) (*model.VirtualAvatar, error) {
	if in.SourceType != model.VirtualAvatarSourceDrama && in.SourceType != model.VirtualAvatarSourceLibrary {
		return nil, errcode.ErrInvalidParams.WithMsg("来源类型只能是 drama_character 或 library_asset")
	}
	if strings.TrimSpace(in.SourceRef) == "" {
		return nil, errcode.ErrInvalidParams.WithMsg("缺少来源标识")
	}
	// 素材 id 统一按十进制存：生成任务里的素材 id 是 uint64，备案回流要靠它对齐，两种写法都收。
	assetID := strings.TrimSpace(in.AssetID)
	if id, ok := parseAssetRef(assetID); ok {
		assetID = strconv.FormatUint(id, 10)
	}
	imageURL := strings.TrimSpace(in.URL)
	// 前端给的地址可能是 /files/... 这类相对路径，方舟下载不到；优先按素材 id 取公开绝对地址。
	if !isAbsoluteURL(imageURL) {
		resolved, err := s.imageURLOf(ctx, actorID, assetID)
		if err != nil {
			if imageURL != "" {
				return nil, errcode.ErrInvalidParams.WithMsg("图片地址不是公网绝对地址，无法提交备案")
			}
			return nil, err
		}
		imageURL = resolved
	}
	row := &model.VirtualAvatar{
		UserID: actorID, SourceType: in.SourceType, SourceRef: in.SourceRef,
		Name: in.Name, AssetID: assetID, URL: imageURL, FilingStatus: model.FilingNone,
	}
	if err := s.avatars.Create(ctx, row); err != nil {
		if errors.Is(err, repository.ErrVirtualAvatarExists) || isUniqueViolationRepo(err) {
			return nil, errcode.ErrFilingExists
		}
		return nil, err
	}
	aiAudit(ctx, s.audit, actorID, "virtual_avatar.collect", "virtual_avatar", fmt.Sprintf("%d", row.ID),
		map[string]any{"source_type": in.SourceType})
	return row, nil
}

// imageURLOf 按素材 id 取可访问地址；没有素材 id 或素材不存在时明确报错，而不是把空地址交给方舟。
func (s *FilingService) imageURLOf(ctx context.Context, userID uint64, assetID string) (string, error) {
	if assetID == "" {
		return "", errcode.ErrInvalidParams.WithMsg("缺少图片来源（asset_id 或 url 至少给一个）")
	}
	id, ok := parseAssetRef(assetID)
	if !ok {
		return "", errcode.ErrInvalidParams.WithMsg("素材标识不合法")
	}
	if s.assets == nil {
		return "", errcode.ErrInvalidParams.WithMsg("宿主未配置素材存储，无法解析图片来源")
	}
	f, err := s.assets.Open(ctx, userID, id)
	if err != nil {
		return "", errcode.ErrInvalidParams.WithMsg("找不到该素材的图片，无法提交备案")
	}
	defer f.Body.Close()
	if !isAbsoluteURL(f.URL) {
		return "", errcode.ErrInvalidParams.WithMsg("素材地址不是公网绝对地址，方舟无法下载（检查 storage.local.base_url）")
	}
	return f.URL, nil
}

// parseAssetRef 兼容两种素材标识：十进制 id（生成任务与素材表用）和 idcodec 十六进制串（画布节点用）。
func parseAssetRef(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	if id, err := strconv.ParseUint(s, 10, 64); err == nil && id > 0 {
		return id, true
	}
	return idcodec.Decode(s)
}

// isAbsoluteURL 判断是不是方舟能直接下载的 http(s) 绝对地址。
func isAbsoluteURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// CollectInput 是归集入参。
type CollectInput struct {
	SourceType string
	SourceRef  string
	Name       string
	AssetID    string
	URL        string
}

// Remove 从虚拟人像库移除（只删归集行）。已备案的条目会同时删方舟资产，避免留下孤儿备案。
func (s *FilingService) Remove(ctx context.Context, actorID, id uint64) error {
	row, err := s.avatars.Get(ctx, actorID, id)
	if err != nil {
		return translateRepoNotFound(err)
	}
	if row.ArkAssetID != "" && row.FilingModelKey != "" {
		if err := s.deleteArkAsset(ctx, row); err != nil {
			return err // 方舟删不掉就不删本地行，避免留下无法清理的备案
		}
	}
	if err := s.avatars.Delete(ctx, actorID, id); err != nil {
		return err
	}
	aiAudit(ctx, s.audit, actorID, "virtual_avatar.remove", "virtual_avatar", fmt.Sprintf("%d", id), nil)
	return nil
}

// Submit 提交备案：读模型的 filing 配置与 AK/SK，调方舟 CreateAsset，写入 pending + 方舟 ID。
func (s *FilingService) Submit(ctx context.Context, actorID, id uint64, modelKey string) (*model.VirtualAvatar, error) {
	row, err := s.avatars.Get(ctx, actorID, id)
	if err != nil {
		return nil, translateRepoNotFound(err)
	}
	if strings.TrimSpace(modelKey) == "" {
		modelKey = row.FilingModelKey
	}
	if modelKey == "" {
		// 角色卡入口不知道该用哪个模型：自动挑第一个开启了虚拟人像库的视频模型。
		picked, err := s.defaultFilingModel(ctx)
		if err != nil {
			return nil, err
		}
		modelKey = picked
	}
	cfg, err := s.filingConfigOf(ctx, modelKey)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, errcode.ErrInvalidParams.WithMsg("备案模型不存在或未发布")
		}
		return nil, err
	}
	if !cfg.Enabled {
		return nil, errcode.ErrFilingDisabled
	}
	ak, sk, err := s.credentials(ctx, modelKey)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.GroupID) == "" {
		return nil, errcode.ErrInvalidParams.WithMsg("该模型的虚拟人像库未配置素材组 ID（group_id）")
	}
	project := cfg.ProjectName
	if strings.TrimSpace(project) == "" {
		project = "default"
	}
	// 早期归集的条目可能没存地址：提交前按素材 id 补一次，别把空地址交给方舟。
	imageURL := strings.TrimSpace(row.URL)
	if !isAbsoluteURL(imageURL) {
		resolved, resolveErr := s.imageURLOf(ctx, actorID, row.AssetID)
		if resolveErr != nil {
			if imageURL != "" {
				return nil, errcode.ErrInvalidParams.WithMsg("图片地址不是公网绝对地址，无法提交备案")
			}
			return nil, resolveErr
		}
		imageURL = resolved
	}
	asset, err := s.ark.CreateAsset(ctx, cfg.Site, ak, sk, cfg.GroupID, imageURL, row.Name, project)
	if err != nil {
		return nil, errcode.ErrFilingUpstream.WithMsg(err.Error())
	}
	patch := map[string]any{
		"filing_status":    model.FilingPending,
		"filing_model_key": modelKey,
		"ark_asset_id":     asset.ID,
		"url":              imageURL,
		"error":            "",
	}
	if err := s.avatars.UpdateFields(ctx, actorID, id, patch); err != nil {
		return nil, err
	}
	aiAudit(ctx, s.audit, actorID, "virtual_avatar.submit", "virtual_avatar", fmt.Sprintf("%d", id),
		map[string]any{"model_key": modelKey})
	return s.avatars.Get(ctx, actorID, id)
}

// Refresh 轮询某条备案状态：调方舟 GetAsset，Active→active，失败态→failed，其余保持 pending。
func (s *FilingService) Refresh(ctx context.Context, actorID, id uint64) (*model.VirtualAvatar, error) {
	row, err := s.avatars.Get(ctx, actorID, id)
	if err != nil {
		return nil, translateRepoNotFound(err)
	}
	if row.ArkAssetID == "" || row.FilingModelKey == "" || row.FilingStatus == model.FilingNone {
		return row, nil
	}
	cfg, err := s.filingConfigOf(ctx, row.FilingModelKey)
	if err != nil {
		return nil, err
	}
	ak, sk, err := s.credentials(ctx, row.FilingModelKey)
	if err != nil {
		return nil, err
	}
	if _, err := s.refreshRow(ctx, row, cfg, ak, sk); err != nil {
		return nil, errcode.ErrFilingUpstream.WithMsg(err.Error())
	}
	return s.avatars.Get(ctx, actorID, id)
}

// RefreshPending 把该用户所有审核中的条目各查一次方舟状态，返回这一轮变成终态的条数。
//
// 一个模型只取一次配置与 AK/SK；单条失败（网络抖动、单条状态异常）不影响其余条目，
// 也不把错误抛给调用方——页面每隔两秒会再问一次，下一轮自然重试，不必让用户看到红字。
func (s *FilingService) RefreshPending(ctx context.Context, userID uint64) (int, error) {
	if !s.claimPendingRefresh(userID) {
		return 0, nil
	}
	rows, err := s.avatars.ListPending(ctx, userID)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	type modelCtx struct {
		cfg    *modelFilingConfig
		ak, sk string
		usable bool
	}
	cache := make(map[string]*modelCtx, 2)
	settled := 0
	for i := range rows {
		row := &rows[i]
		mc, seen := cache[row.FilingModelKey]
		if !seen {
			mc = &modelCtx{}
			if cfg, cfgErr := s.filingConfigOf(ctx, row.FilingModelKey); cfgErr == nil && cfg.Enabled {
				if ak, sk, credErr := s.credentials(ctx, row.FilingModelKey); credErr == nil {
					mc.cfg, mc.ak, mc.sk, mc.usable = cfg, ak, sk, true
				}
			}
			cache[row.FilingModelKey] = mc
		}
		if !mc.usable {
			continue
		}
		status, refreshErr := s.refreshRow(ctx, row, mc.cfg, mc.ak, mc.sk)
		if refreshErr != nil {
			continue
		}
		if status != model.FilingPending {
			settled++
		}
	}
	return settled, nil
}

// claimPendingRefresh 判断这次批量刷新该不该真去问方舟：同一用户 3 秒内只放一次。
// 返回 false 表示刚刷过，调用方直接用库里现有状态就行。
func (s *FilingService) claimPendingRefresh(userID uint64) bool {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	now := time.Now()
	if s.lastRefresh == nil {
		s.lastRefresh = make(map[uint64]time.Time, 8)
	}
	if last, ok := s.lastRefresh[userID]; ok && now.Sub(last) < pendingRefreshMinInterval {
		return false
	}
	s.lastRefresh[userID] = now
	return true
}

// refreshRow 按一条条目查一次方舟状态并落库，返回落库后的状态（没变就是 pending）。
// 只改状态字段：方舟资产号与模型键在提交时就定了，这里不动。
func (s *FilingService) refreshRow(ctx context.Context, row *model.VirtualAvatar, cfg *modelFilingConfig, ak, sk string) (string, error) {
	project := cfg.ProjectName
	if strings.TrimSpace(project) == "" {
		project = "default"
	}
	asset, err := s.ark.GetAsset(ctx, cfg.Site, ak, sk, row.ArkAssetID, project)
	if err != nil {
		return row.FilingStatus, err
	}
	patch := map[string]any{}
	next := row.FilingStatus
	switch strings.ToUpper(asset.Status) {
	case "ACTIVE":
		patch["filing_status"] = model.FilingActive
		patch["error"] = ""
		next = model.FilingActive
	case "FAILED", "ERROR", "CANCELED", "EXPIRED":
		patch["filing_status"] = model.FilingFailed
		patch["error"] = "方舟备案未通过（状态 " + asset.Status + "）"
		next = model.FilingFailed
	}
	if len(patch) > 0 {
		if err := s.avatars.UpdateFields(ctx, row.UserID, uint64(row.ID), patch); err != nil {
			return row.FilingStatus, err
		}
		row.FilingStatus = next
	}
	return next, nil
}

// defaultFilingModel 自动选第一个开启了 capabilities.filing.enabled 的视频模型（按 sort 顺序）。
// 供角色卡入口用——它只拿到图片，不知道该走哪个模型。没有则返回 ErrFilingNoModel。
func (s *FilingService) defaultFilingModel(ctx context.Context) (string, error) {
	models, err := s.catalog.LoadModels(ctx)
	if err != nil {
		return "", err
	}
	for _, pub := range models {
		if pub.Kind != "video" || !pub.Enabled || len(pub.Body) == 0 {
			continue
		}
		var body struct {
			Capabilities struct {
				Filing modelFilingConfig `json:"filing"`
			} `json:"capabilities"`
		}
		if json.Unmarshal(pub.Body, &body) != nil {
			continue
		}
		if body.Capabilities.Filing.Enabled {
			return pub.Key, nil
		}
	}
	return "", errcode.ErrFilingNoModel
}

// credentials 读某模型的备案 AK/SK；任一未配置返回 ErrFilingSecretUnset。
func (s *FilingService) credentials(ctx context.Context, modelKey string) (string, string, error) {
	akName := model.FilingSecretName(modelKey)
	skName := model.FilingSecretKeyName(modelKey)
	akSet, err := s.secrets.SecretIsSet(ctx, akName)
	if err != nil {
		return "", "", err
	}
	skSet, err := s.secrets.SecretIsSet(ctx, skName)
	if err != nil {
		return "", "", err
	}
	if !akSet || !skSet {
		return "", "", errcode.ErrFilingSecretUnset
	}
	ak, err := s.secrets.Get(ctx, akName)
	if err != nil {
		return "", "", err
	}
	sk, err := s.secrets.Get(ctx, skName)
	if err != nil {
		return "", "", err
	}
	return ak, sk, nil
}

// deleteArkAsset 删除方舟资产（内部用）。
func (s *FilingService) deleteArkAsset(ctx context.Context, row *model.VirtualAvatar) error {
	cfg, err := s.filingConfigOf(ctx, row.FilingModelKey)
	if err != nil {
		return err
	}
	ak, sk, err := s.credentials(ctx, row.FilingModelKey)
	if err != nil {
		return err
	}
	project := cfg.ProjectName
	if strings.TrimSpace(project) == "" {
		project = "default"
	}
	if err := s.ark.DeleteAsset(ctx, cfg.Site, ak, sk, row.ArkAssetID, project); err != nil {
		return errcode.ErrFilingUpstream.WithMsg(err.Error())
	}
	return nil
}

// translateRepoNotFound 把仓储的 ErrNotFound 翻成统一的 errcode。
func translateRepoNotFound(err error) error {
	if errors.Is(err, repository.ErrNotFound) {
		return errcode.ErrNotFound.WithMsg("虚拟人像库条目不存在")
	}
	return err
}

// isUniqueViolationRepo 兼容仓储层唯一的重复错误（包级 isUniqueViolation 在 repository 包内不可导出，这里按哨兵判断）。
func isUniqueViolationRepo(err error) bool {
	return errors.Is(err, repository.ErrVirtualAvatarExists)
}
