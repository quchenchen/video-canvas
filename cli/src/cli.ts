#!/usr/bin/env node
// video-canvas-cli：连镜的命令行入口。
// 运行时只依赖 Node 22.18+ 内置能力（技能脚本是 .ts，需要默认的类型擦除）；源码是 TypeScript，构建产物是 dist/cli.js。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APIError, normalizeBase, siteRootOf } from "./client.ts";
import {
  agentApprove,
  agentCancel,
  agentEvents,
  agentRun,
  canvasCompose,
  canvasComposeCancel,
  canvasComposeStatus,
  canvasCreate,
  canvasExport,
  canvasGet,
  canvasGraph,
  canvasImport,
  canvasList,
  canvasNodeAdd,
  canvasNodeRm,
  canvasNodeSet,
  canvasSave,
  credits,
  dramaGet,
  dramaJobCancel,
  dramaJobs,
  dramaList,
  dramaUnit,
  dramaUnits,
  generate,
  login,
  logout,
  modelList,
  modelShow,
  parseArgs,
  taskGet,
  taskWait,
  trace,
  whoami,
} from "./commands.ts";
import { credentialsPath, loadCredentials } from "./config.ts";
import type { Args, Ctx, Flags } from "./types.ts";

const USAGE = `video-canvas-cli（beta）— 连镜命令行

用法：
  video-canvas-cli <命令> [参数]

身份与会话
  login [--base URL] [--name 名称] [--no-open]   设备授权登录（在浏览器里确认一次，默认 30 天免登录）
  logout                                          删除本地凭据
  whoami                                          查看当前身份
  version                                         打印 CLI 版本（与站点版本独立）

画布（读写）
  canvas list [--page N] [--page-size N]
  canvas get <code>
  canvas create --title <标题> [--payload 文件]
  canvas import <导出文件.json>
  canvas export <code> [-o 文件]        -o 与 --output 等价；- 表示输出到 stdout
  canvas graph <code> [-o 文件]
  canvas save <code> --payload 文件 [--revision N]
                                        要 canvas graph 的输出，不是 canvas export 的导出文档

画布节点级编辑（每次都要在终端确认）
  canvas node add <code> --kind <script|image|video|audio> [--label 标题] [--text 正文] [--prompt 提示词]
                        [--model 模型] [--at x,y]
  canvas node set <code> <节点id> [--label 标题] [--text 正文] [--prompt 提示词] [--model 模型]
  canvas node rm <code> <节点id> [更多节点id...]
                                        只提交差异；服务端按 revision 乐观锁写入

模型与积分
  model list [--kind image|video|audio|text]      看有哪些模型、key 是什么
  model show <模型key>                            看这个模型的参数（--param 能填什么）与参考素材上限
  credits                                         余额 / 冻结 / 可用积分

生成（提交后产物由服务端写回节点，无需打开画布）
  generate image|video|audio|text --model <模型key> [--canvas <画布编号> --node <节点id>]
            [--prompt 提示词] [--param 名=值]... [--input '<json>'|@文件|-]
            [--ref-image 素材id]... [--ref-video 素材id]... [--ref-audio 素材id]...
            [--first-frame 素材id [--last-frame 素材id]]   锁首帧 / 首尾帧（视频）
            [--count 1] [--wait] [--timeout 600] [--interval 3]

合成成片
  canvas compose <code> --node <成片节点id> [--assets 素材id,素材id...] [--seqs 1,2,3]
                          [--mode storyboard|compose|selection] [--wait] [--timeout 900]
                                        不给 --assets 时按成片节点的上游顺序推导并打印出来
  canvas compose-status <code> [--job 任务id | --node 节点id]
  canvas compose-cancel <code> --job 任务id

生成任务
  task get <id|task_ref>
  task wait <id|task_ref> [--timeout 600] [--interval 3]

画布 Agent（小镜）：把要改/要生成的事交给它，需要拍板的动作停下来等你决定
  agent run <画布编号> --message "把 S03 重新生成成 10 秒视频" [--selection 节点id,节点id]
            [--budget 积分] [--session 会话编号] [--watch] [--interval 2] [--timeout 600]
  agent events <会话编号> [--after 序号]      看已经发生的事（含审批条目）
  agent approve <审批编号> [--items 0,1] [--reject] [--answer 文本]
  agent cancel <运行编号>
                                        只提交时打印运行编号；--watch 跟到结束或等到需要审批

短剧（只读与任务控制；建项目、改剧本、跑任务仍在网页里）
  drama list [--keyword 关键词] [--page N] [--page-size N]
  drama get <短剧编号> [--episodes 10]          默认只列前 10 集，0 表示全部
  drama units <短剧编号> [--from 1] [--to 20]
  drama unit <短剧编号> <单元号>
  drama jobs <短剧编号> [--active]
  drama job-cancel <短剧编号> --job 任务id

运行记录（转发 scripts/agent-trace；独立安装包用 --script 或 VC_AGENT_TRACE 指定）
  trace pull [--since 7d] [--feedback down] ...
  trace show <run_id>
  trace compare --by harness_key [--since 30d]

全局选项
  --json          输出一行 JSON（{ok,data} / {ok:false,error}），供脚本与 Agent 解析
  --base URL      覆盖 API 地址（也可用环境变量 VC_API_BASE）
  --no-update-check  本次不检查新版本（也可用 VC_NO_UPDATE_CHECK=1）

退出码：0 成功，1 业务或网络错误（含任务失败），2 用法错误，
        3 等待超时（--wait / task wait），4 新建项目或节点级修改被取消

当前是 beta 渠道：命令与参数尽量稳定，但输出格式和提示语仍可能调整。
升级提示写在 stderr；非交互终端与 --json 场景不会打扰脚本。
login 的授权地址始终写在 stderr，--json 时也一样——stdout 只留最后一行 JSON。`;

