package model

import "time"

// CLI 设备授权的状态。
//
// pending  → 用户在网页上确认之前
// approved → 用户已确认，等 CLI 下一次轮询取走 JWT
// consumed → 已取走，不能再用（重放防护）
// denied   → 用户拒绝
// 过期不是一个状态：看 expires_at，过期的记录一律按 expired 处理，由清理任务物理删除。
const (
	CLIDevicePending  = "pending"
	CLIDeviceApproved = "approved"
	CLIDeviceDenied   = "denied"
	CLIDeviceConsumed = "consumed"
)

// CLIDeviceCode 是命令行设备授权的一次申请。
//
// DeviceCodeHash 存 sha256，明文只在申请响应里出现一次：拿到库也换不出令牌。
// UserCode 是给人抄的短码（形如 ABCD-EFGH），授权页按它查，所以明文入库。
type CLIDeviceCode struct {
	ID              uint64     `gorm:"primaryKey" json:"id"`
	DeviceCodeHash  string     `gorm:"size:64;not null;uniqueIndex:uk_cli_device_codes_hash" json:"-"`
	UserCode        string     `gorm:"size:12;not null;uniqueIndex:uk_cli_device_codes_user_code" json:"user_code"`
	ClientName      string     `gorm:"size:64;not null;default:''" json:"client_name"`
	Status          string     `gorm:"size:16;not null;default:pending" json:"status"`
	UserID          *uint64    `gorm:"index:idx_cli_device_codes_user" json:"-"`
	IntervalSeconds int        `gorm:"not null;default:5" json:"-"`
	PollCount       int        `gorm:"not null;default:0" json:"-"`
	LastPolledAt    *time.Time `json:"-"`
	ExpiresAt       time.Time  `gorm:"not null;index:idx_cli_device_codes_expires_at" json:"expires_at"`
	ApprovedAt      *time.Time `json:"-"`
	ConsumedAt      *time.Time `json:"-"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"-"`
}

func (CLIDeviceCode) TableName() string { return "cli_device_codes" }

// CLIDeviceStartReq 是 POST /auth/cli/device 的请求体。client_name 只用于授权页展示。
type CLIDeviceStartReq struct {
	ClientName string `json:"client_name" binding:"omitempty,max=64" label:"客户端名称"`
}

// CLIDeviceStartView 是设备授权的申请结果。
//
// verification_uri 是站点内的相对路径，不拼域名：后端不知道对外域名，CLI 用自己连的
// API 地址去掉 /api/v1 就得到站点根，拼出来的地址一定是用户能打开的。
type CLIDeviceStartView struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// CLIDevicePollReq 是 POST /auth/cli/token 的请求体。
type CLIDevicePollReq struct {
	DeviceCode string `json:"device_code" binding:"required" label:"设备码"`
}

// CLIDevicePollView 是轮询结果。status 决定 CLI 的动作，HTTP 一律 200：
// 统一信封下再叠一层状态码，调用方要同时判断两套语义，容易写错。
type CLIDevicePollView struct {
	Status   string `json:"status"`
	Token    string `json:"token,omitempty"`
	ExpireAt int64  `json:"expire_at,omitempty"`
	Role     string `json:"role,omitempty"`
	Interval int    `json:"interval,omitempty"`
}

// CLIDeviceApproveReq 是确认 / 拒绝设备授权的请求体。
type CLIDeviceApproveReq struct {
	UserCode string `json:"user_code" binding:"required" label:"用户码"`
}

// CLIDeviceDescribeView 是授权页展示的设备信息，不含发起人身份（尚未绑定）。
type CLIDeviceDescribeView struct {
	UserCode   string    `json:"user_code"`
	ClientName string    `json:"client_name"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}
