package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"video-canvas/internal/model"
)

// CLIDeviceRepository 是命令行设备授权的存储。
//
// 所有状态迁移都写成带条件的 UPDATE：授权页与 CLI 轮询会并发改同一行，
// 先读后写会互相覆盖，「谁的条件先满足谁生效」交给数据库判定。
type CLIDeviceRepository struct {
	db *gorm.DB
}

func NewCLIDeviceRepository(db *gorm.DB) *CLIDeviceRepository {
	return &CLIDeviceRepository{db: db}
}

// Create 插入一次设备授权申请。
func (r *CLIDeviceRepository) Create(ctx context.Context, c *model.CLIDeviceCode) error {
	return r.db.WithContext(ctx).Create(c).Error
}

// GetByHash 按设备码指纹查询，不存在返回 ErrNotFound。
func (r *CLIDeviceRepository) GetByHash(ctx context.Context, hash string) (*model.CLIDeviceCode, error) {
	var c model.CLIDeviceCode
	if err := r.db.WithContext(ctx).Where("device_code_hash = ?", hash).First(&c).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &c, nil
}

// GetByUserCode 按用户码查询，不存在返回 ErrNotFound。用户码在库里不带连字符。
func (r *CLIDeviceRepository) GetByUserCode(ctx context.Context, code string) (*model.CLIDeviceCode, error) {
	var c model.CLIDeviceCode
	if err := r.db.WithContext(ctx).Where("user_code = ?", code).First(&c).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &c, nil
}

// Approve 把 pending 且未过期的申请绑定到 userID。返回 false 表示条件不满足（并发或已过期）。
func (r *CLIDeviceRepository) Approve(ctx context.Context, userCode string, userID uint64, now time.Time) (bool, error) {
	res := r.db.WithContext(ctx).Model(&model.CLIDeviceCode{}).
		Where("user_code = ? AND status = ? AND expires_at > ?", userCode, model.CLIDevicePending, now).
		Updates(map[string]any{
			"status":      model.CLIDeviceApproved,
			"user_id":     userID,
			"approved_at": now,
			"updated_at":  now,
		})
	return res.RowsAffected > 0, res.Error
}

// Deny 把还没有被取走令牌的申请置为拒绝。
func (r *CLIDeviceRepository) Deny(ctx context.Context, userCode string, now time.Time) (bool, error) {
	res := r.db.WithContext(ctx).Model(&model.CLIDeviceCode{}).
		Where("user_code = ? AND status IN ?", userCode, []string{model.CLIDevicePending, model.CLIDeviceApproved}).
		Updates(map[string]any{"status": model.CLIDeviceDenied, "updated_at": now})
	return res.RowsAffected > 0, res.Error
}

// MarkPolled 记录一次轮询，供间隔限速判断。
func (r *CLIDeviceRepository) MarkPolled(ctx context.Context, id uint64, now time.Time) error {
	return r.db.WithContext(ctx).Model(&model.CLIDeviceCode{}).Where("id = ?", id).
		Updates(map[string]any{
			"last_polled_at": now,
			"poll_count":     gorm.Expr("poll_count + 1"),
			"updated_at":     now,
		}).Error
}

// Consume 原子地把 approved 改成 consumed。返回 false 表示已被取走（重放）或状态不对。
func (r *CLIDeviceRepository) Consume(ctx context.Context, id uint64, now time.Time) (bool, error) {
	res := r.db.WithContext(ctx).Model(&model.CLIDeviceCode{}).
		Where("id = ? AND status = ?", id, model.CLIDeviceApproved).
		Updates(map[string]any{
			"status":      model.CLIDeviceConsumed,
			"consumed_at": now,
			"updated_at":  now,
		})
	return res.RowsAffected > 0, res.Error
}

// DeleteExpired 物理删除过期记录，只保留 status 供排查；返回删除行数。
func (r *CLIDeviceRepository) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	res := r.db.WithContext(ctx).Where("expires_at < ?", before).Delete(&model.CLIDeviceCode{})
	return res.RowsAffected, res.Error
}
