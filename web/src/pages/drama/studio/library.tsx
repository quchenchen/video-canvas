import { useState } from "react";
import { motion } from "motion/react";
import { AudioLines, Box, GripVertical, Image as ImageIcon, User } from "lucide-react";

import { MediaPreview } from "@/components/canvas/media-preview";
import { StatusPill } from "@/components/drama/status-pill";
import { SPRING } from "@/lib/motion";
import { useStaggeredCount } from "@/hooks/use-staggered-mount";
import { cn } from "@/lib/utils";
import {
  groupByType,
  splitByEpisode,
  type DramaAssetType,
  type RefAsset,
} from "@/utils/drama/segment-assets";

import { useStudio } from "./use-studio";

/** 资产库进入时先画几项、之后每帧追加几项 */
const ASSETS_FIRST = 14;
const ASSETS_BATCH = 10;

/** 各分组合计只取前 n 项（分组顺序不变，画满了的后面分组整个不画）；分组标题上的数量仍写全量 */
function takeFirst<T extends { items: unknown[] }>(
  groups: T[],
  n: number,
): (T & { total: number })[] {
  let left = n;
  const out: (T & { total: number })[] = [];
  for (const group of groups) {
    if (left <= 0) break;
    out.push({ ...group, items: group.items.slice(0, left), total: group.items.length });
    left -= group.items.length;
  }
  return out;
}

/** 拖拽时放在 dataTransfer 里的类型：提示词编辑器据此认出这是一个资产 */
export const ASSET_DRAG_TYPE = "application/x-drama-asset";

const TYPE_ICON: Record<DramaAssetType, typeof User> = {
  character: User,
  scene: ImageIcon,
  prop: Box,
  audio: AudioLines,
};

/** 有没有能当参考图的形象：角色卡节点看主图，其余看节点素材；正在生成的不算（assetId 还指着上一版） */
export function assetHasImage(asset: RefAsset): boolean {
  return !!asset.src && !asset.generating;
}

/** 角色卡上绑了音色：列表里标出来，否则有没有音色在资产库看起来一模一样 */
export function hasVoice(asset: RefAsset): boolean {
  return asset.kind === "character" && asset.character?.voice?.mode === "audio";
}

function Item({ asset, fade }: { asset: RefAsset; fade: boolean }) {
  const Icon = TYPE_ICON[asset.type];
  const noImage = !assetHasImage(asset);
  return (
    <div
      draggable
      title="拖到提示词里"
      onDragStart={(event) => {
        event.dataTransfer.setData(
          ASSET_DRAG_TYPE,
          JSON.stringify({ id: asset.id, label: asset.label }),
        );
        // 拖到别处（如搜索框）时落成资产名；提示词编辑器优先认上面那个类型
        event.dataTransfer.setData("text/plain", asset.label);
        event.dataTransfer.effectAllowed = "copy";
      }}
      className={cn(
        "hover:bg-chrome-hover mx-1 flex w-[calc(100%-0.5rem)] cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs active:cursor-grabbing",
        fade && "animate-in fade-in duration-200 motion-reduce:animate-none",
      )}
    >
      <span className="bg-muted text-muted-foreground grid size-[30px] shrink-0 place-items-center overflow-hidden rounded-[7px]">
        {asset.src && asset.type !== "audio" ? (
          <MediaPreview src={asset.src} mode="thumb" fit="cover" draggable={false} />
        ) : (
          <Icon className="size-3.5" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{asset.label}</span>
      {hasVoice(asset) && (
        <StatusPill tone="muted" className="h-4 max-w-24 truncate text-[10px]">
          {asset.character?.voice?.name?.trim() || "音色"}
        </StatusPill>
      )}
      {noImage && (
        <StatusPill tone="warning" className="h-4 text-[10px]">
          {asset.type === "audio" ? "无音频" : "无图"}
        </StatusPill>
      )}
      <GripVertical className="text-muted-foreground size-3.5 shrink-0" />
    </div>
  );
}

/** 本集 / 全集切换：滑块用 layoutId 在两项之间滑动 */
function Scope({ all, onChange }: { all: boolean; onChange: (all: boolean) => void }) {
  return (
    <div role="group" aria-label="资产范围" className="bg-muted relative flex rounded-lg p-0.5">
      {(
        [
          [false, "本集"],
          [true, "全集"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={label}
          type="button"
          aria-pressed={all === value}
          onClick={() => onChange(value)}
          className={cn(
            "focus-visible:ring-ring/50 relative h-6 rounded-md px-2.5 text-xs font-medium outline-none focus-visible:ring-2",
            all === value ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {all === value && (
            <motion.span
              layoutId="studio-lib-scope"
              transition={SPRING}
              className="bg-background absolute inset-0 rounded-md shadow-sm"
            />
          )}
          <span className="relative">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** 左资产库：本集 / 全集，按角色 / 场景 / 道具分组，无图资产标出；可拖进提示词 */
export function Library() {
  const { assets, assetsStatus, no } = useStudio();
  const [all, setAll] = useState(false);
  const shown = all ? assets : splitByEpisode(assets, no).here;
  const allGroups = groupByType(shown);
  // 进入片场时先画前一批资产（跨分组合计），其余每帧追加一批；每个资产一张缩略图，一次画上百个会卡
  const drawn = useStaggeredCount(shown.length, { first: ASSETS_FIRST, batch: ASSETS_BATCH });
  const groups = takeFirst(allGroups, drawn);
  // 第一批随外壳整块淡入（Phased），只有之后追加的项才各自淡入，不然进入时会叠着闪两下
  const [first] = useState(() => new Set(groups.flatMap((g) => g.items.map((a) => a.id))));
  return (
    <aside aria-label="资产库" className="flex h-full w-full flex-col">
      <div className="flex items-center px-3 pt-3 pb-2">
        <b className="text-sm">资产库</b>
        <span className="flex-1" />
        <Scope all={all} onChange={setAll} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 [scrollbar-gutter:stable]">
        {groups.map((group) => {
          const Icon = TYPE_ICON[group.type];
          return (
            <div key={group.type}>
              <div className="text-muted-foreground flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] [&_svg]:size-3.5">
                <Icon />
                {group.label}
                <span className="tabular-nums">{group.total}</span>
              </div>
              {group.items.map((asset) => (
                <Item key={asset.id} asset={asset} fade={!first.has(asset.id)} />
              ))}
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className="text-muted-foreground px-3 py-8 text-center text-xs">
            {assetsStatus === "loading"
              ? "加载中…"
              : assetsStatus === "error"
                ? "资产读取失败，切到别的标签再回来会重试"
                : all
                  ? "还没有资产，先在资产页做拆解"
                  : "这一集还没有资产，可以切到「全集」看看"}
          </p>
        )}
      </div>
    </aside>
  );
}