/** 画布子命令。 */
async function runCanvas(ctx: Ctx, positional: string[], flags: Flags): Promise<void> {
  const [sub, ...rest] = positional;
  const args: Args = { positional: rest, flags };
  switch (sub) {
    case "list":
      return canvasList(ctx, args);
    case "get":
      return canvasGet(ctx, args);
    case "create":
      return canvasCreate(ctx, args);
    case "import":
      return canvasImport(ctx, args);
    case "export":
      return canvasExport(ctx, args);
    case "graph":
      return canvasGraph(ctx, args);
    case "save":
      return canvasSave(ctx, args);
    case "node":
      return runCanvasNode(ctx, rest, flags);
    case "compose":
      return canvasCompose(ctx, { positional: rest, flags });
    case "compose-status":
      return canvasComposeStatus(ctx, { positional: rest, flags });
    case "compose-cancel":
      return canvasComposeCancel(ctx, { positional: rest, flags });
    default:
      throw new APIError(-1, `未知的 canvas 子命令：${sub || "（空）"}\n\n${USAGE}`, 2);
  }
}

/** 节点级编辑子命令：每次都走人工确认，没有跳过确认的开关。 */
async function runCanvasNode(ctx: Ctx, positional: string[], flags: Flags): Promise<void> {
  const [sub, code, ...rest] = positional;
  const args: Args = { positional: [code as string, ...rest], flags };
  switch (sub) {
    case "add":
      return canvasNodeAdd(ctx, args);
    case "set":
      return canvasNodeSet(ctx, args);
    case "rm":
    case "delete":
      return canvasNodeRm(ctx, args);
    default:
      throw new APIError(-1, `未知的 canvas node 子命令：${sub || "（空）"}\n\n${USAGE}`, 2);
  }
}

/** 生成任务子命令。 */
async function runTask(ctx: Ctx, positional: string[], flags: Flags): Promise<void> {
  const [sub, ...rest] = positional;
  const args: Args = { positional: rest, flags };
  switch (sub) {
    case "get":
      return taskGet(ctx, args);
    case "wait":
      return taskWait(ctx, args);
    default:
      throw new APIError(-1, `未知的 task 子命令：${sub || "（空）"}\n\n${USAGE}`, 2);
  }
}

