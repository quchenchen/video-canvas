import { useCallback, useEffect, useRef, useState } from "react";

import { listVirtualAvatars, type VirtualAvatar } from "@/api/filing";

// 后端对批量刷新做了 3 秒节流，这里跟它对齐。
const POLL_MS = 3000;

/**
 * 虚拟人像库：列出全部归集条目；有 pending（已提交备案）时自动轮询，全部终态后停止。
 * 轮询那一轮带 refreshPending，让后端去方舟问一次真实状态——只重读数据库的话 pending 永远不会变。
 * 提供本地打补丁（提交/刷新后立刻更新一条），避免等下一轮轮询。
 */
export function useVirtualAvatars() {
  const [items, setItems] = useState<VirtualAvatar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (opts?: { refreshPending?: boolean }) => {
    try {
      const rows = await listVirtualAvatars(opts);
      setItems(rows);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasPending = items.some((v) => v.filingStatus === "pending");
  useEffect(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    if (!hasPending) return;
    timer.current = setInterval(() => void refresh({ refreshPending: true }), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [hasPending, refresh]);

  const update = useCallback((next: VirtualAvatar) => {
    setItems((prev) => prev.map((v) => (v.id === next.id ? next : v)));
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((v) => v.id !== id));
  }, []);

  return { items, loading, error, refresh, update, remove };
}
