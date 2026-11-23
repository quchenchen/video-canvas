import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { APIError, errorMessage, normalizeBase, request, siteRootOf } from "./client.ts";
import { clearCredentials, saveCredentials } from "./config.ts";
import type {
  Args,
  Canvas,
  CanvasNode,
  CanvasNodeData,
  ComposeActive,
  ComposeJob,
  ComposeRow,
  Ctx,
  DevicePoll,
  DeviceStart,
  DramaJob,
  DramaSummary,
  DramaUnit,
  DramaView,
  ExportResult,
  FlagValue,
  Flags,
  GenerateItem,
  GenerateResponse,
  Graph,
  ImportResult,
  Me,
  Model,
  ModelParamField,
  OpsResult,
  Page,
  Task,
} from "./types.ts";

/** JSON 解析出来的值：结构由调用方按用途断言，不在解析处假装知道形状。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JSONValue = any;

/** 任务的终态：到这些状态就不必再等。 */
const TERMINAL_TASK_STATUSES = new Set<string>(["succeeded", "failed", "canceled", "expired"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 短选项别名。只登记确实有文档承诺的那几个；其余 `-x` 原样留给 positional，
 * 这样 `trace` 透传给 agent-trace 的参数不会被 CLI 吞掉。
 */
const SHORT_FLAGS: Record<string, string> = { o: "output" };

/**
 * 可以给多次的 flag：保留成列表，而不是后一个覆盖前一个。
 * 只登记「本来就是多值」的几个（生成参数、参考素材、成片素材、镜号），
 * 其余 flag 仍是「后出现者生效」——单值字段给两次是笔误，不该悄悄变成数组。
 */
const MULTI_FLAGS = new Set<string>([
  "param",
  "ref-image",
  "ref-video",
  "ref-audio",
  "assets",
  "seqs",
]);

/**
 * 下一个 token 是不是「另一个选项」而不是值。
 * 负数（`-1`）和单个 `-`（stdout 约定）都算值，否则 `--page-size -1`、`-o -` 无法表达。
 */
function isOptionToken(token: unknown): boolean {
  if (typeof token !== "string") return false;
  if (token === "-") return false;
  if (/^-\d/.test(token)) return false;
  return token.startsWith("-");
}

/** 取一个必需的字符串型 flag（如 --payload、--title）；无值时给出明确用法。 */
export function stringFlag(flags: Flags, name: string, usage: string): string {
  const value = flags[name];
  if (value === undefined) throw new APIError(-1, usage, 2);
  if (value === true || typeof value !== "string")
    throw new APIError(-1, `--${name} 需要字符串值；用法：${usage}`, 2);
  return value;
}

export interface IntOptions {
  min?: number;
  max?: number;
}

/** 校验并转换一个整数值；非法值直接报用法错误，不静默退回默认值。 */
export function toInt(raw: FlagValue | number, name: string, options: IntOptions = {}): number {
  const { min = 1, max = Number.MAX_SAFE_INTEGER } = options;
  if (raw === true || Array.isArray(raw)) throw new APIError(-1, `--${name} 需要一个数字`, 2);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new APIError(-1, `--${name} 需要 ${min}–${max} 的整数，收到「${raw}」`, 2);
  return value;
}

/** 取一个整数型 flag；没给就用默认值。 */
export function intFlag(
  flags: Flags,
  name: string,
  fallback: undefined,
  options?: IntOptions,
): number | undefined;
export function intFlag(flags: Flags, name: string, fallback: number, options?: IntOptions): number;
export function intFlag(
  flags: Flags,
  name: string,
  fallback: number | undefined,
  options?: IntOptions,
): number | undefined;
export function intFlag(
  flags: Flags,
  name: string,
  fallback: number | undefined,
  options?: IntOptions,
): number | undefined {
  const raw = flags[name];
  return raw === undefined ? fallback : toInt(raw, name, options);
}

/**
 * 轻量参数解析：`--key value` / `--key=value` / `--flag` / `-o value`。
 * CLI 只有几个命令，不值得引入第三方解析器；语义固定，Agent 也容易生成。
 */
export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Flags = {};
  const setFlag = (name: string, value: string | true): void => {
    if (!MULTI_FLAGS.has(name)) {
      flags[name] = value;
      return;
    }
    const prev = flags[name];
    if (prev === undefined) flags[name] = [value];
    else if (Array.isArray(prev)) prev.push(value);
    else flags[name] = [prev, value];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > -1) {
        setFlag(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || isOptionToken(next)) {
        setFlag(name, true);
      } else {
        setFlag(name, next);
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
function emit(ctx: Ctx, data: unknown, human: string): void {
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, data }));
  } else {
    ctx.stdout(human);
  }
}

/** 读 JSON 文件；路径写错或内容不是 JSON 都属于用法错误（退出码 2）。 */
function readJSONFile(file: unknown): JSONValue {
  if (file === true || typeof file !== "string")
    throw new APIError(-1, "需要一个 JSON 文件路径", 2);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new APIError(-1, `读取 ${file} 失败：${errorMessage(err)}`, 2);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new APIError(-1, `${file} 不是合法 JSON：${errorMessage(err)}`, 2);
  }
}

/**
 * 写 JSON 文件并返回展示用的路径。
 * `-` 表示输出到 stdout（与常见 Unix 习惯一致），此时不落盘、也不返回绝对路径。
 */
function writeJSONFile(ctx: Ctx, file: unknown, value: unknown): string {
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
    throw new APIError(-1, `写入 ${target} 失败：${errorMessage(err)}`, 0);
  }
  return target;
}

/**
 * 拒绝把 canvas export 的整份导出文档当成画布 payload 灌进去。
 * save / create 要的是 canvas graph 的输出（nodes / edges / viewport）；
 * 导出文档额外带 format / canvas / assets，直接写进去会把画布结构弄坏。
 */
