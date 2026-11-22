package plugin_test

import (
	"testing"
	"time"

	"video-canvas/internal/provider/plugin"
)

// 多 Key 轮转与冷却：同一渠道配多把 Key 时，请求要摊到不同 Key 上；
// 某把被限流后先退出，冷却到期再回来；任务绑定的槽位优先。

func TestKeyPool_RotatesAcrossKeys(t *testing.T) {
	p := plugin.NewKeyPool()
	now := time.Now()
	names := []string{"channel:c", "channel:c:key2", "channel:c:key3"}

	seen := map[string]int{}
	for i := 0; i < 6; i++ {
		name := p.Pick(names, "", now)
		seen[name]++
	}
	if len(seen) != 3 {
		t.Fatalf("6 次请求应摊到 3 把 Key 上，实际：%v", seen)
	}
	for name, n := range seen {
		if n != 2 {
			t.Fatalf("轮转应均匀（每把 2 次），%s 拿到 %d 次", name, n)
		}
	}
}

func TestKeyPool_PrefersBoundSlot(t *testing.T) {
	p := plugin.NewKeyPool()
	now := time.Now()
	names := []string{"channel:c", "channel:c:key2"}

	// 任务绑定的那把即使不在轮转位置上也要用它：查询必须和提交同一把 Key
	for i := 0; i < 4; i++ {
		if got := p.Pick(names, "channel:c:key2", now); got != "channel:c:key2" {
			t.Fatalf("应优先使用绑定的槽位，得到 %s", got)
		}
	}
	// 绑定的槽位已被删除时退回轮转，不报错
	if got := p.Pick([]string{"channel:c"}, "channel:c:key2", now); got != "channel:c" {
		t.Fatalf("绑定槽位不存在时应退回现有 Key，得到 %s", got)
	}
}

func TestKeyPool_SkipsCoolingKey(t *testing.T) {
	p := plugin.NewKeyPool()
	now := time.Now()
	names := []string{"channel:c", "channel:c:key2"}

	p.Cool("channel:c", now.Add(time.Minute))
	for i := 0; i < 4; i++ {
		if got := p.Pick(names, "", now); got != "channel:c:key2" {
			t.Fatalf("冷却中的 Key 不应被选中，得到 %s", got)
		}
	}
}

func TestKeyPool_FallsBackWhenAllCooling(t *testing.T) {
	p := plugin.NewKeyPool()
	now := time.Now()
	names := []string{"channel:c", "channel:c:key2"}

	p.Cool("channel:c", now.Add(time.Minute))
	p.Cool("channel:c:key2", now.Add(10*time.Second))

	// 全在冷却时选最早解冻的那把，宁可试一次也不让任务干等
	if got := p.Pick(names, "", now); got != "channel:c:key2" {
		t.Fatalf("全冷却时应选最早解冻的 Key，得到 %s", got)
	}
	// 冷却结束后恢复轮转
	later := now.Add(2 * time.Minute)
	if got := p.Pick(names, "", later); got != "channel:c" && got != "channel:c:key2" {
		t.Fatalf("冷却结束后应能选到 Key，得到 %s", got)
	}
}

func TestKeyPool_CoolOnlyExtends(t *testing.T) {
	p := plugin.NewKeyPool()
	now := time.Now()
	names := []string{"channel:c", "channel:c:key2"}

	p.Cool("channel:c", now.Add(10*time.Minute))
	// 并发请求带来的更短冷却不能把已有的长冷却改短
	p.Cool("channel:c", now.Add(time.Second))
	if got := p.Pick(names, "", now); got != "channel:c:key2" {
		t.Fatalf("冷却时间只应延长，得到 %s", got)
	}
}
