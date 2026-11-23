import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APIError, normalizeBase, request, siteRootOf } from "./client.mjs";
import { clearCredentials, saveCredentials } from "./config.mjs";

/** 任务的终态：到这些状态就不必再等。 */
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "canceled", "expired"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轻量参数解析：`--key value` / `--key=value` / `--flag`。
 * CLI 只有几个命令，不值得引入第三方解析器；语义固定，Agent 也容易生成。
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

/** 成功输出：--json 时一行 JSON（Agent 友好），否则人读文本。 */
function emit(ctx, data, human) {
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, data }));
  } else {
    ctx.stdout(human);
  }
}

/** 读 JSON 文件，失败时给出带路径的错误。 */
function readJSONFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new APIError(-1, `读取 ${file} 失败：${err.message}`, 0);
  }
}

/** 写文件并返回绝对路径；- 表示写到 stdout 之外不写。 */
function writeJSONFile(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, text);
  return path.resolve(file);
}

/** 尽力打开浏览器；失败静默（用户仍能看到打印的地址）。 */
function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // 无图形环境：忽略
  }
}

function requireToken(ctx) {
  if (!ctx.token) throw new APIError(-1, "还没有登录，先执行 `video-canvas-cli login`", 0);
  return ctx.token;
}

/** 把当前有效配置（命令行 > 环境变量 > 已保存）解析成 base。 */
function resolveBase(ctx, flags) {
  return normalizeBase(flags.base || ctx.env.VC_API_BASE || ctx.creds?.base);
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/** 设备授权登录：申请短码 → 用户在网页确认 → 轮询换 JWT。 */
export async function login(ctx, args) {
  const base = resolveBase(ctx, args.flags);
  const clientName = args.flags.name || `video-canvas-cli@${os.hostname()}`;
  const start = await request({
    base,
    method: "POST",
    path: "/auth/cli/device",
    body: { client_name: String(clientName).slice(0, 64) },
    fetchImpl: ctx.fetchImpl,
  });

  const url = `${siteRootOf(base)}${start.verification_uri_complete}`;
  if (!ctx.json) {
    ctx.stderr(`请在浏览器打开：${url}`);
    ctx.stderr(`并确认用户码：${start.user_code}`);
    ctx.stderr(`（已尝试自动打开浏览器；不想自动打开就加 --no-open）`);
  }
  if (!("no-open" in args.flags)) openBrowser(url);

  let interval = Math.max(1, Number(start.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(start.expires_in) || 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await request({
      base,
      method: "POST",
      path: "/auth/cli/token",
      body: { device_code: start.device_code },
      fetchImpl: ctx.fetchImpl,
    });
    switch (poll.status) {
      case "approved": {
        saveCredentials(
          {
            base,
            token: poll.token,
            expire_at: poll.expire_at,
            role: poll.role,
            client_name: clientName,
          },
          ctx.env,
        );
        emit(
          ctx,
          { base, role: poll.role, expire_at: poll.expire_at },
          `已登录（${poll.role}），凭据保存在 ${ctx.credsPath}`,
        );
        return;
      }
      case "denied":
        throw new APIError(-1, "授权被拒绝", 0);
      case "expired":
        throw new APIError(-1, "授权已过期，请重新执行登录", 0);
      case "consumed":
        throw new APIError(-1, "这个设备码已经被使用，请重新执行登录", 0);
      case "slow_down":
        interval += 5000;
        break;
      default:
        // pending：继续等
        break;
    }
  }
  throw new APIError(-1, "等待授权超时，请重新执行登录", 0);
}

/** 退出登录：本地删凭据。服务端 JWT 是自包含的，真正吊销靠网页改密码。 */
export async function logout(ctx) {
  const removed = clearCredentials(ctx.env);
  emit(ctx, { removed }, removed ? `已删除本地凭据（${ctx.credsPath}）` : "本地没有已保存的凭据");
}

/** 当前身份：调 /me 验证令牌仍然有效。 */
export async function whoami(ctx) {
  const token = requireToken(ctx);
  const me = await request({ base: ctx.base, token, path: "/me", fetchImpl: ctx.fetchImpl });
  const name = me.nickname || me.username;
  emit(
    ctx,
    { user: me, base: ctx.base },
    [`用户：${name}（${me.role}）`, `账号：${me.username}`, `接口：${ctx.base}`].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

function formatCanvasRows(list) {
  if (!list.length) return "（没有画布）";
  const lines = ["CODE\tREV\tUPDATED\tTITLE"];
  for (const item of list) {
    lines.push(
      `${item.id}\t${item.revision}\t${String(item.updated_at).replace("T", " ").slice(0, 19)}\t${item.title}`,
    );
  }
  return lines.join("\n");
}

export async function canvasList(ctx, args) {
  const token = requireToken(ctx);
  const page = await request({
    base: ctx.base,
    token,
    path: "/canvas",
    query: { page: args.flags.page, page_size: args.flags["page-size"] || args.flags.page_size },
    fetchImpl: ctx.fetchImpl,
  });
  const list = page.list || [];
  emit(
    ctx,
    { list, total: page.total, page: page.page, page_size: page.page_size },
    `${formatCanvasRows(list)}\n共 ${page.total} 个，第 ${page.page} 页`,
  );
}

/** 取一张画布的完整数据；code 是画布的对外十六进制 id。 */
async function fetchCanvas(ctx, code) {
  const token = requireToken(ctx);
  return request({
    base: ctx.base,
    token,
    path: `/canvas/${encodeURIComponent(code)}`,
    fetchImpl: ctx.fetchImpl,
  });
}

export async function canvasGet(ctx, args) {
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：canvas get <code>", 2);
  const canvas = await fetchCanvas(ctx, code);
  const graph = canvas.payload_json || {};
  const human = [
    `画布：${canvas.title}（${canvas.id}）`,
    `版本：${canvas.revision}`,
    `更新时间：${canvas.updated_at}`,
    `节点：${(graph.nodes || []).length}  连线：${(graph.edges || []).length}`,
  ].join("\n");
  emit(ctx, canvas, human);
}

export async function canvasCreate(ctx, args) {
  const token = requireToken(ctx);
  const title = args.flags.title || "未命名画布";
  const payloadFile = args.flags.payload;
  const payload = payloadFile
    ? readJSONFile(payloadFile)
    : { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const canvas = await request({
    base: ctx.base,
    token,
    method: "POST",
    path: "/canvas",
    body: { title, payload_json: payload },
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, canvas, `已创建：${canvas.title}（${canvas.id}）版本 ${canvas.revision}`);
}

export async function canvasImport(ctx, args) {
  const token = requireToken(ctx);
  const file = args.positional[0] || args.flags.file;
  if (!file) throw new APIError(-1, "用法：canvas import <导出文件.json>", 2);
  const document = readJSONFile(file);
  const result = await request({
    base: ctx.base,
    token,
    method: "POST",
    path: "/canvas/import",
    body: { document },
    fetchImpl: ctx.fetchImpl,
  });
  const canvas = result.canvas || result;
  const report = result.report || {};
  emit(
    ctx,
    result,
    [
      `已导入：${canvas.title}（${canvas.id}）`,
      `素材：复制 ${report.assets?.copied ?? 0} / 共 ${report.assets?.total ?? 0}，丢失 ${report.assets?.missing?.length ?? 0}`,
      `丢弃连线：${report.edges_dropped ?? 0}`,
    ].join("\n"),
  );
}

export async function canvasExport(ctx, args) {
  const token = requireToken(ctx);
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：canvas export <code> [-o 文件]", 2);
  const result = await request({
    base: ctx.base,
    token,
    path: `/canvas/${encodeURIComponent(code)}/export`,
    fetchImpl: ctx.fetchImpl,
  });
  const out = args.flags.o || args.flags.output || `canvas-${code}.json`;
  const saved = writeJSONFile(out, result.document ?? result);
  emit(
    ctx,
    { file: saved, skipped_assets: result.report?.skipped_assets ?? 0 },
    `已导出到 ${saved}`,
  );
}

export async function canvasGraph(ctx, args) {
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：canvas graph <code> [-o 文件]", 2);
  const canvas = await fetchCanvas(ctx, code);
  const graph = canvas.payload_json || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const out = args.flags.o || args.flags.output;
  if (out) {
    const saved = writeJSONFile(out, graph);
    emit(
      ctx,
      { file: saved, revision: canvas.revision },
      `已写出 ${saved}（版本 ${canvas.revision}）`,
    );
    return;
  }
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, data: { revision: canvas.revision, graph } }));
    return;
  }
  ctx.stdout(JSON.stringify(graph, null, 2));
}

/** 整图保存：后端只认 revision 乐观锁，没给版本就先读一次当前值。 */
export async function canvasSave(ctx, args) {
  const token = requireToken(ctx);
  const code = args.positional[0];
  const file = args.flags.payload;
  if (!code || !file)
    throw new APIError(-1, "用法：canvas save <code> --payload <文件.json> [--revision N]", 2);
  const payload = readJSONFile(file);
  let revision = args.flags.revision;
  if (revision === undefined) {
    const current = await fetchCanvas(ctx, code);
    revision = current.revision;
  }
  const canvas = await request({
    base: ctx.base,
    token,
    method: "PUT",
    path: `/canvas/${encodeURIComponent(code)}`,
    body: { revision: Number(revision), payload_json: payload },
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, canvas, `已保存，新版本 ${canvas.revision}`);
}

// ---------------------------------------------------------------------------
// 生成任务
// ---------------------------------------------------------------------------

/** 任务查询：纯数字走 /:id，编码任务号走 ?ids=（列表接口两种都认）。 */
async function fetchTask(ctx, idOrRef) {
  const token = requireToken(ctx);
  if (/^\d+$/.test(idOrRef)) {
    return request({
      base: ctx.base,
      token,
      path: `/generation-tasks/${idOrRef}`,
      fetchImpl: ctx.fetchImpl,
    });
  }
  const list = await request({
    base: ctx.base,
    token,
    path: "/generation-tasks",
    query: { ids: idOrRef },
    fetchImpl: ctx.fetchImpl,
  });
  const task = Array.isArray(list) ? list[0] : list;
  if (!task) throw new APIError(-1, `找不到任务 ${idOrRef}`, 0);
  return task;
}

function formatTask(task) {
  const progress =
    task.progress === null || task.progress === undefined ? "-" : `${task.progress}%`;
  const lines = [
    `任务：${task.task_ref || task.id}`,
    `状态：${task.status}（${progress}）`,
    `类型：${task.kind}  模型：${task.model_id}`,
    `积分：${task.credits}${task.charged_credits === null ? "" : `（实扣 ${task.charged_credits}）`}`,
  ];
  if (task.error_message) lines.push(`错误：${task.error_code || "-"} ${task.error_message}`);
  for (const out of task.outputs || []) lines.push(`产物：${out.url || out}`);
  return lines.join("\n");
}

export async function taskGet(ctx, args) {
  const id = args.positional[0];
  if (!id) throw new APIError(-1, "用法：task get <id|task_ref>", 2);
  const task = await fetchTask(ctx, id);
  emit(ctx, task, formatTask(task));
}

/** 等任务到终态。状态变化打到 stderr，stdout 只留最终结果，方便 `--json` 接管道。 */
export async function taskWait(ctx, args) {
  const id = args.positional[0];
  if (!id)
    throw new APIError(-1, "用法：task wait <id|task_ref> [--timeout 600] [--interval 3]", 2);
  const timeoutMs = Math.max(1, Number(args.flags.timeout) || 600) * 1000;
  const intervalMs = Math.max(1, Number(args.flags.interval) || 3) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last = "";

  while (Date.now() < deadline) {
    const task = await fetchTask(ctx, id);
    if (task.status !== last) {
      const progress =
        task.progress === null || task.progress === undefined ? "" : ` ${task.progress}%`;
      ctx.stderr(`[${new Date().toISOString().slice(11, 19)}] ${task.status}${progress}`);
      last = task.status;
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      emit(ctx, task, formatTask(task));
      if (task.status !== "succeeded") process.exitCode = 1;
      return;
    }
    await sleep(intervalMs);
  }
  throw new APIError(-1, `等待超时（${timeoutMs / 1000}s），任务仍未结束`, 0);
}

// ---------------------------------------------------------------------------
// 运行记录（复用 scripts/agent-trace）
// ---------------------------------------------------------------------------

/**
 * 转发到 scripts/agent-trace/agent-trace.mjs 的 pull / show / compare。
 * 不复制实现：那份脚本已被 /agent-review skill 和文档引用，保持单一来源。
 */
export function trace(ctx, args) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.resolve(here, "../../scripts/agent-trace/agent-trace.mjs");
  if (!fs.existsSync(script)) {
    throw new APIError(-1, `找不到 agent-trace（${script}），请在仓库内运行`, 0);
  }
  const child = spawn(process.execPath, [script, ...args.positional, ...flagsToArgv(args.flags)], {
    stdio: "inherit",
    env: ctx.env,
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}

function flagsToArgv(flags) {
  const out = [];
  for (const [key, value] of Object.entries(flags)) {
    // --json / --base 是本 CLI 的全局选项，agent-trace 不认，不能透传
    if (key === "help" || key === "json" || key === "base") continue;
    if (value === true) out.push(`--${key}`);
    else out.push(`--${key}`, String(value));
  }
  return out;
}

/** 命令表：bin 用它做分发与 help。 */
export const COMMANDS = {
  login,
  logout,
  whoami,
  canvasList,
  canvasGet,
  canvasCreate,
  canvasImport,
  canvasExport,
  canvasGraph,
  canvasSave,
  taskGet,
  taskWait,
  trace,
};