/** 模型子命令。 */
async function runModel(ctx: Ctx, positional: string[], flags: Flags): Promise<void> {
  const [sub, ...rest] = positional;
  const args: Args = { positional: rest, flags };
  switch (sub) {
    case "list":
      return modelList(ctx, args);
    case "show":
      return modelShow(ctx, args);
    default:
      throw new APIError(-1, `未知的 model 子命令：${sub || "（空）"}\n\n${USAGE}`, 2);
  }
}

/** 小镜子命令：run / events / approve / cancel。 */
async function runAgent(ctx: Ctx, positional: string[], flags: Flags): Promise<void> {
  const [sub, ...rest] = positional;
  const args: Args = { positional: rest, flags };
  switch (sub) {
    case "run":
      return agentRun(ctx, args);
    case "events":
      return agentEvents(ctx, args);
    case "approve":
      return agentApprove(ctx, args);
    case "cancel":
      return agentCancel(ctx, args);
    default:
      throw new APIError(-1, `未知的 agent 子命令：${sub || "（空）"}\n\n${USAGE}`, 2);
  }
}

/** 短剧子命令。 */
async function runDrama(ctx: Ctx, positional: string[], flags: Flags): Promise<void> {
  const [sub, ...rest] = positional;
  const args: Args = { positional: rest, flags };
  switch (sub) {
    case "list":
      return dramaList(ctx, args);
    case "get":
      return dramaGet(ctx, args);
    case "units":
      return dramaUnits(ctx, args);
    case "unit":
      return dramaUnit(ctx, args);
    case "jobs":
      return dramaJobs(ctx, args);
    case "job-cancel":
      return dramaJobCancel(ctx, args);
    default:
      throw new APIError(-1, `未知的 drama 子命令：${sub || "（空）"}\n\n${USAGE}`, 2);
  }
}

function buildContext(flags: Flags): Ctx {
  const env = process.env;
  const creds = loadCredentials(env);
  let base: string | null = null;
  let baseError: unknown = null;
  try {
    if (flags.base || env.VC_API_BASE || creds?.base) {
      base = normalizeBase(flags.base || env.VC_API_BASE || creds?.base);
    }
  } catch (err) {
    // 不要吞掉原因：--base 少了 http:// 时要让用户看到「必须以 http:// 开头」，
    // 而不是后面拼出 `null/canvas` 报一句「无法连接 null」。
    baseError = err;
  }
  return {
    env,
    creds,
    credsPath: credentialsPath(env),
    base,
    baseError,
    token: creds?.token,
    json: flags.json === true || flags.json === "true",
    stdout: (line: string) => process.stdout.write(`${line}\n`),
    stderr: (line: string) => process.stderr.write(`${line}\n`),
    fetchImpl: fetch,
  };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    // 版本只认 package.json：安装包、站点界面、这里三处不会各写一个数（以前就漂过）
    const data = {
      name: "video-canvas-cli",
      version: cliVersion(),
      channel: CLI_CHANNEL,
      node: process.version,
      os: process.platform,
      arch: process.arch,
    };
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    } else {
      process.stdout.write(`${data.name} ${data.version} (${CLI_CHANNEL})\n`);
    }
    return;
  }

  const { positional, flags } = parseArgs(rest);
  const ctx = buildContext(flags);
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  // 升级提醒在后台查，命令照跑；提示只写 stderr，且命令结束时最多等 400ms（见 startUpdateCheck）
  const updater = startUpdateCheck(ctx, rest);
  try {
    switch (command) {
      case "login":
        return await login(ctx, { positional, flags });
      case "logout":
        return await logout(ctx);
      case "whoami":
        return await whoami(ctx);
      case "canvas":
        return await runCanvas(ctx, positional, flags);
      case "task":
        return await runTask(ctx, positional, flags);
      case "model":
        return await runModel(ctx, positional, flags);
      case "drama":
        return await runDrama(ctx, positional, flags);
      case "agent":
        return await runAgent(ctx, positional, flags);
      case "generate":
        return await generate(ctx, { positional, flags });
      case "credits":
        return await credits(ctx);
      case "trace":
        return trace(ctx, { positional, flags });
      default:
        throw new APIError(-1, `未知命令：${command}\n\n${USAGE}`, 2);
    }
  } finally {
    await updater.finish();
  }
}

