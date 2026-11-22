/**
 * 发版后旧页面的「幽灵 chunk」自愈。
 *
 * 场景：构建产物文件名带内容 hash，每次发布 chunk 名全换。浏览器若仍持有旧的
 * index.html（历史版本没发 no-cache，启发式缓存可撑几小时），它引用的
 * /assets/queue-<旧hash>.js 在新版本里已经不存在，动态 import 必然失败，
 * 表现为 React Router 的 "Unexpected Application Error!" 或
 * "Failed to fetch dynamically imported module"。
 *
 * 这类错误重试没有意义（旧文件名不会回来），唯一有效动作是整页刷新：
 * 拉一份新 index.html，顺着新的 hash 重新加载。刷新必须限次，否则一旦
 * 真的缺文件就会无限刷新。
 */

const RELOAD_STAMP_KEY = "stale-chunk-reload-at";

/** 同一次刷新风暴内的去重窗口：窗口内只允许触发一次整页刷新 */
const RELOAD_COOLDOWN_MS = 15_000;

/** Chromium / Safari / Firefox 对动态 import 失败给出的文案并不统一 */
const CHUNK_ERROR_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "error loading dynamically imported module",
  "Unable to preload CSS",
];

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;

  const texts: string[] = [];
  if (typeof error === "string") {
    texts.push(error);
  } else if (error instanceof Error) {
    texts.push(error.message);
    // Vite 会把原始原因挂在 cause 上
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) texts.push(cause.message);
  }

  return texts.some((text) => CHUNK_ERROR_PATTERNS.some((pattern) => text.includes(pattern)));
}

/**
 * 触发一次整页刷新来换掉失效的 chunk。
 *
 * @returns true 表示已经发起了刷新（调用方应展示「正在更新」而不是报错）。
 */
export function reloadForStaleChunk(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) {
      // 刚刷过又失败：说明不是缓存陈旧，而是真的缺资源。停止刷新，
      // 让错误界面把原文透出来，否则用户只会看到无限转圈。
      return false;
    }
    window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch {
    // 隐私模式下 sessionStorage 可能抛异常：宁可刷新一次，也不要把用户卡死
  }

  window.location.reload();
  return true;
}

/**
 * 兜住 router 之外的动态 import：React.lazy 组件（导演编辑器、二维码）不在
 * 路由错误边界内，失败会变成未处理的 rejection，同样需要整页刷新。
 */
export function installStaleChunkGuard(): void {
  if (typeof window === "undefined") return;
  if ((window as { __staleChunkGuard?: boolean }).__staleChunkGuard) return;
  (window as { __staleChunkGuard?: boolean }).__staleChunkGuard = true;

  window.addEventListener("unhandledrejection", (event) => {
    if (isChunkLoadError(event.reason)) {
      if (reloadForStaleChunk()) event.preventDefault();
    }
  });

  window.addEventListener("error", (event) => {
    if (isChunkLoadError((event as ErrorEvent).message)) {
      reloadForStaleChunk();
    }
  });
}
