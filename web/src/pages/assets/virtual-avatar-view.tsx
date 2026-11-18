import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  removeVirtualAvatar,
  submitFiling,
  refreshFiling,
  type VirtualAvatar,
  type VirtualAvatarSource,
} from "@/api/filing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { filingMeta } from "@/components/drama/filing-status";
import { EmptyMark } from "@/components/home/empty-mark";
import { useVirtualAvatars } from "@/hooks/use-virtual-avatars";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<VirtualAvatarSource, string> = {
  drama_character: "拆解角色",
  library_asset: "资产库",
};

/** 资产页「虚拟人像库」：两类来源归集的角色图，统一做方舟备案。 */
export function VirtualAvatarView() {
  const { items, loading, error, refresh, update, remove } = useVirtualAvatars();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => Number(b.filingStatus === "pending") - Number(a.filingStatus === "pending"),
      ),
    [items],
  );

  const submit = async (v: VirtualAvatar) => {
    setBusy(v.id);
    try {
      update(await submitFiling(v.id, v.filingModelKey));
      toast.success("备案已提交");
    } catch {
      // 请求层已弹提示
    } finally {
      setBusy(null);
    }
  };

  const doRefresh = async (v: VirtualAvatar) => {
    setBusy(v.id);
    try {
      update(await refreshFiling(v.id));
    } catch {
      // 请求层已弹提示
    } finally {
      setBusy(null);
    }
  };

  const doRemove = async () => {
    if (!confirmId) return;
    const id = confirmId;
    setConfirmId(null);
    setBusy(id);
    try {
      await removeVirtualAvatar(id);
      remove(id);
      toast.success("已从虚拟人像库移除");
    } catch {
      // 请求层已弹提示
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-6">
      <div className="text-muted-foreground mb-4 text-[13px]">
        归集短剧拆解角色与个人资产库中的人物图，统一提交方舟备案；生成视频时以 asset:// 传给
        Seedance。
      </div>

      {loading ? (
        <div className="text-muted-foreground py-16 text-center text-sm">加载中…</div>
      ) : error ? (
        <EmptyMark
          title="加载失败"
          hint={
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              重试
            </Button>
          }
        />
      ) : sorted.length === 0 ? (
        <EmptyMark title="还没有归集的人像" hint="在角色卡编辑或个人资产库里点「加入虚拟人像库」" />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] md:gap-4">
          {sorted.map((v) => {
            const meta = filingMeta(v.filingStatus);
            const Icon = meta.Icon;
            const isBusy = busy === v.id;
            return (
              <div key={v.id} className="bg-card border-border overflow-hidden rounded-xl border">
                <div className="bg-muted aspect-square w-full overflow-hidden">
                  {v.url ? (
                    <img
                      src={v.url}
                      alt={v.name || "虚拟人像"}
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="text-muted-foreground grid h-full place-items-center text-xs">
                      无预览
                    </div>
                  )}
                </div>
                <div className="space-y-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium" title={v.name}>
                      {v.name || "未命名"}
                    </span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {SOURCE_LABEL[v.sourceType]}
                    </Badge>
                  </div>
                  <div className={cn("flex items-center gap-1 text-xs", meta.tone)}>
                    <Icon className={cn("size-3.5", meta.spin && "animate-spin")} />
                    {meta.label}
                    {v.arkAssetId && (
                      <span
                        className="text-muted-foreground ml-1 truncate font-mono text-[10px]"
                        title={v.arkAssetId}
                      >
                        {v.arkAssetId}
                      </span>
                    )}
                  </div>
                  {v.error && (
                    <p className="text-destructive line-clamp-2 text-[11px]">{v.error}</p>
                  )}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {(v.filingStatus === "none" || v.filingStatus === "failed") && (
                      <Button size="xs" disabled={isBusy} onClick={() => void submit(v)}>
                        {v.filingStatus === "failed" ? "重新备案" : "提交备案"}
                      </Button>
                    )}
                    {v.filingStatus === "pending" && (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => void doRefresh(v)}
                      >
                        刷新状态
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={isBusy}
                      onClick={() => setConfirmId(v.id)}
                    >
                      <Trash2 className="size-3.5" />
                      移除
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={confirmId !== null} onOpenChange={(open) => !open && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从虚拟人像库移除？</AlertDialogTitle>
            <AlertDialogDescription>
              只会移除归集记录（已备案的会同时删除方舟资产），不会影响原角色卡或资产库图片。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doRemove()}>移除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
