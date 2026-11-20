package service

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"video-canvas/internal/canvasdoc"
	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/idcodec"
	"video-canvas/internal/pkg/logger"
	"video-canvas/internal/provider"
	"video-canvas/internal/repository"
)

// References 返回一个真人的图片被哪些角色卡使用（主图或补充图），移除前给用户看。
func (s *VirtualHumanService) References(ctx context.Context, userID, humanID uint64) (*model.VirtualHumanRefListView, error) {
	if _, err := s.loadHuman(ctx, userID, humanID); err != nil {
		return nil, err
	}
	images, err := s.repo.ListImagesByHuman(ctx, userID, humanID)
	if err != nil {
		return nil, err
	}
	refs, err := s.refsOf(ctx, userID, images)
	if err != nil {
		return nil, err
	}
	return &model.VirtualHumanRefListView{Items: refs}, nil
}

// RemoveImage 从真人里移除一张图片，同时删除方舟侧的素材（不可恢复）；个人资产库里的原图不动。
// 还被角色卡用着的图片不能移除；真人只剩这一张时要改用移除真人。
func (s *VirtualHumanService) RemoveImage(ctx context.Context, userID, imageID uint64) error {
	// 1. 图片要存在，且不是真人唯一的一张
	img, err := s.loadImage(ctx, userID, imageID)
	if err != nil {
		return err
	}
	siblings, err := s.repo.ListImagesByHuman(ctx, userID, img.HumanID)
	if err != nil {
		return err
	}
	// 2. 引用检查：被角色卡用着就拒绝，提示里点名角色卡，让用户知道去哪里换
	refs, err := s.refsOf(ctx, userID, []model.VirtualHumanImage{*img})
	if err != nil {
		return err
	}
	if len(refs) > 0 {
		return inUseError(refs)
	}
	if len(siblings) <= 1 {
		return errcode.ErrVirtualHumanLastImage
	}
	// 3. 先删方舟侧再删本地：方舟删除失败就保留本地行让用户重试，避免方舟侧留下没人管的素材
	if err := s.deleteUpstream(ctx, []model.VirtualHumanImage{*img}); err != nil {
		return err
	}
	if err := s.repo.DeleteImage(ctx, userID, imageID); err != nil && !errors.Is(err, repository.ErrNotFound) {
		return err
	}
	return nil
}

// Remove 移除整个真人和它的全部图片，同时删除方舟侧的素材（不可恢复）；个人资产库里的原图不动。
// 任意一张图片还被角色卡用着就不能移除。
func (s *VirtualHumanService) Remove(ctx context.Context, userID, humanID uint64) error {
	// 1. 真人要存在
	if _, err := s.loadHuman(ctx, userID, humanID); err != nil {
		return err
	}
	images, err := s.repo.ListImagesByHuman(ctx, userID, humanID)
	if err != nil {
		return err
	}
	// 2. 引用检查
	refs, err := s.refsOf(ctx, userID, images)
	if err != nil {
		return err
	}
	if len(refs) > 0 {
		return inUseError(refs)
	}
	// 3. 先删方舟侧再删本地（原因同 RemoveImage）；中途失败时已删掉的会清空方舟素材 ID，重试只删剩下的
	if err := s.deleteUpstream(ctx, images); err != nil {
		return err
	}
	if err := s.repo.DeleteHuman(ctx, userID, humanID); errors.Is(err, repository.ErrNotFound) {
		return errcode.ErrVirtualHumanNotFound
	} else if err != nil {
		return err
	}
	return nil
}

// deleteUpstream 删除图片在方舟侧的素材，每删掉一个就清空本地记录的方舟素材 ID（中途失败后重试不会重复删）。
// 没提交成功的（没有方舟素材 ID）跳过；
// 备案渠道已不是当前启用的渠道时拿不到它的凭证，只删本地并记日志——不能因为管理员换了渠道就让用户永远删不掉。
func (s *VirtualHumanService) deleteUpstream(ctx context.Context, images []model.VirtualHumanImage) error {
	var target *provider.FilingTarget
	for _, img := range images {
		if img.ArkAssetID == "" {
			continue
		}
		if target == nil {
			t, err := s.filing.FilingTarget(ctx)
			if err != nil {
				return err
			}
			if t == nil {
				t = &provider.FilingTarget{} // 没有启用的渠道：下面按渠道不一致处理
			}
			target = t
		}
		if img.ChannelKey != target.ChannelKey {
			logger.Warn("真人图片的备案渠道已停用，只删除本地记录", zap.Uint64("image_id", img.ID), zap.String("channel", img.ChannelKey))
			continue
		}
		if err := s.client.DeleteAsset(ctx, *target, img.ArkAssetID); err != nil {
			logger.Warn("删除方舟素材失败", zap.Uint64("image_id", img.ID), zap.Error(err))
			return errcode.ErrFilingUpstream
		}
		img.ArkAssetID, img.Status, img.Error = "", model.FilingFailed, ""
		if err := s.repo.UpdateImageFiling(ctx, &img); err != nil && !errors.Is(err, repository.ErrNotFound) {
			return err
		}
	}
	return nil
}

