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
 * 短选项别名。只登记确实有文档承诺的那几个；其余 `-x` 原样留给 positional，
 * 这样 `trace` 透传给 agent-trace 的参数不会被 CLI 吞掉。
 */
const SHORT_FLAGS = { o: "output" };

/**
 * 下一个 token 是不是「另一个选项」而不是值。
 * 负数（`-1`）和单个 `-`（stdout 约定）都算值，否则 `--page-size -1`、`-o -` 无法表达。
 */
function isOptionToken(token) {
  if (typeof token !== "string") return false;
  if (token === "-") return false;
  if (/^-\d/.test(token)) return false;
  return token.startsWith("-");
}

/** 取一个必需的字符串型 flag（如 --payload、--title）；无值时给出明确用法。 */
export function stringFlag(flags, name, usage) {
  const value = flags[name];
  if (value === undefined) throw new APIError(-1, usage, 2);
  if (value === true || typeof value !== "string")
    throw new APIError(-1, `--${name} 需要字符串值；用法：${usage}`, 2);
  return value;
}

/** 校验并转换一个整数值；非法值直接报用法错误，不静默退回默认值。 */
export function toInt(raw, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === true) throw new APIError(-1, `--${name} 需要一个数字`, 2);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new APIError(-1, `--${name} 需要 ${min}–${max} 的整数，收到「${raw}」`, 2);
  return value;
}

/** 取一个整数型 flag；没给就用默认值。 */
export function intFlag(flags, name, fallback, options) {
  const raw = flags[name];
  return raw === undefined ? fallback : toInt(raw, name, options);
}

/**
 * 轻量参数解析：`--key value` / `--key=value` / `--flag` / `-o value`。
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
      if (next === undefined || isOptionToken(next)) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
      continue;
    }
    // 短选项只认登记过的别名（当前只有 -o → output），其余保持原样
    const alias = arg.length === 2 && arg[0] === "-" ? SHORT_FLAGS[arg[1]] : undefined;
    if (alias) {
      const next = argv[i + 1];
      if (next === undefined || isOptionToken(next)) {
        flags[alias] = true;
      } else {
        flags[alias] = next;
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

/** 读 JSON 文件；路径写错或内容不是 JSON 都属于用法错误（退出码 2）。 */
function readJSONFile(file) {
  if (file === true || typeof file !== "string")
    throw new APIError(-1, "需要一个 JSON 文件路径", 2);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new APIError(-1, `读取 ${file} 失败：${err.message}`, 2);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new APIError(-1, `${file} 不是合法 JSON：${err.message}`, 2);
  }
}

/**
 * 写 JSON 文件并返回展示用的路径。
 * `-` 表示输出到 stdout（与常见 Unix 习惯一致），此时不落盘、也不返回绝对路径。
 */
function writeJSONFile(ctx, file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (file === "-") {
    ctx.stdout(text.trimEnd());
    return "-";
  }
  if (file === true || typeof file !== "string")
    throw new APIError(-1, "写文件需要给出路径（用 - 表示输出到 stdout）", 2);
  const target = path.resolve(file);
  try {
    fs.writeFileSync(target, text);
  } catch (err) {
    throw new APIError(-1, `写入 ${target} 失败：${err.message}`, 0);
  }
  return target;
}

/**
 * 拒绝把 canvas export 的整份导出文档当成画布 payload 灌进去。
 * save / create 要的是 canvas graph 的输出（nodes / edges / viewport）；
 * 导出文档额外带 format / canvas / assets，直接写进去会把画布结构弄坏。
 */
function assertGraphPayload(payload, command) {
  if (payload && typeof payload === "object" && payload.format && payload.canvas) {
    throw new APIError(
      -1,
      `${command} 收到的是 canvas export 的导出文档（含 format / canvas）。` +
        `要建新画布请用 canvas import；要整图保存请先用 canvas graph 取 nodes 与 edges。`,
      2,
    );
  }
}

