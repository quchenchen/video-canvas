package plugin

import (
	"sync"
	"sync/atomic"
	"time"
)

// 多 Key 轮转：同一渠道配多把 Key 时，请求按槽位摊开，让上游按 Key 限的并发真正叠起来。
//
// 两件事：
//   - 轮转：一个渠道一个自增游标，每次取下一把；任务一旦绑定槽位（TaskRef.KeySlot），提交、查询、取消都用同一把，
//     否则上游按 Key 隔离时会查不到自己提交的任务。
//   - 冷却：某把被 429 限流或 401 失效后先退出轮转，冷却到期再回来；全在冷却时选最早解冻的那把，
//     宁可试一次，也不让任务干等。
//
// 状态是进程内的，不跨实例：多实例各自轮转，效果是请求更分散，不会重复用同一把而互相挤。

// keyPool 是一个渠道的 Key 轮转与冷却状态。
type keyPool struct {
	next     atomic.Uint64
	mu       sync.Mutex
	cooldown map[string]time.Time // 凭证名 → 冷却到期时间
}

func newKeyPool() *keyPool { return &keyPool{cooldown: map[string]time.Time{}} }

// pick 选一把 Key：preferred（任务已绑定的槽位）在候选里就直接用它；
// 否则从游标位置开始跳过冷却中的；全在冷却时选最早解冻的那把。
func (p *keyPool) pick(names []string, preferred string, now time.Time) string {
	if len(names) == 0 {
		return ""
	}
	if preferred != "" {
		for _, n := range names {
			if n == preferred {
				return n
			}
		}
	}
	start := int(p.next.Add(1)-1) % len(names)
	var earliest string
	var earliestAt time.Time
	for i := 0; i < len(names); i++ {
		name := names[(start+i)%len(names)]
		until := p.cooledUntil(name)
		if !now.Before(until) {
			return name
		}
		if earliest == "" || until.Before(earliestAt) {
			earliest, earliestAt = name, until
		}
	}
	return earliest
}

// cooledUntil 返回一把 Key 的冷却到期时间；没在冷却返回零值。
func (p *keyPool) cooledUntil(name string) time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cooldown[name]
}

// cool 让一把 Key 冷却到 until（只延长不缩短，避免并发请求把冷却时间反复改小）。
func (p *keyPool) cool(name string, until time.Time) {
	if name == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if until.After(p.cooldown[name]) {
		p.cooldown[name] = until
	}
}

// keyPools 按渠道缓存 keyPool。渠道被删除后残留一个空 pool 不影响正确性，渠道数量很少。
type keyPools struct {
	mu sync.Mutex
	m  map[string]*keyPool
}

func newKeyPools() *keyPools { return &keyPools{m: map[string]*keyPool{}} }

// get 取（或创建）渠道的 keyPool。
func (s *keyPools) get(channelKey string) *keyPool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.m[channelKey]; ok {
		return p
	}
	p := newKeyPool()
	s.m[channelKey] = p
	return p
}
