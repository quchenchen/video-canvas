import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Terminal } from "lucide-react";
import { Link } from "react-router";

import {
  CopyBlock,
  CopyBlockCode,
  CopyBlockHeader,
  CopyBlockTitle,
} from "@/components/admin-ui/copy-block";
import { CopyButton } from "@/components/admin-ui/copy-button";
import { DataPage } from "@/components/admin-ui/data-panel";
import { GLASS_PANEL } from "@/components/admin-ui/glass";
import { Notice } from "@/components/admin-ui/notice";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderTitle,
} from "@/components/admin-ui/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cliApiBase, cliSiteRoot } from "@/utils/cli/api-base";

/**
 * 命令行（CLI）说明页：/cli（用户菜单）与 /admin/cli（后台导航）共用。
 *
 * 刻意不复用 MCP 接入页：两者是平行的两种接入方式，凭据形态、授权动作、
 * 失效方式都不同，混在一页里会让人以为 CLI 要拿 MCP 令牌。
 * 页面里的命令与参数都对着 cli/src/cli.ts 的 USAGE 写，改 CLI 时这里要一起改。
 */
export default function CLIPage() {
  // 站点与接口地址都在运行时算：换域名、换端口、把 API 挂在别的域上都自动跟着变，
  // 不写死任何一个域名，也不假设页面地址就是接口地址。
  const apiBase = cliApiBase(import.meta.env.VITE_API_BASE_URL);
  const siteRoot = cliSiteRoot(import.meta.env.VITE_API_BASE_URL);
  const release = useCLIRelease(apiBase);

  // 三条安装路径都指向**当前站点**：CLI 没有发布到 npm，包只能由本站提供。
  // 地址按运行时算，换域名、走内网、挂反代前缀都不用改这里。
  const installUnix = `# macOS / Linux：装到 ~/.local，之后可以直接敲 vc
curl -fsSL ${siteRoot}/api/v1/cli/install.sh | sh`;

  const installWindows = `# Windows PowerShell：装到 %LOCALAPPDATA%，并写入用户 PATH
irm ${siteRoot}/api/v1/cli/install.ps1 | iex`;

  const installManual = `# 不想执行脚本就手动下包（解压后 node <目录>/dist/cli.js 即可运行）
curl -fsSL ${siteRoot}/api/v1/cli/download?os=unix -o video-canvas-cli.tgz   # macOS / Linux
curl -fsSL ${siteRoot}/api/v1/cli/download?os=windows -o video-canvas-cli.zip # Windows`;

  const login = `# 打印用户码并自动打开浏览器，在网页上点「允许」
vc login --base ${apiBase}

# 站点地址随凭据一起保存，之后不用再带 --base
vc whoami`;

  const basics = `vc canvas list                        # 我名下的画布
vc canvas get <画布编号>               # 画布详情（含节点与连线）
vc canvas create --title "新项目"      # 建一张空画布，返回画布编号
vc canvas export <画布编号> -o 画布.json
vc canvas import 画布.json             # 从导出文件建一张新画布
vc canvas save <画布编号> --payload 画布.json --revision 3`;

  const tasks = `vc task get <任务ID>                  # 查一次生成任务
vc task wait <任务ID> --timeout 600   # 阻塞到出结果，超时退出码 1`;

  const scripting = `vc canvas list --json    # 一行 JSON：{ok,data} / {ok:false,error}
# 退出码：0 成功 · 1 业务或网络错误 · 2 用法错误`;

  return (
    <DataPage>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>
            命令行（CLI）
            <Badge variant="outline" className="ml-2 align-middle font-normal">
              beta
            </Badge>
          </PageHeaderTitle>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            在终端或脚本里读写自己的画布、等生成结果、导运行记录。 与 MCP 接入互不相干： CLI
            不签发也用不到 MCP 令牌。
          </p>
          <p className="text-muted-foreground mt-1 max-w-3xl text-xs">
            当前是 <strong>beta</strong>{" "}
            渠道：命令名与参数会尽量稳定，但相当一段时间内仍属测试状态，
            输出格式和提示语可能调整；有变化会写在升级提示旁边。
          </p>
        </PageHeaderHeading>
        <PageHeaderActions>
          {/* 完整参考单独一页：安装步骤保持短，契约与排障放到文档里 */}
          <Link to="/cli/docs" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <BookOpen />
            查看 CLI 文档
          </Link>
        </PageHeaderActions>
      </PageHeader>

      <Notice tone="info" title="CLI 和 MCP 是两条独立的路" className="mb-4">
        MCP 是让 <strong>AI 工具</strong>（Claude、Cursor 等）直接操作画布的协议，靠项目令牌授权；
        CLI 是给 <strong>人或者脚本</strong>
        用的，登录时在网页上确认一次用户码，换到的是你自己的登录态。 两者能做的事都限于
        <strong>你名下</strong>的画布，只是调用方不同——不需要为了用 CLI 去建 MCP 项目。
      </Notice>

      <Panel title="与 MCP 接入的区别" className="mb-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-muted-foreground border-chrome-border border-b text-left text-xs">
                <th className="w-24 pb-2 font-normal">对比项</th>
                <th className="pb-2 font-normal">MCP 接入</th>
                <th className="pb-2 font-normal">命令行（CLI）</th>
              </tr>
            </thead>
            <tbody className="divide-chrome-border divide-y">
              <Row label="谁在用" mcp="AI 工具" cli="人和脚本" />
              <Row label="凭据" mcp="项目令牌 vcm_…，有有效期" cli="设备授权换来的登录态，存本机" />
              <Row
                label="怎么授权"
                mcp="在 MCP 接入页签发令牌"
                cli="执行 vc login，网页上确认用户码"
              />
              <Row label="失效方式" mcp="停用项目或注销令牌" cli="登出、改密码或登录态过期" />
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="安装" className="mb-4">
        <p className="text-muted-foreground text-xs">
          命令行单独发版，版本号与站点版本无关
          {release.version ? `：当前 ${release.version}` : ""}。 它<strong>没有发布到 npm</strong>
          ，安装包由本站提供；按系统选一条执行即可（需要 Node 18 及以上，脚本会先检查）。
        </p>
        <CopyBlock>
          <CopyBlockHeader>
            <CopyBlockTitle>macOS / Linux</CopyBlockTitle>
            <CopyButton text={installUnix} />
          </CopyBlockHeader>
          <CopyBlockCode>{installUnix}</CopyBlockCode>
        </CopyBlock>
        <CopyBlock>
          <CopyBlockHeader>
            <CopyBlockTitle>Windows（PowerShell）</CopyBlockTitle>
            <CopyButton text={installWindows} />
          </CopyBlockHeader>
          <CopyBlockCode>{installWindows}</CopyBlockCode>
        </CopyBlock>
        <CopyBlock>
          <CopyBlockHeader>
            <CopyBlockTitle>手动下载</CopyBlockTitle>
            <CopyButton text={installManual} />
          </CopyBlockHeader>
          <CopyBlockCode>{installManual}</CopyBlockCode>
        </CopyBlock>
        <p className="text-muted-foreground text-xs">
          装好后有两个等价的命令名：<code>vc</code> 和 <code>video-canvas-cli</code>。
          升级就是重跑同一条安装命令（脚本向服务端要最新版本）；卸载删掉{" "}
          <code>~/.local/share/video-canvas-cli</code>（Windows 是{" "}
          <code>%LOCALAPPDATA%\video-canvas-cli</code>）与 PATH 里的两个链接即可。
        </p>
      </Panel>

      <Panel title="登录" className="mb-4">
        <CopyBlock>
          <CopyBlockHeader>
            <CopyBlockTitle>登录（当前站点 {siteRoot}）</CopyBlockTitle>
            <CopyButton text={login} />
          </CopyBlockHeader>
          <CopyBlockCode>{login}</CopyBlockCode>
        </CopyBlock>
        <p className="text-muted-foreground text-xs">
          上面的地址是按当前页面的接口配置实时算出来的，换域名或走内网地址访问，这里会自动跟着变，
          不用手改。 用户码 10 分钟内有效；网页上点「拒绝」，命令会立刻退出，什么都不做则等超时。
          不想自动开浏览器就加 <code>--no-open</code>，手动打开打印出来的地址。
        </p>
      </Panel>

      <Panel title="常用命令" className="mb-4">
        <CopyBlock>
          <CopyBlockHeader>
            <CopyBlockTitle>画布</CopyBlockTitle>
            <CopyButton text={basics} />
          </CopyBlockHeader>
          <CopyBlockCode>{basics}</CopyBlockCode>
        </CopyBlock>
        <CopyBlock>
          <CopyBlockHeader>
            <CopyBlockTitle>生成任务</CopyBlockTitle>
            <CopyButton text={tasks} />
          </CopyBlockHeader>
          <CopyBlockCode>{tasks}</CopyBlockCode>
        </CopyBlock>
        <p className="text-muted-foreground text-xs">
          <code>canvas save</code> 带 <code>--revision</code> 时按乐观锁提交：
          画布在别处被改过会直接失败，不会覆盖别人的修改。 完整命令见 <code>vc --help</code>。
        </p>
      </Panel>

      <Panel title="脚本与 Agent 调用" className="mb-4">
        <CopyBlock>
          <CopyBlockHeader>
            <CopyBlockTitle>结构化输出与退出码</CopyBlockTitle>
            <CopyButton text={scripting} />
          </CopyBlockHeader>
          <CopyBlockCode>{scripting}</CopyBlockCode>
        </CopyBlock>
        <p className="text-muted-foreground text-xs">
          <code>--json</code> 下 stdout 只有一行 JSON，进度与提示都走 stderr，管道里可以直接解析。
        </p>
      </Panel>

      <Panel title="凭据与安全">
        <p className="text-muted-foreground text-xs">
          登录态保存在 <code>~/.config/video-canvas/credentials.json</code>
          （目录 0700、文件 0600，内有站点地址与令牌）。 它等同你的登录态，能做的事和网页里一样，
          不要提交进仓库、不要共享给他人。
        </p>
        <p className="text-muted-foreground text-xs">
          <code>vc logout</code> 只删除本机凭据，服务端那枚令牌要等自然过期或用网页改密码后失效。
          换站点就重新 <code>vc login --base 新地址</code>，会覆盖旧凭据。
        </p>
      </Panel>
    </DataPage>
  );
}

