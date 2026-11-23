package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	. "video-canvas/internal/handler"
	"video-canvas/internal/router"
	"video-canvas/internal/service"
)

// 命令行发行接口里的地址：配了 server.public_url 就用它，没配才按请求头推导。
// 生产踩过一次：TLS 终止在隧道那层、X-Forwarded-Proto 没传，拼出来的安装地址是 http://，
// 而 `vc login --base http://…` 会吃到 301、POST 退化成 GET，登录直接失败。
func TestCLIReleaseOrigin(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "cli")
	if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
		t.Skip("仓库里没有 cli 目录，跳过")
	}
	svc := service.NewCLIReleaseService(dir)

	cases := []struct {
		name      string
		publicURL string
		proto     string
		want      string
	}{
		{name: "配置优先且去掉尾部斜杠", publicURL: "https://example.com/", proto: "http", want: "https://example.com"},
		{name: "没配置就看 X-Forwarded-Proto", proto: "https", want: "https://canvas.test"},
		{name: "都没有就是 http", want: "http://canvas.test"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			engine := router.New(gin.TestMode, "cli-release-secret", router.Handlers{
				CLIRelease: NewCLIReleaseHandler(svc, tc.publicURL),
			})
			req := httptest.NewRequest(http.MethodGet, "/api/v1/cli/release", nil)
			req.Host = "canvas.test"
			if tc.proto != "" {
				req.Header.Set("X-Forwarded-Proto", tc.proto)
			}
			w := httptest.NewRecorder()
			engine.ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("状态 %d：%s", w.Code, w.Body.String())
			}
			var resp struct {
				Data struct {
					Version string            `json:"version"`
					Install map[string]string `json:"install"`
					Files   []struct {
						OS  string `json:"os"`
						URL string `json:"url"`
					} `json:"files"`
				} `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("解析响应: %v", err)
			}
			if resp.Data.Version == "" {
				t.Fatal("没有返回 CLI 版本")
			}
			if got := resp.Data.Install["unix"]; got != "curl -fsSL "+tc.want+"/api/v1/cli/install.sh | sh" {
				t.Fatalf("unix 安装命令 = %q", got)
			}
			if got := resp.Data.Install["windows"]; got != "irm "+tc.want+"/api/v1/cli/install.ps1 | iex" {
				t.Fatalf("windows 安装命令 = %q", got)
			}
			for _, file := range resp.Data.Files {
				if want := tc.want + "/api/v1/cli/download?os=" + file.OS; file.URL != want {
					t.Fatalf("%s 下载地址 = %q，期望 %q", file.OS, file.URL, want)
				}
			}
		})
	}
}
