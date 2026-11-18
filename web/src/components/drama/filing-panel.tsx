import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  collectVirtualAvatar,
  listVirtualAvatars,
  submitFiling,
  type FilingStatus,
  type VirtualAvatar,
} from "@/api/filing";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { filingMeta } from "./filing-status";

/** 各状态在这里的补充说明（图标、颜色、主文案由 filing-status 统一规范） */
const HINT: Record<FilingStatus, string> = {
  none: "加入虚拟人像库后方可提交方舟备案",
  pending: "已提交，等待方舟处理",
  processing: "方舟正在处理素材",
  active: "生成时将使用 asset:// 备案形象",
  failed: "可重新提交",
};

/**
 * 角色卡详情里的虚拟人像库备案区：展示该角色图的备案状态，提供「加入并备案 / 重新备案」。
 * 归集来源固定为 drama_character；提交时用开启了虚拟人像库的视频模型（后端自动挑）。
 */
export function FilingPanel({
  assetId,
  src,
  name,
}: {
  assetId?: string;
  src?: string | null;
  name?: string;
}) {
  const [row, setRow] = useState<VirtualAvatar | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!assetId) return;
    let alive = true;
    void listVirtualAvatars()
      .then((all) => {
        if (!alive) return;
        setRow(all.find((v) => v.assetId === assetId || v.sourceRef === assetId) ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [assetId]);

  if (!assetId) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-xs">
        生成形象后可加入虚拟人像库
      </div>
    );
  }

  const status: FilingStatus = row?.filingStatus ?? "none";
  const meta = filingMeta(status);
  const pending = status === "pending" || status === "processing" || busy;
  const Icon = meta.Icon;

  const submit = async () => {
    setBusy(true);
    try {
      // 未归集先归集（角色卡来源），再提交备案
      const collected =
        row ??
        (await collectVirtualAvatar({
          source_type: "drama_character",
          source_ref: assetId,
          asset_id: assetId,
          url: src ?? "",
          name: name || assetId,
        }));
      setRow(collected);
      const next = await submitFiling(collected.id, collected.filingModelKey);
      setRow(next);
      toast.success("已加入虚拟人像库并提交备案");
    } catch {
      // 请求层已弹提示
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Icon className={cn("size-3.5", meta.tone, (meta.spin || pending) && "animate-spin")} />
          <span className={meta.tone}>{meta.label}</span>
        </div>
        {(status === "none" || status === "failed") && (
          <Button variant="outline" size="xs" disabled={busy} onClick={() => void submit()}>
            {busy ? "提交中…" : status === "failed" ? "重新备案" : "加入并备案"}
          </Button>
        )}
      </div>
      <div className="text-muted-foreground mt-1 text-[11px] leading-4">
        {status === "failed" && row?.error ? row.error : HINT[status]}
      </div>
      {row?.arkAssetId && (
        <div className="text-muted-foreground mt-0.5 truncate font-mono text-[10px]">
          {row.arkAssetId}
        </div>
      )}
    </div>
  );
}
