import { motion } from "motion/react";
import {
  AudioLines,
  Check,
  CircleX,
  FolderOpen,
  Gem,
  Image as ImageIcon,
  Loader2,
  Mountain,
  PencilLine,
  Plus,
  Type,
  Upload,
  UserRound,
  Video,
  type LucideIcon,
} from "lucide-react";

import type { FilingDto } from "@/api/filing";
import { MediaPreview } from "@/components/canvas/media-preview";
import { FilingButton } from "@/components/drama/filing-button";
import { DramaPoster } from "@/components/drama/poster";
import { Button } from "@/components/ui/button";
import { DURATION, STAGGER, STAGGER_MAX, TAP_CARD } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { canFillNode } from "@/utils/canvas/fill-upload";
import { assetUploaded, type AssetItem, type AssetType } from "@/utils/drama/assets";

export const TYPE_ICON: Record<AssetType, LucideIcon> = {
  character: UserRound,
  scene: Mountain,
  prop: Gem,
  text: Type,
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
};

/** 完成态的封面：取节点素材（角色卡节点的主图也是它的 src）；没有可显示的就用渐变占位 */
function DoneCover({ item }: { item: AssetItem }) {
  const { data } = item;
  if (data.kind === "script") {
    return (
      <div className="text-muted-foreground bg-muted absolute inset-0 overflow-hidden p-3 text-xs leading-5 break-words">
        {data.text?.slice(0, 160)}
      </div>
    );
  }
  if (data.src && data.mediaType !== "video" && data.kind !== "video" && data.kind !== "audio") {
    return (
      <div className="absolute inset-0">
        {/* 三视图按原比例完整显示，空出的部分露出卡片底色。 */}
        <MediaPreview src={data.src} alt={item.name} mode="thumb" draggable={false} />
      </div>
    );
  }
  if (data.src && (data.kind === "video" || data.mediaType === "video")) {
    return (
      <video
        src={data.src}
        muted
        preload="metadata"
        className="absolute inset-0 size-full object-cover"
      />
    );
  }
  return <DramaPoster seed={item.name + item.look} className="absolute inset-0" />;
}

/** 空状态里的一块说明（待生成 / 生成中 / 失败） */
function EmptyFrame({
  tone = "idle",
  children,
}: {
  tone?: "idle" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 grid place-items-center rounded-[inherit] border border-dashed p-2 text-center text-xs",
        tone === "error"
          ? "border-destructive/40 text-destructive"
          : "text-muted-foreground border-border",
      )}
    >
      <div className="flex flex-col items-center gap-1.5">{children}</div>
    </div>
  );
}

/** 分段胶囊里的一段：透明底，悬停提亮（同 ChromeSegment） */
const SEGMENT_CLASS =
  "hover:bg-chrome-hover text-foreground focus-visible:ring-ring/60 inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full text-xs transition-colors duration-150 outline-none focus-visible:ring-2 [&_svg]:size-3.5 [&_svg]:shrink-0";

/**
 * 空卡的上传入口：贴在封面底部的半透明分段胶囊（coding-standards 6.1），左上传、右素材库。
 * 平时收起，悬停卡片或键盘聚焦时从下方浮出；没有悬停的触屏设备一直显示。压在整卡的「进画布」按钮之上。
 */
function FillActions({
  onUpload,
  onPickLibrary,
}: {
  onUpload?: () => void;
  onPickLibrary?: () => void;
}) {
  return (
    <div className="absolute inset-x-2.5 bottom-2.5 z-20">
      {/* 淡入淡出加在带模糊的这一层上：祖先半透明会让 backdrop-blur 失效，淡出一开始模糊就突然没了，看着像卡顿。
          退出 150ms，约为进入 200ms 的 70% */}
      <div className="bg-chrome ring-chrome-border flex translate-y-1.5 items-center gap-0.5 rounded-full p-1 opacity-0 shadow-lg ring-1 backdrop-blur-xl backdrop-saturate-150 transition-[opacity,translate] duration-150 ease-out will-change-[opacity,translate] group-hover/card:translate-y-0 group-hover/card:opacity-100 group-hover/card:duration-200 focus-within:translate-y-0 focus-within:opacity-100 focus-within:duration-200 motion-reduce:transition-none [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100">
        <button type="button" className={SEGMENT_CLASS} onClick={onUpload}>
          <Upload />
          上传
        </button>
        <span aria-hidden className="bg-chrome-border h-4 w-px shrink-0" />
        <button type="button" className={SEGMENT_CLASS} onClick={onPickLibrary}>
          <FolderOpen />
          素材库
        </button>
      </div>
    </div>
  );
}

