import { useState } from "react";

import { createFiling, retryFiling, type FilingDto } from "@/api/filing";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { filingMeta, FILING_RETRY_ICON } from "./filing-status";

/** 人物卡上的真人备案入口：未备案灰 / 进行中黄转圈 / 已备案绿 / 失败红可重试。 */
export function FilingButton({
  filing,
  onUpdate,
}: {
  filing?: FilingDto;
  onUpdate: (f: FilingDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const status = filing?.status ?? "none";
  const pending = status === "pending" || status === "processing" || busy;
  const meta = filingMeta(status);

  const submit = async () => {
    if (!filing?.assetId || busy || pending) return;
    setBusy(true);
    try {
      const next = await createFiling(filing.assetId, filing.sourceUrl);
      onUpdate(next);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!filing?.assetId || busy) return;
    setBusy(true);
    try {
      onUpdate(await retryFiling(filing.assetId));
    } finally {
      setBusy(false);
    }
  };

  const title =
    status === "active"
      ? `已备案 · ${filing?.filingId ?? ""}`
      : status === "failed"
        ? `备案失败：${filing?.error ?? "点击重试"}`
        : status === "none"
          ? "提交真人形象备案"
          : meta.label;

  if (status === "failed") {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={title}
        title={title}
        disabled={busy}
        onClick={retry}
      >
        <FILING_RETRY_ICON className={cn(meta.tone, busy && "animate-spin")} />
      </Button>
    );
  }

  const Icon = meta.Icon;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={title}
      title={title}
      disabled={pending || !filing?.assetId}
      onClick={submit}
    >
      <Icon className={cn(meta.tone, (meta.spin || pending) && "animate-spin")} />
    </Button>
  );
}
