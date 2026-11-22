package canvasgraph

// 素材种类，与前端 NodeMediaType 和 assets.kind 一致。
const (
	MediaImage = "image"
	MediaVideo = "video"
	MediaAudio = "audio"
)

// MediaRef 是节点上引用的一个素材：只记素材 id、种类和它属于哪一类（成片 / 第几镜的分镜图），
// 文件本身的信息（mime、大小）由调用方按 id 查库。
type MediaRef struct {
	AssetID string // 素材 id（十进制字符串）
	Kind    string // image / video / audio
	Final   bool   // 是不是节点上的成片（data.finalAssetId）
	Shot    int    // >0 表示分镜表第 N 镜（从 1 起）手传的分镜图，旧数据才有的形态
}

// MediaRefs 返回节点引用的全部素材，按「历次产物（旧 → 新）→ 当前版（若不在产物里）→ 成片 → 角色素材 → 分镜手传图」排列。
//
// 为什么要在后端也做一遍：打包下载要按节点归类把文件附上，而画布里的素材引用有五种形态
// （outputs、老节点的 assetId 镜像、finalAssetId、角色卡的补充图 / 声音、分镜旧手传图），
// 少读一种就会在压缩包里静默少文件。规则与前端 readOutputs / activeOutputIdOf 一致：
// 产物非空就只认产物，产物为空时老节点的那份 assetId 当成唯一一版。
func MediaRefs(n Node) []MediaRef {
	d := n.Data()
	out := make([]MediaRef, 0, 4)
	seen := make(map[string]bool, 4)
	add := func(id, kind string, final bool, shot int) {
		if id == "" || id == "0" || seen[id] {
			return
		}
		switch kind {
		case MediaImage, MediaVideo, MediaAudio:
		default:
			kind = MediaImage
		}
		seen[id] = true
		out = append(out, MediaRef{AssetID: id, Kind: kind, Final: final, Shot: shot})
	}
	// 节点的种类可以当素材种类的兜底：视频节点的产物就是视频，图片节点的就是图片
	nodeKind := n.Kind()
	for _, o := range readOutputs(d) {
		kind := str(o["mediaType"])
		if kind == "" {
			kind = nodeKind
		}
		add(str(o["assetId"]), kind, false, 0)
	}
	if id := str(d["assetId"]); id != "" && !seen[id] {
		kind := str(d["mediaType"])
		if kind == "" {
			kind = nodeKind
		}
		add(id, kind, false, 0)
	}
	add(str(d["finalAssetId"]), MediaVideo, true, 0)
	if ch, ok := d["character"].(map[string]any); ok {
		if extras, ok := ch["extras"].([]any); ok {
			for _, item := range extras {
				if m, ok := item.(map[string]any); ok {
					add(str(m["assetId"]), MediaImage, false, 0)
				}
			}
		}
		if voice, ok := ch["voice"].(map[string]any); ok {
			add(str(voice["assetId"]), MediaAudio, false, 0)
		}
	}
	if sb, ok := d["storyboard"].(map[string]any); ok {
		if shots, ok := sb["shots"].([]any); ok {
			for i, item := range shots {
				m, ok := item.(map[string]any)
				if !ok {
					continue
				}
				if img, ok := m["image"].(map[string]any); ok {
					add(str(img["assetId"]), MediaImage, false, i+1)
				}
			}
		}
	}
	return out
}