/**
 * 资产卡（原型资产列表）：封面按状态显示——已完成（素材）、生成中、分析设定中、失败、待生成（角色显示「待生成形象」）。
 * 点整张卡进画布定位到对应节点；名字旁的按钮弹框编辑提示词（角色卡还能打开详情改音色）；
 * 多选 / 框选后批量生成，已生成的也能选上重新生成；多选模式下点卡片是勾选。
 * 根节点带 data-asset-id，列表框选按它量卡片位置。
 * 出现集数：全集一个小标，具体集号一串小点，未分类写「未分类」。
 * 空卡（没素材、没生成过）直接给「上传」「素材库」；生成过的不能上传。上传来的卡左上角标「上传」，没有提示词可编辑。
 */
export function AssetCard({
  item,
  index,
  multi,
  selected,
  onToggle,
  onLocate,
  onEditPrompt,
  onEditCharacter,
  filing,
  onFilingUpdate,
  onUpload,
  onPickLibrary,
}: {
  item: AssetItem;
  index: number;
  multi: boolean;
  selected: boolean;
  onToggle: () => void;
  onLocate: () => void;
  /** 弹框编辑提示词、模型和参数（角色 / 场景 / 道具） */
  onEditPrompt: () => void;
  /** 打开角色卡详情（角色名、形象、补充图、音色） */
  onEditCharacter: () => void;
  /** 真人备案记录（仅角色卡有） */
  filing?: FilingDto;
  onFilingUpdate?: (f: FilingDto) => void;
  /** 选本地文件放进这张空卡 */
  onUpload?: () => void;
  /** 从素材库选一个放进这张空卡 */
  onPickLibrary?: () => void;
}) {
  const Icon = TYPE_ICON[item.type];
  const uploaded = assetUploaded(item.data);
  const generated =
    !uploaded && (item.type === "character" || item.type === "scene" || item.type === "prop");
  const fillable = !multi && item.type !== "text" && canFillNode(item.data);
  const fill = fillable ? <FillActions onUpload={onUpload} onPickLibrary={onPickLibrary} /> : null;
  // 已生成的也能勾选：再生成一次就是重新生成
  const canGenerate =
    generated && (item.status === "idle" || item.status === "error" || item.status === "done");
  const hasVoice = item.type === "character" && !!item.data.character?.voice;

  return (
    <motion.div
      data-slot="asset-card"
      data-asset-id={item.id}
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, delay: Math.min(index, STAGGER_MAX) * STAGGER }}
      className="group/card min-w-0"
    >
      <motion.div
        whileTap={multi && canGenerate ? TAP_CARD : undefined}
        className={cn(
          "bg-muted relative aspect-3/4 overflow-hidden rounded-xl",
          selected && "ring-primary ring-2",
        )}
      >
        {item.status === "done" ? (
          <>
            <DoneCover item={item} />
            {uploaded && (
              <span className="bg-chrome ring-chrome-border text-foreground absolute top-2 left-2 rounded-full px-2 text-[11px] leading-5 ring-1 backdrop-blur-xl">
                上传
              </span>
            )}
            <div className="from-cover-scrim absolute inset-x-0 bottom-0 bg-linear-to-t to-transparent px-2.5 pt-8 pb-2">
              <div className="text-cover-foreground truncate text-xs font-semibold">
                {item.name}
              </div>
            </div>
          </>
        ) : item.status === "uploading" ? (
          <EmptyFrame>
            <Loader2 className="size-5 animate-spin" />
            <span className="tabular-nums">上传中 {item.data.uploadProgress ?? 0}%</span>
          </EmptyFrame>
        ) : item.status === "running" ? (
          <EmptyFrame>
            <Loader2 className="size-5 animate-spin" />
            生成中
          </EmptyFrame>
        ) : item.status === "analyzing" ? (
          <EmptyFrame>
            <Loader2 className="size-5 animate-spin" />
            正在分析设定
          </EmptyFrame>
        ) : item.status === "error" ? (
          <EmptyFrame tone="error">
            <CircleX className="size-5" />
            {item.data.uploaded ? "上传失败" : "生成失败"}
            <span className="text-muted-foreground text-[11px]">
              {!item.data.uploaded && item.data.error ? item.data.error.slice(0, 24) : "可以重试"}
            </span>
          </EmptyFrame>
        ) : (
          <EmptyFrame>
            <Icon className="size-5" />
            {item.type === "character" ? "待生成形象" : "待生成"}
          </EmptyFrame>
        )}

        {fill}

        {multi && canGenerate && (
          <button
            type="button"
            aria-label={selected ? "取消选择" : "选择"}
            aria-pressed={selected}
            onClick={onToggle}
            className={cn(
              "focus-visible:ring-ring/60 absolute inset-0 z-10 flex items-start justify-start p-2 outline-none focus-visible:ring-3 focus-visible:ring-inset",
            )}
          >
            <span
              className={cn(
                "bg-background/90 grid size-5 place-items-center rounded-md border",
                selected && "bg-primary text-primary-foreground border-transparent",
              )}
            >
              {selected && <Check className="size-3.5" />}
            </span>
          </button>
        )}

        {!multi && (
          <button
            type="button"
            aria-label={`在画布中打开 ${item.name}`}
            title="在画布中打开"
            onClick={onLocate}
            className="focus-visible:ring-ring/60 absolute inset-0 z-10 cursor-pointer rounded-[inherit] outline-none transition-colors duration-150 hover:bg-white/5 focus-visible:ring-3 focus-visible:ring-inset"
          />
        )}
      </motion.div>

      <div className="px-0.5 pt-1.5">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {item.name}
            {item.look && <span className="text-muted-foreground font-normal"> · {item.look}</span>}
          </div>
          {generated && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`编辑 ${item.name} 的提示词`}
              title="提示词与生成设置"
              onClick={onEditPrompt}
            >
              <PencilLine />
            </Button>
          )}
          {item.type === "character" && item.data.assetId && filing && onFilingUpdate && (
            <FilingButton filing={filing} onUpdate={onFilingUpdate} />
          )}
          {item.type === "character" && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`编辑 ${item.name} 的角色详情与音色`}
              title="角色详情与音色"
              onClick={onEditCharacter}
            >
              <AudioLines />
            </Button>
          )}
        </div>
        <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          {hasVoice && <AudioLines className="size-3" aria-label="已设定音色" />}
          {item.episodes === null ? (
            <span className="text-status-warning">未分类</span>
          ) : item.episodes.length === 0 ? (
            <span className="bg-muted rounded-full px-1.5 leading-4">全集</span>
          ) : (
            <span className="flex flex-wrap gap-0.5">
              {item.episodes.map((no) => (
                <i
                  key={no}
                  className="bg-muted min-w-4 rounded px-1 text-center leading-4 tabular-nums not-italic"
                >
                  {no}
                </i>
              ))}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** 新建卡上半「新建」按钮的文字：角色是引入角色卡，其余是新建某类 */
const CREATE_LABEL: Record<AssetType, string> = {
  character: "引入角色卡",
  scene: "新建场景",
  prop: "新建道具",
  text: "新建文本",
  image: "新建图片",
  video: "新建视频",
  audio: "新建音频",
};

/**
 * 资产网格末尾的新建卡：新建一张当前类型的空卡。
 * @param scope 新卡的归类说明（出现在第 N 集 / 全集出现 / 未分类）
 */
export function AddAssetCard({
  type,
  scope,
  onCreate,
}: {
  type: AssetType;
  scope: string;
  onCreate: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCreate}
      className="text-muted-foreground hover:bg-muted/60 focus-visible:ring-ring/50 flex aspect-3/4 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-sm outline-none focus-visible:ring-2"
    >
      <Plus className="size-5" />
      {CREATE_LABEL[type]}
      <span className="text-xs">{scope}</span>
    </button>
  );
}
