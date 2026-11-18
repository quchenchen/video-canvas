import { useCallback, useEffect, useRef, useState } from "react";

import { listFilings, type FilingDto, type FilingStatus } from "@/api/filing";

// 后端对批量刷新做了 3 秒节流，这里跟它对齐，免得白打请求。
const POLL_MS = 3000;
const SETTLED: FilingStatus[] = ["none", "active", "failed"];

/** 有未终态备案时自动轮询，全部终态后停止。key 用 assetId。
 *  轮询那一轮带 refreshPending：后端去方舟问一次真实状态，只重读数据库的话 pending 永远不会变。 */
export function useFilings(assetIds: string[]) {
  const [filings, setFilings] = useState<Record<string, FilingDto>>({});
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const key = assetIds.join(",");

  const refresh = useCallback(
    async (opts?: { refreshPending?: boolean }) => {
      const ids = key ? key.split(",") : [];
      if (ids.length === 0) {
        setFilings({});
        return;
      }
      setLoading(true);
      try {
        const items = await listFilings(ids, opts);
        setFilings(Object.fromEntries(items.map((f) => [f.assetId, f])));
      } finally {
        setLoading(false);
      }
    },
    [key],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasPending = Object.values(filings).some((f) => !SETTLED.includes(f.status));
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

  const update = useCallback((f: FilingDto) => {
    setFilings((prev) => ({ ...prev, [f.assetId]: f }));
  }, []);

  return { filings, loading, refresh, update };
}
