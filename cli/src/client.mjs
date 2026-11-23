/** 业务错误：code 是后端信封里的 code，status 是 HTTP 状态码。 */
export class APIError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "APIError";
    this.code = code;
    this.status = status;
  }
}

/**
 * 规范化 API 根地址：允许用户只给站点根（https://host），自动补 /api/v1；末尾斜杠一律去掉。
 * 这样 `--base https://host` 和 `--base https://host/api/v1` 行为一致。
 */
export function normalizeBase(raw) {
  const trimmed = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) throw new APIError(-1, "缺少 API 地址，请用 --base 或环境变量 VC_API_BASE 指定", 0);
  if (!/^https?:\/\//i.test(trimmed))
    throw new APIError(-1, `API 地址必须以 http:// 或 https:// 开头：${trimmed}`, 0);
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

/** 站点根（授权页地址用它拼），与 normalizeBase 互逆。 */
export function siteRootOf(base) {
  return base.replace(/\/api\/v1$/i, "");
}

function buildURL(base, path, query) {
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "")
      url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * 调一次后端接口并拆统一信封。
 *
 * 成功返回 data；HTTP 非 2xx 或 code !== 0 抛 APIError。401 单独带提示，
 * 因为 CLI 最常见的失败就是令牌过期，调用方要能一句说清「重新登录」。
 */
export async function request({
  base,
  token,
  method = "GET",
  path,
  body,
  query,
  fetchImpl = fetch,
}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetchImpl(buildURL(base, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new APIError(-1, `无法连接 ${base}：${err.message}`, 0);
  }

  const text = await res.text();
  let envelope;
  try {
    envelope = text ? JSON.parse(text) : {};
  } catch {
    throw new APIError(-1, `服务端返回的不是 JSON（HTTP ${res.status}）`, res.status);
  }
  if (res.status === 401) {
    throw new APIError(
      envelope.code ?? 20003,
      "登录已过期或被撤销，请重新执行 video-canvas-cli login",
      401,
    );
  }
  if (!res.ok || (envelope.code !== undefined && envelope.code !== 0)) {
    throw new APIError(
      envelope.code ?? -1,
      envelope.msg || `请求失败（HTTP ${res.status}）`,
      res.status,
    );
  }
  return envelope.data;
}
