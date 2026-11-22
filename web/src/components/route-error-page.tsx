import { useEffect, useState } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router";

import { Button } from "@/components/ui/button";
import { isChunkLoadError, reloadForStaleChunk } from "@/lib/stale-chunk";

/**
 * 路由级错误兜底。
 *
 * React Router 在没有自定义 errorElement 时只抛一句
 * "Unexpected Application Error!"，把真正的原因（例如发版后旧 chunk 失效）
 * 压掉了 —— 用户以为是功能坏了，排查时也要靠翻 devtools 才能看到原文。
 * 这里区分两类错误分别处理：
 *
 * - 陈旧 chunk：自动整页刷新一次，界面显示「正在更新」；
 * - 其他错误：把错误原文和路由路径露出来，便于直接定位。
 */
export function RouteErrorPage() {
  const error = useRouteError();
  const chunkFailed = isChunkLoadError(error);
  const [reloading, setReloading] = useState(false);
  const [reloadBlocked, setReloadBlocked] = useState(false);

  useEffect(() => {
    if (!chunkFailed) return;
    setReloading(true);
    // 冷却窗口内不再刷新，说明资源确实缺失，此时必须让用户看到原文
    if (!reloadForStaleChunk()) {
      setReloading(false);
      setReloadBlocked(true);
    }
  }, [chunkFailed]);

  const detail = describeError(error);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-xl space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">
            {reloading ? "正在更新到最新版本" : chunkFailed ? "页面版本已过期" : "页面出错了"}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {reloading
              ? "正在为你重新加载…"
              : chunkFailed
                ? "站点刚发布新版本，旧页面资源已失效"
                : "这个页面没能正常打开"}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {reloading
              ? "通常一两秒即可完成，无需操作。"
              : chunkFailed
                ? "重新加载后即可拿到新版页面；如果反复出现，说明部署可能不完整，请联系管理员。"
                : "可以直接重试；如果持续失败，请把下面的详情反馈给管理员。"}
          </p>
        </div>

        {!reloading && (
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => window.location.reload()}>重新加载</Button>
            <Button variant="outline" onClick={() => window.location.assign("/")}>
              返回首页
            </Button>
          </div>
        )}

        {!reloading && detail && (
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">错误详情</p>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground/80">
              {detail}
            </pre>
            {reloadBlocked && (
              <p className="mt-2 text-xs text-muted-foreground">
                已自动重试过一次仍未恢复，因此不再刷新，避免陷入循环。
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function describeError(error: unknown): string {
  if (!error) return "";

  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}\n${typeof error.data === "string" ? error.data : JSON.stringify(error.data, null, 2)}`;
  }

  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? `\n\ncaused by: ${cause.message}` : "";
    return `${error.name}: ${error.message}${causeText}`;
  }

  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}
