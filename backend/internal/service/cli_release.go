package service

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// 命令行（CLI）的发行包：版本单独一套，与站点版本无关。
//
// 这里刻意**不预生成产物、也不嵌进二进制**：CLI 是零依赖的纯 JS（几十 KB），
// 请求时从仓库里的 cli/ 目录现场打包即可。好处是版本永远等于 cli/package.json 里那一行，
// 不存在「包里是旧版本、界面写新版本」的漂移；代价是每次请求读几个小文件，已加缓存。
//
// 为什么要有这个接口：CLI **没有发布到 npm**，用户装不了 `npm i -g video-canvas-cli`。
// 所以安装包必须由站点自己提供，并按平台分开（Unix 用 tar.gz，Windows 用 zip）。
const (
	// CLIOSUnix 覆盖 macOS 与 Linux：两者的安装流程一致，都用 sh 脚本与 tar.gz。
	CLIOSUnix = "unix"
	// CLIOSWindows 单独一路：PowerShell 的 Expand-Archive 只吃 zip。
	CLIOSWindows = "windows"

	// CLINodeRange 是安装脚本会检查的最低 Node 版本。
	CLINodeRange = ">=18"

	// cliDownloadPath 是安装脚本与下载链接共用的路径，改路由时一起改。
	cliDownloadPath = "/api/v1/cli/download"
	cliInstallUnix  = "/api/v1/cli/install.sh"
	cliInstallWin   = "/api/v1/cli/install.ps1"
)

// ErrCLIReleaseUnavailable 表示这个构建里没有带上 cli/ 目录（例如镜像没拷贝源码）。
var ErrCLIReleaseUnavailable = errors.New("当前部署没有附带命令行源码，无法提供安装包")

