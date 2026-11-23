#!/usr/bin/env node
// video-canvas-cli：连镜的命令行入口。
// 只依赖 Node 18+ 内置能力，认证走设备授权（RFC 8628 简化版），不存密码。

import { APIError, normalizeBase } from "../src/client.mjs";
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

const USAGE = `video-canvas-cli — 连镜命令行

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

退出码：0 成功，1 业务或网络错误，2 用法错误`;

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
    process.stdout.write(`${COMMANDS_VERSION}\n`);
    return;
  }

  const { positional, flags } = parseArgs(rest);
  const ctx = buildContext(flags);
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  switch (command) {
    case "login":
      return login(ctx, { positional, flags });
    case "logout":
      return logout(ctx);
    case "whoami":
      return whoami(ctx);
    case "canvas":
      return runCanvas(ctx, positional, flags);
    case "task":
      return runTask(ctx, positional, flags);
    case "trace":
      return trace(ctx, { positional, flags });
    default:
      throw new APIError(-1, `未知命令：${command}\n\n${USAGE}`, 2);
  }
}

const COMMANDS_VERSION = "video-canvas-cli 0.1.0";

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