// refsOf 找出这些图片被哪些角色卡使用：先用 SQL 粗筛出可能用到的画布，再解析画布内容精确到节点。
// 画布内容损坏的跳过（记日志），不让一张坏画布挡住移除。
func (s *VirtualHumanService) refsOf(ctx context.Context, userID uint64, images []model.VirtualHumanImage) ([]model.VirtualHumanRefView, error) {
	imageOf := make(map[string]uint64, len(images))
	ids := make([]string, 0, len(images))
	for _, img := range images {
		id := strconv.FormatUint(img.AssetID, 10)
		imageOf[id] = img.ID
		ids = append(ids, id)
	}
	rows, err := s.canvases.CanvasesUsingAssets(ctx, userID, ids)
	if err != nil {
		return nil, err
	}
	refs := []model.VirtualHumanRefView{}
	for _, row := range rows {
		uses, err := canvasdoc.CharacterImageUses(row.Payload)
		if err != nil {
			logger.Warn("解析画布内容失败，跳过引用检查", zap.Uint64("canvas_id", row.ID), zap.Error(err))
			continue
		}
		for _, use := range uses {
			for _, assetID := range use.AssetIDs {
				if imageID, ok := imageOf[assetID]; ok {
					refs = append(refs, model.VirtualHumanRefView{
						ImageID: idcodec.ID(imageID), CanvasID: idcodec.ID(row.ID), CanvasTitle: row.Title,
						NodeID: use.NodeID, NodeName: use.Name,
					})
				}
			}
		}
	}
	return refs, nil
}

// inUseError 生成「正被角色卡使用」的错误，提示里列出前几处（画布标题 · 角色名）。
func inUseError(refs []model.VirtualHumanRefView) error {
	const shown = 3
	var parts []string
	seen := map[string]bool{}
	for _, r := range refs {
		label := "《" + r.CanvasTitle + "》角色卡「" + r.NodeName + "」"
		if seen[label] {
			continue
		}
		seen[label] = true
		parts = append(parts, label)
	}
	msg := "图片正被" + strings.Join(parts[:min(len(parts), shown)], "、")
	if len(parts) > shown {
		msg += " 等 " + strconv.Itoa(len(parts)) + " 处"
	}
	return errcode.ErrVirtualHumanInUse.WithMsg(msg + "使用，先在角色卡里换掉或删掉")
}

// FiledAssetImages 是 FiledAssetResolver 需要的数据访问（真实实现是 repository.VirtualHumanRepository）。
type FiledAssetImages interface {
	// GetImageByAsset 按 user_id + asset_id 查询真人图片，不在真人库里返回 repository.ErrNotFound。
	GetImageByAsset(ctx context.Context, userID, assetID uint64) (*model.VirtualHumanImage, error)
	// UpdateImageFiling 写回图片的备案结果，不存在返回 repository.ErrNotFound。
	UpdateImageFiling(ctx context.Context, img *model.VirtualHumanImage) error
}

// pendingCheckTimeout 是生成时同步查一次审核状态的超时：挂在提交生成的关键路径上，不能把用户卡住。
const pendingCheckTimeout = 5 * time.Second

// FiledAssetResolver 实现 provider.FiledAssetResolver：生成时把真人库里备案可用的图片换成 asset://<方舟素材 ID>。
// 单独成一个类型，是因为插件执行器比渠道服务先组装，不能依赖完整的 VirtualHumanService；
// 查审核状态要用的备案目标和方舟客户端在渠道服务建好后由 UseFiling 接上。
type FiledAssetResolver struct {
	images   FiledAssetImages
	filing   FilingTargetSource
	client   FilingClient
	official OfficialAssetSource
}

// OfficialAssetSource 查询官方参考音色：只有 source=official 且有官方 asset ID 的素材才返回 ok。
// 由素材仓储实现，官方音色是系统公共素材（user_id=0），不带用户条件。
type OfficialAssetSource interface {
	OfficialAsset(ctx context.Context, id uint64) (*model.Asset, bool)
}

// NewFiledAssetResolver 创建解析器。
func NewFiledAssetResolver(images FiledAssetImages) *FiledAssetResolver {
	return &FiledAssetResolver{images: images}
}

// WithOfficialAssets 接上官方音色来源，只在 initialize 组装时调用一次。
// 没接上时保持原有行为：只处理真人库备案图片。
func (r *FiledAssetResolver) WithOfficialAssets(source OfficialAssetSource) {
	r.official = source
}

