package repository

import (
	"context"
	"errors"
	"strconv"

	"gorm.io/gorm"

	"video-canvas/internal/model"
)

// ErrVirtualAvatarExists 表示同一用户对同一来源已经归集过。
var ErrVirtualAvatarExists = errors.New("virtual avatar source already collected")

// VirtualAvatarRepository 是虚拟人像库的存储：归集条目的增删改查。
type VirtualAvatarRepository struct {
	db *gorm.DB
}

// NewVirtualAvatarRepository 组装虚拟人像库的存储层。
func NewVirtualAvatarRepository(db *gorm.DB) *VirtualAvatarRepository {
	return &VirtualAvatarRepository{db: db}
}

// List 按用户列出全部归集条目，新的在前。
func (r *VirtualAvatarRepository) List(ctx context.Context, userID uint64) ([]model.VirtualAvatar, error) {
	var rows []model.VirtualAvatar
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).Order("id DESC").Find(&rows).Error
	return rows, err
}

// Get 取用户的一条归集条目；不存在返回 ErrNotFound。
func (r *VirtualAvatarRepository) Get(ctx context.Context, userID, id uint64) (*model.VirtualAvatar, error) {
	var row model.VirtualAvatar
	err := r.db.WithContext(ctx).Where("user_id = ? AND id = ?", userID, id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// GetBySource 按来源指针查（加入归集时防重复）。
func (r *VirtualAvatarRepository) GetBySource(ctx context.Context, userID uint64, sourceType, sourceRef string) (*model.VirtualAvatar, error) {
	var row model.VirtualAvatar
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND source_type = ? AND source_ref = ?", userID, sourceType, sourceRef).
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ActiveByAsset 按素材 id 查用户已备案生效的条目：生成任务引用素材时用它换成方舟资产 URI。
//
// 同一张图在库里常有多条素材记录（资产库存档、画布产物各一份，id 不同但 sha256 相同），
// 备案只挂在其中一条上；按 id 查不到时再按内容指纹兜底，否则用户「备案了这张图」仍然会在生成时被风控拦。
func (r *VirtualAvatarRepository) ActiveByAsset(ctx context.Context, userID, assetID uint64) (*model.VirtualAvatar, error) {
	row, err := r.FindByAsset(ctx, userID, assetID)
	if err != nil {
		return nil, err
	}
	if row.FilingStatus != model.FilingActive {
		return nil, ErrNotFound
	}
	return row, nil
}

// FindByAsset 按素材 id（含内容指纹兜底）查一条已提交过方舟的归集记录：已生效优先，其次审核中。
//
// 生成链路拿到 pending 也要能处理——提交备案后到方舟审核完成之间用户可能立刻开拍，
// 这时同步查一次状态就能把「已通过但界面还没刷新」的素材用上，而不是退回普通 URL 去撞风控。
func (r *VirtualAvatarRepository) FindByAsset(ctx context.Context, userID, assetID uint64) (*model.VirtualAvatar, error) {
	var row model.VirtualAvatar
	// 已生效的排前面：同一张图可能先备案失败一次、后来重试成功。
	const preferActive = "CASE WHEN filing_status = 'active' THEN 0 ELSE 1 END, id"
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND asset_id = ? AND filing_status IN ? AND ark_asset_id <> ''",
			userID, strconv.FormatUint(assetID, 10), []string{model.FilingActive, model.FilingPending}).
		Order(preferActive).
		First(&row).Error
	if err == nil {
		return &row, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	// 内容指纹兜底：素材记录不同、字节完全相同，视为同一张已提交过的图片。
	err = r.db.WithContext(ctx).Raw(`
		SELECT v.* FROM virtual_avatars v
		JOIN assets a ON a.id::text = v.asset_id
		JOIN assets t ON t.id = ?
		WHERE v.user_id = ? AND v.filing_status IN ? AND v.ark_asset_id <> ''
		  AND a.sha256 <> '' AND a.sha256 = t.sha256
		ORDER BY CASE WHEN v.filing_status = 'active' THEN 0 ELSE 1 END, v.id
		LIMIT 1`, assetID, userID, []string{model.FilingActive, model.FilingPending}).Scan(&row).Error
	if err != nil {
		return nil, err
	}
	if row.ID == 0 {
		return nil, ErrNotFound
	}
	return &row, nil
}

// ListPending 列出用户还在审核中的条目（只取有方舟资产号和模型键的，没有的刷也刷不出来）。
func (r *VirtualAvatarRepository) ListPending(ctx context.Context, userID uint64) ([]model.VirtualAvatar, error) {
	var rows []model.VirtualAvatar
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND filing_status = ? AND ark_asset_id <> '' AND filing_model_key <> ''",
			userID, model.FilingPending).
		Order("id").
		Find(&rows).Error
	return rows, err
}

// Create 插入一条归集条目；同来源重复返回 ErrVirtualAvatarExists（靠部分唯一索引兜底）。
func (r *VirtualAvatarRepository) Create(ctx context.Context, row *model.VirtualAvatar) error {
	err := r.db.WithContext(ctx).Create(row).Error
	if err != nil && isUniqueViolation(err) {
		return ErrVirtualAvatarExists
	}
	return err
}

// UpdateFields 局部更新一条归集条目的指定字段。
func (r *VirtualAvatarRepository) UpdateFields(ctx context.Context, userID, id uint64, patch map[string]any) error {
	if len(patch) == 0 {
		return nil
	}
	res := r.db.WithContext(ctx).Model(&model.VirtualAvatar{}).
		Where("user_id = ? AND id = ?", userID, id).
		Updates(patch)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

// Delete 硬删除一条归集条目（只删本表，不碰来源）。
func (r *VirtualAvatarRepository) Delete(ctx context.Context, userID, id uint64) error {
	res := r.db.WithContext(ctx).Where("user_id = ? AND id = ?", userID, id).Delete(&model.VirtualAvatar{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
