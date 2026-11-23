import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/utils/admin/clipboard";

/**
 * 「复制令牌」按钮：明文不在页面状态里，点了才向服务端要一次。
 *
 * 和后台的 CopyButton 一样先试异步剪贴板、失败退回旧办法；两者都不行时 toast 提示，
 * 因为这时用户手上什么也没有，不是「按钮文案没变」就能糊过去的情况。
 *
 * @param load 取回明文（失败抛错）
 */
export function CopySecretButton({ load }: { load: () => Promise<string> }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    setBusy(true);
    try {
      const text = await load();
      if (!text || !(await copyToClipboard(text))) {
        toast.error("复制失败，请点「重新签发」换一枚");
        return;
      }
      setCopied(true);
      toast.success("令牌已复制");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("取不回明文，请点「重新签发」换一枚");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={busy}
      aria-label="复制令牌"
      title="复制令牌"
      onClick={() => void copy()}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "已复制" : "复制"}
    </Button>
  );
}
