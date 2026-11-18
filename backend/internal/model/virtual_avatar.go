package model

import (
	"time"

	"video-canvas/internal/pkg/idcodec" //nolint:depguard // 对外 ID 统一用十六进制串，与画布、短剧一致（同 marketing.go）
)

// 虚拟人像库备案状态。
const (
	FilingNone    = "none"    // 未备案
	FilingPending = "pending" // 已提交，等待方舟处理
	FilingActive  = "active"  // 方舟备案完成（Asset Status=Active）
	FilingFailed  = "failed"  // 备案失败，可重试
)

// 虚拟人像库的来源类型：与来源解耦，删归集不碰来源。
const (
	VirtualAvatarSourceDrama   = "drama_character" // 短剧画布里的拆解角色卡节点
	VirtualAvatarSourceLibrary = "library_asset"   // 个人资产库里的图片条目
)

// VirtualAvatar 是归集进虚拟人像库的一条角色图片，统一走方舟备案。
// 备案走模型配置：filing_model_key 指向开启了 body.filing.enabled 的视频模型，
// AK/SK 从 ai_secrets（filing:<model_key>:access_key / :secret_key）读取。
type VirtualAvatar struct {
	ID             idcodec.ID `gorm:"primaryKey" json:"id"` // 对外十六进制串，与全项目 ID 约定一致
	UserID         uint64     `gorm:"not null;index:idx_virtual_avatars_user;uniqueIndex:uk_virtual_avatar_source,priority:1" json:"user_id"`
	SourceType     string     `gorm:"size:24;not null;uniqueIndex:uk_virtual_avatar_source,priority:2" json:"source_type"`
	SourceRef      string     `gorm:"size:128;not null;uniqueIndex:uk_virtual_avatar_source,priority:3" json:"source_ref"`
	Name           string     `gorm:"size:255;not null;default:''" json:"name"`
	AssetID        string     `gorm:"size:64;not null;default:''" json:"asset_id"`
	URL            string     `gorm:"type:text;not null;default:''" json:"url"`
	FilingStatus   string     `gorm:"size:16;not null;default:none" json:"filing_status"`
	FilingModelKey string     `gorm:"size:128;not null;default:''" json:"filing_model_key"`
	ArkAssetID     string     `gorm:"size:128;not null;default:''" json:"ark_asset_id"`
	Error          string     `gorm:"type:text;not null;default:''" json:"error,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// TableName 指定表名。
func (VirtualAvatar) TableName() string { return "virtual_avatars" }

// FilingSecretName 返回某个模型的备案 AccessKey 在 ai_secrets 里的名字。
func FilingSecretName(modelKey string) string { return "filing:" + modelKey + ":access_key" }

// FilingSecretKeyName 返回某个模型的备案 SecretKey 在 ai_secrets 里的名字。
// 两者成对出现，改名前缀要一起改，否则老模型的凭据会读不到。
func FilingSecretKeyName(modelKey string) string { return "filing:" + modelKey + ":secret_key" }
