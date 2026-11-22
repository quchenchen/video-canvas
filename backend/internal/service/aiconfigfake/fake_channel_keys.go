package aiconfigfake

import (
	"context"
	"sort"
	"time"

	"video-canvas/internal/model"
	"video-canvas/internal/repository"
)

// 渠道多 Key 槽位的内存实现，行为对齐 repository.AIChannelRepository。

// ListChannelKeys 返回渠道的槽位，按 slot 升序。
func (m *MemRepo) ListChannelKeys(_ context.Context, channelKey string) ([]model.AIChannelKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := append([]model.AIChannelKey(nil), m.ChannelKeys[channelKey]...)
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return out, nil
}

// CountEnabledChannelKeys 返回启用的槽位数。
func (m *MemRepo) CountEnabledChannelKeys(_ context.Context, channelKey string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, k := range m.ChannelKeys[channelKey] {
		if k.Enabled {
			n++
		}
	}
	return n, nil
}

// AddChannelKey 分配下一个槽位后插入；渠道不存在返回 ErrNotFound。
func (m *MemRepo) AddChannelKey(_ context.Context, k *model.AIChannelKey) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.Channels[k.ChannelKey]; !ok {
		return repository.ErrNotFound
	}
	maxSlot := 0
	for _, row := range m.ChannelKeys[k.ChannelKey] {
		if row.Slot > maxSlot {
			maxSlot = row.Slot
		}
	}
	k.Slot = maxSlot + 1
	now := time.Now()
	k.CreatedAt, k.UpdatedAt = now, now
	m.ChannelKeys[k.ChannelKey] = append(m.ChannelKeys[k.ChannelKey], *k)
	return nil
}

// UpdateChannelKey 更新备注 / 启停；槽位不存在返回 ErrNotFound。
func (m *MemRepo) UpdateChannelKey(_ context.Context, channelKey string, slot int, remark *string, enabled *bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.ChannelKeys[channelKey]
	for i := range rows {
		if rows[i].Slot != slot {
			continue
		}
		if remark != nil {
			rows[i].Remark = *remark
		}
		if enabled != nil {
			rows[i].Enabled = *enabled
		}
		rows[i].UpdatedAt = time.Now()
		m.ChannelKeys[channelKey] = rows
		return nil
	}
	return repository.ErrNotFound
}

// DeleteChannelKey 删除槽位；不存在返回 ErrNotFound。
func (m *MemRepo) DeleteChannelKey(_ context.Context, channelKey string, slot int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.ChannelKeys[channelKey]
	for i := range rows {
		if rows[i].Slot != slot {
			continue
		}
		m.ChannelKeys[channelKey] = append(rows[:i], rows[i+1:]...)
		return nil
	}
	return repository.ErrNotFound
}

// FillChannelKeyHint 只补空白的末四位。
func (m *MemRepo) FillChannelKeyHint(_ context.Context, channelKey string, slot int, hint string) error {
	return m.setChannelKeyHint(channelKey, slot, hint, true)
}

// SetChannelKeyHint 覆盖末四位。
func (m *MemRepo) SetChannelKeyHint(_ context.Context, channelKey string, slot int, hint string) error {
	return m.setChannelKeyHint(channelKey, slot, hint, false)
}

func (m *MemRepo) setChannelKeyHint(channelKey string, slot int, hint string, onlyEmpty bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.ChannelKeys[channelKey]
	for i := range rows {
		if rows[i].Slot != slot {
			continue
		}
		if onlyEmpty && rows[i].Hint != "" {
			return nil
		}
		rows[i].Hint = hint
		rows[i].UpdatedAt = time.Now()
		m.ChannelKeys[channelKey] = rows
		return nil
	}
	return repository.ErrNotFound
}

// SecretSlots 让 MemRepo 也能当 provider.SecretSlotResolver 用（测试里验证多 Key 轮转时注入宿主）。
func (m *MemRepo) SecretSlots(_ context.Context, channelKey string) ([]string, error) {
	rows, err := m.ListChannelKeys(context.Background(), channelKey)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []string{model.ChannelSecretName(channelKey)}, nil
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.Enabled {
			out = append(out, model.ChannelKeySecretName(channelKey, r.Slot))
		}
	}
	if len(out) == 0 {
		out = append(out, model.ChannelKeySecretName(channelKey, rows[0].Slot))
	}
	return out, nil
}
