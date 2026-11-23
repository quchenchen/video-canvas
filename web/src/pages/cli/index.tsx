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

  const basics = `# 项目：找到 / 看结构 / 新建（新建需在终端输入 yes）
vc canvas list
vc canvas get <画布编号>
vc canvas graph <画布编号> -o 画布.json
vc canvas create --title "新项目"

# 素材：看模型与余额，提交生成并等结果
vc model list --kind image
vc credits
vc generate image --model <模型key> --prompt "…" --canvas <画布编号> --node <节点id> --wait

# 画布：改节点（需确认）/ 整图写回
vc canvas node add <画布编号> --kind script --label "旁白" --text "第一句"
vc canvas save <画布编号> --payload 画布.json --revision 3

# 成片：按连线顺序拼片
vc canvas compose <画布编号> --node <成片节点id> --wait`;

  const tasks = `vc task get <任务ID>                  # 查一次生成任务
vc task wait <任务ID> --timeout 600   # 阻塞到出结果；超时是退出码 3，任务仍在跑
vc canvas compose-status <画布编号> --node <成片节点id>`;

  const scripting = `vc canvas list --json    # 一行 JSON：{ok,data} / {ok:false,error}
# 退出码：0 成功 · 1 业务或网络错误 · 2 用法错误 · 3 等待超时 · 4 确认被取消`;

  // 技能跟着安装包走，路径带版本号，用通配符找
  const skill = `# 技能就装在命令行目录下
ls -d ~/.local/share/video-canvas-cli/*/skill

# 拷进你用的助手的技能目录（Claude Code / Codex / WorkBuddy 等），放一处即可
mkdir -p ~/.claude/skills && cp -R ~/.local/share/video-canvas-cli/*/skill ~/.claude/skills/video-canvas-cli`;

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
            在终端或脚本里读写你名下的画布：登录、生成、合成、导出。凭据是你自己的登录态，不涉及 MCP
            令牌。
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

      <Panel title="安装" className="mb-4">
        <p className="text-muted-foreground text-xs">
          命令行单独发版，版本号与站点版本无关
          {release.version ? `：当前 ${release.version}` : ""}。 它<strong>没有发布到 npm</strong>
          ，安装包由本站提供；按系统选一条执行即可（需要 Node 22.18 及以上，脚本会先检查）。
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

      <Panel title="配套技能" className="mb-4">
        <p className="text-muted-foreground text-xs">
          安装包附带一份技能文档，供终端里的 AI 助手（Claude Code、Codex、WorkBuddy
          等）查阅：适用场景、模型与参数的查询方式、节点 id 的选取方法、需要人工确认的操作。
          文档随安装包放在安装目录下。
        </p>
        <CopyBlock>
          <CopyBlockHeader>
            <CopyBlockTitle>把技能交给你的助手</CopyBlockTitle>
            <CopyButton text={skill} />
          </CopyBlockHeader>
          <CopyBlockCode>{skill}</CopyBlockCode>
        </CopyBlock>
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
