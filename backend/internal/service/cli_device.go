package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/repository"
)

// 设备授权的默认参数。TTL 比一次性验证码长很多：用户可能要先登录再回来确认。
const (
	cliDeviceDefaultTTL      = 10 * time.Minute
	cliDeviceDefaultInterval = 5 * time.Second
	cliUserCodeLen           = 8
)

// DefaultCLITokenTTL 是命令行登录态的默认有效期（30 天）。
// 设备码只管「这次确认多久内有效」，登录态管「确认之后能免登录用多久」，两者不是一个数：
// 前者 10 分钟，后者 30 天。后台「注册设置 → 命令行登录有效期」可改后者。
const DefaultCLITokenTTL = 30 * 24 * time.Hour

// 用户码字符集：去掉元音（避免拼出单词）和易混字符（0/O、1/I/L）。
// 30^8 的空间足够，配合 10 分钟过期与轮询限速，猜不中。
const cliUserCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ23456789"

// cliDeviceVerificationPath 是授权页路径，CLI 用自己的站点根拼成完整 URL。
const cliDeviceVerificationPath = "/cli/authorize"

// CLIDeviceRepo 是设备授权服务的数据访问接口（真实实现是 repository.CLIDeviceRepository）。
type CLIDeviceRepo interface {
	Create(ctx context.Context, c *model.CLIDeviceCode) error
	GetByHash(ctx context.Context, hash string) (*model.CLIDeviceCode, error)
	GetByUserCode(ctx context.Context, code string) (*model.CLIDeviceCode, error)
	Approve(ctx context.Context, userCode string, userID uint64, now time.Time) (bool, error)
	Deny(ctx context.Context, userCode string, now time.Time) (bool, error)
	MarkPolled(ctx context.Context, id uint64, now time.Time) error
	Consume(ctx context.Context, id uint64, now time.Time) (bool, error)
}

// CLIDeviceUserReader 查询授权时的用户，用于确认账号仍然存在且未被停用。
type CLIDeviceUserReader interface {
	GetByID(ctx context.Context, id uint64) (*model.User, error)
}

// CLIDeviceTokenIssuer 签发登录 JWT；实现是 UserService，保证与网页登录同一套 token_version 语义。
type CLIDeviceTokenIssuer interface {
	IssueToken(u *model.User) (*model.LoginView, error)
	// IssueTokenWithTTL 按指定有效期签发：命令行登录态用后台配置的天数，不是网页的 72 小时。
	IssueTokenWithTTL(u *model.User, ttl time.Duration) (*model.LoginView, error)
}

// CLITokenPolicy 提供命令行登录态的有效期（天）。后台「注册设置」是唯一来源。
type CLITokenPolicy interface {
	CLITokenDays(ctx context.Context) (int, error)
}

// CLIDeviceDeps 是设备授权服务的依赖与配置。
type CLIDeviceDeps struct {
	Repo   CLIDeviceRepo
	Users  CLIDeviceUserReader
	Issuer CLIDeviceTokenIssuer
	Now    func() time.Time
	TTL    time.Duration
	// Interval 是同一设备码两次轮询的最小间隔，也是返回给 CLI 的 interval。
	Interval time.Duration
	// TokenDays 读命令行登录态的有效期；为空或读取失败时按 DefaultCLITokenTTL（30 天）。
	TokenDays CLITokenPolicy
}

// CLIDeviceService 负责命令行设备授权的申请、轮询换令牌与网页确认。
type CLIDeviceService struct {
	CLIDeviceDeps
}

func NewCLIDeviceService(deps CLIDeviceDeps) *CLIDeviceService {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.TTL <= 0 {
		deps.TTL = cliDeviceDefaultTTL
	}
	if deps.Interval <= 0 {
		deps.Interval = cliDeviceDefaultInterval
	}
	return &CLIDeviceService{CLIDeviceDeps: deps}
}

