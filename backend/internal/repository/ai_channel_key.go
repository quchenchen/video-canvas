package repository

import (
	"context"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"video-canvas/internal/model"
)

// 渠道的多 Key 槽位（ai_channel_keys）：密文在 ai_secrets，这里只读写元信息。

// ListChannelKeys 返回渠道的全部 Key 槽位，按 slot 升序。渠道不存在时返回空切片（由 service 先校验渠道）。
func (r *AIChannelRepository) ListChannelKeys(ctx context.Context, channelKey string) ([]model.AIChannelKey, error) {
	rows := make([]model.AIChannelKey, 0, 4)
	err := r.db.WithContext(ctx).Where("channel_key = ?", channelKey).Order("slot").Find(&rows).Error
	return rows, err
}

// CountEnabledChannelKeys 返回渠道启用的槽位数：并发额度与轮转都按它算，停用的槽位不参与。
func (r *AIChannelRepository) CountEnabledChannelKeys(ctx context.Context, channelKey string) (int, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.AIChannelKey{}).
		Where("channel_key = ? AND enabled", channelKey).Count(&n).Error
	return int(n), err
}

// AddChannelKey 插入一个槽位：在同一事务里先锁渠道行，再取 MAX(slot)+1，避免并发添加拿到同一个槽位号。
// 渠道不存在返回 ErrNotFound（锁行时拿不到）。
func (r *AIChannelRepository) AddChannelKey(ctx context.Context, k *model.AIChannelKey) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1. 锁渠道行：同渠道的并发添加在这里串行
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("key").
			Where("key = ?", k.ChannelKey).First(&model.AIChannel{}).Error; err != nil {
			return translate(err)
		}
		// 2. 取下一个槽位号；删掉中间某把后不重排，序号只增不减
		var maxSlot int
		if err := tx.Raw(`SELECT COALESCE(MAX(slot), 0) FROM ai_channel_keys WHERE channel_key = ?`, k.ChannelKey).
			Scan(&maxSlot).Error; err != nil {
			return err
		}
		k.Slot = maxSlot + 1
		return tx.Create(k).Error
	})
}

// UpdateChannelKey 更新槽位的备注与启用状态（nil 表示不改）；槽位不存在返回 ErrNotFound。
func (r *AIChannelRepository) UpdateChannelKey(ctx context.Context, channelKey string, slot int, remark *string, enabled *bool) error {
	updates := map[string]any{}
	if remark != nil {
		updates["remark"] = *remark
	}
	if enabled != nil {
		updates["enabled"] = *enabled
	}
	if len(updates) == 0 {
		return nil
	}
	res := r.db.WithContext(ctx).Model(&model.AIChannelKey{}).
		Where("channel_key = ? AND slot = ?", channelKey, slot).Updates(updates)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteChannelKey 删除槽位的元信息；槽位不存在返回 ErrNotFound。密文由 service 在同一流程里删。
func (r *AIChannelRepository) DeleteChannelKey(ctx context.Context, channelKey string, slot int) error {
	res := r.db.WithContext(ctx).Where("channel_key = ? AND slot = ?", channelKey, slot).Delete(&model.AIChannelKey{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

// FillChannelKeyHint 补写末四位提示（升级回填的行 hint 为空，服务读到明文后补上）。
func (r *AIChannelRepository) FillChannelKeyHint(ctx context.Context, channelKey string, slot int, hint string) error {
	return r.db.WithContext(ctx).Model(&model.AIChannelKey{}).
		Where("channel_key = ? AND slot = ? AND hint = ''", channelKey, slot).
		UpdateColumn("hint", hint).Error
}

// SetChannelKeyHint 覆盖末四位提示：主 Key 被替换后旧的四位已经不对了。
func (r *AIChannelRepository) SetChannelKeyHint(ctx context.Context, channelKey string, slot int, hint string) error {
	return r.db.WithContext(ctx).Model(&model.AIChannelKey{}).
		Where("channel_key = ? AND slot = ?", channelKey, slot).
		UpdateColumn("hint", hint).Error
}