// CLIReleaseFile 是某个平台的安装包及其指纹：安装脚本用它校验下载是否完整。
type CLIReleaseFile struct {
	OS     string `json:"os"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// CLIRelease 是一次发行对外可见的全部信息。
type CLIRelease struct {
	Version string           `json:"version"`
	Node    string           `json:"node"`
	Files   []CLIReleaseFile `json:"files"`
}

type cliPackage struct {
	name string
	data []byte
}

// CLIReleaseService 从磁盘上的 cli/ 目录产出安装包。
type CLIReleaseService struct {
	// root 是 cli 目录的绝对路径；为空表示没找到（接口据此报 501）。
	root string
	// files 是参与打包的相对路径白名单（不含 test/ 与 node_modules）。
	files []string

	mu    sync.Mutex
	cache map[string]cliPackage // key: os
	// stamp 是打包输入的快照（版本 + 各文件 mtime/size）：开发时改了源码会自动重新打包。
	stamp string
}

// NewCLIReleaseService 定位 cli 目录。dir 为空时按常见相对位置探测：
// 镜像里是 /app/cli（工作目录 /app），仓库里 go run 是 backend/../cli。
func NewCLIReleaseService(dir string) *CLIReleaseService {
	root := locateCLIDir(dir)
	svc := &CLIReleaseService{root: root, cache: map[string]cliPackage{}}
	if root != "" {
		svc.files = cliPackagedFiles(root)
	}
	return svc
}

// locateCLIDir 找带 package.json 的 cli 目录。
func locateCLIDir(dir string) string {
	candidates := []string{dir, "cli", filepath.Join("..", "cli"), filepath.Join("..", "..", "cli")}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(abs, "package.json")); err == nil {
			return abs
		}
	}
	return ""
}

// cliPackagedFiles 收集要打进包的文件：只有运行需要的那几项。
//
// 源码是 TypeScript（cli/src/*.ts），安装包里放的是 tsc 的产物（cli/dist/*.js）：
// 用户机器只需要 Node，不需要 TypeScript 或任何构建步骤。测试、node_modules、
// 构建配置都不进包，装完的目录就是「够跑」的最小集合。
//
// dist 缺失时返回空列表——宁可让接口报 501（并打日志），也不能下发一个没有代码的包：
// 装出来的 vc 会在第一次调用时莫名其妙地找不到命令。
func cliPackagedFiles(root string) []string {
	keep := func(rel string) bool {
		switch {
		case rel == "package.json", rel == "README.md":
			return true
		case strings.HasPrefix(rel, "dist"+string(filepath.Separator)):
			return true
		}
		return false
	}
	var out []string
	for _, dir := range []string{"dist"} {
		_ = filepath.WalkDir(filepath.Join(root, dir), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil //nolint:nilerr // 缺目录就当没有：打包时按现有文件来
			}
			rel, relErr := filepath.Rel(root, p)
			if relErr != nil || !keep(rel) {
				return nil
			}
			out = append(out, rel)
			return nil
		})
	}
	if _, err := os.Stat(filepath.Join(root, "dist", "cli.js")); err != nil {
		// 没有入口文件：当成「没有可发布的命令行」，而不是发一个残缺包
		return nil
	}
	for _, name := range []string{"package.json", "README.md"} {
		if _, err := os.Stat(filepath.Join(root, name)); err == nil {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// version 读 cli/package.json 里的版本：这是 CLI 版本的唯一来源。
func (s *CLIReleaseService) version() (string, error) {
	if s.root == "" {
		return "", ErrCLIReleaseUnavailable
	}
	raw, err := os.ReadFile(filepath.Join(s.root, "package.json"))
	if err != nil {
		return "", fmt.Errorf("读取命令行版本失败: %w", err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", fmt.Errorf("解析命令行版本失败: %w", err)
	}
	if strings.TrimSpace(pkg.Version) == "" {
		return "", errors.New("命令行 package.json 没有 version")
	}
	return pkg.Version, nil
}

// snapshot 给输入拍一张快照，用来判断缓存是否还能用。
func (s *CLIReleaseService) snapshot(version string) string {
	parts := []string{version}
	for _, rel := range s.files {
		info, err := os.Stat(filepath.Join(s.root, rel))
		if err != nil {
			parts = append(parts, rel+":missing")
			continue
		}
		parts = append(parts, fmt.Sprintf("%s:%d:%d", rel, info.Size(), info.ModTime().UnixNano()))
	}
	return strings.Join(parts, "|")
}

// Release 返回版本、Node 要求与各平台的包指纹。
func (s *CLIReleaseService) Release() (CLIRelease, error) {
	version, err := s.version()
	if err != nil {
		return CLIRelease{}, err
	}
	files := make([]CLIReleaseFile, 0, 2)
	for _, osName := range []string{CLIOSUnix, CLIOSWindows} {
		name, data, err := s.Package(osName)
		if err != nil {
			return CLIRelease{}, err
		}
		sum := sha256.Sum256(data)
		files = append(files, CLIReleaseFile{
			OS:     osName,
			Name:   name,
			Size:   int64(len(data)),
			SHA256: hex.EncodeToString(sum[:]),
		})
	}
	return CLIRelease{Version: version, Node: CLINodeRange, Files: files}, nil
}

// Package 打一个平台的安装包。osName 只接受 unix / windows。
func (s *CLIReleaseService) Package(osName string) (name string, data []byte, err error) {
	if osName != CLIOSUnix && osName != CLIOSWindows {
		return "", nil, fmt.Errorf("不支持的平台：%s", osName)
	}
	version, err := s.version()
	if err != nil {
		return "", nil, err
	}
	stamp := s.snapshot(version)

	s.mu.Lock()
	defer s.mu.Unlock()
	if stamp == s.stamp {
		if pkg, ok := s.cache[osName]; ok {
			return pkg.name, pkg.data, nil
		}
	}

	pkg, err := s.build(osName, version)
	if err != nil {
		return "", nil, err
	}
	// 换了输入就把旧缓存整套丢掉：unix 与 windows 必须来自同一批源文件
	if stamp != s.stamp {
		s.cache = map[string]cliPackage{}
		s.stamp = stamp
	}
	s.cache[osName] = pkg
	return pkg.name, pkg.data, nil
}

// build 按平台产出 tar.gz 或 zip。包内是扁平结构（package.json、dist/），解包即用。
func (s *CLIReleaseService) build(osName, version string) (cliPackage, error) {
	entries, err := s.entries()
	if err != nil {
		return cliPackage{}, err
	}
	if osName == CLIOSWindows {
		data, err := zipEntries(entries)
		if err != nil {
			return cliPackage{}, err
		}
		return cliPackage{name: fmt.Sprintf("video-canvas-cli-%s.zip", version), data: data}, nil
	}
	data, err := tarGzEntries(entries)
	if err != nil {
		return cliPackage{}, err
	}
	return cliPackage{name: fmt.Sprintf("video-canvas-cli-%s.tgz", version), data: data}, nil
}

type cliEntry struct {
	rel  string
	mode fs.FileMode
	body []byte
}

// entries 读出白名单文件的当前内容。
func (s *CLIReleaseService) entries() ([]cliEntry, error) {
	if len(s.files) == 0 {
		return nil, ErrCLIReleaseUnavailable
	}
	out := make([]cliEntry, 0, len(s.files))
	for _, rel := range s.files {
		// 路径来自 cliPackagedFiles 的白名单（cli 目录下的 dist/ 与 package.json），不是请求参数
		//nolint:gosec // G304: 输入是启动时算好的白名单，不接受外部路径
		body, err := os.ReadFile(filepath.Join(s.root, rel))
		if err != nil {
			return nil, fmt.Errorf("读取 %s 失败: %w", rel, err)
		}
		mode := fs.FileMode(0o644)
		// 入口要可执行：Unix 上靠 shebang 直接跑（dist/cli.js 的第一行是 #!/usr/bin/env node）
		if rel == filepath.Join("dist", "cli.js") {
			mode = 0o755
		}
		out = append(out, cliEntry{rel: filepath.ToSlash(rel), mode: mode, body: body})
	}
	return out, nil
}

// tarGzEntries 打 tar.gz。Gzip 头里不留 mtime，保证同样输入产出同样的字节（指纹可用作校验）。
func tarGzEntries(entries []cliEntry) ([]byte, error) {
	var buf bytes.Buffer
	gz, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		header := &tar.Header{
			Name: entry.rel,
			Mode: int64(entry.mode),
			Size: int64(len(entry.body)),
		}
		if err := tw.WriteHeader(header); err != nil {
			return nil, err
		}
		if _, err := tw.Write(entry.body); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// zipEntries 打 zip：Windows 只认 zip（PowerShell 5.1 的 Expand-Archive）。
func zipEntries(entries []cliEntry) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.rel, Method: zip.Deflate}
		header.SetMode(entry.mode)
		header.Modified = time.Time{} // 同上：不留时间戳
		w, err := zw.CreateHeader(header)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(entry.body); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// DownloadPath 拼下载地址：安装脚本与界面共用，避免三处各写一份。
func DownloadPath(osName string) string {
	return cliDownloadPath + "?os=" + osName
}

// InstallScriptPath 拼安装脚本地址（按平台分 .sh / .ps1）。
func InstallScriptPath(osName string) string {
	if osName == CLIOSWindows {
		return cliInstallWin
	}
	return cliInstallUnix
}