// Start 生成一对码：device_code 给 CLI 轮询，user_code 给用户抄到网页上。
func (s *CLIDeviceService) Start(ctx context.Context, clientName string) (*model.CLIDeviceStartView, error) {
	deviceCode, err := randomURLToken(32)
	if err != nil {
		return nil, err
	}
	userCode, err := s.uniqueUserCode(ctx)
	if err != nil {
		return nil, err
	}
	now := s.Now()
	rec := &model.CLIDeviceCode{
		DeviceCodeHash:  hashDeviceCode(deviceCode),
		UserCode:        userCode,
		ClientName:      strings.TrimSpace(clientName),
		Status:          model.CLIDevicePending,
		IntervalSeconds: int(s.Interval.Seconds()),
		ExpiresAt:       now.Add(s.TTL),
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.Repo.Create(ctx, rec); err != nil {
		return nil, err
	}
	return &model.CLIDeviceStartView{
		DeviceCode:              deviceCode,
		UserCode:                formatUserCode(userCode),
		VerificationURI:         cliDeviceVerificationPath,
		VerificationURIComplete: cliDeviceVerificationPath + "?code=" + formatUserCode(userCode),
		ExpiresIn:               int(s.TTL.Seconds()),
		Interval:                int(s.Interval.Seconds()),
	}, nil
}

// Poll 是 CLI 的轮询入口。除「设备码本身无效」外都返回 200 + status，让调用方只看一个字段。
//
// 顺序很重要：先确认状态再限速。用户刚确认完就轮询时，不该因为间隔没到而多等一轮。
func (s *CLIDeviceService) Poll(ctx context.Context, deviceCode string) (*model.CLIDevicePollView, error) {
	deviceCode = strings.TrimSpace(deviceCode)
	if deviceCode == "" {
		return nil, errcode.ErrCLIDeviceInvalid
	}
	rec, err := s.Repo.GetByHash(ctx, hashDeviceCode(deviceCode))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, errcode.ErrCLIDeviceInvalid
		}
		return nil, err
	}
	now := s.Now()
	if now.After(rec.ExpiresAt) {
		return &model.CLIDevicePollView{Status: "expired"}, nil
	}

	switch rec.Status {
	case model.CLIDeviceDenied:
		return &model.CLIDevicePollView{Status: "denied"}, nil
	case model.CLIDeviceConsumed:
		return &model.CLIDevicePollView{Status: "consumed"}, nil
	case model.CLIDeviceApproved:
		return s.consume(ctx, rec, now)
	case model.CLIDevicePending:
		if rec.LastPolledAt != nil && now.Sub(*rec.LastPolledAt) < s.Interval {
			return &model.CLIDevicePollView{Status: "slow_down", Interval: int(s.Interval.Seconds())}, nil
		}
		if err := s.Repo.MarkPolled(ctx, rec.ID, now); err != nil {
			return nil, err
		}
		return &model.CLIDevicePollView{Status: "pending", Interval: int(s.Interval.Seconds())}, nil
	default:
		return nil, errcode.ErrCLIDeviceState
	}
}

// consume 把已批准的申请换成 JWT。并发轮询只有一个能成功，其余按 consumed 回。
func (s *CLIDeviceService) consume(ctx context.Context, rec *model.CLIDeviceCode, now time.Time) (*model.CLIDevicePollView, error) {
	if rec.UserID == nil {
		return nil, errcode.ErrCLIDeviceState
	}
	ok, err := s.Repo.Consume(ctx, rec.ID, now)
	if err != nil {
		return nil, err
	}
	if !ok {
		return &model.CLIDevicePollView{Status: "consumed"}, nil
	}
	user, err := s.Users.GetByID(ctx, *rec.UserID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, errcode.ErrCLIDeviceInvalid
		}
		return nil, err
	}
	if user.Status != model.UserStatusActive {
		return nil, errcode.ErrCLIDeviceDisabled
	}
	view, err := s.Issuer.IssueTokenWithTTL(user, s.tokenTTL(ctx))
	if err != nil {
		return nil, err
	}
	return &model.CLIDevicePollView{
		Status:   "approved",
		Token:    view.Token,
		ExpireAt: view.ExpireAt,
		Role:     view.Role,
	}, nil
}

// tokenTTL 取命令行登录态的有效期：后台设置优先，读不到（或值非法）就按 30 天。
// 这里**不读** mcp_token_days / mcp_call_timeout：那是外部接入令牌与单次调用超时，跟登录态没关系。
func (s *CLIDeviceService) tokenTTL(ctx context.Context) time.Duration {
	if s.TokenDays == nil {
		return DefaultCLITokenTTL
	}
	days, err := s.TokenDays.CLITokenDays(ctx)
	if err != nil || days <= 0 {
		return DefaultCLITokenTTL
	}
	return time.Duration(days) * 24 * time.Hour
}

