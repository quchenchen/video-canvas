package service_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"video-canvas/internal/model"
	"video-canvas/internal/service"
	"video-canvas/internal/service/aiconfigfake"
)

// 同一渠道多把 Key：新增 / 列表 / 启停 / 删除，以及渠道视图与宿主看到的槽位列表。
// 直接对应「上游按 Key 限并发，一个渠道配多把 Key 才能把并发叠起来」这个需求。

func newKeyEnv(t *testing.T) *achEnv {
	t.Helper()
	e := newAchEnv(t)
	if _, err := e.svc.Create(context.Background(), createInput()); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestAIChannelService_AddKeys(t *testing.T) {
	ctx := context.Background()
	e := newKeyEnv(t)

	k1, err := e.svc.AddKey(ctx, 7, "main", service.ChannelKeyInput{Value: "sk-aaaa1111", Remark: "账号 A"})
	if err != nil {
		t.Fatal(err)
	}
	if k1.Slot != 1 || k1.Hint != "1111" || k1.Remark != "账号 A" || !k1.Enabled {
		t.Fatalf("第一把 Key 不符合预期：%+v", k1)
	}
	k2, err := e.svc.AddKey(ctx, 7, "main", service.ChannelKeyInput{Value: "sk-bbbb2222"})
	if err != nil {
		t.Fatal(err)
	}
	if k2.Slot != 2 || k2.Hint != "2222" {
		t.Fatalf("第二把 Key 应拿到槽位 2：%+v", k2)
	}

	// 列表：按槽位升序，只回显末四位
	list, err := e.svc.ListKeys(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Slot != 1 || list[1].Slot != 2 || list[1].Hint != "2222" {
		t.Fatalf("列表不符合预期：%+v", list)
	}

	// 渠道视图：有 Key、数量是 2（前端据此显示“共 N 把”）
	view, err := e.svc.Get(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	if !view.SecretSet || view.KeyCount != 2 {
		t.Fatalf("渠道视图应显示 2 把 Key：secret_set=%v key_count=%d", view.SecretSet, view.KeyCount)
	}

	// 密文按槽位分开存：槽位 1 沿用历史名，槽位 2 是 :key2
	if got, err := e.cfg.Get(ctx, model.ChannelSecretName("main")); err != nil || got != "sk-aaaa1111" {
		t.Fatalf("槽位 1 的凭证不对：%q %v", got, err)
	}
	if got, err := e.cfg.Get(ctx, model.ChannelKeySecretName("main", 2)); err != nil || got != "sk-bbbb2222" {
		t.Fatalf("槽位 2 的凭证不对：%q %v", got, err)
	}

	// 审计只记槽位，不含任何明文
	if len(e.repo.Audits) == 0 {
		t.Fatal("应写审计")
	}
	for _, a := range e.repo.Audits {
		if strings.Contains(string(a.DetailJSON), "sk-") {
			t.Fatalf("审计里不能出现 Key 明文：%s", a.DetailJSON)
		}
	}
}

func TestAIChannelService_AddKeyValidation(t *testing.T) {
	ctx := context.Background()
	e := newKeyEnv(t)

	if _, err := e.svc.AddKey(ctx, 7, "main", service.ChannelKeyInput{Value: "   "}); err == nil {
		t.Fatal("空 Key 应被拒绝")
	}
	if _, err := e.svc.AddKey(ctx, 7, "missing", service.ChannelKeyInput{Value: "sk-x"}); err == nil {
		t.Fatal("渠道不存在应被拒绝")
	}
	// 数量上限：并发额度按 Key 数放大，不能无限加
	for i := 0; i < 10; i++ {
		if _, err := e.svc.AddKey(ctx, 7, "main", service.ChannelKeyInput{Value: "sk-" + strings.Repeat("a", 8) + string(rune('a'+i))}); err != nil {
			t.Fatalf("第 %d 把应能添加：%v", i+1, err)
		}
	}
	if _, err := e.svc.AddKey(ctx, 7, "main", service.ChannelKeyInput{Value: "sk-over-limit"}); err == nil {
		t.Fatal("超过上限应被拒绝")
	}
}

func TestAIChannelService_DisableAndDeleteKeys(t *testing.T) {
	ctx := context.Background()
	e := newKeyEnv(t)

	first, _ := e.svc.AddKey(ctx, 7, "main", service.ChannelKeyInput{Value: "sk-aaaa1111"})
	second, _ := e.svc.AddKey(ctx, 7, "main", service.ChannelKeyInput{Value: "sk-bbbb2222"})

	// 停用一把：允许（还有一把启用）
	disabled := false
	view, err := e.svc.UpdateKey(ctx, 7, "main", first.Slot, nil, &disabled)
	if err != nil {
		t.Fatalf("还有其他启用时允许停用：%v", err)
	}
	if view.Enabled {
		t.Fatal("停用后视图应为未启用")
	}

	// 停用最后一把启用的：拒绝，否则渠道立刻不可用
	if _, err := e.svc.UpdateKey(ctx, 7, "main", second.Slot, nil, &disabled); err == nil {
		t.Fatal("不允许停用最后一把启用的 Key")
	}

	// 宿主看到的槽位：只剩启用的那把
	names, err := e.cfg.SecretSlots(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != model.ChannelKeySecretName("main", second.Slot) {
		t.Fatalf("槽位列表应只剩启用的那把：%v", names)
	}

	// 删除启用的那把：槽位与密文都要消失，视图回到没有 Key
	if err := e.svc.DeleteKey(ctx, 7, "main", second.Slot); err != nil {
		t.Fatal(err)
	}
	if _, err := e.cfg.Get(ctx, model.ChannelKeySecretName("main", second.Slot)); !errors.Is(err, service.ErrAISecretNotSet) {
		t.Fatalf("删除后密文应一并删除，得到 %v", err)
	}
	after, err := e.svc.Get(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	// 剩下那把虽然停用，但 Key 还在：仍算“已配置”，运维可以再启用回来
	if !after.SecretSet || after.KeyCount != 1 {
		t.Fatalf("停用但未删除的槽位仍要计数：secret_set=%v key_count=%d", after.SecretSet, after.KeyCount)
	}

	// 全部删掉：渠道回到“没有 Key”
	if err := e.svc.DeleteKey(ctx, 7, "main", first.Slot); err != nil {
		t.Fatal(err)
	}
	empty, err := e.svc.Get(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	if empty.SecretSet || empty.KeyCount != 0 {
		t.Fatalf("删完后不应还显示有 Key：secret_set=%v key_count=%d", empty.SecretSet, empty.KeyCount)
	}
}

func TestAIChannelService_SetSecretKeepsSlotOne(t *testing.T) {
	ctx := context.Background()
	e := newKeyEnv(t)

	// 兼容入口：老前端只调 SetSecret，应自动建槽位 1，凭证名仍是历史的 channel:<key>
	if err := e.svc.SetSecret(ctx, 7, "main", "sk-legacy9999"); err != nil {
		t.Fatal(err)
	}
	list, err := e.svc.ListKeys(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Slot != 1 || list[0].Hint != "9999" {
		t.Fatalf("SetSecret 应自动建槽位 1：%+v", list)
	}
	if got, err := e.cfg.Get(ctx, model.ChannelSecretName("main")); err != nil || got != "sk-legacy9999" {
		t.Fatalf("凭证应写在历史名下：%q %v", got, err)
	}

	// 再覆盖：仍然写槽位 1，末四位跟着更新
	if err := e.svc.SetSecret(ctx, 7, "main", "sk-updated0000"); err != nil {
		t.Fatal(err)
	}
	list, _ = e.svc.ListKeys(ctx, "main")
	if len(list) != 1 || list[0].Hint != "0000" {
		t.Fatalf("覆盖后末四位应更新：%+v", list)
	}
}

func TestAIChannelService_SecretSlotsFallbackForLegacyChannel(t *testing.T) {
	ctx := context.Background()
	repo := aiconfigfake.NewMemRepo()
	cfg := service.NewAIConfigService(repo, repo, repo, "test-master-key")
	svc := service.NewAIChannelService(repo, cfg, cfg, &aiconfigfake.ModelLister{}, repo, &aiconfigfake.Notifier{})
	if _, err := svc.Create(ctx, createInput()); err != nil {
		t.Fatal(err)
	}
	// 模拟迁移回填之前的渠道：只有 channel:<key> 的密文，没有槽位行
	if err := cfg.SetSecret(ctx, model.ChannelSecretName("main"), "sk-old", 1); err != nil {
		t.Fatal(err)
	}
	names, err := cfg.SecretSlots(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != model.ChannelSecretName("main") {
		t.Fatalf("没有槽位行时应回退到单 Key：%v", names)
	}
}
