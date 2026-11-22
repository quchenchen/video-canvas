package plugin

import "time"

// 白盒测试用的导出：internal/tests/provider/plugin 在包外，需要一个入口驱动未导出的 keyPool。

// KeyPoolForTest 包装 keyPool，把轮转与冷却暴露给包外测试。
type KeyPoolForTest struct{ *keyPool }

// NewKeyPool 构造一个空的 Key 轮转池。
func NewKeyPool() *KeyPoolForTest { return &KeyPoolForTest{newKeyPool()} }

// Pick 选一把 Key，语义同 operation 里的选择。
func (p *KeyPoolForTest) Pick(names []string, preferred string, now time.Time) string {
	return p.pick(names, preferred, now)
}

// Cool 让一把 Key 冷却到 until。
func (p *KeyPoolForTest) Cool(name string, until time.Time) { p.cool(name, until) }
