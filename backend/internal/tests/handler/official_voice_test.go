package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	. "video-canvas/internal/handler"

	"video-canvas/internal/config"
	"video-canvas/internal/model"
	"video-canvas/internal/service"
)

// GET /assets/official 返回官方音色列表，带缩略图地址与官方溯源 ID，
// 且不受当前用户归属影响（系统公共素材）。
func TestListOfficialVoices(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &fakeAssetHandlerRepo{rows: map[uint64]*model.Asset{}}
	repo.rows[1] = &model.Asset{ID: 1, UserID: 0, Kind: "audio", Source: model.AssetSourceOfficial,
		StorageID: 1, StorageKey: "o0/202611/a.wav", ThumbnailKey: "o0/202611/a.png",
		OfficialAssetID: "asset-a", FileName: "Voice A"}
	repo.rows[2] = &model.Asset{ID: 2, UserID: 7, Kind: "audio", Source: model.AssetSourceUpload,
		StorageID: 1, StorageKey: "u7/202611/private.wav"} // 私有素材不能混进官方列表
	svc := service.NewAssetService(repo, nil, config.Storage{})
	h := NewAssetHandler(svc)

	r := gin.New()
	r.GET("/api/v1/assets/official", h.ListOfficial)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/assets/official?kind=audio", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Data service.OfficialVoicePage `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Data.Total != 1 || len(resp.Data.Items) != 1 {
		t.Fatalf("只应返回 1 条官方音色：%+v", resp.Data)
	}
	it := resp.Data.Items[0]
	if it.OfficialAssetID != "asset-a" || it.ThumbnailURL == "" || it.URL == "" {
		t.Fatalf("官方音色视图字段不全：%+v", it)
	}
}

// 分页参数非法要被拒，不能给默认值绕过。
func TestListOfficialVoices_BadParams(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &fakeAssetHandlerRepo{rows: map[uint64]*model.Asset{}}
	h := NewAssetHandler(service.NewAssetService(repo, nil, config.Storage{}))
	r := gin.New()
	r.GET("/api/v1/assets/official", h.ListOfficial)

	for _, q := range []string{"?limit=0", "?limit=101", "?offset=-1", "?offset=abc"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/assets/official"+q, nil))
		if w.Code == http.StatusOK {
			t.Fatalf("参数 %s 应被拒绝", q)
		}
	}
}
