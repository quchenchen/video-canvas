import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { listAllOfficialVoices, type OfficialVoicePageDto } from "@/api/official-voice";
import type { AssetDto } from "@/api/asset/type";
import { AssetCover } from "@/components/assets/asset-card";
import { AssetPreview, type AssetPreviewEntry } from "@/components/assets/asset-preview";
import { AssetSearch } from "@/components/assets/asset-search";
import { AssetsToolbar } from "@/components/assets/assets-toolbar";
import { VoiceFilterChips } from "@/components/assets/voice-filter-chips";
import { EmptyMark } from "@/components/home/empty-mark";
import { TAP_CARD } from "@/lib/motion";
import {
  filterOfficialVoices,
  VOICE_GROUP_OPTIONS,
  VOICE_LANG_OPTIONS,
  VOICE_SCOPE_LABEL,
  voiceGroupLabel,
  voiceDisplayName,
  type VoiceGroupFilter,
  type VoiceLangFilter,
} from "@/utils/assets/official-voices";

/** 音色缩略图是 144px 头像，用紧凑网格一行多列，名字常显在下方。 */
const VOICE_GRID =
  "grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-[repeat(auto-fill,minmax(104px,1fr))]";

function OfficialVoiceCard({ asset, onPreview }: { asset: AssetDto; onPreview: () => void }) {
  const name = voiceDisplayName(asset);
  // 角标是子类别（男孩/女生…）；分类还没回填的老数据退回显示来源，至少能分辨方舟与 BytePlus
  const badge = voiceGroupLabel(asset) || VOICE_SCOPE_LABEL[asset.scope ?? ""] || "";
  return (
    <motion.button
      type="button"
      data-slot="official-voice-card"
      aria-label={name}
      whileTap={TAP_CARD}
      onClick={onPreview}
      className="bg-card hover:bg-accent flex min-w-0 flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors"
    >
      <span className="bg-muted relative block aspect-square w-full overflow-hidden rounded-md">
        <AssetCover asset={asset} />
        {badge && (
          <span className="bg-cover-scrim text-cover-foreground pointer-events-none absolute top-1 right-1 rounded-full px-1.5 text-[9px] leading-4">
            {badge}
          </span>
        )}
      </span>
      <span className="block truncate px-0.5 text-center text-[11px] leading-tight">{name}</span>
    </motion.button>
  );
}

/**
 * 资产页「音色库」：seedance 官方参考音色，系统公共素材，所有人可见。
 * 卡片显示缩略图，点开用 <audio> 试听；在画布视频节点里可作为参考音频选中。
 * Seedance 生成时传官方 asset:// 地址，其他模型传转存后的文件地址（由后端按插件分流）。
 * 分类两个层级：大类别是语言（中文 = 方舟国内，English = BytePlus），子类别是人群（男孩/女孩/男生/女生）。
 * 搜索和个人资产库同款：素材一次取全量，筛选与搜索都在本地做，点选即时生效。
 */
export function OfficialView() {
  const [page, setPage] = useState<OfficialVoicePageDto | null>(null);
  const [input, setInput] = useState("");
  const [lang, setLang] = useState<VoiceLangFilter>("all");
  const [group, setGroup] = useState<VoiceGroupFilter>("all");
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listAllOfficialVoices()
      .then((items) => {
        if (alive) setPage({ items, total: items.length });
      })
      .catch(() => {
        if (alive) toast.error("音色库加载失败，请稍后重试");
      });
    return () => {
      alive = false;
    };
  }, []);

  const query = input.trim();
  const filtering = query !== "" || lang !== "all" || group !== "all";
  const items = useMemo(
    () => filterOfficialVoices(page?.items ?? [], { query, lang, group }),
    [page, query, lang, group],
  );

  const entries = useMemo<AssetPreviewEntry[]>(
    () =>
      items.map((asset) => ({
        id: asset.id,
        asset,
        label: voiceDisplayName(asset),
      })),
    [items],
  );

  const count =
    page === null ? "加载中…" : filtering ? `找到 ${items.length} 条` : `共 ${page.total} 条`;

  return (
    <div className="pt-2">
      <AssetsToolbar className="mt-4 mb-4">
        <span className="text-muted-foreground shrink-0 pl-2.5 text-xs">语言</span>
        <VoiceFilterChips
          label="语言"
          options={VOICE_LANG_OPTIONS}
          value={lang}
          onChange={setLang}
        />
        <span aria-hidden className="bg-chrome-border mx-1.5 h-4 w-px shrink-0" />
        <span className="text-muted-foreground shrink-0 text-xs">人群</span>
        <VoiceFilterChips
          label="人群"
          options={VOICE_GROUP_OPTIONS}
          value={group}
          onChange={setGroup}
        />
        <div className="ml-auto pl-1">
          <AssetSearch value={input} onChange={setInput} placeholder="搜索音色名称" />
        </div>
      </AssetsToolbar>

      <div className="text-muted-foreground mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[13px]">
        <p>点卡片试听；在画布和片场里可以把它当参考音频。</p>
        <span aria-live="polite" className="shrink-0 tabular-nums">
          {count}
        </span>
      </div>

      {items.length === 0 && page !== null ? (
        filtering ? (
          <EmptyMark
            title={query ? `没有找到“${query}”` : "这个分类下还没有音色"}
            hint="换个关键词，或换成「全部」再看看"
          />
        ) : (
          <EmptyMark title="暂无音色" hint="音色由管理员导入，稍后再来看" />
        )
      ) : (
        <div data-slot="official-voice-grid" className={VOICE_GRID}>
          {items.map((asset) => (
            <OfficialVoiceCard
              key={asset.id}
              asset={asset}
              onPreview={() => setPreviewId(asset.id)}
            />
          ))}
        </div>
      )}

      <AssetPreview
        entries={entries}
        targetId={previewId}
        onTargetChange={setPreviewId}
        onClose={() => setPreviewId(null)}
      />
    </div>
  );
}
