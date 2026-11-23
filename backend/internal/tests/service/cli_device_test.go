package service_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/utils"
	"video-canvas/internal/repository"
	. "video-canvas/internal/service"
)

// fakeCLIDeviceRepo 是内存版设备授权存储：只实现状态机需要的条件更新语义。
type fakeCLIDeviceRepo struct {
	rows   map[uint64]*model.CLIDeviceCode
	nextID uint64
}

func newFakeCLIDeviceRepo() *fakeCLIDeviceRepo {
	return &fakeCLIDeviceRepo{rows: map[uint64]*model.CLIDeviceCode{}}
}

func (r *fakeCLIDeviceRepo) Create(_ context.Context, c *model.CLIDeviceCode) error {
	r.nextID++
	c.ID = r.nextID
	cp := *c
	r.rows[c.ID] = &cp
	return nil
}

func (r *fakeCLIDeviceRepo) GetByHash(_ context.Context, hash string) (*model.CLIDeviceCode, error) {
	for _, row := range r.rows {
		if row.DeviceCodeHash == hash {
			cp := *row
			return &cp, nil
		}
	}
	return nil, repository.ErrNotFound
}

func (r *fakeCLIDeviceRepo) GetByUserCode(_ context.Context, code string) (*model.CLIDeviceCode, error) {
	for _, row := range r.rows {
		if row.UserCode == code {
			cp := *row
			return &cp, nil
		}
	}
	return nil, repository.ErrNotFound
}

func (r *fakeCLIDeviceRepo) Approve(_ context.Context, userCode string, userID uint64, now time.Time) (bool, error) {
	row := r.byCode(userCode)
	if row == nil || row.Status != model.CLIDevicePending || !now.Before(row.ExpiresAt) {
		return false, nil
	}
	row.Status = model.CLIDeviceApproved
	row.UserID = &userID
	row.ApprovedAt = &now
	return true, nil
}

func (r *fakeCLIDeviceRepo) Deny(_ context.Context, userCode string, _ time.Time) (bool, error) {
	row := r.byCode(userCode)
	if row == nil || (row.Status != model.CLIDevicePending && row.Status != model.CLIDeviceApproved) {
		return false, nil
	}
	row.Status = model.CLIDeviceDenied
	return true, nil
}

func (r *fakeCLIDeviceRepo) MarkPolled(_ context.Context, id uint64, now time.Time) error {
	if row := r.rows[id]; row != nil {
		row.LastPolledAt = &now
		row.PollCount++
	}
	return nil
}

func (r *fakeCLIDeviceRepo) Consume(_ context.Context, id uint64, now time.Time) (bool, error) {
	row := r.rows[id]
	if row == nil || row.Status != model.CLIDeviceApproved {
		return false, nil
	}
	row.Status = model.CLIDeviceConsumed
	row.ConsumedAt = &now
	return true, nil
}

func (r *fakeCLIDeviceRepo) byCode(code string) *model.CLIDeviceCode {
	for _, row := range r.rows {
		if row.UserCode == code {
			return row
		}
	}
	return nil
}

type fakeCLIUsers struct {
	users map[uint64]*model.User
}

func (f *fakeCLIUsers) GetByID(_ context.Context, id uint64) (*model.User, error) {
	u, ok := f.users[id]
	if !ok {
		return nil, repository.ErrNotFound
	}
	return u, nil
}

type fakeIssuer struct{}

func (fakeIssuer) IssueToken(u *model.User) (*model.LoginView, error) {
	tok, exp, err := utils.GenerateToken(uint(u.ID), u.Username, u.TokenVersion, testJWTSecret, "test", 1)
	if err != nil {
		return nil, err
	}
	return &model.LoginView{Token: tok, ExpireAt: exp, Role: u.Role}, nil
}

type cliEnv struct {
	svc  *CLIDeviceService
	repo *fakeCLIDeviceRepo
	now  time.Time
}

func newCLIEnv(t *testing.T) *cliEnv {
	t.Helper()
	now := time.Date(2026, 11, 23, 10, 0, 0, 0, time.UTC)
	repo := newFakeCLIDeviceRepo()
	users := &fakeCLIUsers{users: map[uint64]*model.User{
		7: {BaseModel: model.BaseModel{ID: 7}, Username: "alice", Role: model.RoleUser, Status: model.UserStatusActive},
		8: {BaseModel: model.BaseModel{ID: 8}, Username: "banned", Role: model.RoleUser, Status: model.UserStatusDisabled},
	}}
	clock := now
	svc := NewCLIDeviceService(CLIDeviceDeps{
		Repo: repo, Users: users, Issuer: fakeIssuer{},
		Now: func() time.Time { return clock },
	})
	return &cliEnv{svc: svc, repo: repo, now: now}
}

func TestCLIDeviceStart(t *testing.T) {
	env := newCLIEnv(t)
	view, err := env.svc.Start(context.Background(), "video-canvas-cli")
	if err != nil {
		t.Fatal(err)
	}
	if view.DeviceCode == "" || len(view.UserCode) != 9 || view.UserCode[4] != '-' {
		t.Fatalf("码格式不对：%+v", view)
	}
	if view.VerificationURI != "/cli/authorize" || !strings.Contains(view.VerificationURIComplete, "?code=") {
		t.Fatalf("授权地址不对：%+v", view)
	}
	if view.ExpiresIn <= 0 || view.Interval <= 0 {
		t.Fatalf("有效期与间隔应为正数：%+v", view)
	}
	// 库里只能有哈希，不能落设备码明文
	for _, row := range env.repo.rows {
		if row.DeviceCodeHash == view.DeviceCode || strings.Contains(row.DeviceCodeHash, view.DeviceCode) {
			t.Fatal("库里不应存设备码明文")
		}
		if row.ClientName != "video-canvas-cli" || row.Status != model.CLIDevicePending {
			t.Fatalf("初始记录不对：%+v", row)
		}
	}
}

