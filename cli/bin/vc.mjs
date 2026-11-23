#!/usr/bin/env node
// video-canvas-cli：连镜的命令行入口。
// 只依赖 Node 18+ 内置能力，认证走设备授权（RFC 8628 简化版），不存密码。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APIError, normalizeBase, siteRootOf } from "../src/client.mjs";
import {
  canvasCreate,
  canvasExport,
  canvasGet,
  canvasGraph,
  canvasImport,
  canvasList,
  canvasSave,
  login,
  logout,
  parseArgs,
  taskGet,
  taskWait,
  trace,
  whoami,
} from "../src/commands.mjs";
import { credentialsPath, loadCredentials } from "../src/config.mjs";

const USAGE = `video-canvas-cli（beta）— 连镜命令行

用法：
  video-canvas-cli <命令> [参数]

登录
  login [--base URL] [--name 名称] [--no-open]   设备授权登录（在浏览器里确认）
  logout                                          删除本地凭据
  whoami                                          查看当前身份

画布
  canvas list [--page N] [--page-size N]
  canvas get <code>
  canvas create --title <标题> [--payload 文件]
  canvas import <导出文件.json>
  canvas export <code> [-o 文件]
  canvas graph <code> [-o 文件]
  canvas save <code> --payload 文件 [--revision N]

生成任务
  task get <id|task_ref>
  task wait <id|task_ref> [--timeout 600] [--interval 3]

运行记录（转发 scripts/agent-trace）
  trace pull [--since 7d] [--feedback down] ...
  trace show <run_id>
  trace compare --by harness_key [--since 30d]

全局选项
  --json          输出一行 JSON（{ok,data} / {ok:false,error}），供脚本与 Agent 解析
  --base URL      覆盖 API 地址（也可用环境变量 VC_API_BASE）
  --no-update-check  本次不检查新版本（也可用 VC_NO_UPDATE_CHECK=1）

版本
  version         打印 CLI 版本（与站点版本独立）；加 --json 输出机器可读信息

退出码：0 成功，1 业务或网络错误，2 用法错误

当前是 beta 渠道：命令与参数尽量稳定，但输出格式和提示语仍可能调整。
升级提示写在 stderr；非交互终端与 --json 场景不会打扰脚本。`;

/** 画布子命令。 */
async function runCanvas(ctx, positional, flags) {
  const [sub, ...rest] = positional;
  const args = { positional: rest, flags };
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
    default:
      throw new APIError(-1, `未知的 canvas 子命令：${sub || "（空）"}\n\n${USAGE}`, 2);
  }
}

/** 生成任务子命令。 */
async function runTask(ctx, positional, flags) {
  const [sub, ...rest] = positional;
  const args = { positional: rest, flags };
  switch (sub) {
    case "get":
      return taskGet(ctx, args);
    case "wait":
      return taskWait(ctx, args);
    default:
      throw new APIError(-1, `未知的 task 子命令：${sub || "（空）"}\n\n${USAGE}`, 2);
  }
}

function buildContext(flags) {
  const env = process.env;
  const creds = loadCredentials(env);
  let base = null;
  try {
    if (flags.base || env.VC_API_BASE || creds?.base) {
      base = normalizeBase(flags.base || env.VC_API_BASE || creds?.base);
    }
  } catch {
    base = null;
  }
  return {
    env,
    creds,
    credsPath: credentialsPath(env),
    base,
    token: creds?.token,
    json: flags.json === true || flags.json === "true",
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    fetchImpl: fetch,
  };
}

async function main(argv) {
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
      case "trace":
        return await trace(ctx, { positional, flags });
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
function isNewer(a, b) {
  const parse = (value) =>
    String(value)
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0);
  }
  return false;
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
function startUpdateCheck(ctx, argv) {
  const skip =
    process.env.VC_NO_UPDATE_CHECK === "1" ||
    argv.includes("--no-update-check") ||
    !ctx.base ||
    !process.stderr.isTTY;
  if (skip) return { finish: async () => {} };

  const local = cliVersion();
  const pending = fetch(`${ctx.base}/cli/release`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(1500),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => (body && body.data && body.data.version) || null)
    .catch(() => null);

  return {
    finish: async () => {
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 400);
        // 不要因为这条提示把进程多留 400ms
        if (typeof timer.unref === "function") timer.unref();
      });
      const latest = await Promise.race([pending, timeout]);
      if (!latest || !isNewer(String(latest), local)) return;
      const site = siteRootOf(ctx.base);
      const how =
        process.platform === "win32"
          ? `irm ${site}/api/v1/cli/install.ps1 | iex`
          : `curl -fsSL ${site}/api/v1/cli/install.sh | sh`;
      ctx.stderr("");
      ctx.stderr(`提示：命令行有新版本 ${latest}（当前 ${local}，${CLI_CHANNEL} 渠道）。升级：${how}`);
      ctx.stderr("  不想每次都查：VC_NO_UPDATE_CHECK=1");
    },
  };
}

/**
 * CLI 自己的版本号，与站点版本无关：命令行可以单独发版、单独修 bug。
 * 安装包会把 package.json 一起带上，所以装完之后读到的就是安装时的那个版本。
 */
function cliVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    // 源码被单独拷走、package.json 不在旁边：不报错，给一个显然不是正式版的值
    return "0.0.0";
  }
}

const wantsJson = process.argv.slice(2).includes("--json");

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof APIError) {
    if (wantsJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: err.code, message: err.message } })}\n`,
      );
    } else {
      process.stderr.write(`错误：${err.message}\n`);
    }
    process.exitCode = err.status === 2 ? 2 : 1;
    return;
  }
  if (wantsJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: -1, message: String(err?.message || err) } })}\n`,
    );
  } else {
    process.stderr.write(`错误：${err?.stack || err}\n`);
  }
  process.exitCode = 1;
});
