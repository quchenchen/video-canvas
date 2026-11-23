/**
 * CLI 的 `--base` 该填什么：与应用实际请求一致的那条 API 根地址。
 *
 * 不能直接用 `window.location.origin`：开发与生产都可能把 API 挂在别的域名，
 * 或者放在 `/xxx/api/v1` 这样的前缀下，页面地址和接口地址不是一回事。
 * 唯一可信的来源是应用自己用的 `VITE_API_BASE_URL`（`utils/requests/request.ts` 的 baseURL）。
 *
 * 它可能是相对路径（`/api/v1`），而 CLI 在终端里跑、拿不到相对路径，所以要按当前页面的
 * origin 绝对化成 `https://host/api/v1`。CLI 的 normalizeBase 两种写法都接受，
 * 并且会自己补 `/api/v1`，这里保持原样即可。
 */
export function cliApiBase(
  apiBase?: string,
  origin: string = typeof window === "undefined" ? "" : window.location.origin,
): string {
  const raw = (apiBase ?? "").trim();
  const path = raw === "" ? "/api/v1" : raw;

  if (/^https?:\/\//i.test(path)) return stripTrailingSlash(path);

  // 相对路径一律按站点根解析：`api/v1` 与 `/api/v1` 等价
  const absolute = new URL(path.startsWith("/") ? path : `/${path}`, origin || "http://localhost");
  return stripTrailingSlash(absolute.toString());
}

/** 站点根：CLI 里授权页的地址用它拼（`siteRootOf` 的同一语义）。 */
export function cliSiteRoot(apiBase?: string, origin?: string): string {
  return cliApiBase(apiBase, origin).replace(/\/api\/v1$/i, "");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
