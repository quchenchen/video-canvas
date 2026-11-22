package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/logger"
	"video-canvas/internal/repository"
)

// 多 Key 的限制，与 ai_channel_keys 的列宽一致。
const (
	// maxChannelKeys 是单渠道最多能配的 Key 数：上游按 Key 限并发时，够测试放大即可，再多多半是误粘。
	maxChannelKeys = 10
	// channelKeyRemarkMaxLen 是备注的长度上限。
	channelKeyRemarkMaxLen = 64
	// channelKeyHintLen 是回显给运营辨认的末四位长度。
	channelKeyHintLen = 4
)

// ChannelKeyView 是一把 Key 的管理端视图：只有槽位、末四位、备注与启停，永远不含明文。
type ChannelKeyView struct {
	Slot      int       `json:"slot"`
	Hint      string    `json:"hint"`
	Remark    string    `json:"remark"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ChannelKeyInput 是新增一把 Key 的参数。
type ChannelKeyInput struct {
	Value  string // 明文，只在这条链路上存在，加密入库后不再回读
	Remark string
}

// ListKeys 返回渠道的 Key 槽位。升级回填的行没有末四位，这里解密补上并写回（只输出末四位，不含明文）。
func (s *AIChannelService) ListKeys(ctx context.Context, key string) ([]ChannelKeyView, error) {
	if _, err := s.load(ctx, key); err != nil {
		return nil, err
	}
	rows, err := s.repo.ListChannelKeys(ctx, key)
	if err != nil {
		return nil, err
	}
	out := make([]ChannelKeyView, 0, len(rows))
	for _, r := range rows {
		if r.Hint == "" {
			if hint := s.keyHint(ctx, key, r.Slot); hint != "" {
				r.Hint = hint
				// 补不上不影响展示，下次读还会再试
				if err := s.repo.FillChannelKeyHint(ctx, key, r.Slot, hint); err != nil {
					logger.Warn("补写渠道 Key 末四位失败", zap.String("channel", key), zap.Int("slot", r.Slot), zap.Error(err))
				}
			}
		}
		out = append(out, ChannelKeyView{
			Slot: r.Slot, Hint: r.Hint, Remark: r.Remark, Enabled: r.Enabled,
			CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		})
	}
	return out, nil
}

// AddKey 给渠道新增一把 Key：占一个槽位、加密写入 ai_secrets，然后刷新 Registry。
// 槽位先占、密文后写：密文写失败时把槽位删掉，避免留下“有空槽没 Key”的记录。
func (s *AIChannelService) AddKey(ctx context.Context, actorID uint64, key string, in ChannelKeyInput) (*ChannelKeyView, error) {
	// 1. 渠道必须存在，否则会写出没有主人的凭证
	if _, err := s.load(ctx, key); err != nil {
		return nil, err
	}
	// 2. 参数：粘贴时常带换行，先去掉首尾空白
	value := strings.TrimSpace(in.Value)
	if value == "" {
		return nil, errcode.ErrInvalidParams.WithMsg("API Key 不能为空")
	}
	if len(value) > aiSecretMaxLen {
		return nil, errcode.ErrInvalidParams.WithMsg(fmt.Sprintf("API Key 不能超过 %d 字节", aiSecretMaxLen))
	}
	remark := strings.TrimSpace(in.Remark)
	if len(remark) > channelKeyRemarkMaxLen {
		return nil, errcode.ErrInvalidParams.WithMsg(fmt.Sprintf("备注不能超过 %d 个字符", channelKeyRemarkMaxLen))
	}
	// 3. 数量上限（并发额度按 Key 数放大，不能无限加）
	rows, err := s.repo.ListChannelKeys(ctx, key)
	if err != nil {
		return nil, err
	}
	if len(rows) >= maxChannelKeys {
		return nil, errcode.ErrInvalidParams.WithMsg(fmt.Sprintf("单个渠道最多配 %d 把 Key，请先删除不用的", maxChannelKeys))
	}
	// 4. 占槽位
	row := &model.AIChannelKey{ChannelKey: key, Hint: hintOf(value), Remark: remark, Enabled: true}
	err = s.repo.AddChannelKey(ctx, row)
	if errors.Is(err, repository.ErrNotFound) {
		return nil, errcode.ErrChannelNotFound
	}
	if err != nil {
		return nil, err
	}
	// 5. 加密入库；失败回滚槽位
	if err := s.secrets.SetSecret(ctx, model.ChannelKeySecretName(key, row.Slot), value, actorID); err != nil {
		if delErr := s.repo.DeleteChannelKey(ctx, key, row.Slot); delErr != nil {
			logger.Warn("回滚渠道 Key 槽位失败", zap.String("channel", key), zap.Int("slot", row.Slot), zap.Error(delErr))
		}
		return nil, err
	}
	// 6. 审计（只记槽位）与热生效
	aiAudit(ctx, s.audit, actorID, model.AuditChannelKeyAdd, model.AuditTargetChannel, key, map[string]any{"slot": row.Slot})
	s.secrets.ForgetChannelSlots(key)
	s.notifyChanged(ctx, "channel key add "+key)
	return &ChannelKeyView{
		Slot: row.Slot, Hint: row.Hint, Remark: row.Remark, Enabled: true,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}, nil
}

// UpdateKey 修改一把 Key 的备注与启停（nil 表示不改）。
// 不允许停用最后一把启用的 Key：那会让渠道立刻不可用，运营多半是想“换一把”而不是“全关”。
func (s *AIChannelService) UpdateKey(ctx context.Context, actorID uint64, key string, slot int, remark *string, enabled *bool) (*ChannelKeyView, error) {
	// 1. 渠道与槽位都要存在
	if _, err := s.load(ctx, key); err != nil {
		return nil, err
	}
	rows, err := s.repo.ListChannelKeys(ctx, key)
	if err != nil {
		return nil, err
	}
	target := findSlot(rows, slot)
	if target == nil {
		return nil, errcode.ErrInvalidParams.WithMsg("这把 Key 不存在，请刷新后重试")
	}
	// 2. 参数
	var clean *string
	if remark != nil {
		v := strings.TrimSpace(*remark)
		if len(v) > channelKeyRemarkMaxLen {
			return nil, errcode.ErrInvalidParams.WithMsg(fmt.Sprintf("备注不能超过 %d 个字符", channelKeyRemarkMaxLen))
		}
		clean = &v
	}
	// 3. 拒绝停用最后一把启用的 Key
	if enabled != nil && !*enabled && target.Enabled && countEnabled(rows) <= 1 {
		return nil, errcode.ErrInvalidParams.WithMsg("至少要保留一把启用的 Key，请先添加新的再停用这把")
	}
	// 4. 写库（remark / enabled 都没传时直接返回当前视图）
	err = s.repo.UpdateChannelKey(ctx, key, slot, clean, enabled)
	if errors.Is(err, repository.ErrNotFound) {
		return nil, errcode.ErrInvalidParams.WithMsg("这把 Key 不存在，请刷新后重试")
	}
	if err != nil {
		return nil, err
	}
	// 5. 审计与热生效：启用状态影响槽位列表，进而影响并发倍乘
	detail := map[string]any{"slot": slot}
	if enabled != nil {
		detail["enabled"] = *enabled
	}
	aiAudit(ctx, s.audit, actorID, model.AuditChannelKeyUpdate, model.AuditTargetChannel, key, detail)
	s.secrets.ForgetChannelSlots(key)
	s.notifyChanged(ctx, "channel key update "+key)
	// 6. 返回最新状态
	rows, err = s.repo.ListChannelKeys(ctx, key)
	if err != nil {
		return nil, err
	}
	if latest := findSlot(rows, slot); latest != nil {
		return &ChannelKeyView{Slot: latest.Slot, Hint: latest.Hint, Remark: latest.Remark, Enabled: latest.Enabled,
			CreatedAt: latest.CreatedAt, UpdatedAt: latest.UpdatedAt}, nil
	}
	return nil, errcode.ErrInvalidParams.WithMsg("这把 Key 不存在，请刷新后重试")
}

// DeleteKey 删除一把 Key：先删槽位元信息（它决定了轮转与并发），再删密文。
// 密文删除失败只留一条取不到的加密记录（没有槽位就轮不到它），记警告而不让接口失败。
func (s *AIChannelService) DeleteKey(ctx context.Context, actorID uint64, key string, slot int) error {
	if _, err := s.load(ctx, key); err != nil {
		return err
	}
	err := s.repo.DeleteChannelKey(ctx, key, slot)
	if errors.Is(err, repository.ErrNotFound) {
		return errcode.ErrInvalidParams.WithMsg("这把 Key 不存在，请刷新后重试")
	}
	if err != nil {
		return err
	}
	// 清掉本实例明文缓存与密文
	if err := s.secrets.DeleteSecret(ctx, model.ChannelKeySecretName(key, slot)); err != nil {
		logger.Warn("删除渠道 Key 密文失败，槽位已不可用", zap.String("channel", key), zap.Int("slot", slot), zap.Error(err))
	}
	aiAudit(ctx, s.audit, actorID, model.AuditChannelKeyDelete, model.AuditTargetChannel, key, map[string]any{"slot": slot})
	s.secrets.ForgetChannelSlots(key)
	s.notifyChanged(ctx, "channel key delete "+key)
	return nil
}

// primaryKey 返回「主 Key」的槽位与凭证名：最小槽位里第一把启用的；全都停用时退回最小槽位。
// slot 为 0 表示这个渠道还没有槽位行（迁移回填之前的渠道），此时凭证名是历史的 channel:<key>。
func (s *AIChannelService) primaryKey(ctx context.Context, key string) (int, string, error) {
	rows, err := s.repo.ListChannelKeys(ctx, key)
	if err != nil {
		return 0, "", err
	}
	for _, r := range rows {
		if r.Enabled {
			return r.Slot, model.ChannelKeySecretName(key, r.Slot), nil
		}
	}
	if len(rows) > 0 {
		return rows[0].Slot, model.ChannelKeySecretName(key, rows[0].Slot), nil
	}
	return 0, model.ChannelSecretName(key), nil
}

// primarySecretName 只取主 Key 的凭证名（拉模型、测连通性用）。
func (s *AIChannelService) primarySecretName(ctx context.Context, key string) (string, error) {
	_, name, err := s.primaryKey(ctx, key)
	return name, err
}

// keyHint 解密一把 Key 取末四位；取不到或太短返回空串（展示时按“已设置”处理）。
func (s *AIChannelService) keyHint(ctx context.Context, key string, slot int) string {
	plain, err := s.secrets.Get(ctx, model.ChannelKeySecretName(key, slot))
	if err != nil {
		return ""
	}
	return hintOf(plain)
}

// hintOf 取明文的末四位；短于四位时全部遮掉，不退化成明文。
func hintOf(plain string) string {
	plain = strings.TrimSpace(plain)
	if len(plain) <= channelKeyHintLen {
		if plain == "" {
			return ""
		}
		return strings.Repeat("*", len(plain))
	}
	return plain[len(plain)-channelKeyHintLen:]
}

// findSlot 在槽位列表里找指定槽位。
func findSlot(rows []model.AIChannelKey, slot int) *model.AIChannelKey {
	for i := range rows {
		if rows[i].Slot == slot {
			return &rows[i]
		}
	}
	return nil
}

// countEnabled 数启用的槽位。
func countEnabled(rows []model.AIChannelKey) int {
	n := 0
	for _, r := range rows {
		if r.Enabled {
			n++
		}
	}
	return n
}