/**
 * CLI 目前是 beta：命令名与参数会尽量稳定，但输出格式、提示语、子命令仍可能调整。
 * 这个标记同时出现在 --help、--version 与站点文档里，不要只在其中一处改。
 */
const CLI_CHANNEL = "beta";

/** 语义化版本比较：a 比 b 新返回 true。beta 期间只比前三段数字，预发布后缀按同版本处理。 */
function isNewer(a: string, b: string): boolean {
  const parse = (value: string): number[] =>
    String(value)
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0);
  }
  return false;
}

interface Updater {
  finish(): Promise<void>;
}

/**
 * 自动升级提醒：启动时向站点查一次最新版本，命令结束时最多等 400ms 再提示。
 *
 * 刻意做成「不落盘、不阻塞、失败静默」：
 * - 不写缓存文件，避免在只读 HOME / 容器里报错；一次 release 请求只有几百字节；
 * - 非交互（stderr 不是终端）不查，脚本与 CI 的日志里不会突然多一行；
 * - --json 时提示仍走 stderr，不影响 stdout 的单行 JSON；
 * - VC_NO_UPDATE_CHECK=1 或 --no-update-check 可彻底关掉。
 */
function startUpdateCheck(ctx: Ctx, argv: string[]): Updater {
  const skip =
    process.env.VC_NO_UPDATE_CHECK === "1" ||
    argv.includes("--no-update-check") ||
    !ctx.base ||
    !process.stderr.isTTY;
  if (skip) return { finish: async () => {} };

  const base = ctx.base as string;
  const local = cliVersion();
  const pending: Promise<string | null> = fetch(`${base}/cli/release`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(1500),
  })
    .then((res) => (res.ok ? (res.json() as Promise<{ data?: { version?: string } }>) : null))
    .then((body) => body?.data?.version || null)
    .catch(() => null);

  return {
    finish: async () => {
      const timeout = new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 400);
        // 不要因为这条提示把进程多留 400ms
        if (typeof timer.unref === "function") timer.unref();
      });
      const latest = await Promise.race([pending, timeout]);
      if (!latest || !isNewer(String(latest), local)) return;
      const site = siteRootOf(base);
      const how =
        process.platform === "win32"
          ? `irm ${site}/api/v1/cli/install.ps1 | iex`
          : `curl -fsSL ${site}/api/v1/cli/install.sh | sh`;
      ctx.stderr("");
      ctx.stderr(
        `提示：命令行有新版本 ${latest}（当前 ${local}，${CLI_CHANNEL} 渠道）。升级：${how}`,
      );
      ctx.stderr("  不想每次都查：VC_NO_UPDATE_CHECK=1");
    },
  };
}

/**
 * CLI 自己的版本号，与站点版本无关：命令行可以单独发版、单独修 bug。
 * 安装包会把 package.json 一起带上，所以装完之后读到的就是安装时的那个版本。
 *
 * 源码在 src/、产物在 dist/，两种位置的上一级都是 cli/（package.json 所在）。
 */
function cliVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    // 源码被单独拷走、package.json 不在旁边：不报错，给一个显然不是正式版的值
    return "0.0.0";
  }
}

const wantsJson = process.argv.slice(2).some((arg) => arg === "--json" || arg === "--json=true");

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof APIError) {
    if (wantsJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: err.code, message: err.message } })}\n`,
      );
    } else {
      process.stderr.write(`错误：${err.message}\n`);
    }
    // exitCode 优先：task wait 超时用 3，与「任务失败」的 1 区分开
    process.exitCode = err.exitCode ?? (err.status === 2 ? 2 : 1);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: -1, message } })}\n`);
  } else {
    process.stderr.write(`错误：${err instanceof Error ? err.stack : message}\n`);
  }
  process.exitCode = 1;
});