function assertGraphPayload(payload: JSONValue, command: string): void {
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
function resolveOutput(
  ctx: Ctx,
  args: Args,
  fallback: string | undefined,
  usage: string,
): string | undefined {
  const raw = args.flags.output !== undefined ? args.flags.output : args.flags.o;
  if (raw === undefined) return fallback;
  if (raw === true || typeof raw !== "string")
    throw new APIError(-1, `--output 需要文件路径（用 - 表示输出到 stdout）；用法：${usage}`, 2);
  if (raw === "-" && ctx.json)
    throw new APIError(-1, "--output - 与 --json 冲突：stdout 只能放一种内容", 2);
  return raw;
}

/** 尽力打开浏览器；失败静默（用户仍能看到打印的地址）。 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // 无图形环境：忽略
  }
}

function requireToken(ctx: Ctx): string {
  if (!ctx.token) throw new APIError(-1, "还没有登录，先执行 `video-canvas-cli login`", 0);
  return ctx.token;
}

/**
 * 取可用的 API 根地址。
 * 构建 ctx 时就失败过（比如 --base 少了 http://），优先抛那条原始错误——
 * 直接把 null 拼进 URL 只会得到误导性的「无法连接 null：Invalid URL」。
 */
function baseOf(ctx: Ctx): string {
  if (ctx.base) return ctx.base;
  if (ctx.baseError) throw ctx.baseError;
  throw new APIError(-1, "缺少 API 地址，请用 --base 或环境变量 VC_API_BASE 指定", 2);
}

/** 把当前有效配置（命令行 > 环境变量 > 已保存）解析成 base。 */
function resolveBase(ctx: Ctx, flags: Flags): string {
  return normalizeBase(flags.base || ctx.env.VC_API_BASE || ctx.creds?.base);
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/** 设备授权登录：申请短码 → 用户在网页确认 → 轮询换 JWT。 */
export async function login(ctx: Ctx, args: Args): Promise<void> {
  const base = resolveBase(ctx, args.flags);
  const clientName = String(args.flags.name || `video-canvas-cli@${os.hostname()}`);
  const start = await request<DeviceStart>({
    base,
    method: "POST",
    path: "/auth/cli/device",
    body: { client_name: clientName.slice(0, 64) },
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
    const poll = await request<DevicePoll>({
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
export async function logout(ctx: Ctx): Promise<void> {
  const removed = clearCredentials(ctx.env);
  emit(ctx, { removed }, removed ? `已删除本地凭据（${ctx.credsPath}）` : "本地没有已保存的凭据");
}

/** 当前身份：调 /me 验证令牌仍然有效。 */
export async function whoami(ctx: Ctx): Promise<void> {
  const token = requireToken(ctx);
  const base = baseOf(ctx);
  const me = await request<Me>({ base, token, path: "/me", fetchImpl: ctx.fetchImpl });
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

function formatCanvasRows(list: Canvas[]): string {
  if (!list.length) return "（没有画布）";
  const lines = ["CODE\tREV\tUPDATED\tTITLE"];
  for (const item of list) {
    lines.push(
      `${item.id}\t${item.revision}\t${String(item.updated_at).replace("T", " ").slice(0, 19)}\t${item.title}`,
    );
  }
  return lines.join("\n");
}

export async function canvasList(ctx: Ctx, args: Args): Promise<void> {
  const token = requireToken(ctx);
  const pageSizeRaw =
    args.flags["page-size"] !== undefined ? args.flags["page-size"] : args.flags.page_size;
  const page = await request<Page<Canvas>>({
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
async function fetchCanvas(ctx: Ctx, code: string): Promise<Canvas> {
  const token = requireToken(ctx);
  return request<Canvas>({
    base: baseOf(ctx),
    token,
    path: `/canvas/${encodeURIComponent(code)}`,
    fetchImpl: ctx.fetchImpl,
  });
}

export async function canvasGet(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：canvas get <code>", 2);
  const canvas = await fetchCanvas(ctx, code);
  const graph: Graph = canvas.payload_json || {};
  const human = [
    `画布：${canvas.title}（${canvas.id}）`,
    `版本：${canvas.revision}`,
    `更新时间：${canvas.updated_at}`,
    `节点：${(graph.nodes || []).length}  连线：${(graph.edges || []).length}`,
  ].join("\n");
  emit(ctx, canvas, human);
}

/** 新建项目前的确认信息。 */
interface CreateConfirm {
  what: string;
  title: string;
  lines: string[];
  hint: string;
}

/**
 * 新建项目（画布）前的硬门禁。
 *
 * 为什么单独设这道门：`canvas create` / `canvas import` 会在账号下**新增**一张画布，
 * 而命令行是能被脚本/Agent 批量调用的——没有拦截的话，一次循环就能堆出几十张没人知道的空项目，
 * 事后还得有人去前端一张张删（CLI 本身没有 delete）。节点级修改只是改已有画布，这道门管的是「新建」这类动作。
 *
 * 三道门与节点级修改一致：--json 不可用（脚本无法"确认"）、stdin/stderr 必须是终端、必须输入 yes。
 */
async function confirmCreate(ctx: Ctx, confirm: CreateConfirm): Promise<void> {
  const { what, title, lines, hint } = confirm;
  if (ctx.json)
    throw new APIError(
      -1,
      `\`${what}\` 会在账号下新建项目，必须先由人确认，不能与 --json 一起用；${hint}`,
      2,
    );
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new APIError(
      -1,
      [
        `\`${what}\` 需要交互确认：新建项目会在账号下留下新画布，当前终端不是交互式的，已拒绝执行。`,
        `请在终端里手动执行；${hint}`,
      ].join("\n"),
      2,
    );
  ctx.stderr(`将新建画布：`);
  ctx.stderr(`  标题：${title}`);
  for (const line of lines) ctx.stderr(`  ${line}`);
  await askYes(ctx, `确认新建？输入 yes 回车，其它任意输入取消：`, "已取消，没有新建任何画布");
}

/**
 * 等人点头的唯一出口：只认终端里敲的 `yes`。
 * 取消用退出码 4（与「被取消」区分于「失败」），非交互终端与 --json 一律拒绝。
 */
async function askYes(ctx: Ctx, question: string, cancelMessage: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  let answer = "";
  try {
    answer = await rl.question(question);
  } finally {
    rl.close();
  }
  if (answer.trim() !== "yes") throw new APIError(-1, cancelMessage, 0, 4);
}

export async function canvasCreate(ctx: Ctx, args: Args): Promise<void> {
  const token = requireToken(ctx);
  const usage = "canvas create --title <标题> [--payload 文件]";
  const title =
    args.flags.title === undefined ? "未命名画布" : stringFlag(args.flags, "title", usage);
  const payload: JSONValue =
    args.flags.payload === undefined
      ? { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
      : readJSONFile(stringFlag(args.flags, "payload", usage));
  assertGraphPayload(payload, "canvas create");

  const nodes = payload.nodes || [];
  const edges = payload.edges || [];
  await confirmCreate(ctx, {
    what: "canvas create",
    title,
    lines: [
      `内容：${nodes.length ? `${nodes.length} 个节点、${edges.length} 条连线` : "空白画布"}`,
      `来源：${args.flags.payload === undefined ? "命令行参数（无 payload）" : "命令行参数 --payload"}`,
    ],
    hint: "要在脚本里批量建画布，只能在终端里逐次确认；CLI 没有跳过确认的开关。",
  });

  const canvas = await request<Canvas>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: "/canvas",
    body: { title, payload_json: payload },
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, canvas, `已创建：${canvas.title}（${canvas.id}）版本 ${canvas.revision}`);
}

export async function canvasImport(ctx: Ctx, args: Args): Promise<void> {
  const token = requireToken(ctx);
  const file = args.positional[0] ?? args.flags.file;
  if (file === undefined) throw new APIError(-1, "用法：canvas import <导出文件.json>", 2);
  const document: JSONValue = readJSONFile(file);
  const source = document.canvas || {};
  const assets = Array.isArray(document.assets)
    ? document.assets.length
    : Object.keys(document.assets || {}).length;
  await confirmCreate(ctx, {
    what: "canvas import",
    title: source.title || "（导出文档里没有标题）",
    lines: [
      `来源：${typeof file === "string" ? path.resolve(file) : file}`,
      `内容：${(source.nodes || []).length} 个节点、${(source.edges || []).length} 条连线、${assets} 份素材`,
    ],
    hint: "导入只新建画布，不会覆盖已有画布；已存在的画布请用 canvas save 改。",
  });
  const result = await request<ImportResult>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: "/canvas/import",
    body: { document },
    fetchImpl: ctx.fetchImpl,
  });
  const canvas: Canvas = result.canvas || (result as unknown as Canvas);
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

export async function canvasExport(ctx: Ctx, args: Args): Promise<void> {
  const token = requireToken(ctx);
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：canvas export <code> [-o 文件]", 2);
  const out = resolveOutput(ctx, args, `canvas-${code}.json`, "canvas export <code> [-o 文件]");
  const result = await request<ExportResult>({
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

export async function canvasGraph(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：canvas graph <code> [-o 文件]", 2);
  const out = resolveOutput(ctx, args, undefined, "canvas graph <code> [-o 文件]");
  const canvas = await fetchCanvas(ctx, code);
  const graph: Graph = canvas.payload_json || {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
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
export async function canvasSave(ctx: Ctx, args: Args): Promise<void> {
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
  const canvas = await request<Canvas>({
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
// 节点级编辑：只提交差异，且必须由人在终端确认
// ---------------------------------------------------------------------------

/** 命令行支持新建的节点种类。其余种类要填内嵌结构，适合在画面上建。 */
const CLI_NODE_KINDS = ["script", "image", "video", "audio"];

const KIND_NAMES: Record<string, string> = {
  script: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
  storyboard: "分镜表",
  compose: "成片",
  character: "角色",
  director: "导演台",
};

const kindName = (kind?: string): string => (kind ? KIND_NAMES[kind] || kind : "节点");

/** 解析 `--at 100,200`。 */
function parsePoint(raw: FlagValue): { x: number; y: number } {
  const parts = String(raw).split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y))
    throw new APIError(-1, "--at 需要 x,y 两个数字，例如 --at 100,200", 2);
  return { x, y };
}

/** 按 id 找节点；找不到直接报错，别把无效 id 提交给服务端。 */
function nodeById(graph: Graph, id: string): CanvasNode {
  const node = (graph.nodes || []).find((n) => n && n.id === id);
  if (!node) throw new APIError(-1, `画布上没有节点 ${id}`, 2);
  return node;
}

/** 把服务端返回的差异排成人能读的几行。 */
function formatChanges(res: OpsResult): string {
  const lines = [`已保存，版本 ${res.revision}`];
  for (const c of res.changes || []) {
    const mark = c.op === "create" ? "+" : c.op === "update" ? "~" : "-";
    const what = c.kind === "edge" ? "连线" : "节点";
    const fields = c.op === "update" && c.after ? `（${Object.keys(c.after).join("、")}）` : "";
    lines.push(`${mark} ${what} ${c.id}${fields}`);
  }
  if (lines.length === 1) lines.push("（没有实际改动）");
  for (const w of res.warnings || []) lines.push(`提醒：${w}`);
  return lines.join("\n");
}

/** 节点级改动要提交的内容：ops 与 deleteNodeIds 至少有一个，外加给人看的说明。 */
interface NodeOps {
  ops?: Array<Record<string, unknown>>;
  deleteNodeIds?: string[];
  lines: string[];
}

/**
 * 节点级改动的唯一出口：先读当前图、把要改的内容摆给人看、等终端确认，
 * 确认后带「刚才读到的那个 revision」提交。
 *
 * 这样人确认的差异与实际落库的差异不会错位：读完之后画布被别人改过，
 * 服务端会以 409 拒绝，而不是把人没看过的版本覆盖掉。
 *
 * 没有 --yes 之类的旁路：脚本要批量改画布，走 `canvas graph` + `canvas save`。
 */
async function commitNodeOps(
  ctx: Ctx,
  code: string,
  build: (graph: Graph) => NodeOps,
): Promise<void> {
  if (ctx.json)
    throw new APIError(
      -1,
      "节点级修改必须先由人确认，不能与 --json 一起用；脚本批量修改请用 canvas graph + canvas save",
      2,
    );
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new APIError(
      -1,
      [
        "节点级修改需要交互确认：当前终端不是交互式的，已拒绝执行。",
        "请在终端里手动执行；脚本批量修改画布请用 canvas graph + canvas save。",
      ].join("\n"),
      2,
    );

  const canvas = await fetchCanvas(ctx, code);
  const graph: Graph = canvas.payload_json || { nodes: [], edges: [] };
  const { ops, deleteNodeIds, lines } = build(graph);

  ctx.stderr(`画布：${canvas.title}（${code}）当前版本 ${canvas.revision}`);
  ctx.stderr("将提交以下改动：");
  for (const line of lines) ctx.stderr(`  ${line}`);
  await askYes(ctx, "确认执行？输入 yes 回车，其它任意输入取消：", "已取消，画布未修改");

  const body: Record<string, unknown> = { revision: canvas.revision };
  if (ops?.length) body.ops = ops;
  if (deleteNodeIds?.length) body.deleteNodeIds = deleteNodeIds;
  const res = await request<OpsResult>({
    base: baseOf(ctx),
    token: requireToken(ctx),
    method: "POST",
    path: `/canvas/${encodeURIComponent(code)}/ops`,
    body,
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, res, formatChanges(res));
}

/** canvas node add：新建一个普通节点。 */
export async function canvasNodeAdd(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const usage =
    "canvas node add <画布编号> --kind <种类> [--label 标题] [--text 正文] [--prompt 提示词] [--model 模型] [--at x,y]";
  if (!code) throw new APIError(-1, `用法：${usage}`, 2);
  const kind = stringFlag(args.flags, "kind", usage);
  if (!CLI_NODE_KINDS.includes(kind))
    throw new APIError(
      -1,
      `--kind 只能是 ${CLI_NODE_KINDS.map((k) => `${k}（${kindName(k)}）`).join(" / ")}；` +
        "角色卡、分镜表、成片、导演台要在画面上创建",
      2,
    );

  const label = args.flags.label === undefined ? "" : stringFlag(args.flags, "label", usage);
  const model = args.flags.model === undefined ? undefined : stringFlag(args.flags, "model", usage);
  const at = args.flags.at === undefined ? undefined : parsePoint(args.flags.at);
  if (kind === "script" && args.flags.prompt !== undefined)
    throw new APIError(-1, "文本节点的正文用 --text 传（服务端写进节点正文），不要用 --prompt", 2);
  if (kind !== "script" && args.flags.text !== undefined)
    throw new APIError(-1, `--text 只用于文本节点；${kindName(kind)}节点请用 --prompt`, 2);
  const content =
    kind === "script"
      ? args.flags.text === undefined
        ? undefined
        : stringFlag(args.flags, "text", usage)
      : args.flags.prompt === undefined
        ? undefined
        : stringFlag(args.flags, "prompt", usage);

  await commitNodeOps(ctx, code, () => {
    const op: Record<string, unknown> = { op: "create_node", tempId: "n1", kind };
    if (label) op.label = label;
    if (content !== undefined) op.prompt = content;
    if (model !== undefined) op.model = model;
    if (at) op.position = at;
    const lines = [`+ 新建${kindName(kind)}节点${label ? `「${label}」` : ""}`];
    if (content !== undefined)
      lines.push(`  ${kind === "script" ? "正文" : "提示词"} ${content.length} 字`);
    if (model !== undefined) lines.push(`  模型 ${model}`);
    if (at) lines.push(`  位置 ${at.x},${at.y}`);
    return { ops: [op], lines };
  });
}

/** canvas node set：改标题、正文、提示词或模型。 */
export async function canvasNodeSet(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const id = args.positional[1];
  const usage =
    "canvas node set <画布编号> <节点id> [--label 标题] [--text 正文] [--prompt 提示词] [--model 模型]";
  if (!code || !id) throw new APIError(-1, `用法：${usage}`, 2);
  if (!["label", "text", "prompt", "model"].some((k) => args.flags[k] !== undefined))
    throw new APIError(-1, "至少给一个要改的字段：--label / --text / --prompt / --model", 2);

  await commitNodeOps(ctx, code, (graph) => {
    const node = nodeById(graph, id);
    const kind = node.data?.kind;
    const op: Record<string, unknown> = { op: "update_node", id };
    const lines = [
      `~ 修改${kindName(kind)}节点 ${id}${node.data?.label ? `「${node.data.label}」` : ""}`,
    ];

    if (args.flags.label !== undefined) {
      const value = stringFlag(args.flags, "label", usage);
      op.label = value;
      lines.push(`  标题 → ${value}`);
    }
    if (args.flags.text !== undefined) {
      if (kind !== "script")
        throw new APIError(-1, `--text 只用于文本节点；${kindName(kind)}节点请用 --prompt`, 2);
      const value = stringFlag(args.flags, "text", usage);
      op.prompt = value;
      lines.push(`  正文 → ${value.length} 字`);
    }
    if (args.flags.prompt !== undefined) {
      if (kind === "script") throw new APIError(-1, "文本节点的正文请用 --text", 2);
      const value = stringFlag(args.flags, "prompt", usage);
      op.prompt = value;
      lines.push(`  提示词 → ${value.length} 字`);
    }
    if (args.flags.model !== undefined) {
      const value = stringFlag(args.flags, "model", usage);
      op.model = value;
      lines.push(`  模型 → ${value}`);
    }
    return { ops: [op], lines };
  });
}

/** canvas node rm：删节点，连带清理连线、分镜挂接与成片顺序（由服务端统一处理）。 */
export async function canvasNodeRm(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const ids = args.positional.slice(1);
  if (!code || !ids.length)
    throw new APIError(-1, "用法：canvas node rm <画布编号> <节点id> [更多节点id...]", 2);

  await commitNodeOps(ctx, code, (graph) => {
    const drop = new Set(ids);
    const lines: string[] = [];
    for (const id of ids) {
      const node = nodeById(graph, id);
      if (node.type === "group")
        throw new APIError(-1, `不能删组 ${id}：先把成员移出组，或在画面上删除`, 2);
      lines.push(
        `- 删除${kindName(node.data?.kind)}节点 ${id}${node.data?.label ? `「${node.data.label}」` : ""}`,
      );
    }
    const edges = (graph.edges || []).filter((e) => drop.has(e.source) || drop.has(e.target));
    if (edges.length) lines.push(`  同时删除 ${edges.length} 条连线`);
    let refs = 0;
    for (const n of graph.nodes || []) {
      const shots = n?.data?.storyboard?.shots;
      if (Array.isArray(shots))
        for (const shot of shots) {
          const video = shot?.videoNodeId;
          const image = shot?.imageNodeId;
          if (video && drop.has(video)) refs++;
          if (image && drop.has(image)) refs++;
        }
      const order = n?.data?.composeOrder;
      if (Array.isArray(order)) for (const v of order) if (drop.has(String(v))) refs++;
    }
    if (refs) lines.push(`  同时清掉 ${refs} 处分镜 / 成片引用`);
    return { deleteNodeIds: ids, lines };
  });
}

// ---------------------------------------------------------------------------
// 生成任务
// ---------------------------------------------------------------------------

/** 任务查询：纯数字走 /:id，编码任务号走 ?ids=（列表接口两种都认）。 */
async function fetchTask(ctx: Ctx, idOrRef: string): Promise<Task> {
  const token = requireToken(ctx);
  if (/^\d+$/.test(idOrRef)) {
    return request<Task>({
      base: baseOf(ctx),
      token,
      path: `/generation-tasks/${idOrRef}`,
      fetchImpl: ctx.fetchImpl,
    });
  }
  const list = await request<Task[] | Task>({
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

function formatTask(task: Task): string {
  const progress =
    task.progress === null || task.progress === undefined ? "-" : `${task.progress}%`;
  const lines = [
    `任务：${task.task_ref || task.id}`,
    `状态：${task.status}（${progress}）`,
    `类型：${task.kind}  模型：${task.model_id}`,
    `积分：${task.credits}${task.charged_credits === null ? "" : `（实扣 ${task.charged_credits}）`}`,
  ];
  if (task.error_message) lines.push(`错误：${task.error_code || "-"} ${task.error_message}`);
  for (const out of task.outputs || [])
    lines.push(`产物：${typeof out === "string" ? out : out.url || JSON.stringify(out)}`);
  return lines.join("\n");
}

export async function taskGet(ctx: Ctx, args: Args): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new APIError(-1, "用法：task get <id|task_ref>", 2);
  const task = await fetchTask(ctx, id);
  emit(ctx, task, formatTask(task));
}

/** 等任务到终态。状态变化打到 stderr，stdout 只留最终结果，方便 `--json` 接管道。 */
export async function taskWait(ctx: Ctx, args: Args): Promise<void> {
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
// 模型与积分：提交生成之前先看清「有哪些模型」「要多少积分」
// ---------------------------------------------------------------------------

/** 取一个可重复 flag 的值：支持给多次，也支持一次给逗号分隔。 */
function listFlag(flags: Flags, name: string): string[] {
  const raw = flags[name];
  if (raw === undefined) return [];
  const values: Array<string | true> = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const value of values) {
    if (value === true || typeof value !== "string")
      throw new APIError(-1, `--${name} 需要值，例如 --${name} 1024`, 2);
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function formatModelRows(list: Model[]): string {
  if (!list.length) return "（没有可用模型）";
  const lines = ["KEY\tKIND\tLABEL\tHINT"];
  for (const item of list) {
    lines.push(`${item.key}\t${item.kind}\t${item.label || ""}\t${item.hint || ""}`);
  }
  return lines.join("\n");
}

/** 可用的模型清单（已上架、渠道与插件都就绪的）。 */
export async function modelList(ctx: Ctx, args: Args): Promise<void> {
  const token = requireToken(ctx);
  const kind = args.flags.kind;
  if (kind !== undefined && (kind === true || typeof kind !== "string"))
    throw new APIError(-1, "用法：model list [--kind image|video|audio|text]", 2);
  const models =
    (await request<Model[]>({
      base: baseOf(ctx),
      token,
      path: "/models",
      query: { kind },
      fetchImpl: ctx.fetchImpl,
    })) || [];
  emit(ctx, models, formatModelRows(models));
}

/** 一行参数说明：范围 / 默认值 / 是否在画布上隐藏。 */
function formatParamLine(name: string, field: ModelParamField): string {
  const range =
    field.type === "enum"
      ? `可选 ${(field.options || []).join(" / ")}`
      : field.type === "number"
        ? `${field.min ?? "-"}–${field.max ?? "-"}${field.unit ? ` ${field.unit}` : ""}`
        : "布尔";
  const fallback = field.open === false ? "，画布上不显示、按默认发送" : "";
  const preset = field.default !== undefined ? `，默认 ${JSON.stringify(field.default)}` : "";
  return `参数 ${name}：${field.label || name}（${range}${preset}${fallback}）`;
}

/**
 * 单个模型的细节：生成方式、参数（--param 能填什么）、参考素材上限、计价。
 * 这些正是提交生成时最容易猜错的部分，所以单独一条命令，而不是让用户翻后台。
 */
export async function modelShow(ctx: Ctx, args: Args): Promise<void> {
  const key = args.positional[0];
  if (!key) throw new APIError(-1, "用法：model show <模型 key>", 2);
  const token = requireToken(ctx);
  const models =
    (await request<Model[]>({
      base: baseOf(ctx),
      token,
      path: "/models",
      fetchImpl: ctx.fetchImpl,
    })) || [];
  const model = models.find((item) => item.key === key);
  if (!model) {
    const near = models
      .filter((item) => String(item.key).includes(key) || String(item.label || "").includes(key))
      .map((item) => item.key);
    throw new APIError(
      -1,
      `找不到模型 ${key}${near.length ? `；相近的有：${near.join("、")}` : ""}。用 model list 看全部`,
      0,
    );
  }
  const caps = model.capabilities || {};
  const lines = [
    `${model.label || model.key}（${model.key}）`,
    `种类：${model.kind}${model.vendor ? `  厂商：${model.vendor}` : ""}`,
    `生成方式：${(caps.ops || []).join(" / ") || "-"}`,
  ];
  // capabilities.params 在接口里是「名字 -> 字段」的对象（键序就是画布参数面板的顺序），不是数组
  const params: Array<[string, ModelParamField]> =
    caps.params && typeof caps.params === "object" ? Object.entries(caps.params) : [];
  for (const [name, field] of params) lines.push(formatParamLine(name, field));
  if (caps.prompt?.max) lines.push(`提示词上限：${caps.prompt.max} 字`);
  for (const [type, spec] of Object.entries(caps.refs || {})) {
    if (!spec?.on) continue;
    lines.push(
      `参考素材：${type} 最多 ${spec.max ?? "-"} 个${spec.max_mb ? `，单个不超过 ${spec.max_mb} MB` : ""}`,
    );
  }
  if (model.pricing) lines.push(`计价：${JSON.stringify(model.pricing)}`);
  emit(ctx, model, lines.join("\n"));
}

/** 当前积分：余额、冻结中、可用。 */
export async function credits(ctx: Ctx): Promise<void> {
  const token = requireToken(ctx);
  const data = await request<{ balance: number; frozen: number; available: number }>({
    base: baseOf(ctx),
    token,
    path: "/credits",
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, data, `积分：余额 ${data.balance}  冻结 ${data.frozen}  可用 ${data.available}`);
}

// ---------------------------------------------------------------------------
// 生成：提交 /generation-tasks
// ---------------------------------------------------------------------------

const GENERATE_KINDS = new Set<string>(["image", "video", "audio", "text"]);

/** 读 --input：JSON 字符串、@文件 或 -（标准输入）。只接受对象。 */
function readInputJSON(flags: Flags, usage: string): Record<string, unknown> {
  const raw = flags.input;
  if (raw === undefined) return {};
  if (raw === true || typeof raw !== "string")
    throw new APIError(-1, `--input 需要 JSON 字符串、@文件 或 -；用法：${usage}`, 2);
  let text: string;
  if (raw === "-") {
    try {
      text = fs.readFileSync(0, "utf8");
    } catch (err) {
      throw new APIError(-1, `读取标准输入失败：${errorMessage(err)}`, 2);
    }
  } else if (raw.startsWith("@")) {
    return readJSONFile(raw.slice(1));
  } else {
    text = raw;
  }
  let parsed: JSONValue;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new APIError(-1, `--input 不是合法 JSON：${errorMessage(err)}`, 2);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new APIError(-1, '--input 需要 JSON 对象，例如 \'{"prompt":"海边日出"}\'', 2);
  return parsed;
}

/** 把 --input / --prompt / --param / --ref-* 合成接口要的 input 对象。 */
function buildGenerateInput(flags: Flags, usage: string): Record<string, unknown> {
  const input: Record<string, unknown> = { ...readInputJSON(flags, usage) };
  if (flags.prompt !== undefined) input.prompt = stringFlag(flags, "prompt", usage);
  for (const pair of listFlag(flags, "param")) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new APIError(-1, `--param 要写成 名=值，收到「${pair}」`, 2);
    const name = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1);
    let value: unknown = raw;
    // 数字、布尔、数组按 JSON 解释，其余按字符串：CLI 上 `--param duration=5` 最自然
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    input[name] = value;
  }
  const refFlags: Array<[string, string]> = [
    ["ref-image", "images"],
    ["ref-video", "videos"],
    ["ref-audio", "audios"],
  ];
  for (const [key, name] of refFlags) {
    const ids = listFlag(flags, key);
    if (!ids.length) continue;
    input[name] = ids.map((id) => {
      if (!/^\d+$/.test(id))
        throw new APIError(-1, `--${key} 要素材 id（纯数字），收到「${id}」`, 2);
      return id;
    });
  }
  return input;
}

/** 提交后等任务到终态；超时抛退出码 3，与 task wait 一致。 */
async function waitTaskTerminal(
  ctx: Ctx,
  id: string,
  opts: { timeoutSeconds: number; intervalSeconds: number },
): Promise<Task> {
  const { timeoutSeconds, intervalSeconds } = opts;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const task = await fetchTask(ctx, id);
    if (task.status !== last) {
      const progress =
        task.progress === null || task.progress === undefined ? "" : ` ${task.progress}%`;
      ctx.stderr(`[${new Date().toISOString().slice(11, 19)}] ${id} ${task.status}${progress}`);
      last = task.status;
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) return task;
    await sleep(intervalSeconds * 1000);
  }
  throw new APIError(
    -1,
    `等待超时（${timeoutSeconds}s），任务 ${id} 仍未结束；可用 task get ${id} 继续查`,
    0,
    3,
  );
}

function formatSubmittedItems(items: GenerateItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.task) {
      lines.push(
        `+ 节点 ${item.node_id || "-"}：任务 ${item.task.task_ref || item.task.id}（${item.task.status}，冻结 ${item.task.credits} 积分）`,
      );
    } else if (item.error) {
      lines.push(`! 节点 ${item.node_id || "-"}：失败 ${item.error.status} ${item.error.message}`);
    }
  }
  return lines.length ? lines.join("\n") : "（没有提交任何任务）";
}

/**
 * 提交一次生成。产物回填由画布负责：任务已经绑在节点上，打开画布时按节点拉取生成记录并落到节点，
 * 与在网页上点生成是同一条链路——CLI 不自己改节点，也就不会和画布里的编辑抢版本。
 */
export async function generate(ctx: Ctx, args: Args): Promise<void> {
  const kind = args.positional[0];
  const usage =
    "generate <image|video|audio|text> --model <模型key> " +
    "[--canvas <画布编号> --node <节点id>] [--prompt <提示词>] [--param 名=值]... " +
    "[--input '<json>'|@文件|-] [--ref-image <素材id>]... [--count 1] [--wait] [--timeout 600] [--interval 3]";
  if (!kind || !GENERATE_KINDS.has(kind))
    throw new APIError(
      -1,
      `第一项要写生成种类（${[...GENERATE_KINDS].join(" / ")}）。用法：${usage}`,
      2,
    );
  const model = stringFlag(args.flags, "model", usage);
  const canvas = args.flags.canvas;
  const node = args.flags.node;
  const targets: Array<[string, FlagValue | undefined]> = [
    ["canvas", canvas],
    ["node", node],
  ];
  for (const [name, value] of targets) {
    if (value !== undefined && (value === true || typeof value !== "string"))
      throw new APIError(-1, `--${name} 需要字符串值。用法：${usage}`, 2);
  }
  // 绑节点才会在画布里留下这次生成；只给一个的话另一个就没意义了
  if ((canvas === undefined) !== (node === undefined))
    throw new APIError(-1, "--canvas 与 --node 要一起给（都省略就是一条不挂画布的临时任务）", 2);

  const input = buildGenerateInput(args.flags, usage);
  if (!Object.keys(input).length)
    throw new APIError(-1, "至少要给一个生成参数：--prompt、--param 或 --input", 2);

  const count = intFlag(args.flags, "count", 1, { max: 8 });
  if (count > 1 && node === undefined)
    throw new APIError(-1, "--count 大于 1 时必须给 --node：多个任务要绑在同一个节点上", 2);

  const body: Record<string, unknown> = { kind, model_id: model, input };
  if (canvas !== undefined) body.canvas_id = canvas;
  if (node !== undefined) {
    body.node_id = node;
    body.node_ids = Array.from({ length: count }, () => node);
  }

  const token = requireToken(ctx);
  const idempotencyKey =
    typeof args.flags["idempotency-key"] === "string"
      ? args.flags["idempotency-key"]
      : randomUUID();
  const res = await request<GenerateResponse>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: "/generation-tasks",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
    fetchImpl: ctx.fetchImpl,
  });
  const items = Array.isArray(res?.items) ? res.items : [];
  const tasks = items.map((item) => item.task).filter((task): task is Task => Boolean(task));
  const failures = items.filter((item) => item.error);
  if (!tasks.length) {
    const first = failures[0]?.error;
    throw new APIError(
      first?.code ?? -1,
      `提交失败：${first ? `${first.status} ${first.message}` : "服务端没有返回任务"}`,
      0,
    );
  }

  if (args.flags.wait === undefined) {
    emit(
      ctx,
      { items, tasks },
      [
        formatSubmittedItems(items),
        "",
        "任务已提交，产物会在打开画布时回填到节点；要在这里等，加 --wait。",
      ].join("\n"),
    );
    return;
  }

  const timeoutSeconds = intFlag(args.flags, "timeout", 600, { max: 86400 });
  const intervalSeconds = intFlag(args.flags, "interval", 3, { max: 3600 });
  const settled: Task[] = [];
  for (const task of tasks) {
    settled.push(await waitTaskTerminal(ctx, String(task.id), { timeoutSeconds, intervalSeconds }));
  }
  const failed = settled.filter((task) => task.status !== "succeeded");
  const human = [formatSubmittedItems(items), "", ...settled.map((task) => formatTask(task))].join(
    "\n",
  );
  if (!failed.length) {
    emit(ctx, { items, tasks: settled }, human);
    return;
  }
  const firstFailed = failed[0] as Task;
  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: false,
        error: {
          code: firstFailed.error_code ?? -1,
          message: firstFailed.error_message || `任务${firstFailed.status}`,
        },
        data: { items, tasks: settled },
      }),
    );
  } else {
    ctx.stdout(human);
  }
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 合成成片
// ---------------------------------------------------------------------------

const TERMINAL_COMPOSE_STATUSES = new Set<string>(["succeeded", "failed", "canceled"]);

/** 节点当前生效的素材 id：优先 activeOutputId 指向的那一版，老节点只有 assetId。 */
function activeAssetIdOf(data?: CanvasNodeData): string {
  const activeId = data?.activeOutputId;
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  if (activeId !== undefined && activeId !== null) {
    const hit = outputs.find((one) => String(one.id) === String(activeId));
    if (hit?.assetId) return String(hit.assetId);
  }
  return data?.assetId ? String(data.assetId) : "";
}

/**
 * 按成片节点的上游推导素材顺序，规则与画布一致：
 * 先认 data.composeOrder（用户手动调过的段序），其余按画布位置（先上下、再左右）。
 * 只收视频节点；还没出视频的段跳过，并在返回值里报出来。
 */
function deriveComposeAssets(
  graph: Graph,
  nodeId: string,
): { rows: ComposeRow[]; missing: number[] } {
  const nodes = graph.nodes || [];
  const composeNode = nodes.find((item) => item.id === nodeId);
  if (!composeNode) throw new APIError(-1, `画布里找不到节点 ${nodeId}`, 0);
  if (composeNode.data?.kind !== "compose")
    throw new APIError(
      -1,
      `节点 ${nodeId} 不是成片节点（data.kind=${composeNode.data?.kind || "-"}）`,
      2,
    );
  const order = Array.isArray(composeNode.data.composeOrder) ? composeNode.data.composeOrder : [];
  const rank = new Map(order.map((id, index) => [id, index]));
  const sources = (graph.edges || [])
    .filter((edge) => edge.target === nodeId)
    .map((edge) => nodes.find((item) => item.id === edge.source))
    .filter((item): item is CanvasNode => Boolean(item) && item?.data?.kind === "video");
  const positionOf = (item: CanvasNode): { x: number; y: number } => ({
    x: Number(item.position?.x ?? 0),
    y: Number(item.position?.y ?? 0),
  });
  const sorted = [...sources].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra === undefined && rb === undefined) {
      const pa = positionOf(a);
      const pb = positionOf(b);
      return pa.y - pb.y || pa.x - pb.x || String(a.id).localeCompare(String(b.id));
    }
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
  const rows: ComposeRow[] = [];
  const missing: number[] = [];
  sorted.forEach((item, seq) => {
    const assetId = activeAssetIdOf(item.data);
    if (!assetId) {
      missing.push(seq);
      rows.push({ seq, node: item.id, label: item.data?.label || "视频", assetId: "" });
      return;
    }
    rows.push({ seq, node: item.id, label: item.data?.label || "视频", assetId });
  });
  return { rows, missing };
}

function formatComposeRows(rows: ComposeRow[]): string {
  if (!rows.length) return "（成片节点上没有连进来的视频）";
  const lines = ["SEQ\tASSET\tNODE\tLABEL"];
  for (const row of rows) {
    lines.push(`${row.seq}\t${row.assetId || "（还没有视频）"}\t${row.node}\t${row.label}`);
  }
  return lines.join("\n");
}

function formatComposeJob(job: ComposeJob): string {
  const lines = [`合成任务：${job.id}`, `状态：${job.status}`];
  if (job.segment_count !== undefined) lines.push(`片段：${job.segment_count}`);
  if (job.duration_ms) lines.push(`时长：${(job.duration_ms / 1000).toFixed(1)} 秒`);
  if (job.result_asset_id) lines.push(`成片素材：${job.result_asset_id}`);
  if (job.result_asset_url) lines.push(`成片地址：${job.result_asset_url}`);
  if (job.error) lines.push(`错误：${job.error}`);
  return lines.join("\n");
}

/**
 * 合成成片：POST /canvas/:id/compose，asset_ids 的顺序就是成片顺序。
 * 不给 --assets 时按画布里的成片节点推导（composeOrder 优先），并把推导结果打出来，
 * 用户能对着看是不是想要的顺序——顺序错了成片就错了，不能猜完不吭声。
 */
export async function canvasCompose(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const usage =
    "canvas compose <画布编号> --node <成片节点id> [--assets 素材id,素材id...] [--seqs 1,2,3] " +
    "[--mode storyboard|compose|selection] [--wait] [--timeout 900] [--interval 5]";
  const node = args.flags.node;
  if (!code || node === undefined) throw new APIError(-1, `用法：${usage}`, 2);
  if (node === true || typeof node !== "string")
    throw new APIError(-1, `--node 需要成片节点 id。用法：${usage}`, 2);

  let rows: ComposeRow[] = [];
  let assetIds = listFlag(args.flags, "assets");
  let derived = false;
  if (!assetIds.length) {
    const canvas = await fetchCanvas(ctx, code);
    const graph: Graph = canvas.payload_json || {};
    const result = deriveComposeAssets(graph, node);
    rows = result.rows;
    assetIds = result.rows.map((row) => row.assetId).filter(Boolean);
    derived = true;
    if (!assetIds.length)
      throw new APIError(
        -1,
        `${formatComposeRows(rows)}\n成片节点 ${node} 的上游还没有可用的视频素材；` +
          "先在画布里生成视频，或用 --assets 显式给素材 id",
        0,
      );
  }

  const body: Record<string, unknown> = { node_id: node, asset_ids: assetIds };
  const seqs = listFlag(args.flags, "seqs").map((raw) => toInt(raw, "seqs", { min: 0 }));
  if (seqs.length) body.seqs = seqs;
  if (typeof args.flags.mode === "string") body.mode = args.flags.mode;

  const token = requireToken(ctx);
  const job = await request<ComposeJob>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: `/canvas/${encodeURIComponent(code)}/compose`,
    body,
    fetchImpl: ctx.fetchImpl,
  });
  const plan = derived ? formatComposeRows(rows) : `素材顺序：${assetIds.join(" → ")}`;

  if (args.flags.wait === undefined) {
    emit(
      ctx,
      { job, assets: assetIds, rows },
      [plan, "", formatComposeJob(job), "", "已提交，加 --wait 可以等它合成完。"].join("\n"),
    );
    return;
  }

  const timeoutSeconds = intFlag(args.flags, "timeout", 900, { max: 86400 });
  const intervalSeconds = intFlag(args.flags, "interval", 5, { max: 3600 });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "";
  let final = job;
  while (Date.now() < deadline) {
    final = await request<ComposeJob>({
      base: baseOf(ctx),
      token,
      path: `/canvas/${encodeURIComponent(code)}/compose/${encodeURIComponent(String(job.id))}`,
      fetchImpl: ctx.fetchImpl,
    });
    if (final.status !== last) {
      ctx.stderr(`[${new Date().toISOString().slice(11, 19)}] ${final.status}`);
      last = final.status;
    }
    if (TERMINAL_COMPOSE_STATUSES.has(final.status)) break;
    await sleep(intervalSeconds * 1000);
  }
  if (!TERMINAL_COMPOSE_STATUSES.has(final.status))
    throw new APIError(
      -1,
      `等待超时（${timeoutSeconds}s），合成任务 ${job.id} 仍未结束；可用 canvas compose-status 继续查`,
      0,
      3,
    );

  const human = [plan, "", formatComposeJob(final)].join("\n");
  if (final.status === "succeeded") {
    emit(ctx, { job: final, assets: assetIds, rows }, human);
    return;
  }
  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: false,
        error: { code: -1, message: final.error || `合成${final.status}` },
        data: { job: final, assets: assetIds, rows },
      }),
    );
  } else {
    ctx.stdout(human);
  }
  process.exitCode = 1;
}

/** 查合成任务：给 --job 就按任务 id 查，给 --node 就查该节点上最新的任务（含是否已过期）。 */
export async function canvasComposeStatus(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const usage =
    "canvas compose-status <画布编号> [--job <任务id> | --node <成片节点id> [--assets 素材id,...]]";
  if (!code) throw new APIError(-1, `用法：${usage}`, 2);
  const jobId = args.flags.job;
  const node = args.flags.node;
  if (jobId === undefined && node === undefined)
    throw new APIError(-1, `要给 --job 或 --node 其中之一。用法：${usage}`, 2);
  const token = requireToken(ctx);
  if (jobId !== undefined) {
    if (jobId === true || typeof jobId !== "string")
      throw new APIError(-1, `--job 需要任务 id。用法：${usage}`, 2);
    const job = await request<ComposeJob>({
      base: baseOf(ctx),
      token,
      path: `/canvas/${encodeURIComponent(code)}/compose/${encodeURIComponent(jobId)}`,
      fetchImpl: ctx.fetchImpl,
    });
    emit(ctx, job, formatComposeJob(job));
    return;
  }
  if (node === true || typeof node !== "string")
    throw new APIError(-1, `--node 需要成片节点 id。用法：${usage}`, 2);
  const assets = listFlag(args.flags, "assets");
  const res = await request<ComposeActive | null>({
    base: baseOf(ctx),
    token,
    path: `/canvas/${encodeURIComponent(code)}/compose/active`,
    query: { node_id: node, asset_ids: assets.join(",") },
    fetchImpl: ctx.fetchImpl,
  });
  if (!res) {
    emit(ctx, {}, "这个节点上没有进行中的合成任务");
    return;
  }
  const stale = res.stale === undefined ? "" : res.stale ? "（素材已变，成片过期）" : "";
  emit(ctx, res, `${formatComposeJob(res)}${stale}`);
}

/** 取消还没落终态的合成任务。 */
export async function canvasComposeCancel(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const usage = "canvas compose-cancel <画布编号> --job <任务id>";
  if (!code || args.flags.job === undefined) throw new APIError(-1, `用法：${usage}`, 2);
  const jobId = stringFlag(args.flags, "job", usage);
  const token = requireToken(ctx);
  const job = await request<ComposeJob>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: `/canvas/${encodeURIComponent(code)}/compose/${encodeURIComponent(jobId)}/cancel`,
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, job, formatComposeJob(job));
}

// ---------------------------------------------------------------------------
// 短剧：只读与任务控制
// ---------------------------------------------------------------------------

function formatDramaRows(list: DramaSummary[]): string {
  if (!list.length) return "（没有短剧）";
  const lines = ["CODE\tSTATUS\tPHASE\tEPISODES\tLOCKED\tUPDATED\tTITLE"];
  for (const item of list) {
    lines.push(
      `${item.id}\t${item.status}\t${item.phase || "-"}\t${item.episode_count ?? 0}\t${item.locked_count ?? 0}\t${String(
        item.updated_at || "",
      )
        .replace("T", " ")
        .slice(0, 19)}\t${item.title}`,
    );
  }
  return lines.join("\n");
}

/** 集号列表压成一行：96 集全铺开会把表格挤成两屏，超过 6 个就收成区间。 */
function formatEpisodes(list?: number[]): string {
  const episodes = (list || []).slice().sort((a, b) => a - b);
  if (!episodes.length) return "-";
  if (episodes.length <= 6) return episodes.join(",");
  const head = episodes.slice(0, 3).join(",");
  const tail = episodes.slice(-2).join(",");
  return `${head}…${tail}（${episodes.length} 集）`;
}

function formatJobRows(list: DramaJob[]): string {
  if (!list.length) return "（没有任务）";
  const lines = ["JOB\tSTEP\tSTATUS\tPROGRESS\tEPISODES\tLANE\tCREDITS"];
  for (const job of list) {
    lines.push(
      `${job.id}\t${job.step}\t${job.status}\t${job.progress ?? 0}%\t${formatEpisodes(job.episodes)}\t${job.lane || "-"}\t${job.credits ?? 0}`,
    );
  }
  return lines.join("\n");
}

function formatDramaDetail(view: DramaView, episodeLimit = 10): string {
  const lines = [
    `${view.title}（${view.id}）`,
    `状态：${view.status}  阶段：${view.phase || "-"}`,
    `原文：${view.source_chars ?? 0} 字  单元：${view.units_total ?? 0} 个（${view.unit_kind || "-"}）`,
  ];
  if ((view.target_episodes ?? 0) > 0)
    lines.push(
      `目标：${view.target_episodes} 集 × ${view.episode_seconds ?? 0} 秒  画幅：${view.ratio || "-"}`,
    );
  else lines.push(`画幅：${view.ratio || "-"}`);
  lines.push(`画布：${view.canvas_id || "-"}`);
  if (view.pause_reason) lines.push(`暂停原因：${view.pause_reason}（${view.pause_code || "-"}）`);
  const episodes = view.episodes || [];
  if (episodes.length) {
    // 真正跑过的短剧动辄上百集：默认只列前 10 集，把「还有多少」说清楚，
    // 而不是把 96 行刷满终端（实测一个 96 集项目会打出 175 行）。
    const shown = episodeLimit > 0 ? episodes.slice(0, episodeLimit) : episodes;
    lines.push(
      `分集（${episodes.length} 集${shown.length < episodes.length ? `，只列前 ${shown.length}` : ""}）：`,
    );
    for (const ep of shown) {
      lines.push(
        `  第 ${ep.no} 集  ${ep.title || ""}  单元 ${ep.unit_from ?? "-"}–${ep.unit_to ?? "-"}  剧本 ${ep.script_status || "-"}`,
      );
    }
    if (shown.length < episodes.length)
      lines.push(`  …… 还有 ${episodes.length - shown.length} 集；加 --episodes 0 看全部`);
  }
  return lines.join("\n");
}

const pageOf = <T>(res: T[] | Page<T> | null | undefined): Page<T> =>
  Array.isArray(res)
    ? { list: res, total: res.length, page: 1, page_size: res.length }
    : res || { list: [], total: 0 };

export async function dramaList(ctx: Ctx, args: Args): Promise<void> {
  const token = requireToken(ctx);
  const page = pageOf(
    await request<DramaSummary[] | Page<DramaSummary>>({
      base: baseOf(ctx),
      token,
      path: "/dramas",
      query: {
        keyword: typeof args.flags.keyword === "string" ? args.flags.keyword : undefined,
        page: intFlag(args.flags, "page", undefined),
        page_size: intFlag(args.flags, "page-size", undefined, { max: 200 }),
      },
      fetchImpl: ctx.fetchImpl,
    }),
  );
  const list = page.list || [];
  emit(
    ctx,
    { list, total: page.total, page: page.page, page_size: page.page_size },
    `${formatDramaRows(list)}\n共 ${page.total} 部，第 ${page.page} 页`,
  );
}

export async function dramaGet(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const usage = "drama get <短剧编号> [--episodes 10（0 表示全部）]";
  if (!code) throw new APIError(-1, `用法：${usage}`, 2);
  const episodeLimit = intFlag(args.flags, "episodes", 10, { min: 0, max: 1000 });
  const token = requireToken(ctx);
  const view = await request<DramaView>({
    base: baseOf(ctx),
    token,
    path: `/dramas/${encodeURIComponent(code)}`,
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, view, formatDramaDetail(view, episodeLimit));
}

export async function dramaUnits(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：drama units <短剧编号> [--from 1] [--to 20]", 2);
  const token = requireToken(ctx);
  const from = intFlag(args.flags, "from", undefined, { min: 1 });
  const to = intFlag(args.flags, "to", undefined, { min: 1 });
  const res = await request<DramaUnit[] | { items?: DramaUnit[] }>({
    base: baseOf(ctx),
    token,
    path: `/dramas/${encodeURIComponent(code)}/units`,
    query: { from, to },
    fetchImpl: ctx.fetchImpl,
  });
  // 服务端把列表包在 {items: [...]} 里（不是裸数组）：按裸数组处理会得到「(没有单元)」
  const items = Array.isArray(res) ? res : (res?.items ?? []);
  const lines = items.map(
    (unit) => `${unit.no}\t${unit.title || ""}\t${unit.chars ?? (unit.text || "").length} 字`,
  );
  emit(ctx, items, items.length ? ["NO\tTITLE\tCHARS", ...lines].join("\n") : "（没有单元）");
}

export async function dramaUnit(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const no = args.positional[1];
  if (!code || !no) throw new APIError(-1, "用法：drama unit <短剧编号> <单元号>", 2);
  const token = requireToken(ctx);
  const unit = await request<DramaUnit>({
    base: baseOf(ctx),
    token,
    path: `/dramas/${encodeURIComponent(code)}/units/${encodeURIComponent(no)}`,
    fetchImpl: ctx.fetchImpl,
  });
  emit(
    ctx,
    unit,
    [
      `第 ${unit.no} 单元  ${unit.title || ""}${unit.chars ? `（${unit.chars} 字）` : ""}`,
      "",
      unit.text || "（正文为空）",
    ].join("\n"),
  );
}

export async function dramaJobs(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  if (!code) throw new APIError(-1, "用法：drama jobs <短剧编号> [--active]", 2);
  const token = requireToken(ctx);
  const res = await request<{ items?: DramaJob[] } | null>({
    base: baseOf(ctx),
    token,
    path: `/dramas/${encodeURIComponent(code)}/jobs`,
    query: args.flags.active === undefined ? undefined : { status: "active" },
    fetchImpl: ctx.fetchImpl,
  });
  const items = (res && res.items) || [];
  emit(ctx, { items }, formatJobRows(items));
}

export async function dramaJobCancel(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const usage = "drama job-cancel <短剧编号> --job <任务id>";
  if (!code || args.flags.job === undefined) throw new APIError(-1, `用法：${usage}`, 2);
  const jobId = stringFlag(args.flags, "job", usage);
  const token = requireToken(ctx);
  const job = await request<DramaJob>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: `/dramas/${encodeURIComponent(code)}/jobs/${encodeURIComponent(jobId)}/cancel`,
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, job, formatJobRows([job]));
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
export function trace(ctx: Ctx, args: Args): void {
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
function resolveTraceScript(ctx: Ctx, args: Args): string {
  const explicit = args.flags.script ?? ctx.env.VC_AGENT_TRACE;
  if (explicit !== undefined) {
    if (explicit === true || typeof explicit !== "string")
      throw new APIError(-1, "--script 需要 agent-trace.mjs 的路径", 2);
    const target = path.resolve(explicit);
    if (!fs.existsSync(target)) throw new APIError(-1, `找不到 agent-trace：${target}`, 2);
    return target;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 源码在 cli/src、产物在 cli/dist，两种位置的上一级都是 cli/
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

function flagsToArgv(flags: Flags): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    // --json / --base / --script 是本 CLI 的选项，agent-trace 不认，不能透传
    if (key === "help" || key === "json" || key === "base" || key === "script") continue;
    if (value === true) out.push(`--${key}`);
    else out.push(`--${key}`, String(value));
  }
  return out;
}

/** 命令表：bin 用它做分发与 help。 */
// ── 小镜（画布里的 Agent）────────────────────────────────────────────
// 复杂操作交给它：挑模型、把上游关键帧接成参考图、按画布语义改节点，都由它决定；
// 需要人拍板的动作它停下来等审批，命令行只负责把条目摊开、把人的决定送回去。

interface AgentSessionView {
  id: string;
  canvas_id: string;
  title: string;
  mode: string;
  last_seq: number;
}

interface AgentRunView {
  id: string;
  session_id: string;
  status: string;
}

interface AgentEventView {
  session_id: string;
  run_id: string | null;
  seq: number;
  type: string;
  data: unknown;
  created_at: string;
}

const AGENT_USAGE =
  'agent run <画布编号> --message "<要它做什么>" [--selection id,id] [--budget 积分] ' +
  "[--session 会话编号] [--watch] [--interval 2] [--timeout 600]\n" +
  "      agent events <会话编号> [--after 序号]\n" +
  "      agent approve <审批编号> [--items 0,1] [--reject] [--answer 文本]\n" +
  "      agent cancel <运行编号>";

/** 取这个画布的对话；没有就新建一条。同一画布复用同一条线，网页里能看到同样的上下文。 */
async function ensureAgentSession(ctx: Ctx, code: string): Promise<AgentSessionView> {
  const token = requireToken(ctx);
  const base = baseOf(ctx);
  const path = `/canvas/${encodeURIComponent(code)}/agent/sessions`;
  const list = await request<AgentSessionView[]>({
    base,
    token,
    method: "GET",
    path,
    fetchImpl: ctx.fetchImpl,
  });
  if (Array.isArray(list) && list.length > 0) return list[list.length - 1]!;
  return request<AgentSessionView>({
    base,
    token,
    method: "POST",
    path,
    body: { title: "命令行" },
    fetchImpl: ctx.fetchImpl,
  });
}

/** 一条事件的人类可读形态：回复原文输出，审批把 payload 原样摊开，工具调用给一行摘要。 */
function formatAgentEvent(e: AgentEventView): string {
  const data = (e.data ?? {}) as Record<string, unknown>;
  if (e.type.startsWith("approval.")) {
    const id = typeof data.id === "string" ? data.id : "";
    const payload = data.payload ?? {};
    return [
      `⚠ ${e.type}${id ? `（审批编号 ${id}）` : ""}`,
      JSON.stringify(payload, null, 2),
      id ? `  批准：vc agent approve ${id} --items 0,1,2` : "",
      id ? `  驳回：vc agent approve ${id} --reject` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  // 助手的回答就是这轮要的东西，原样输出，不截断。
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (e.type === "message.done") return text ? `\n${text}\n` : "";
  // 状态与用量是给机器看的，人类模式不刷屏。
  if (e.type === "run.status" || e.type === "run.usage" || e.type === "message.user") return "";
  const name = typeof data.name === "string" ? data.name : "";
  const summary = typeof data.summary === "string" ? data.summary : "";
  const label = typeof data.label === "string" ? data.label : "";
  const tail = (summary || label || name).slice(0, 120);
  return tail ? `  · ${e.type}  ${tail}` : `  · ${e.type}`;
}

/** 这条事件是否表示「可以收尾了」：有正文的回复、需要人拍板、或运行已经结束。 */
function agentSettled(e: AgentEventView): boolean {
  if (e.type.startsWith("approval.") || e.type === "run.finished" || e.type === "run.failed") return true;
  if (e.type !== "message.done") return false;
  const data = (e.data ?? {}) as Record<string, unknown>;
  return typeof data.text === "string" && data.text.trim() !== "";
}

/** 拉一页事件；返回下一页的游标与这一页。 */
async function pullAgentEvents(
  ctx: Ctx,
  sid: string,
  after: number,
): Promise<{ events: AgentEventView[]; next: number }> {
  const token = requireToken(ctx);
  const events = await request<AgentEventView[]>({
    base: baseOf(ctx),
    token,
    method: "GET",
    path: `/agent/sessions/${encodeURIComponent(sid)}/events?after=${after}&limit=100`,
    fetchImpl: ctx.fetchImpl,
  });
  const list = Array.isArray(events) ? events : [];
  const next = list.length > 0 ? list[list.length - 1]!.seq : after;
  return { events: list, next };
}

/**
 * 把一件事交给小镜做。默认只提交并打印运行编号；加 --watch 才跟到它有回复或需要审批。
 *
 * 为什么默认不跟：Agent 跑一轮可能几分钟、也可能停在审批等一整夜，脚本不该被它挂住。
 */
export async function agentRun(ctx: Ctx, args: Args): Promise<void> {
  const code = args.positional[0];
  const message = args.flags.message;
  if (!code || typeof message !== "string" || !message.trim()) {
    throw new APIError(-1, `用法：vc ${AGENT_USAGE}`, 2);
  }

  const session = await ensureAgentSession(ctx, code);
  let sid = session.id;
  // 从会话当前的位置往后看：历史事件已经发生过，不能在 --watch 里重放一遍。
  let cursor = typeof session.last_seq === "number" ? session.last_seq : 0;
  if (typeof args.flags.session === "string" && args.flags.session && args.flags.session !== sid) {
    sid = args.flags.session;
    const siblings = await request<AgentSessionView[]>({
      base: baseOf(ctx),
      token: requireToken(ctx),
      method: "GET",
      path: `/canvas/${encodeURIComponent(code)}/agent/sessions`,
      fetchImpl: ctx.fetchImpl,
    });
    const hit = Array.isArray(siblings) ? siblings.find((item) => item.id === sid) : undefined;
    cursor = typeof hit?.last_seq === "number" ? hit.last_seq : 0;
  }

  const body: Record<string, unknown> = { message };
  const selection = listFlag(args.flags, "selection");
  if (selection.length) body.selection = selection;
  if (args.flags.budget !== undefined) {
    body.budget_credits = toInt(args.flags.budget, "budget", { min: 0 });
  }

  const token = requireToken(ctx);
  const run = await request<AgentRunView>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: `/agent/sessions/${encodeURIComponent(sid)}/runs`,
    body,
    fetchImpl: ctx.fetchImpl,
  });

  if (args.flags.watch === undefined) {
    emit(
      ctx,
      { session_id: sid, run },
      [
        `已交给小镜：运行 ${run.id}（会话 ${sid}）`,
        "加 --watch 可以跟到它跑完；停下来要你确认时，用 vc agent approve 决策。",
      ].join("\n"),
    );
    return;
  }

  const interval = args.flags.interval === undefined ? 2 : toInt(args.flags.interval, "interval", { min: 1 });
  const timeout = args.flags.timeout === undefined ? 600 : toInt(args.flags.timeout, "timeout", { min: 1 });
  const deadline = Date.now() + timeout * 1000;
  const printed: AgentEventView[] = [];
  let waiting = false;

  while (true) {
    const { events, next } = await pullAgentEvents(ctx, sid, cursor);
    cursor = next;
    for (const e of events) {
      printed.push(e);
      const line = formatAgentEvent(e);
      if (line) ctx.stderr(line);
      if (e.type.startsWith("approval.")) waiting = true;
    }
    // 它已经回了话就别继续干等：收尾动作（用量、状态归位）不影响人看结果。
    if (waiting || events.some(agentSettled)) break;
    if (Date.now() >= deadline) {
      emit(
        ctx,
        { session_id: sid, run, events: printed, waiting: false },
        `等到 ${timeout} 秒还没结束，运行 ${run.id} 仍在服务端继续。\n继续看：vc agent events ${sid} --after ${cursor}`,
      );
      process.exitCode = 3;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }

  const tail = waiting
    ? "它停下来等你确认：按上面列出的编号批准，或 --reject 驳回。"
    : "小镜已回复。它若还在后台收尾，用 vc agent events 接着看。";
  emit(ctx, { session_id: sid, run, events: printed, waiting }, tail);
}

/** 看一条会话里已经发生的事；--after 从某个序号之后接着看。 */
export async function agentEvents(ctx: Ctx, args: Args): Promise<void> {
  const sid = args.positional[0];
  if (!sid) throw new APIError(-1, `用法：vc ${AGENT_USAGE}`, 2);
  const after = args.flags.after === undefined ? 0 : toInt(args.flags.after, "after", { min: 0 });
  const { events, next } = await pullAgentEvents(ctx, sid, after);
  emit(
    ctx,
    { session_id: sid, events, next },
    events.length ? events.map(formatAgentEvent).join("\n") : "这段时间没有新事件。",
  );
}

/**
 * 对一次审批下决定。默认整体通过；--items 只批准指定序号，--reject 整体驳回。
 * 命令行不猜条目的含义：编号来自 agent 事件里列出的那一批动作，人看到什么就批什么。
 */
export async function agentApprove(ctx: Ctx, args: Args): Promise<void> {
  const aid = args.positional[0];
  if (!aid) throw new APIError(-1, `用法：vc ${AGENT_USAGE}`, 2);
  const reject = args.flags.reject !== undefined;
  const items = listFlag(args.flags, "items").map((raw) => toInt(raw, "items", { min: 0 }));
  const body: Record<string, unknown> = { decision: reject ? "reject" : "approve" };
  if (!reject && items.length) {
    body.items = items.map((index) => ({ index, approve: true }));
  }
  if (typeof args.flags.answer === "string") body.answer = args.flags.answer;

  const token = requireToken(ctx);
  const view = await request<Record<string, unknown>>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: `/agent/approvals/${encodeURIComponent(aid)}/decision`,
    body,
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, view, `已提交决定：${reject ? "驳回" : "批准"}${items.length ? `（条目 ${items.join(",")}）` : ""}。`);
}

/** 停掉一轮运行：Agent 不再继续，已经提交的生成任务照常完成。 */
export async function agentCancel(ctx: Ctx, args: Args): Promise<void> {
  const rid = args.positional[0];
  if (!rid) throw new APIError(-1, `用法：vc ${AGENT_USAGE}`, 2);
  const token = requireToken(ctx);
  const view = await request<Record<string, unknown>>({
    base: baseOf(ctx),
    token,
    method: "POST",
    path: `/agent/runs/${encodeURIComponent(rid)}/cancel`,
    fetchImpl: ctx.fetchImpl,
  });
  emit(ctx, view, `已取消运行 ${rid}。`);
}

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
  canvasNodeAdd,
  canvasNodeRm,
  canvasNodeSet,
  canvasSave,
  canvasCompose,
  canvasComposeStatus,
  canvasComposeCancel,
  modelList,
  modelShow,
  credits,
  generate,
  dramaList,
  dramaGet,
  dramaUnits,
  dramaUnit,
  dramaJobs,
  dramaJobCancel,
  taskGet,
  taskWait,
  trace,
  agentRun,
  agentEvents,
  agentApprove,
  agentCancel,
};
