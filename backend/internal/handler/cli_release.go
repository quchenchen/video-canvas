package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"video-canvas/internal/pkg/errcode"
	"video-canvas/internal/pkg/response"
	"video-canvas/internal/service"
)

// CLIReleaseHandler 提供命令行的安装包与安装脚本。
//
// 这几个接口不需要登录：装 CLI 的人此时还没有凭据，而包体里也没有任何站点私有内容。
type CLIReleaseHandler struct {
	svc *service.CLIReleaseService
}

// NewCLIReleaseHandler 注入发行服务（cli 目录的定位与打包都在服务层）。
func NewCLIReleaseHandler(svc *service.CLIReleaseService) *CLIReleaseHandler {
	return &CLIReleaseHandler{svc: svc}
}

// Release 返回 CLI 的独立版本、Node 要求、各平台包指纹，以及可直接粘的安装命令。
// 界面上的安装说明也读这个接口，避免「文档写 0.1.0、包里是 0.0.9」。
func (h *CLIReleaseHandler) Release(c *gin.Context) {
	rel, err := h.svc.Release()
	if err != nil {
		failCLIRelease(c, err)
		return
	}
	base := requestOrigin(c)
	files := make([]gin.H, 0, len(rel.Files))
	for _, file := range rel.Files {
		files = append(files, gin.H{
			"os":     file.OS,
			"name":   file.Name,
			"size":   file.Size,
			"sha256": file.SHA256,
			"url":    base + service.DownloadPath(file.OS),
		})
	}
	response.OK(c, gin.H{
		"version": rel.Version,
		"node":    rel.Node,
		"files":   files,
		"install": gin.H{
			"unix":    fmt.Sprintf("curl -fsSL %s | sh", base+service.InstallScriptPath(service.CLIOSUnix)),
			"windows": fmt.Sprintf("irm %s | iex", base+service.InstallScriptPath(service.CLIOSWindows)),
		},
		"download": gin.H{
			"unix":    base + service.DownloadPath(service.CLIOSUnix),
			"windows": base + service.DownloadPath(service.CLIOSWindows),
		},
	})
}

// Download 直接下发安装包。os 只接受 unix / windows，省略按 unix 处理。
func (h *CLIReleaseHandler) Download(c *gin.Context) {
	osName := c.DefaultQuery("os", service.CLIOSUnix)
	name, data, err := h.svc.Package(osName)
	if err != nil {
		failCLIRelease(c, err)
		return
	}
	contentType := "application/gzip"
	if osName == service.CLIOSWindows {
		contentType = "application/zip"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	// 同一版本可缓存，但换版本要立刻拿到新包
	c.Header("Cache-Control", "public, max-age=300")
	c.Data(http.StatusOK, contentType, data)
}

// InstallScript 下发安装脚本。脚本里的站点地址按请求方看到的 origin 现拼，
// 所以内网地址、自定义域名、反向代理前缀都不用改代码。
func (h *CLIReleaseHandler) InstallScript(c *gin.Context) {
	osName := service.CLIOSUnix
	if strings.HasSuffix(c.Request.URL.Path, ".ps1") {
		osName = service.CLIOSWindows
	}
	// 先确认这个部署真的有安装包：否则用户拿到脚本，跑到下载那一步才失败
	if _, err := h.svc.Release(); err != nil {
		failCLIRelease(c, err)
		return
	}
	// 脚本是纯文本、不是 JSON 信封：c.Data 直接下发字节，别走 response 包
	c.Header("Cache-Control", "public, max-age=60")
	c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(service.CLIInstallScript(osName, requestOrigin(c))))
}

// failCLIRelease 把服务层错误映射成对外错误码：
// 「没有附带源码」是部署问题（404），平台参数写错是调用方问题（400），其余算内部错误。
func failCLIRelease(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrCLIReleaseUnavailable):
		response.Fail(c, errcode.ErrNotFound.WithMsg(err.Error()))
	case strings.HasPrefix(err.Error(), "不支持的平台"):
		response.Fail(c, errcode.ErrInvalidParams.WithMsg(err.Error()))
	default:
		response.Fail(c, errcode.ErrInternal.WithMsg(err.Error()))
	}
}

// requestOrigin 取请求方看到的站点根地址（scheme + host）。
// 生产在前面有 nginx 反代，scheme 要看 X-Forwarded-Proto，不能只看 Request.TLS。
func requestOrigin(c *gin.Context) string {
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	if proto := c.GetHeader("X-Forwarded-Proto"); proto != "" {
		scheme = strings.ToLower(strings.TrimSpace(strings.Split(proto, ",")[0]))
	}
	host := c.GetHeader("X-Forwarded-Host")
	if host == "" {
		host = c.Request.Host
	}
	return scheme + "://" + host
}
