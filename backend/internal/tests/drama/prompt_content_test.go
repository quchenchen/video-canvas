package drama_test

import (
	"strings"
	"testing"

	. "video-canvas/internal/drama"
)

// TestPromptContentRequirements 锁定内置提示词的关键质量要求，防止被改回小说腔或笼统写法。
func TestPromptContentRequirements(t *testing.T) {
	tests := []struct {
		step string
		want []string
	}{
		{"scripts", []string{"集尾钩子", "禁止小说式写法", "对白要口语化", "△", "场次标题行", "集号-场号 日/夜 内/外", "（OS）", "（VO）", "【闪回】", "【字幕：", "【本集完】",
			// 篇幅沿用原文口径，不引入无实测依据的字数公式；注水由「事件写完就停」拦。
			"篇幅与给定单集时长相称", "事件写完就停",
			// 场以「局面是否变化」判定，不再给场次数量指标——数量指标必然逼出拆场。
			"局面没变的段落并进上一场", "换地点、换时段",
			// 开场与结尾：短剧的留存全靠这两头。
			"开场数秒内就要给出钩子或冲突", "未完成状态",
			// 信息增量取代台词功能清单：只要场里没交付新事，写什么都没用。
			"影响后面怎么演",
			// 套话禁令：穷举会被近义词绕过，靠“能否说清做了什么”判掉。
			"指节泛白", "满身冷汗", "近义词",
			// 跨集衔接、桥段判据与台词口语感。
			"不要把上一集结尾重新演一遍", "本质是同一件事", "打断、半句、反问和语气词",
			// 命名一致性：下游资产拆解与分镜靠同名对齐，名字漂移会拆出重复资产。
			"资产拆解与分镜"}},
		{"breakdown", []string{"角色表、场景表、道具表", "变体划分", "别名", "群演", "复用", "跨集"}},
		{"asset_prompts", []string{"四视图设定图", "四画面不对称分栏", "胸部以上的正面平视特写", "严格90度侧面", "脚底对齐同一水平线", "正面", "背面", "空间格局图", "产品参考图", "纯净", "不出现人物", "未成年角色"}},
	}
	for _, tt := range tests {
		t.Run(tt.step, func(t *testing.T) {
			prompt, err := Prompt(tt.step, map[string]any{})
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.want {
				if !strings.Contains(prompt, w) {
					t.Errorf("%s 提示词缺少关键要求 %q", tt.step, w)
				}
			}
			for _, banned := range []string{"Seedance", "Minimax", "MiniMax"} {
				if strings.Contains(prompt, banned) {
					t.Errorf("%s 提示词不应出现平台名 %q", tt.step, banned)
				}
			}
		})
	}
}