// Describe 给授权页展示设备信息。只认未过期的用户码，不泄露发起方 IP 等环境信息。
func (s *CLIDeviceService) Describe(ctx context.Context, userCode string) (*model.CLIDeviceDescribeView, error) {
	rec, err := s.byUserCode(ctx, userCode)
	if err != nil {
		return nil, err
	}
	status := rec.Status
	if s.Now().After(rec.ExpiresAt) {
		status = "expired"
	}
	return &model.CLIDeviceDescribeView{
		UserCode:   formatUserCode(rec.UserCode),
		ClientName: rec.ClientName,
		Status:     status,
		CreatedAt:  rec.CreatedAt,
		ExpiresAt:  rec.ExpiresAt,
	}, nil
}

// Approve 让当前登录用户确认授权。同一个用户重复确认是幂等的，换一个用户则拒绝。
func (s *CLIDeviceService) Approve(ctx context.Context, userID uint64, userCode string) error {
	code, err := s.byUserCode(ctx, userCode)
	if err != nil {
		return err
	}
	switch code.Status {
	case model.CLIDevicePending:
		ok, err := s.Repo.Approve(ctx, code.UserCode, userID, s.Now())
		if err != nil {
			return err
		}
		if !ok {
			return errcode.ErrCLIDeviceUserCode
		}
		return nil
	case model.CLIDeviceApproved:
		if code.UserID != nil && *code.UserID == userID {
			return nil
		}
		return errcode.ErrCLIDeviceState
	default:
		return errcode.ErrCLIDeviceState
	}
}

// Deny 让当前登录用户拒绝授权。
func (s *CLIDeviceService) Deny(ctx context.Context, userCode string) error {
	code, err := s.byUserCode(ctx, userCode)
	if err != nil {
		return err
	}
	ok, err := s.Repo.Deny(ctx, code.UserCode, s.Now())
	if err != nil {
		return err
	}
	if !ok {
		return errcode.ErrCLIDeviceState
	}
	return nil
}

// byUserCode 统一做「规范化 + 存在性 + 过期」检查，避免三个入口各写一遍。
func (s *CLIDeviceService) byUserCode(ctx context.Context, userCode string) (*model.CLIDeviceCode, error) {
	code := normalizeUserCode(userCode)
	if code == "" {
		return nil, errcode.ErrCLIDeviceUserCode
	}
	rec, err := s.Repo.GetByUserCode(ctx, code)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, errcode.ErrCLIDeviceUserCode
		}
		return nil, err
	}
	if s.Now().After(rec.ExpiresAt) {
		return nil, errcode.ErrCLIDeviceUserCode
	}
	return rec, nil
}

// uniqueUserCode 生成一个没被占用的用户码。撞车概率极低，重试几次足够。
func (s *CLIDeviceService) uniqueUserCode(ctx context.Context) (string, error) {
	for range 5 {
		code, err := randomUserCode()
		if err != nil {
			return "", err
		}
		if _, err := s.Repo.GetByUserCode(ctx, code); err != nil {
			if errors.Is(err, repository.ErrNotFound) {
				return code, nil
			}
			return "", err
		}
	}
	return "", errcode.ErrInternal
}

// randomURLToken 生成 n 字节随机数并做 base64url（无填充），长度约 4n/3。
func randomURLToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// randomUserCode 生成 8 位用户码（不带连字符）。
func randomUserCode() (string, error) {
	buf := make([]byte, cliUserCodeLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, cliUserCodeLen)
	for i, b := range buf {
		out[i] = cliUserCodeAlphabet[int(b)%len(cliUserCodeAlphabet)]
	}
	return string(out), nil
}

// hashDeviceCode 统一设备码的存储与查询口径。
func hashDeviceCode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// formatUserCode 把库里存的 8 位码展示成 ABCD-EFGH，方便用户照着念。
func formatUserCode(code string) string {
	if len(code) != cliUserCodeLen {
		return code
	}
	return code[:4] + "-" + code[4:]
}

// normalizeUserCode 去掉用户输入里的连字符、空格并转大写，兼容大小写和复制粘贴。
func normalizeUserCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(code)) {
		if r == '-' || r == ' ' || r == '\t' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
