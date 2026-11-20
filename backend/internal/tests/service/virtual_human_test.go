package service_test

import (
	"context"
	"errors"
	"io"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"video-canvas/internal/model"
	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/idcodec"
	"video-canvas/internal/provider"
	"video-canvas/internal/repository"
	. "video-canvas/internal/service"
)

// 本文件测试真人库服务（VirtualHumanService）：加入 / 加图 / 重新提交时的备案提交，审核状态刷新与节流，
// 移除前的角色卡引用检查与方舟侧删除，以及生成时把已备案素材换成 asset://（FiledAssetResolver）。

// ---------- 假仓储 ----------

type vhRepo struct {
	humans map[uint64]*model.VirtualHuman
	images map[uint64]*model.VirtualHumanImage
	next   uint64
}

func newVHRepo() *vhRepo {
	return &vhRepo{humans: map[uint64]*model.VirtualHuman{}, images: map[uint64]*model.VirtualHumanImage{}}
}

func (r *vhRepo) ListHumans(_ context.Context, userID uint64) ([]model.VirtualHuman, error) {
	var out []model.VirtualHuman
	for _, h := range r.humans {
		if h.UserID == userID {
			out = append(out, *h)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

func (r *vhRepo) CountHumans(ctx context.Context, userID uint64) (int64, error) {
	l, _ := r.ListHumans(ctx, userID)
	return int64(len(l)), nil
}

func (r *vhRepo) GetHuman(_ context.Context, userID, id uint64) (*model.VirtualHuman, error) {
	h, ok := r.humans[id]
	if !ok || h.UserID != userID {
		return nil, repository.ErrNotFound
	}
	cp := *h
	return &cp, nil
}

func (r *vhRepo) RenameHuman(_ context.Context, userID, id uint64, name string) error {
	h, ok := r.humans[id]
	if !ok || h.UserID != userID {
		return repository.ErrNotFound
	}
	h.Name = name
	return nil
}

func (r *vhRepo) dupAsset(userID, assetID uint64) bool {
	for _, img := range r.images {
		if img.UserID == userID && img.AssetID == assetID {
			return true
		}
	}
	return false
}

func (r *vhRepo) CreateHumanWithImage(_ context.Context, h *model.VirtualHuman, img *model.VirtualHumanImage) error {
	if r.dupAsset(img.UserID, img.AssetID) {
		return repository.ErrDuplicate
	}
	r.next++
	h.ID = r.next
	cp := *h
	r.humans[h.ID] = &cp
	r.next++
	img.ID, img.HumanID = r.next, h.ID
	ci := *img
	r.images[img.ID] = &ci
	return nil
}

func (r *vhRepo) DeleteHuman(_ context.Context, userID, id uint64) error {
	h, ok := r.humans[id]
	if !ok || h.UserID != userID {
		return repository.ErrNotFound
	}
	for k, img := range r.images {
		if img.HumanID == id {
			delete(r.images, k)
		}
	}
	delete(r.humans, id)
	return nil
}

func (r *vhRepo) ListImages(_ context.Context, userID uint64) ([]model.VirtualHumanImage, error) {
	var out []model.VirtualHumanImage
	for _, img := range r.images {
		if img.UserID == userID {
			out = append(out, *img)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].HumanID != out[j].HumanID {
			return out[i].HumanID < out[j].HumanID
		}
		if out[i].Sort != out[j].Sort {
			return out[i].Sort < out[j].Sort
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (r *vhRepo) ListImagesByHuman(ctx context.Context, userID, humanID uint64) ([]model.VirtualHumanImage, error) {
	all, _ := r.ListImages(ctx, userID)
	var out []model.VirtualHumanImage
	for _, img := range all {
		if img.HumanID == humanID {
			out = append(out, img)
		}
	}
	return out, nil
}

func (r *vhRepo) GetImage(_ context.Context, userID, id uint64) (*model.VirtualHumanImage, error) {
	img, ok := r.images[id]
	if !ok || img.UserID != userID {
		return nil, repository.ErrNotFound
	}
	cp := *img
	return &cp, nil
}

func (r *vhRepo) GetImageByAsset(_ context.Context, userID, assetID uint64) (*model.VirtualHumanImage, error) {
	for _, img := range r.images {
		if img.UserID == userID && img.AssetID == assetID {
			cp := *img
			return &cp, nil
		}
	}
	return nil, repository.ErrNotFound
}

func (r *vhRepo) CreateImageInHuman(_ context.Context, img *model.VirtualHumanImage) error {
	h, ok := r.humans[img.HumanID]
	if !ok || h.UserID != img.UserID {
		return repository.ErrNotFound
	}
	if r.dupAsset(img.UserID, img.AssetID) {
		return repository.ErrDuplicate
	}
	r.next++
	img.ID = r.next
	cp := *img
	r.images[img.ID] = &cp
	return nil
}

func (r *vhRepo) UpdateImageFiling(_ context.Context, img *model.VirtualHumanImage) error {
	cur, ok := r.images[img.ID]
	if !ok || cur.UserID != img.UserID {
		return repository.ErrNotFound
	}
	cur.ChannelKey, cur.ArkAssetID, cur.Status, cur.Error = img.ChannelKey, img.ArkAssetID, img.Status, img.Error
	return nil
}

func (r *vhRepo) SetImageSort(_ context.Context, userID, id uint64, s int) error {
	img, ok := r.images[id]
	if !ok || img.UserID != userID {
		return repository.ErrNotFound
	}
	img.Sort = s
	return nil
}

func (r *vhRepo) DeleteImage(_ context.Context, userID, id uint64) error {
	img, ok := r.images[id]
	if !ok || img.UserID != userID {
		return repository.ErrNotFound
	}
	delete(r.images, id)
	return nil
}

// ---------- 其他假依赖 ----------

// vhCanvases 模拟「哪些画布的角色卡用了这些素材」：payloads 是该用户的全部画布内容，按素材是否出现做粗筛。
type vhCanvases struct {
	rows []model.CanvasPayloadRow
}

func (c *vhCanvases) CanvasesUsingAssets(_ context.Context, _ uint64, ids []string) ([]model.CanvasPayloadRow, error) {
	var out []model.CanvasPayloadRow
	for _, row := range c.rows {
		for _, id := range ids {
			if strings.Contains(string(row.Payload), `"`+id+`"`) {
				out = append(out, row)
				break
			}
		}
	}
	return out, nil
}

// vhAssets 同时实现 provider.AssetStore 与按 ID 批量查素材。
type vhAssets struct {
	rows   map[uint64]*model.Asset
	remote bool
	base   string // 非空时替换地址前缀，模拟本地存储（相对路径或配了公网 base_url）
}

func (a *vhAssets) Get(_ context.Context, userID, id uint64) (*model.Asset, error) {
	row, ok := a.rows[id]
	if !ok || row.UserID != userID {
		return nil, provider.ErrAssetNotFound
	}
	return row, nil
}

func (a *vhAssets) Open(ctx context.Context, userID, id uint64) (*provider.AssetFile, error) {
	row, err := a.Get(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	base := "https://cdn/"
	if a.base != "" {
		base = a.base
	}
	return &provider.AssetFile{Asset: row, Body: io.NopCloser(strings.NewReader("")), URL: base + strconv.FormatUint(id, 10), Remote: a.remote}, nil
}

func (a *vhAssets) ListByIDs(_ context.Context, ids []uint64) ([]model.Asset, error) {
	var out []model.Asset
	for _, id := range ids {
		if row, ok := a.rows[id]; ok {
			out = append(out, *row)
		}
	}
	return out, nil
}

type vhViews struct{}

func (vhViews) ViewOf(_ context.Context, a *model.Asset) (*model.AssetView, error) {
	return &model.AssetView{ID: a.ID, Kind: a.Kind, URL: "/files/" + strconv.FormatUint(a.ID, 10)}, nil
}

type vhFiling struct {
	target *provider.FilingTarget
}

func (f *vhFiling) FilingTarget(context.Context) (*provider.FilingTarget, error) {
	if f.target == nil {
		return nil, nil
	}
	cp := *f.target
	return &cp, nil
}

// vhClient 模拟方舟：记下每次调用，按 status 回答审核状态。
type vhClient struct {
	createErr error
	deleteErr error
	status    map[string]string
	next      int
	created   []string // 提交时的图片地址
	deleted   []string
	queried   []string
}

func (c *vhClient) CreateAsset(_ context.Context, t provider.FilingTarget, imageURL, _ string) (string, error) {
	if t.AccessKey == "" {
		panic("没带 AK")
	}
	if c.createErr != nil {
		return "", c.createErr
	}
	c.next++
	c.created = append(c.created, imageURL)
	return "asset-" + strconv.Itoa(c.next), nil
}

func (c *vhClient) GetAsset(_ context.Context, _ provider.FilingTarget, id string) (string, error) {
	c.queried = append(c.queried, id)
	if s, ok := c.status[id]; ok {
		return s, nil
	}
	return provider.FilingAssetProcessing, nil
}

func (c *vhClient) DeleteAsset(_ context.Context, _ provider.FilingTarget, id string) error {
	if c.deleteErr != nil {
		return c.deleteErr
	}
	c.deleted = append(c.deleted, id)
	return nil
}

// ---------- 组装 ----------

type vhEnv struct {
	svc      *VirtualHumanService
	repo     *vhRepo
	assets   *vhAssets
	canvases *vhCanvases
	filing   *vhFiling
	client   *vhClient
	now      time.Time
}

const vhUser = uint64(7)

func newVHEnv(t *testing.T) *vhEnv {
	t.Helper()
	env := &vhEnv{
		repo: newVHRepo(),
		assets: &vhAssets{remote: true, rows: map[uint64]*model.Asset{
			11: {ID: 11, UserID: vhUser, Kind: "image"}, 12: {ID: 12, UserID: vhUser, Kind: "image"},
			13: {ID: 13, UserID: vhUser, Kind: "image"}, 14: {ID: 14, UserID: vhUser, Kind: "image"},
			15: {ID: 15, UserID: vhUser, Kind: "image"}, 16: {ID: 16, UserID: vhUser, Kind: "image"},
			20: {ID: 20, UserID: vhUser, Kind: "video"}, 30: {ID: 30, UserID: 99, Kind: "image"},
		}},
		canvases: &vhCanvases{},
		filing: &vhFiling{target: &provider.FilingTarget{
			ChannelKey: "ark", BaseURL: "https://ark.cn-beijing.volces.com/api/v3", GroupID: "g", AccessKey: "ak", SecretKey: "sk",
		}},
		client: &vhClient{status: map[string]string{}},
		now:    time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC),
	}
	env.svc = NewVirtualHumanService(VirtualHumanDeps{
		Repo: env.repo, Canvases: env.canvases, Assets: env.assets, AssetRows: env.assets, Views: vhViews{},
		Filing: env.filing, Client: env.client, Now: func() time.Time { return env.now },
	})
	return env
}

func decodeID(t *testing.T, id idcodec.ID) uint64 {
	t.Helper()
	return uint64(id)
}

// ---------- 加入真人库 ----------

func TestVirtualHuman_CreateSubmitsFiling(t *testing.T) {
	env := newVHEnv(t)
	v, err := env.svc.Create(context.Background(), vhUser, "  迅哥儿  ", 11)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	if v.Name != "迅哥儿" || len(v.Images) != 1 || v.Status != model.FilingPending {
		t.Fatalf("view = %+v", v)
	}
	if v.Images[0].Asset == nil || v.Images[0].Asset.ID != 11 {
		t.Fatalf("图片应带素材视图：%+v", v.Images[0])
	}
	// 用存储的公网地址提交方舟，记下方舟素材 ID 与备案渠道
	if len(env.client.created) != 1 || env.client.created[0] != "https://cdn/11" {
		t.Fatalf("提交地址 = %v", env.client.created)
	}
	img := env.repo.images[decodeID(t, v.Images[0].ID)]
	if img.ArkAssetID != "asset-1" || img.ChannelKey != "ark" || img.Status != model.FilingPending {
		t.Fatalf("图片行 = %+v", img)
	}
}

func TestVirtualHuman_CreateUpstreamFailureMarksFailed(t *testing.T) {
	env := newVHEnv(t)
	env.client.createErr = errors.New("方舟 CreateAsset 返回错误 InvalidParameter: secret detail")
	v, err := env.svc.Create(context.Background(), vhUser, "迅哥儿", 11)
	if err != nil {
		t.Fatalf("提交方舟失败不应让加入失败（真人已建好，可以重新提交）：%v", err)
	}
	if v.Status != model.FilingFailed || v.Images[0].Status != model.FilingFailed {
		t.Fatalf("应标记为失败：%+v", v)
	}
	if v.Images[0].Error == "" || strings.Contains(v.Images[0].Error, "secret detail") {
		t.Fatalf("失败原因要给用户看得懂的话，不透传上游原文：%q", v.Images[0].Error)
	}
}

func TestVirtualHuman_CreateErrors(t *testing.T) {
	cases := []struct {
		name  string
		setup func(env *vhEnv)
		input string
		asset uint64
		want  *errcode.Error
	}{
		{"名称为空", nil, "   ", 11, errcode.ErrVirtualHumanInvalid},
		{"名称超长", nil, strings.Repeat("长", 31), 11, errcode.ErrVirtualHumanInvalid},
		{"未配置虚拟人像库", func(env *vhEnv) { env.filing.target = nil }, "a", 11, errcode.ErrFilingNotConfigured},
		{"素材不存在", nil, "a", 404, errcode.ErrVirtualHumanInvalid},
		{"别人的素材", nil, "a", 30, errcode.ErrVirtualHumanInvalid},
		{"不是图片", nil, "a", 20, errcode.ErrVirtualHumanInvalid},
		{"本地存储且地址是相对路径", func(env *vhEnv) { env.assets.remote, env.assets.base = false, "/files/" }, "a", 11, errcode.ErrVirtualHumanImageNotPublic},
		{"已在真人库", func(env *vhEnv) {
			_, _ = env.svc.Create(context.Background(), vhUser, "先来的", 11)
		}, "a", 11, errcode.ErrVirtualHumanImageDup},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := newVHEnv(t)
			if c.setup != nil {
				c.setup(env)
			}
			_, err := env.svc.Create(context.Background(), vhUser, c.input, c.asset)
			wantCode(t, err, c.want)
		})
	}
}

// 本地存储配了公网 base_url 时地址是绝对地址，方舟拉得到，照常提交（与 PR #80 实测过的部署方式一致）
func TestVirtualHuman_CreateWithPublicLocalStorage(t *testing.T) {
	env := newVHEnv(t)
	env.assets.remote, env.assets.base = false, "https://canvas.example.com/files/"
	if _, err := env.svc.Create(context.Background(), vhUser, "a", 11); err != nil {
		t.Fatalf("公网绝对地址应能提交：%v", err)
	}
	if len(env.client.created) != 1 || env.client.created[0] != "https://canvas.example.com/files/11" {
		t.Fatalf("提交地址 = %v", env.client.created)
	}
}

func TestVirtualHuman_CreateLimit(t *testing.T) {
	env := newVHEnv(t)
	for i := 0; i < model.MaxVirtualHumans; i++ {
		env.repo.humans[uint64(1000+i)] = &model.VirtualHuman{ID: uint64(1000 + i), UserID: vhUser, Name: "x"}
	}
	_, err := env.svc.Create(context.Background(), vhUser, "a", 11)
	wantCode(t, err, errcode.ErrVirtualHumanLimit)
}

// ---------- 加图、设封面、改名 ----------

func TestVirtualHuman_AddImageAndCover(t *testing.T) {
	env := newVHEnv(t)
	ctx := context.Background()
	v, _ := env.svc.Create(ctx, vhUser, "迅哥儿", 11)
	hid := decodeID(t, v.ID)

	v, err := env.svc.AddImage(ctx, vhUser, hid, 12)
	if err != nil {
		t.Fatalf("AddImage 失败：%v", err)
	}
	if len(v.Images) != 2 || v.Images[1].Asset.ID != 12 || len(env.client.created) != 2 {
		t.Fatalf("加图后 = %+v，提交 %v", v.Images, env.client.created)
	}

	// 设封面：第二张排到第一张
	v, err = env.svc.SetCover(ctx, vhUser, hid, decodeID(t, v.Images[1].ID))
	if err != nil {
		t.Fatalf("SetCover 失败：%v", err)
	}
	if v.Images[0].Asset.ID != 12 {
		t.Fatalf("封面应换成素材 12，得到 %d", v.Images[0].Asset.ID)
	}
	_, err = env.svc.SetCover(ctx, vhUser, hid, 9999)
	wantCode(t, err, errcode.ErrVirtualHumanImageNotFound)

	v, err = env.svc.Rename(ctx, vhUser, hid, " 鲁迅 ")
	if err != nil || v.Name != "鲁迅" {
		t.Fatalf("Rename = %+v, %v", v, err)
	}
	_, err = env.svc.Rename(ctx, vhUser, 9999, "a")
	wantCode(t, err, errcode.ErrVirtualHumanNotFound)
}

func TestVirtualHuman_AddImageErrors(t *testing.T) {
	ctx := context.Background()
	t.Run("真人不存在", func(t *testing.T) {
		env := newVHEnv(t)
		_, err := env.svc.AddImage(ctx, vhUser, 9999, 12)
		wantCode(t, err, errcode.ErrVirtualHumanNotFound)
	})
	t.Run("超过 5 张", func(t *testing.T) {
		env := newVHEnv(t)
		v, _ := env.svc.Create(ctx, vhUser, "a", 11)
		hid := decodeID(t, v.ID)
		for _, id := range []uint64{12, 13, 14, 15} {
			if _, err := env.svc.AddImage(ctx, vhUser, hid, id); err != nil {
				t.Fatalf("加第 %d 张失败：%v", id, err)
			}
		}
		_, err := env.svc.AddImage(ctx, vhUser, hid, 16)
		wantCode(t, err, errcode.ErrVirtualHumanImageLimit)
	})
	t.Run("素材已在别的真人里", func(t *testing.T) {
		env := newVHEnv(t)
		a, _ := env.svc.Create(ctx, vhUser, "a", 11)
		_, _ = env.svc.Create(ctx, vhUser, "b", 12)
		_, err := env.svc.AddImage(ctx, vhUser, decodeID(t, a.ID), 12)
		wantCode(t, err, errcode.ErrVirtualHumanImageDup)
	})
	t.Run("未配置虚拟人像库", func(t *testing.T) {
		env := newVHEnv(t)
		a, _ := env.svc.Create(ctx, vhUser, "a", 11)
		env.filing.target = nil
		_, err := env.svc.AddImage(ctx, vhUser, decodeID(t, a.ID), 12)
		wantCode(t, err, errcode.ErrFilingNotConfigured)
	})
}

// ---------- 刷新审核状态 ----------

func TestVirtualHuman_ListRefreshesPendingWithThrottle(t *testing.T) {
	env := newVHEnv(t)
	ctx := context.Background()
	a, _ := env.svc.Create(ctx, vhUser, "a", 11) // asset-1
	b, _ := env.svc.Create(ctx, vhUser, "b", 12) // asset-2
	env.client.status["asset-1"] = provider.FilingAssetActive
	env.client.status["asset-2"] = provider.FilingAssetFailed

	// 不带 refresh 只读库，不查方舟
	list, err := env.svc.List(ctx, vhUser, false)
	if err != nil || len(env.client.queried) != 0 {
		t.Fatalf("不带 refresh 不应查方舟：%v，查了 %v", err, env.client.queried)
	}
	if !list.FilingReady || len(list.Items) != 2 {
		t.Fatalf("list = %+v", list)
	}

	list, err = env.svc.List(ctx, vhUser, true)
	if err != nil {
		t.Fatalf("List 失败：%v", err)
	}
	status := map[idcodec.ID]string{}
	for _, it := range list.Items {
		status[it.ID] = it.Status
	}
	if status[a.ID] != model.FilingActive || status[b.ID] != model.FilingFailed {
		t.Fatalf("刷新后状态 = %v", status)
	}
	if env.repo.images[decodeID(t, b.Images[0].ID)].Error == "" {
		t.Fatal("审核失败要写原因")
	}

	// 3 秒内再次刷新不查方舟；已出结果的图片之后也不再查
	env.client.queried = nil
	_, _ = env.svc.AddImage(ctx, vhUser, decodeID(t, a.ID), 13) // asset-3 审核中
	_, _ = env.svc.List(ctx, vhUser, true)
	if len(env.client.queried) != 0 {
		t.Fatalf("节流期内不应查方舟，查了 %v", env.client.queried)
	}
	env.now = env.now.Add(4 * time.Second)
	_, _ = env.svc.List(ctx, vhUser, true)
	if len(env.client.queried) != 1 || env.client.queried[0] != "asset-3" {
		t.Fatalf("只应查审核中的 asset-3，查了 %v", env.client.queried)
	}
}

func TestVirtualHuman_ListWithoutFilingConfig(t *testing.T) {
	env := newVHEnv(t)
	_, _ = env.svc.Create(context.Background(), vhUser, "a", 11)
	env.filing.target = nil
	list, err := env.svc.List(context.Background(), vhUser, true)
	if err != nil {
		t.Fatalf("List 失败：%v", err)
	}
	if list.FilingReady || len(list.Items) != 1 || len(env.client.queried) != 0 {
		t.Fatalf("未配置时照常列出、不查方舟：%+v，查了 %v", list, env.client.queried)
	}
}

// ---------- 重新提交 ----------

func TestVirtualHuman_RetryImage(t *testing.T) {
	env := newVHEnv(t)
	ctx := context.Background()
	env.client.createErr = errors.New("boom")
	v, _ := env.svc.Create(ctx, vhUser, "a", 11)
	imgID := decodeID(t, v.Images[0].ID)

	env.client.createErr = nil
	v, err := env.svc.RetryImage(ctx, vhUser, imgID)
	if err != nil {
		t.Fatalf("RetryImage 失败：%v", err)
	}
	if v.Images[0].Status != model.FilingPending || env.repo.images[imgID].ArkAssetID == "" || env.repo.images[imgID].Error != "" {
		t.Fatalf("重新提交后应回到审核中：%+v", env.repo.images[imgID])
	}

	// 审核中的不能重复提交；不存在的图片
	_, err = env.svc.RetryImage(ctx, vhUser, imgID)
	wantCode(t, err, errcode.ErrVirtualHumanRetryInvalid)
	_, err = env.svc.RetryImage(ctx, vhUser, 9999)
	wantCode(t, err, errcode.ErrVirtualHumanImageNotFound)
}

// ---------- 引用与移除 ----------

// canvasWith 造一张画布：一个角色卡节点，主图 + 补充图。
func canvasWith(id uint64, title, nodeID, name, mainAsset string, extras ...string) model.CanvasPayloadRow {
	var ex []string
	for _, e := range extras {
		ex = append(ex, `{"assetId":"`+e+`"}`)
	}
	payload := `{"nodes":[{"id":"` + nodeID + `","data":{"kind":"character","assetId":"` + mainAsset +
		`","character":{"name":"` + name + `","extras":[` + strings.Join(ex, ",") + `]}}}]}`
	return model.CanvasPayloadRow{ID: id, Title: title, Payload: []byte(payload)}
}

func TestVirtualHuman_ReferencesAndRemoveImage(t *testing.T) {
	env := newVHEnv(t)
	ctx := context.Background()
	v, _ := env.svc.Create(ctx, vhUser, "迅哥儿", 11)
	hid := decodeID(t, v.ID)
	v, _ = env.svc.AddImage(ctx, vhUser, hid, 12)
	used, free := decodeID(t, v.Images[0].ID), decodeID(t, v.Images[1].ID)
	env.canvases.rows = []model.CanvasPayloadRow{canvasWith(100, "故乡", "n1", "迅哥儿", "11")}

	refs, err := env.svc.References(ctx, vhUser, hid)
	if err != nil {
		t.Fatalf("References 失败：%v", err)
	}
	if len(refs.Items) != 1 || refs.Items[0].CanvasTitle != "故乡" || refs.Items[0].NodeName != "迅哥儿" ||
		decodeID(t, refs.Items[0].ImageID) != used || decodeID(t, refs.Items[0].CanvasID) != 100 {
		t.Fatalf("refs = %+v", refs.Items)
	}

	// 被角色卡用着的图片不能移除，提示里点名角色卡
	err = env.svc.RemoveImage(ctx, vhUser, used)
	wantCode(t, err, errcode.ErrVirtualHumanInUse)
	if !strings.Contains(err.Error(), "迅哥儿") {
		t.Fatalf("提示应点名角色卡：%v", err)
	}

	// 没被用的可以移除，并删掉方舟侧素材
	if err := env.svc.RemoveImage(ctx, vhUser, free); err != nil {
		t.Fatalf("RemoveImage 失败：%v", err)
	}
	if _, ok := env.repo.images[free]; ok || len(env.client.deleted) != 1 || env.client.deleted[0] != "asset-2" {
		t.Fatalf("应删掉图片行和方舟素材 asset-2：deleted=%v", env.client.deleted)
	}

	// 唯一的图片要改用移除真人
	env.canvases.rows = nil
	err = env.svc.RemoveImage(ctx, vhUser, used)
	wantCode(t, err, errcode.ErrVirtualHumanLastImage)

	err = env.svc.RemoveImage(ctx, vhUser, 9999)
	wantCode(t, err, errcode.ErrVirtualHumanImageNotFound)
}

func TestVirtualHuman_RemoveImageUpstreamFailureKeepsRow(t *testing.T) {
	env := newVHEnv(t)
	ctx := context.Background()
	v, _ := env.svc.Create(ctx, vhUser, "a", 11)
	v, _ = env.svc.AddImage(ctx, vhUser, decodeID(t, v.ID), 12)
	env.client.deleteErr = errors.New("timeout")
	err := env.svc.RemoveImage(ctx, vhUser, decodeID(t, v.Images[1].ID))
	wantCode(t, err, errcode.ErrFilingUpstream)
	if _, ok := env.repo.images[decodeID(t, v.Images[1].ID)]; !ok {
		t.Fatal("方舟删除失败时要保留图片行，让用户重试")
	}
}

func TestVirtualHuman_Remove(t *testing.T) {
	env := newVHEnv(t)
	ctx := context.Background()
	v, _ := env.svc.Create(ctx, vhUser, "迅哥儿", 11)
	hid := decodeID(t, v.ID)
	_, _ = env.svc.AddImage(ctx, vhUser, hid, 12)

	// 任意一张图被角色卡（补充图）用着就不能移除
	env.canvases.rows = []model.CanvasPayloadRow{canvasWith(100, "社戏", "n9", "双喜", "99", "12")}
	err := env.svc.Remove(ctx, vhUser, hid)
	wantCode(t, err, errcode.ErrVirtualHumanInUse)

	env.canvases.rows = nil
	if err := env.svc.Remove(ctx, vhUser, hid); err != nil {
		t.Fatalf("Remove 失败：%v", err)
	}
	if len(env.repo.humans) != 0 || len(env.repo.images) != 0 || len(env.client.deleted) != 2 {
		t.Fatalf("应删掉真人、图片和 2 个方舟素材：deleted=%v", env.client.deleted)
	}
	err = env.svc.Remove(ctx, vhUser, hid)
	wantCode(t, err, errcode.ErrVirtualHumanNotFound)
}

func TestVirtualHuman_RemoveSkipsUpstreamOfOtherChannel(t *testing.T) {
	env := newVHEnv(t)
	ctx := context.Background()
	v, _ := env.svc.Create(ctx, vhUser, "a", 11)
	// 管理员把虚拟人像库换到了别的渠道：旧渠道的凭证已拿不到，只删本地记录
	env.filing.target.ChannelKey = "other"
	if err := env.svc.Remove(ctx, vhUser, decodeID(t, v.ID)); err != nil {
		t.Fatalf("Remove 失败：%v", err)
	}
	if len(env.client.deleted) != 0 || len(env.repo.humans) != 0 {
		t.Fatalf("不应调方舟删除，本地应删掉：deleted=%v humans=%d", env.client.deleted, len(env.repo.humans))
	}
}

// ---------- 生成时换成 asset:// ----------

func TestFiledAssetResolver(t *testing.T) {
	env := newVHEnv(t)
	ctx := context.Background()
	v, _ := env.svc.Create(ctx, vhUser, "a", 11)
	r := NewFiledAssetResolver(env.repo)

	if _, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "ark"}); ok {
		t.Fatal("审核中的图片不能换成 asset://")
	}
	env.repo.images[decodeID(t, v.Images[0].ID)].Status = model.FilingActive
	uri, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "ark"})
	if !ok || uri != "asset://asset-1" {
		t.Fatalf("FiledAssetURI = %q, %v", uri, ok)
	}
	if _, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "other"}); ok {
		t.Fatal("别的渠道不能用这个渠道的备案")
	}
	if _, ok := r.FiledAssetURI(ctx, 99, 11, provider.ChannelSnapshot{Key: "ark"}); ok {
		t.Fatal("别人的素材不能换")
	}
	if _, ok := r.FiledAssetURI(ctx, vhUser, 12, provider.ChannelSnapshot{Key: "ark"}); ok {
		t.Fatal("不在真人库里的素材不能换")
	}
}