/** 页面里的白板区块：标题 + 内容，间距与其他后台页一致。 */
function Panel({
  title,
  className,
  children,
}: {
  title: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`${GLASS_PANEL} mb-4 grid gap-3 p-4 ${className ?? ""}`}>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Terminal className="size-4" aria-hidden="true" />
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * 读服务端的 CLI 发行信息，只为在页面上显示「当前版本」。
 * 它和安装脚本读的是同一个接口，所以界面上的版本号不会与包体不一致。
 * 拿不到（老部署没有这个接口）就什么都不显示——安装命令本身仍然可用。
 */
function useCLIRelease(apiBase: string): { version: string | null } {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${apiBase}/cli/release`, { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { version?: string } } | null) => {
        const next = body?.data?.version;
        if (alive && typeof next === "string" && next) setVersion(next);
      })
      .catch(() => setVersion(null));
    return () => {
      alive = false;
    };
  }, [apiBase]);
  return { version };
}

/** 对比表的一行。 */
function Row({ label, mcp, cli }: { label: string; mcp: ReactNode; cli: ReactNode }) {
  return (
    <tr>
      <th className="text-muted-foreground py-2 pr-4 text-left align-top text-xs font-normal">
        {label}
      </th>
      <td className="py-2 pr-4 align-top">{mcp}</td>
      <td className="py-2 align-top">{cli}</td>
    </tr>
  );
}
