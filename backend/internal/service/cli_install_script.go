package service

import "strings"

// 安装脚本模板：把 __BASE__ 换成请求方看到的站点地址（换域名、走内网、挂子路径都自动跟着变）。
//
// 两个脚本的共同约定：
//   - 只依赖系统自带工具 + Node（CLI 本身就要 Node 18+），不要求 curl 之外的东西；
//   - 版本向服务端要（/api/v1/cli/release），脚本里不写死版本，升级只要重跑同一条命令；
//   - 安装位置可覆盖（VC_PREFIX），卸载就是删掉那个目录 + 两个软链。
//
// 为什么分两套：macOS/Linux 用 sh + tar.gz；Windows 的 PowerShell 5.1 只有 Expand-Archive 且只吃 zip。
const cliInstallUnixScript = `#!/bin/sh
# 连镜（video-canvas）命令行安装脚本
# 用法：curl -fsSL __BASE__/api/v1/cli/install.sh | sh
# 可选环境变量：VC_BASE 站点地址、VC_VERSION 指定版本、VC_PREFIX 安装前缀（默认 ~/.local）
set -eu

VC_BASE="${VC_BASE:-__BASE__}"
PREFIX="${VC_PREFIX:-$HOME/.local}"
API="$VC_BASE/api/v1/cli"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "需要 Node.js 18 或更高版本，见 https://nodejs.org/zh-cn/download"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || die "Node.js 版本过低（当前 $(node -v)），需要 18 或更高"

# 版本以服务端为准：脚本不写死版本，升级重跑同一条命令即可
VERSION="${VC_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "$API/release" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version||""))}catch{}})')
fi
[ -n "$VERSION" ] || die "取不到最新版本，请确认 $API/release 可以访问"

SHARE="$PREFIX/share/video-canvas-cli/$VERSION"
BIN="$PREFIX/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "安装 video-canvas-cli $VERSION"
say "  站点   $VC_BASE"
say "  位置   $SHARE"

curl -fsSL "$API/download?os=unix" -o "$TMP/cli.tgz" || die "下载失败：$API/download?os=unix"
mkdir -p "$TMP/pkg"
tar -xzf "$TMP/cli.tgz" -C "$TMP/pkg" || die "解包失败，安装包可能不完整"

INSTALLED=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/package.json").version))' "$TMP/pkg") \
  || die "安装包里没有 package.json"
[ "$INSTALLED" = "$VERSION" ] || say "提示：服务端刚更新过（$VERSION → $INSTALLED），按 $INSTALLED 安装"

rm -rf "$SHARE"
mkdir -p "$SHARE" "$BIN"
cp -R "$TMP/pkg/." "$SHARE/"

# 两个等价命令名都指向同一个入口；Node 解析 ESM 时会沿真实路径找 ../src，软链不影响
ln -sf "$SHARE/bin/vc.mjs" "$BIN/vc"
ln -sf "$SHARE/bin/vc.mjs" "$BIN/video-canvas-cli"

say "已装好：$("$BIN/vc" --version 2>/dev/null || echo "video-canvas-cli $INSTALLED")"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    say ""
    say "把 $BIN 加进 PATH 才能直接敲 vc，例如："
    say "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc && . ~/.zshrc"
    ;;
esac
say "下一步：vc login --base $VC_BASE"
`

const cliInstallWindowsScript = `# 连镜（video-canvas）命令行安装脚本（Windows）
# 用法：irm __BASE__/api/v1/cli/install.ps1 | iex
# 可选：$env:VC_BASE、$env:VC_VERSION、$env:VC_PREFIX
$ErrorActionPreference = 'Stop'

$Base = if ($env:VC_BASE) { $env:VC_BASE } else { '__BASE__' }
$Base = $Base.TrimEnd('/')
$Api = "$Base/api/v1/cli"

function Fail($message) { throw "错误：$message" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail '需要 Node.js 18 或更高版本，见 https://nodejs.org/zh-cn/download' }
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { Fail "Node.js 版本过低（当前 $(node -v)），需要 18 或更高" }

$Version = $env:VC_VERSION
if (-not $Version) {
  try { $Version = (Invoke-RestMethod -Uri "$Api/release" -UseBasicParsing).version }
  catch { Fail "取不到最新版本，请确认 $Api/release 可以访问" }
}
if (-not $Version) { Fail '服务端没有返回版本号' }

$Prefix = if ($env:VC_PREFIX) { $env:VC_PREFIX } else { Join-Path $env:LOCALAPPDATA 'video-canvas-cli' }
$Lib = Join-Path $Prefix "$Version\lib"
$BinDir = Join-Path $Prefix "$Version\bin"

Write-Host "安装 video-canvas-cli $Version"
Write-Host "  站点   $Base"
Write-Host "  位置   $Lib"

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('vc-cli-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
try {
  $Zip = Join-Path $Tmp 'cli.zip'
  Invoke-WebRequest -Uri "$Api/download?os=windows" -OutFile $Zip -UseBasicParsing
  if (Test-Path $Lib) { Remove-Item $Lib -Recurse -Force }
  New-Item -ItemType Directory -Path $Lib -Force | Out-Null
  Expand-Archive -Path $Zip -DestinationPath $Lib -Force
}
finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Join-Path $Lib 'package.json'))) { Fail '安装包不完整（缺 package.json）' }

# 两个 .cmd 转发到 node：PowerShell 执行策略不管 .cmd，双击也行
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$shim = @'
@echo off
node "%~dp0..\lib\bin\vc.mjs" %*
'@
Set-Content -Path (Join-Path $BinDir 'vc.cmd') -Value $shim -Encoding ASCII
Copy-Item -Path (Join-Path $BinDir 'vc.cmd') -Destination (Join-Path $BinDir 'video-canvas-cli.cmd') -Force

# 用户 PATH：用 .NET API 读改写，避开 setx 的 1024 字符截断
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($userPath) { $parts = $userPath -split ';' | Where-Object { $_ } }
if ($parts -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', (($parts + $BinDir) -join ';'), 'User')
  Write-Host "已把 $BinDir 加入用户 PATH（重开终端生效）"
}
$env:Path = "$BinDir;$env:Path"

Write-Host ('已装好：' + (& node "$Lib\bin\vc.mjs" --version))
Write-Host "下一步：vc login --base $Base"
`

// CLIInstallScript 返回注入站点地址后的安装脚本。osName 只区分 windows 与其他。
func CLIInstallScript(osName, base string) string {
	tpl := cliInstallUnixScript
	if osName == CLIOSWindows {
		tpl = cliInstallWindowsScript
	}
	return strings.ReplaceAll(tpl, "__BASE__", strings.TrimRight(base, "/"))
}
