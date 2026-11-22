package plugin_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"video-canvas/internal/provider"
	"video-canvas/internal/provider/plugin"
)

// 多 Key：同一个渠道配多把 Key 时
//  1. 并发额度按启用的把数放大（上游按 Key 限并发时，这才是有意义的提升）；
//  2. 请求按槽位轮转，连续两次提交用不同的 Key；
//  3. 任务绑定过槽位时（查询 / 取消），强制用提交时的同一把 Key。

// multiKeySecrets 是支持多槽位的凭证解析器。
type multiKeySecrets struct {
	mu    sync.Mutex
	keys  map[string]string
	slots []string
	used  []string
}

func (m *multiKeySecrets) Get(_ context.Context, name string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.used = append(m.used, name)
	v, ok := m.keys[name]
	if !ok {
		return "", errors.New("凭证未设置")
	}
	return v, nil
}

func (m *multiKeySecrets) SecretSlots(_ context.Context, _ string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.slots...), nil
}

func newMultiKeySecrets() *multiKeySecrets {
	return &multiKeySecrets{
		keys:  map[string]string{"channel:openai-main": "sk-A", "channel:openai-main:key2": "sk-B"},
		slots: []string{"channel:openai-main", "channel:openai-main:key2"},
	}
}

// multiKeyProbe 记录上游同时在处理的请求数峰值。
type multiKeyProbe struct {
	inflight atomic.Int32
	peak     atomic.Int32
	hold     time.Duration
}

func (p *multiKeyProbe) handler(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
	n := p.inflight.Add(1)
	defer p.inflight.Add(-1)
	for {
		old := p.peak.Load()
		if n <= old || p.peak.CompareAndSwap(old, n) {
			break
		}
	}
	time.Sleep(p.hold)
	_, _ = w.Write([]byte(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`))
}

func TestMultiKey_ScalesConcurrency(t *testing.T) {
	secrets := newMultiKeySecrets()
	env := newOpenAIEnv(t, func(o *plugin.Options) { o.Secrets = secrets })
	probe := &multiKeyProbe{hold: 150 * time.Millisecond}
	srv := httptest.NewServer(&fakeNewAPI{handler: probe.handler})
	defer srv.Close()

	snap := env.snapshot(srv.URL, "", promptCaps)
	// 每把 Key 只允许 1 个并发请求：两把 Key 就应该能同时跑 2 个
	snap.Channel.RateLimit = provider.RateLimit{MaxConcurrency: 1}

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = env.exec.Submit(context.Background(), snap, provider.SubmitInput{
				Task: provider.TaskRef{ID: uint64(i + 1), UserID: 9}, Input: map[string]any{"prompt": "x"},
			})
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 个请求失败：%v", i+1, err)
		}
	}
	if got := probe.peak.Load(); got < 2 {
		t.Fatalf("两把 Key、每把 1 并发时上游应同时收到 2 个请求，实际峰值 %d", got)
	}
}

func TestMultiKey_RotatesAndBindsSlot(t *testing.T) {
	secrets := newMultiKeySecrets()
	env := newOpenAIEnv(t, func(o *plugin.Options) { o.Secrets = secrets })
	up := &fakeNewAPI{handler: (&multiKeyProbe{hold: 0}).handler}
	srv := httptest.NewServer(up)
	defer srv.Close()

	snap := env.snapshot(srv.URL, "", promptCaps)

	// 连续两个新任务：按槽位轮转，各用一把
	for i := 0; i < 2; i++ {
		if _, err := env.exec.Submit(context.Background(), snap, provider.SubmitInput{
			Task: provider.TaskRef{ID: uint64(10 + i), UserID: 9}, Input: map[string]any{"prompt": "x"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	auths := map[string]bool{}
	for _, r := range up.requests {
		auths[r.Auth] = true
	}
	if !auths["Bearer sk-A"] || !auths["Bearer sk-B"] {
		t.Fatalf("两次提交应各用一把 Key，实际收到：%v", auths)
	}

	// 绑定槽位：查询必须用提交时那把（上游按 Key 隔离时换了 Key 会查不到任务）
	up.requests = nil
	if _, err := env.exec.Submit(context.Background(), snap, provider.SubmitInput{
		Task:  provider.TaskRef{ID: 20, UserID: 9, KeySlot: "channel:openai-main:key2"},
		Input: map[string]any{"prompt": "x"},
	}); err != nil {
		t.Fatal(err)
	}
	if got := up.last().Auth; got != "Bearer sk-B" {
		t.Fatalf("绑定槽位的任务应使用该槽位的 Key，实际：%s", got)
	}
}

func TestMultiKey_CoolsDownThrottledKey(t *testing.T) {
	secrets := newMultiKeySecrets()
	env := newOpenAIEnv(t, func(o *plugin.Options) { o.Secrets = secrets })
	var mu sync.Mutex
	var auths []string
	srv := httptest.NewServer(&fakeNewAPI{handler: func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		mu.Lock()
		auths = append(auths, r.Header.Get("Authorization"))
		mu.Unlock()
		// 第一把被限流，第二把正常
		if r.Header.Get("Authorization") == "Bearer sk-A" {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"message":"rate limit"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`))
	}})
	defer srv.Close()

	snap := env.snapshot(srv.URL, "", promptCaps)
	if _, err := env.exec.Submit(context.Background(), snap, provider.SubmitInput{
		Task: provider.TaskRef{ID: 31, UserID: 9}, Input: map[string]any{"prompt": "x"},
	}); err == nil {
		t.Fatal("第一把被限流时应返回错误")
	}
	// 下一把会轮到 sk-A（游标已前进到 key2），但再下一个新任务必须跳过冷却中的 sk-A
	if _, err := env.exec.Submit(context.Background(), snap, provider.SubmitInput{
		Task: provider.TaskRef{ID: 32, UserID: 9}, Input: map[string]any{"prompt": "x"},
	}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(auths) != 2 || auths[1] != "Bearer sk-B" {
		t.Fatalf("被限流的 Key 应冷却、自动换下一把，实际请求序列：%v", auths)
	}
}

// 只有一把 Key 时，行为与加多 Key 之前完全一致：并发额度不放大。
func TestMultiKey_SingleKeyKeepsQuota(t *testing.T) {
	secrets := &multiKeySecrets{keys: map[string]string{"channel:openai-main": "sk-A"}, slots: []string{"channel:openai-main"}}
	env := newOpenAIEnv(t, func(o *plugin.Options) { o.Secrets = secrets })
	probe := &multiKeyProbe{hold: 120 * time.Millisecond}
	srv := httptest.NewServer(&fakeNewAPI{handler: probe.handler})
	defer srv.Close()

	snap := env.snapshot(srv.URL, "", promptCaps)
	snap.Channel.RateLimit = provider.RateLimit{MaxConcurrency: 1}

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = env.exec.Submit(context.Background(), snap, provider.SubmitInput{
				Task: provider.TaskRef{ID: uint64(40 + i), UserID: 9}, Input: map[string]any{"prompt": "x"},
			})
		}(i)
	}
	wg.Wait()
	if got := probe.peak.Load(); got != 1 {
		t.Fatalf("单 Key 时并发上限应保持 1，实际峰值 %d", got)
	}
}