// 生成时遇到审核中的图片，同步查一次方舟：用户刚提交备案就去生成时，方舟往往已经通过，
// 不能因为本地还没刷新就退回普通地址去撞风控（与 PR #80 一致）。
func TestFiledAssetResolver_ChecksPendingOnce(t *testing.T) {
	ctx := context.Background()

	t.Run("方舟已通过：换成 asset:// 并写回可用", func(t *testing.T) {
		env := newVHEnv(t)
		v, _ := env.svc.Create(ctx, vhUser, "a", 11) // asset-1，审核中
		r := NewFiledAssetResolver(env.repo)
		r.UseFiling(env.filing, env.client)
		env.client.status["asset-1"] = provider.FilingAssetActive
		uri, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "ark"})
		if !ok || uri != "asset://asset-1" {
			t.Fatalf("FiledAssetURI = %q, %v", uri, ok)
		}
		if env.repo.images[decodeID(t, v.Images[0].ID)].Status != model.FilingActive {
			t.Fatal("查到通过后要写回可用，下次不用再查")
		}
	})

	t.Run("方舟判定失败：按普通图片传，并写回失败原因", func(t *testing.T) {
		env := newVHEnv(t)
		v, _ := env.svc.Create(ctx, vhUser, "a", 11)
		r := NewFiledAssetResolver(env.repo)
		r.UseFiling(env.filing, env.client)
		env.client.status["asset-1"] = provider.FilingAssetFailed
		if _, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "ark"}); ok {
			t.Fatal("审核失败不能换成 asset://")
		}
		img := env.repo.images[decodeID(t, v.Images[0].ID)]
		if img.Status != model.FilingFailed || img.Error == "" {
			t.Fatalf("应写回失败：%+v", img)
		}
	})

	t.Run("还在审核 / 没配置虚拟人像库 / 渠道不同：按普通图片传", func(t *testing.T) {
		env := newVHEnv(t)
		_, _ = env.svc.Create(ctx, vhUser, "a", 11)
		r := NewFiledAssetResolver(env.repo)
		if _, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "ark"}); ok || len(env.client.queried) != 0 {
			t.Fatalf("没接备案配置时不查方舟：查了 %v", env.client.queried)
		}
		r.UseFiling(env.filing, env.client)
		if _, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "ark"}); ok || len(env.client.queried) != 1 {
			t.Fatalf("还在审核应按普通图片传，且只查一次：查了 %v", env.client.queried)
		}
		if _, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "other"}); ok || len(env.client.queried) != 1 {
			t.Fatalf("别的渠道不查：查了 %v", env.client.queried)
		}
		env.filing.target = nil
		if _, ok := r.FiledAssetURI(ctx, vhUser, 11, provider.ChannelSnapshot{Key: "ark"}); ok || len(env.client.queried) != 1 {
			t.Fatalf("虚拟人像库没配置时不查：查了 %v", env.client.queried)
		}
	})
}