// UseFiling 接上备案目标和方舟客户端，只在 initialize 组装时调用一次（之后不再改，不存在并发写）。
// 没接上时审核中的图片一律按普通图片传。
func (r *FiledAssetResolver) UseFiling(filing FilingTargetSource, client FilingClient) {
	r.filing, r.client = filing, client
}

// FiledAssetURI 返回素材的方舟引用。真人图片只有在该用户的真人库里、备案渠道就是任务所走的渠道时才考虑：
// 方舟素材只在备案的那个账号下有效，别的渠道拿到也用不了。官方参考音色同理，只认同资源域（见 provider.ResolveChannelScope）。
//   - 已可用：直接返回 asset://；
//   - 审核中：同步查一次方舟（5 秒超时）。用户刚提交备案就去生成时方舟往往已经通过，不能因为本地还没刷新
//     就退回普通地址去撞风控；查到通过或失败都写回，免得下次再查；
//   - 其余情况、以及任何查询出错，按未备案处理（照常传图片地址），只记日志。
func (r *FiledAssetResolver) FiledAssetURI(ctx context.Context, userID, assetID uint64, ch provider.ChannelSnapshot) (string, bool) {
	// 0. 公开音色：方舟国内站与 BytePlus 各自一套公开素材，asset-xxx 只在同一资源域内有效。
	//    跨域（例如把国内站的音色拿去 BytePlus）上游会报 asset not found，这里回退成音频文件 URL。
	//    资源域取渠道声明、没声明时按 base_url 推断；两者冲突或都推断不出来一律回退，宁可退化也不发错地址。
	//    其他模型不认这个地址，因此只有插件显式声明 filed 时才会走到这里（见 executor.filedAssetURI）。
	if r.official != nil {
		if a, ok := r.official.OfficialAsset(ctx, assetID); ok && a.Source == model.AssetSourceOfficial && a.OfficialAssetID != "" {
			if provider.ScopeConflict(ch.VoiceScope, ch.BaseURL) {
				logger.Warn("渠道声明的公开素材资源域与 BaseURL 不一致，公开音色按音频文件传",
					zap.String("channel", ch.Key), zap.String("voice_scope", ch.VoiceScope), zap.String("base_url", ch.BaseURL))
			}
			if a.OfficialScope == "" || a.OfficialScope != provider.ResolveChannelScope(ch.VoiceScope, ch.BaseURL) {
				return "", false
			}
			return provider.FilingAssetURIPrefix + a.OfficialAssetID, true
		}
	}

	img, err := r.images.GetImageByAsset(ctx, userID, assetID)
	if err != nil {
		if !errors.Is(err, repository.ErrNotFound) {
			logger.Warn("查询真人图片备案失败，按普通图片传", zap.Uint64("asset_id", assetID), zap.Error(err))
		}
		return "", false
	}
	if img.ArkAssetID == "" || img.ChannelKey != ch.Key {
		return "", false
	}
	switch img.Status {
	case model.FilingActive:
		return provider.FilingAssetURIPrefix + img.ArkAssetID, true
	case model.FilingPending:
		if r.checkPending(ctx, img) {
			return provider.FilingAssetURIPrefix + img.ArkAssetID, true
		}
	}
	return "", false
}

// checkPending 给一张审核中的图片同步查一次方舟状态，通过返回 true；出了结果（通过或失败）就写回。
// 当前启用的渠道不是图片的备案渠道时拿不到凭证，不查。
func (r *FiledAssetResolver) checkPending(ctx context.Context, img *model.VirtualHumanImage) bool {
	if r.filing == nil || r.client == nil {
		return false
	}
	target, err := r.filing.FilingTarget(ctx)
	if err != nil || target == nil || target.ChannelKey != img.ChannelKey {
		return false
	}
	checkCtx, cancel := context.WithTimeout(ctx, pendingCheckTimeout)
	defer cancel()
	status, err := r.client.GetAsset(checkCtx, *target, img.ArkAssetID)
	if err != nil {
		logger.Warn("生成前查询方舟素材状态失败，按普通图片传", zap.Uint64("image_id", img.ID), zap.Error(err))
		return false
	}
	switch status {
	case provider.FilingAssetActive:
		img.Status, img.Error = model.FilingActive, ""
	case provider.FilingAssetFailed:
		img.Status, img.Error = model.FilingFailed, filingRejectedMsg
	default:
		return false
	}
	if err := r.images.UpdateImageFiling(ctx, img); err != nil && !errors.Is(err, repository.ErrNotFound) {
		logger.Warn("写回真人图片备案状态失败", zap.Uint64("image_id", img.ID), zap.Error(err))
	}
	return img.Status == model.FilingActive
}
