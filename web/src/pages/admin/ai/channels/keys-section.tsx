import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { addChannelKey, deleteChannelKey, listChannelKeys, updateChannelKey } from "@/api/admin/ai";
import type { ChannelKeyView } from "@/api/admin/ai/type.d";
import { confirm } from "@/components/admin-ui/confirm-dialog";
import { FormField } from "@/components/admin-ui/form-field";
import { Notice } from "@/components/admin-ui/notice";
import { Tag } from "@/components/admin-ui/tag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SUPER_ONLY } from "./channel-list";

/**
 * 渠道详情里的「API Key」区块：同一渠道可以配多把 Key。
 *
 * 为什么需要多把：上游按 Key 限并发时，一个渠道只有一把 Key 就卡在单 Key 的额度上；
 * 配 N 把之后请求按槽位轮转，rps / 并发上限 / 同时生成数都按「每把 Key」算，有效并发能到 N 倍。
 * 某一把握到 429、401 或余额不足时先冷却一段时间，后续请求自动换下一把。
 *
 * 安全：明文只写不读。列表只回显末四位与备注，输入框提交后立刻清空。
 * 只有 super_admin 能读这个列表（后端接口同样是 super_admin）。
 * @param channelKey 渠道 key
 * @param canWrite 是否 super_admin
 * @param onChanged Key 增删或启停后回调父级刷新渠道清单（secret_set / key_count 变了）
 */
export function ChannelKeysSection({
  channelKey,
  canWrite,
  onChanged,
}: {
  channelKey: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [keys, setKeys] = useState<ChannelKeyView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [remark, setRemark] = useState("");
  const [adding, setAdding] = useState(false);
  /** 正在启停 / 删除的槽位：避免同一行重复点 */
  const [busySlot, setBusySlot] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!canWrite) return;
    setFailed(false);
    void listChannelKeys(channelKey)
      .then((list) => setKeys(list))
      .catch(() => setFailed(true));
  }, [channelKey, canWrite]);

  // 渠道切换由父级传的 key 触发重挂载，这里只负责按当前渠道拉一次
  useEffect(() => {
    load();
  }, [load]);

  if (!canWrite) {
    return (
      <section data-slot="channel-keys" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">API Key</h3>
        <p className="text-muted-foreground text-xs">{SUPER_ONLY}</p>
      </section>
    );
  }

  const add = async () => {
    const value = apiKey.trim();
    if (!value || adding) return;
    // 取走明文并立刻清空输入：请求期间与之后 state 里都不再持有 Key
    setApiKey("");
    const note = remark.trim();
    setRemark("");
    setAdding(true);
    try {
      const created = await addChannelKey(channelKey, value, note);
      setKeys((prev) => [...(prev ?? []), created].sort((a, b) => a.slot - b.slot));
      toast.success(`已添加第 ${created.slot} 把 Key`);
      onChanged();
    } catch {
      // 全局 toast 已弹；把用户输入还回去，免得白粘一次
      setApiKey(value);
      setRemark(note);
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (item: ChannelKeyView, enabled: boolean) => {
    setBusySlot(item.slot);
    try {
      const updated = await updateChannelKey(channelKey, item.slot, { enabled });
      setKeys((prev) => prev?.map((k) => (k.slot === updated.slot ? updated : k)) ?? null);
      toast.success(enabled ? `第 ${item.slot} 把已启用` : `第 ${item.slot} 把已停用`);
      onChanged();
    } catch {
      // toast 已弹，列表保持原样
    } finally {
      setBusySlot(null);
    }
  };

  const remove = (item: ChannelKeyView) => {
    void confirm({
      title: `删除第 ${item.slot} 把 Key？`,
      destructive: true,
      confirmLabel: "删除",
      description: item.remark
        ? `「${item.remark}」（末四位 ${item.hint || "未知"}）删除后不再参与轮转，进行中的任务不受影响。`
        : `末四位 ${item.hint || "未知"}，删除后不再参与轮转，进行中的任务不受影响。`,
      onConfirm: async () => {
        setBusySlot(item.slot);
        try {
          await deleteChannelKey(channelKey, item.slot);
          setKeys((prev) => prev?.filter((k) => k.slot !== item.slot) ?? null);
          toast.success(`已删除第 ${item.slot} 把 Key`);
          onChanged();
        } finally {
          setBusySlot(null);
        }
      },
    });
  };

  const enabledCount = keys?.filter((k) => k.enabled).length ?? 0;

  return (
    <section data-slot="channel-keys" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">API Key</h3>
        {keys && keys.length > 0 && (
          <Tag tone="neutral">
            共 {keys.length} 把·启用 {enabledCount} 把
          </Tag>
        )}
        <span className="text-muted-foreground text-xs">
          多把 Key 按槽位轮转；并发上限按「每把
          Key」算，启用的把数越多，这个渠道能跑的同时请求越多（最多 10 把）
        </span>
      </div>

      {failed && (
        <Notice tone="danger">
          读取 Key 列表失败，请刷新页面重试。已配置的 Key 仍在正常使用。
        </Notice>
      )}

      {keys === null && !failed && (
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" />
          正在读取…
        </div>
      )}

      {keys && keys.length === 0 && (
        <p className="text-muted-foreground text-xs">
          还没有 Key。在下面添加第一把后，这个渠道的模型才能被调用。
        </p>
      )}

      {keys && keys.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {keys.map((item) => {
            const busy = busySlot === item.slot;
            return (
              <li
                key={item.slot}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2"
              >
                <span className="text-muted-foreground font-mono text-xs">#{item.slot}</span>
                <span className="font-mono text-sm">
                  ••••{item.hint || <span className="text-muted-foreground">????</span>}
                </span>
                {item.remark && (
                  <span className="text-muted-foreground max-w-40 truncate text-xs">
                    {item.remark}
                  </span>
                )}
                <Tag tone={item.enabled ? "success" : "neutral"}>
                  {item.enabled ? "启用" : "停用"}
                </Tag>
                <div className="ml-auto flex items-center gap-1.5">
                  <Switch
                    aria-label={item.enabled ? "停用这把 Key" : "启用这把 Key"}
                    checked={item.enabled}
                    disabled={busy}
                    onCheckedChange={(checked) => void toggle(item, checked)}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`删除第 ${item.slot} 把 Key`}
                    disabled={busy}
                    onClick={() => remove(item)}
                  >
                    {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="新增 Key" htmlFor="new-channel-key">
          <Input
            id="new-channel-key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder="粘贴 API Key"
            value={apiKey}
            disabled={adding}
            onChange={(event) => setApiKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
          />
        </FormField>
        <FormField label="备注（可选）" htmlFor="new-channel-key-remark">
          <Input
            id="new-channel-key-remark"
            autoComplete="off"
            spellCheck={false}
            placeholder="如：账号 A / 测试专用"
            maxLength={64}
            value={remark}
            disabled={adding}
            onChange={(event) => setRemark(event.target.value)}
          />
        </FormField>
      </div>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={adding || !apiKey.trim()}
          onClick={() => void add()}
        >
          {adding ? <Loader2 className="animate-spin" /> : <Plus />}
          添加 Key
        </Button>
      </div>
    </section>
  );
}
