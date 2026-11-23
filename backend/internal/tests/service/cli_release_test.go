package service_test

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	. "video-canvas/internal/service"
)

// 命令行发行包：版本取自 cli/package.json，包体按平台现场打（Unix 用 tar.gz，Windows 用 zip）。

// cliDir 返回仓库里的 cli 目录。后端单独发布时没有这个目录，跳过而不是失败。
func cliDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join("..", "..", "..", "..", "cli")
	if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
		t.Skip("仓库里没有 cli 目录，跳过命令行发行测试")
	}
	return dir
}

func TestCLIReleasePackages(t *testing.T) {
	dir := cliDir(t)
	svc := NewCLIReleaseService(dir)

	release, err := svc.Release()
	if err != nil {
		t.Fatalf("Release: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		t.Fatalf("读 package.json: %v", err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatalf("解析 package.json: %v", err)
	}
	// 版本必须与 package.json 一致：这是 CLI 独立版本管理的单一来源
	if release.Version != pkg.Version {
		t.Fatalf("版本不一致：接口 %q，package.json %q", release.Version, pkg.Version)
	}
	if release.Node != CLINodeRange {
		t.Fatalf("Node 要求 = %q，期望 %q", release.Node, CLINodeRange)
	}
	if len(release.Files) != 2 {
		t.Fatalf("包数量 = %d，期望 2（unix / windows）", len(release.Files))
	}
	for _, file := range release.Files {
		if file.Size <= 0 {
			t.Fatalf("%s 包大小异常：%d", file.OS, file.Size)
		}
		if len(file.SHA256) != 64 {
			t.Fatalf("%s 指纹异常：%q", file.OS, file.SHA256)
		}
	}

	name, data, err := svc.Package(CLIOSUnix)
	if err != nil {
		t.Fatalf("Package(unix): %v", err)
	}
	if !strings.HasSuffix(name, ".tgz") {
		t.Fatalf("unix 包名 = %q，期望 .tgz", name)
	}
	for _, want := range []string{
		"package.json",
		"dist/cli.js",
		"dist/client.js",
		// 配套技能跟着包走：用户装完才有东西可放进自己的助手
		"skill/SKILL.md",
		"skill/references/commands.md",
		"skill/scripts/node-pick.ts",
	} {
		if !hasName(tarNames(t, data), want) {
			t.Fatalf("tgz 缺少 %s，实际 %v", want, tarNames(t, data))
		}
	}

	winName, winData, err := svc.Package(CLIOSWindows)
	if err != nil {
		t.Fatalf("Package(windows): %v", err)
	}
	if !strings.HasSuffix(winName, ".zip") {
		t.Fatalf("windows 包名 = %q，期望 .zip", winName)
	}
	if !hasName(zipNames(t, winData), "dist/cli.js") {
		t.Fatalf("zip 缺少 dist/cli.js，实际 %v", zipNames(t, winData))
	}
	// 两个包都只装运行需要的东西，别把测试源码带进安装目录
	if hasName(tarNames(t, data), "test/client.test.ts") {
		t.Fatal("tgz 不该包含 test/")
	}
}

func TestCLIReleaseDeterministic(t *testing.T) {
	dir := cliDir(t)
	svc := NewCLIReleaseService(dir)
	_, first, err := svc.Package(CLIOSUnix)
	if err != nil {
		t.Fatalf("Package: %v", err)
	}
	_, second, err := svc.Package(CLIOSUnix)
	if err != nil {
		t.Fatalf("Package: %v", err)
	}
	// 同样的输入必须得到同样的字节，sha256 才能当校验值用
	if !bytes.Equal(first, second) {
		t.Fatal("两次打包结果不一致")
	}
}

func TestCLIReleaseUnavailable(t *testing.T) {
	svc := NewCLIReleaseService(filepath.Join(t.TempDir(), "missing"))
	if _, err := svc.Release(); !errors.Is(err, ErrCLIReleaseUnavailable) {
		t.Fatalf("Release 错误 = %v，期望 ErrCLIReleaseUnavailable", err)
	}
	if _, _, err := svc.Package(CLIOSUnix); !errors.Is(err, ErrCLIReleaseUnavailable) {
		t.Fatalf("Package 错误 = %v，期望 ErrCLIReleaseUnavailable", err)
	}
	if _, _, err := svc.Package("plan9"); err == nil || !strings.Contains(err.Error(), "不支持的平台") {
		t.Fatalf("未知平台错误 = %v", err)
	}
}

func TestCLIInstallScript(t *testing.T) {
	unix := CLIInstallScript(CLIOSUnix, "https://example.com/")
	if strings.Contains(unix, "__BASE__") {
		t.Fatal("Unix 脚本里的 __BASE__ 没有被替换")
	}
	for _, want := range []string{
		"VC_BASE:-https://example.com", // 站点地址注入到默认值里
		`API="$VC_BASE/api/v1/cli"`,
		"download?os=unix",
		"JSON.parse(s).data.version", // 接口是 {code,msg,data} 信封，版本在 data 里
		"~/.local",
		"ln -sf",
		// 技能随包安装，装完必须告诉人它在哪、怎么交给助手
		`$SHARE/skill`,
		"配套技能",
	} {
		if !strings.Contains(unix, want) {
			t.Fatalf("Unix 脚本缺少 %q", want)
		}
	}

	ps := CLIInstallScript(CLIOSWindows, "https://example.com")
	if strings.Contains(ps, "__BASE__") {
		t.Fatal("Windows 脚本里的 __BASE__ 没有被替换")
	}
	for _, want := range []string{
		"https://example.com",
		"download?os=windows",
		".data.version",
		"Expand-Archive",
		"LOCALAPPDATA",
		`$Lib\skill`,
		"配套技能",
	} {
		if !strings.Contains(ps, want) {
			t.Fatalf("Windows 脚本缺少 %q", want)
		}
	}
}

func hasName(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func tarNames(t *testing.T, data []byte) []string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("解 gzip: %v", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var names []string
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("读 tar: %v", err)
		}
		names = append(names, header.Name)
	}
	return names
}

func zipNames(t *testing.T, data []byte) []string {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("读 zip: %v", err)
	}
	names := make([]string, 0, len(reader.File))
	for _, file := range reader.File {
		names = append(names, file.Name)
	}
	return names
}
