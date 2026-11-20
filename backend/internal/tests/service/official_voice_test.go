package service_test

import (
	"context"
	"testing"
	"time"

	. "video-canvas/internal/service"

	"video-canvas/internal/config"
	"video-canvas/internal/model"
	"video-canvas/internal/provider"
)

// 官方音色是系统公共素材（user_id=0, source=official）：任意登录用户都要能
// 1) 通过 Get 读到它（试听 / 参考音频预检），2) 通过 Open 生成上游可拉的签名 URL。
// 但普通用户素材仍严格隔离，不能被别人读到。
func TestAssetService_GetOfficialVoice(t *testing.T) {
	repo := newFakeAssetRepo()
	store := newFakeAssetStore()
	// 手动插入一条系统公共音色和一条普通用户素材
	repo.rows[10] = &model.Asset{ID: 10, UserID: 0, Kind: "audio", Source: model.AssetSourceOfficial,
		StorageID: 1, StorageKey: "o0/202611/voice.wav", MimeType: "audio/wav", FileName: "Big Boogie",
		OfficialAssetID: "asset-20260908172134-jdrd2"}
	repo.rows[11] = &model.Asset{ID: 11, UserID: 7, Kind: "audio", Source: model.AssetSourceUpload,
		StorageID: 1, StorageKey: "u7/202611/private.wav", MimeType: "audio/wav"}

	reg := newFakeRegistry(1, objectHandle(1, store, time.Hour))
	svc := NewAssetService(repo, reg, config.Storage{SignedTTL: time.Hour})

	// 用户 99 能读到系统公共音色
	got, err := svc.Get(context.Background(), 99, 10)
	if err != nil {
		t.Fatalf("系统公共音色应对所有用户可读，却报错：%v", err)
	}
	if got.ID != 10 || got.OfficialAssetID == "" {
		t.Fatalf("读到的不是期望的官方音色：%+v", got)
	}

	// 用户 99 读不到别人私有素材
	if _, err := svc.Get(context.Background(), 99, 11); err == nil {
		t.Fatal("别人的私有素材不应被读到")
	}
}

// Open 是生成链路读取参考音频的入口：必须给官方音色产出 Remote 签名 URL，
// 这样 doubao-video.js 才能把平台地址当 audio_url 传给方舟。
func TestAssetService_OpenOfficialVoice(t *testing.T) {
	repo := newFakeAssetRepo()
	store := newFakeAssetStore()
	store.objects["o0/202611/voice.wav"] = []byte("wav")
	repo.rows[10] = &model.Asset{ID: 10, UserID: 0, Kind: "audio", Source: model.AssetSourceOfficial,
		StorageID: 1, StorageKey: "o0/202611/voice.wav", MimeType: "audio/wav"}

	reg := newFakeRegistry(1, objectHandle(1, store, time.Hour))
	svc := NewAssetService(repo, reg, config.Storage{SignedTTL: time.Hour})

	f, err := svc.Open(context.Background(), 42, 10)
	if err != nil {
		t.Fatalf("生成链路应能打开官方音色：%v", err)
	}
	if f.URL == "" {
		t.Fatal("官方音色必须有可被上游拉取的 URL")
	}
	if !f.Remote {
		t.Fatal("官方音色必须标记为远端可拉取，否则上游拿到的是 /files 内网地址")
	}
	_ = f.Body.Close()
}

// ViewOf 要把缩略图 key 转成 URL、把官方溯源 ID 透出给前端卡片。
func TestAssetService_ViewOfOfficialVoice(t *testing.T) {
	repo := newFakeAssetRepo()
	svc := NewAssetService(repo, newFakeRegistry(1, objectHandle(1, newFakeAssetStore(), time.Hour)),
		config.Storage{Local: config.LocalStorage{BaseURL: "https://api.example.com"}})

	view, err := svc.ViewOf(context.Background(), &model.Asset{
		ID: 10, Kind: "audio", StorageKey: "o0/202611/voice.wav",
		ThumbnailKey: "o0/202611/thumb.png", OfficialAssetID: "asset-20260908172134-jdrd2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.ThumbnailURL != "https://api.example.com/files/o0/202611/thumb.png" {
		t.Fatalf("缩略图 URL 不对：%q", view.ThumbnailURL)
	}
	if view.OfficialAssetID != "asset-20260908172134-jdrd2" {
		t.Fatalf("官方溯源 ID 没透出：%q", view.OfficialAssetID)
	}
	if view.URL != "https://api.example.com/files/o0/202611/voice.wav" {
		t.Fatalf("音频 URL 不对：%q", view.URL)
	}
}

// provider.AssetStore 接口约束：Get 的语义变化不能破坏原有一致性（找不到就是 ErrAssetNotFound）。
func TestAssetService_GetOfficialMissingStillFails(t *testing.T) {
	svc := NewAssetService(newFakeAssetRepo(), newFakeRegistry(1, objectHandle(1, newFakeAssetStore(), time.Hour)), config.Storage{})
	if _, err := svc.Get(context.Background(), 1, 999); err == nil {
		t.Fatal("不存在的素材必须报错")
	}
	_ = provider.ErrAssetNotFound // 保持 import，错误类型由 service 内部翻译
}
