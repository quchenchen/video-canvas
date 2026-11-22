package model

import (
	"strconv"
	"time"
)

// AIChannelKey 是渠道下一把 API Key 的元信息：密文与所有凭证一样加密存在 ai_secrets，
// 名字由 ChannelKeySecretName 给出；这里只存“第几把、末四位、备注、是否启用”。
//
// 一个渠道可以配多把 Key：上游按 Key 限并发时，N 把 Key 能让有效并发成倍放大；
// 请求按槽位轮转（见 provider/plugin 的 keypool），某把被上游限流或余额不足时先冷却、换下一把。
type AIChannelKey struct {
	ChannelKey string    `gorm:"primaryKey;size:64" json:"channel_key"`     // 所属渠道 key
	Slot       int       `gorm:"primaryKey;not null" json:"slot"`           // 槽位序号，1 起；稳定不变，删掉中间某把也不会重排
	Hint       string    `gorm:"size:16;not null;default:''" json:"hint"`   // Key 的末四位，只用于辨认，不含明文
	Remark     string    `gorm:"size:64;not null;default:''" json:"remark"` // 备注，如“账号 A”“测试专用”
	Enabled    bool      `gorm:"not null;default:true" json:"enabled"`      // 停用后不再被轮转选中，进行中的任务仍用它的槽位收尾
	CreatedAt  time.Time `json:"created_at"`                                // 创建时间
	UpdatedAt  time.Time `json:"updated_at"`                                // 更新时间
}

// TableName 指定表名。
func (AIChannelKey) TableName() string { return "ai_channel_keys" }

// ChannelKeySecretName 返回槽位 slot 的 API Key 在 ai_secrets 里的名字。
// 槽位 1 沿用历史名 channel:<渠道 key>，所以升级前已经设过 Key 的渠道不需要迁移数据；
// 槽位 2 起用 channel:<渠道 key>:key<N>。渠道 key 不含冒号，三者不会互相冲突。
func ChannelKeySecretName(channelKey string, slot int) string {
	if slot <= 1 {
		return ChannelSecretName(channelKey)
	}
	return ChannelSecretName(channelKey) + ":key" + strconv.Itoa(slot)
}