/** 解析 --output / -o；`-` 表示 stdout，且不能与 --json 同时用。 */
function resolveOutput(ctx, args, fallback, usage) {
  const raw = args.flags.output !== undefined ? args.flags.output : args.flags.o;
  if (raw === undefined) return fallback;
  if (raw === true || typeof raw !== "string")
    throw new APIError(-1, `--output 需要文件路径（用 - 表示输出到 stdout）；用法：${usage}`, 2);
  if (raw === "-" && ctx.json)
    throw new APIError(-1, "--output - 与 --json 冲突：stdout 只能放一种内容", 2);
  return raw;
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

/**
 * 取可用的 API 根地址。
 * 构建 ctx 时就失败过（比如 --base 少了 http://），优先抛那条原始错误——
 * 直接把 null 拼进 URL 只会得到误导性的「无法连接 null：Invalid URL」。
 */
function baseOf(ctx) {
  if (ctx.base) return ctx.base;
  if (ctx.baseError) throw ctx.baseError;
  throw new APIError(-1, "缺少 API 地址，请用 --base 或环境变量 VC_API_BASE 指定", 2);
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
  // 授权地址始终写 stderr：--json 时 stdout 只留最终一行 JSON，但脚本/用户必须知道去哪儿点确认，
  // 否则登录会一直等到超时（早期版本就是因为把它关在 !ctx.json 里，--json 登录实际不可用）。
  ctx.stderr(`请在浏览器打开：${url}`);
  ctx.stderr(`并确认用户码：${start.user_code}`);
  ctx.stderr(`（已尝试自动打开浏览器；不想自动打开就加 --no-open）`);
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
  const base = baseOf(ctx);
  const me = await request({ base, token, path: "/me", fetchImpl: ctx.fetchImpl });
  const name = me.nickname || me.username;
  emit(
    ctx,
    { user: me, base },
    [`用户：${name}（${me.role}）`, `账号：${me.username}`, `接口：${base}`].join("\n"),
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
  const pageSizeRaw =
    args.flags["page-size"] !== undefined ? args.flags["page-size"] : args.flags.page_size;
  const page = await request({
    base: baseOf(ctx),
    token,
    path: "/canvas",
    query: {
      page: intFlag(args.flags, "page", undefined),
      page_size:
        pageSizeRaw === undefined ? undefined : toInt(pageSizeRaw, "page-size", { max: 200 }),
    },
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
    base: baseOf(ctx),
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
  const title =
    args.flags.title === undefined
      ? "未命名画布"
      : stringFlag(args.flags, "title", "canvas create --title <标题> [--payload 文件]");
  const payload =
    args.flags.payload === undefined
      ? { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
      : readJSONFile(
          stringFlag(args.flags, "payload", "canvas create --title <标题> [--payload 文件]"),
        );
  assertGraphPayload(payload, "canvas create");
  const canvas = await request({
    base: baseOf(ctx),
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
  const file = args.positional[0] ?? args.flags.file;
  if (file === undefined) throw new APIError(-1, "用法：canvas import <导出文件.json>", 2);
  const document = readJSONFile(file);
  const result = await request({
    base: baseOf(ctx),
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
  const out = resolveOutput(ctx, args, `canvas-${code}.json`, "canvas export <code> [-o 文件]");
  const result = await request({
    base: baseOf(ctx),
    token,
    path: `/canvas/${encodeURIComponent(code)}/export`,
    fetchImpl: ctx.fetchImpl,
  });
  const document = result.document ?? result;
  if (out === "-") {
    ctx.stdout(JSON.stringify(document, null, 2));
    return;
  }
  const saved = writeJSONFile(ctx, out, document);
  emit(
    ctx,
    { file: saved, skipped_assets: result.report?.skipped_assets ?? 0 },
    `已导出到 ${saved}`,
  );
}

export async function canvasGraph(ctx, args) {
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：canvas graph <code> [-o 文件]", 2);
  const out = resolveOutput(ctx, args, undefined, "canvas graph <code> [-o 文件]");
  const canvas = await fetchCanvas(ctx, code);
  const graph = canvas.payload_json || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (out === "-") {
    ctx.stdout(JSON.stringify(graph, null, 2));
    return;
  }
  if (out) {
    const saved = writeJSONFile(ctx, out, graph);
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
  const usage = "canvas save <code> --payload <文件.json> [--revision N]";
  if (!code) throw new APIError(-1, `用法：${usage}`, 2);
  const file = stringFlag(args.flags, "payload", usage);
  const payload = readJSONFile(file);
  assertGraphPayload(payload, "canvas save");
  let revision = intFlag(args.flags, "revision", undefined);
  if (revision === undefined) {
    const current = await fetchCanvas(ctx, code);
    revision = current.revision;
  }
  const canvas = await request({
    base: baseOf(ctx),
    token,
    method: "PUT",
    path: `/canvas/${encodeURIComponent(code)}`,
    body: { revision, payload_json: payload },
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
      base: baseOf(ctx),
      token,
      path: `/generation-tasks/${idOrRef}`,
      fetchImpl: ctx.fetchImpl,
    });
  }
  const list = await request({
    base: baseOf(ctx),
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
  const timeoutSeconds = intFlag(args.flags, "timeout", 600, { max: 86400 });
  const intervalSeconds = intFlag(args.flags, "interval", 3, { max: 3600 });
  const deadline = Date.now() + timeoutSeconds * 1000;
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
      if (task.status === "succeeded") {
        emit(ctx, task, formatTask(task));
        return;
      }
      // 失败终态：JSON 的 ok 必须与退出码一致，否则脚本会看到 ok:true 却拿到退出码 1。
      if (ctx.json) {
        ctx.stdout(
          JSON.stringify({
            ok: false,
            error: {
              code: task.error_code ?? -1,
              message: task.error_message || `任务${task.status}`,
            },
            data: task,
          }),
        );
      } else {
        ctx.stdout(formatTask(task));
      }
      process.exitCode = 1;
      return;
    }
    await sleep(intervalSeconds * 1000);
  }
  // 超时不是任务失败：用独立退出码 3，脚本才能区分「没等到」和「跑挂了」。
  throw new APIError(
    -1,
    `等待超时（${timeoutSeconds}s），任务仍未结束；可继续用 task get ${id} 查询`,
    0,
    3,
  );
}

// ---------------------------------------------------------------------------
// 运行记录（复用 scripts/agent-trace）
// ---------------------------------------------------------------------------

/**
 * 转发到 scripts/agent-trace/agent-trace.mjs 的 pull / show / compare。
 * 不复制实现：那份脚本已被 /agent-review skill 和文档引用，保持单一来源。
 *
 * 独立安装包不带 scripts/，所以额外支持 --script 与 VC_AGENT_TRACE；
 * 都找不到时给出可操作的提示，而不是只说「请在仓库内运行」。
 */
export function trace(ctx, args) {
  const script = resolveTraceScript(ctx, args);
  const child = spawn(process.execPath, [script, ...args.positional, ...flagsToArgv(args.flags)], {
    stdio: "inherit",
    env: ctx.env,
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}

/** 定位 agent-trace：显式参数 > 环境变量 > 仓库相对路径 > 当前目录。 */
function resolveTraceScript(ctx, args) {
  const explicit = args.flags.script ?? ctx.env.VC_AGENT_TRACE;
  if (explicit !== undefined) {
    if (explicit === true || typeof explicit !== "string")
      throw new APIError(-1, "--script 需要 agent-trace.mjs 的路径", 2);
    const target = path.resolve(explicit);
    if (!fs.existsSync(target)) throw new APIError(-1, `找不到 agent-trace：${target}`, 2);
    return target;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../scripts/agent-trace/agent-trace.mjs"),
    path.resolve(process.cwd(), "scripts/agent-trace/agent-trace.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new APIError(
    -1,
    [
      "找不到 agent-trace：独立安装包不包含运行记录脚本。",
      "请用 `vc trace ... --script <仓库>/scripts/agent-trace/agent-trace.mjs`，",
      "或设置环境变量 VC_AGENT_TRACE 指向该文件，也可以 cd 到仓库根再执行。",
      `（已尝试：${candidates.join("、")}）`,
    ].join("\n"),
    2,
  );
}

function flagsToArgv(flags) {
  const out = [];
  for (const [key, value] of Object.entries(flags)) {
    // --json / --base / --script 是本 CLI 的选项，agent-trace 不认，不能透传
    if (key === "help" || key === "json" || key === "base" || key === "script") continue;
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