func TestCLIDevicePollPendingAndSlowDown(t *testing.T) {
	env := newCLIEnv(t)
	ctx := context.Background()
	start, err := env.svc.Start(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	first, err := env.svc.Poll(ctx, start.DeviceCode)
	if err != nil || first.Status != "pending" {
		t.Fatalf("首次轮询应为 pending：%+v %v", first, err)
	}
	second, err := env.svc.Poll(ctx, start.DeviceCode)
	if err != nil || second.Status != "slow_down" {
		t.Fatalf("间隔内再轮询应为 slow_down：%+v %v", second, err)
	}
}

func TestCLIDeviceApproveThenConsume(t *testing.T) {
	env := newCLIEnv(t)
	ctx := context.Background()
	start, err := env.svc.Start(ctx, "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if err := env.svc.Approve(ctx, 7, start.UserCode); err != nil {
		t.Fatal(err)
	}
	// 用户确认后应立刻拿到令牌，不受 interval 限制
	got, err := env.svc.Poll(ctx, start.DeviceCode)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "approved" || got.Token == "" || got.Role != model.RoleUser {
		t.Fatalf("应返回令牌：%+v", got)
	}
	claims, err := utils.ParseToken(got.Token, testJWTSecret)
	if err != nil || claims.UserID != 7 {
		t.Fatalf("token 内容不对：%+v %v", claims, err)
	}
	// 重放同一个设备码：不能再发一次令牌
	again, err := env.svc.Poll(ctx, start.DeviceCode)
	if err != nil || again.Status != "consumed" || again.Token != "" {
		t.Fatalf("重放应为 consumed 且无令牌：%+v %v", again, err)
	}
}

func TestCLIDeviceDenied(t *testing.T) {
	env := newCLIEnv(t)
	ctx := context.Background()
	start, _ := env.svc.Start(ctx, "")
	if err := env.svc.Deny(ctx, start.UserCode); err != nil {
		t.Fatal(err)
	}
	got, err := env.svc.Poll(ctx, start.DeviceCode)
	if err != nil || got.Status != "denied" {
		t.Fatalf("应为 denied：%+v %v", got, err)
	}
	if err := env.svc.Approve(ctx, 7, start.UserCode); err == nil {
		t.Fatal("拒绝后不能再授权")
	}
}

func TestCLIDeviceExpired(t *testing.T) {
	env := newCLIEnv(t)
	ctx := context.Background()
	start, _ := env.svc.Start(ctx, "")
	// 直接改动记录模拟时间流逝，避免依赖真实时钟
	for _, row := range env.repo.rows {
		row.ExpiresAt = env.now.Add(-time.Second)
	}
	got, err := env.svc.Poll(ctx, start.DeviceCode)
	if err != nil || got.Status != "expired" {
		t.Fatalf("应为 expired：%+v %v", got, err)
	}
	if err := env.svc.Approve(ctx, 7, start.UserCode); !isCLIUserCodeErr(err) {
		t.Fatalf("过期后授权应报用户码无效，得到 %v", err)
	}
}

func TestCLIDeviceInvalidCode(t *testing.T) {
	env := newCLIEnv(t)
	if _, err := env.svc.Poll(context.Background(), "not-a-real-code"); !isCLIInvalidErr(err) {
		t.Fatalf("未知设备码应报 ErrCLIDeviceInvalid，得到 %v", err)
	}
	if _, err := env.svc.Poll(context.Background(), ""); !isCLIInvalidErr(err) {
		t.Fatalf("空设备码应报 ErrCLIDeviceInvalid，得到 %v", err)
	}
}

func TestCLIDeviceDisabledUser(t *testing.T) {
	env := newCLIEnv(t)
	ctx := context.Background()
	start, _ := env.svc.Start(ctx, "")
	if err := env.svc.Approve(ctx, 8, start.UserCode); err != nil {
		t.Fatal(err)
	}
	if _, err := env.svc.Poll(ctx, start.DeviceCode); !isCLIDisabledErr(err) {
		t.Fatalf("停用账号不应拿到令牌，得到 %v", err)
	}
}

func TestCLIDeviceDescribe(t *testing.T) {
	env := newCLIEnv(t)
	ctx := context.Background()
	start, _ := env.svc.Start(ctx, "macbook")
	view, err := env.svc.Describe(ctx, strings.ToLower(start.UserCode))
	if err != nil {
		t.Fatal(err)
	}
	if view.ClientName != "macbook" || view.Status != model.CLIDevicePending || view.UserCode != start.UserCode {
		t.Fatalf("展示信息不对：%+v", view)
	}
	// 带连字符与不带连字符都要认
	if _, err := env.svc.Describe(ctx, strings.ReplaceAll(start.UserCode, "-", "")); err != nil {
		t.Fatalf("无连字符的用户码应可用：%v", err)
	}
}

func isCLIInvalidErr(err error) bool {
	return err != nil && err.Error() == errcode.ErrCLIDeviceInvalid.Error()
}

func isCLIUserCodeErr(err error) bool {
	return err != nil && err.Error() == errcode.ErrCLIDeviceUserCode.Error()
}

func isCLIDisabledErr(err error) bool {
	return err != nil && err.Error() == errcode.ErrCLIDeviceDisabled.Error()
}
