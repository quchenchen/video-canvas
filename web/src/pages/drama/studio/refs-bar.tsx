import { Fragment } from "react";
import { AudioLines, Box, Image as ImageIcon, User } from "lucide-react";

import { MediaPreview } from "@/components/canvas/media-preview";
import { StatusPill } from "@/components/drama/status-pill";
import { cn } from "@/lib/utils";
import type { RefView } from "@/utils/drama/segment-input";

import { useStudio } from "./use-studio";

const TYPE_ICON = { character: User, scene: ImageIcon, prop: Box } as const;

/** 参考素材条上的一项：缩略图 + 名字 + 状态标记（只用文字 / 角色卡声音未生效 / 失效 / 被截断） */
function Chip({ view }: { view: RefView }) {
  const { assets } = useStudio();
  const asset = assets.find((item) => item.id === view.id);
  const Icon = TYPE_ICON[view.type ?? "scene"];
  const dead = view.state === "dead";
  return (
    <span
      className={cn(
        "bg-muted inline-flex h-[30px] items-center gap-1.5 rounded-lg pr-2 pl-[3px] text-xs",
        dead && "bg-destructive/10 text-destructive",
      )}
    >
      <span className="bg-background/60 text-muted-foreground grid size-6 shrink-0 place-items-center overflow-hidden rounded-md">
        {asset?.src && !dead ? (
          <MediaPreview src={asset.src} mode="thumb" fit="cover" draggable={false} />
        ) : (
          <Icon className="size-3.5" />
        )}
      </span>
      <span className={cn("max-w-32 truncate", dead && "line-through")}>{view.label}</span>
      {dead && (
        <StatusPill tone="destructive" className="h-4 text-[10px]">
          已失效
        </StatusPill>
      )}
      {view.state === "text" && (
        <StatusPill tone="warning" className="h-4 text-[10px]">
          只用文字
        </StatusPill>
      )}
      {view.truncated && (
        <StatusPill tone="warning" className="h-4 text-[10px]">
          部分未带入
        </StatusPill>
      )}
      {view.voice === "ignored" && (
        <StatusPill tone="warning" className="h-4 text-[10px]">
          角色卡声音未生效
        </StatusPill>
      )}
      {view.voice === "dropped" && (
        <StatusPill tone="warning" className="h-4 text-[10px]">
          声音未带入
        </StatusPill>
      )}
    </span>
  );
}

/** 同一时刻只放一路试听，点新的先停上一路 */
let preview: HTMLAudioElement | null = null;

function playVoice(src: string) {
  preview?.pause();
  preview = new Audio(src);
  void preview.play().catch(() => {
    preview = null;
  });
}

/**
 * 角色卡音色单独一条素材：角色卡上绑的音色会作为参考音频进 input.audios，
 * 和参考图一样要能在素材条里看见、能试听，不然只看角色 chip 上的小图标判断不了带没带。
 */
/** 角色音色的音频条目：显示「角色名 · 音色名」，老数据没有音色名时退回「角色名 · 音色」。 */
function VoiceChip({ label, name, src }: { label: string; name?: string; src: string }) {
  const voiceName = name?.trim() ?? "";
  const text = voiceName ? `${label} · ${voiceName}` : `${label} · 音色`;
  return (
    <button
      type="button"
      aria-label={`试听${text}`}
      title="点一下试听音色"
      onClick={() => playVoice(src)}
      className="bg-muted hover:bg-accent focus-visible:ring-ring/60 inline-flex h-[30px] items-center gap-1.5 rounded-lg pr-2 pl-[3px] text-xs outline-none focus-visible:ring-2"
    >
      <span className="bg-background/60 text-muted-foreground grid size-6 shrink-0 place-items-center rounded-md">
        <AudioLines className="size-3.5" />
      </span>
      <span className="max-w-40 truncate">{text}</span>
    </button>
  );
}

/**
 * 参考素材条：按提示词里的 @ 解析出这次会带上的参考图 / 音频，标出「只用文字」「角色卡声音未生效」，
 * 右上角是 n/上限（参考图张数、参考音频条数）。不另列说明文字，状态都标在每个素材上。
 * 解析规则见 utils/drama/segment-input.ts。
 */
export function RefsBar() {
  const { plan, assets } = useStudio();
  if (!plan) return null;
  return (
    <section aria-label="参考素材">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted-foreground text-xs">参考素材</span>
        {plan.imageMax > 0 && (
          <StatusPill
            tone={plan.imageCount >= plan.imageMax ? "warning" : "muted"}
            className="tabular-nums"
          >
            图 {plan.imageCount}/{plan.imageMax}
          </StatusPill>
        )}
        {plan.audioMax > 0 && plan.audioCount > 0 && (
          <StatusPill
            tone={plan.audioCount >= plan.audioMax ? "warning" : "muted"}
            className="tabular-nums"
          >
            音频 {plan.audioCount}/{plan.audioMax}
          </StatusPill>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {plan.refs.map((view) => {
          const voice = assets.find((item) => item.id === view.id)?.character?.voice;
          return (
            <Fragment key={view.id}>
              <Chip view={view} />
              {view.voice === "used" && voice?.mode === "audio" && voice.src && (
                <VoiceChip label={view.label} name={voice.name} src={voice.src} />
              )}
            </Fragment>
          );
        })}
      </div>
      {plan.voiceNotice && (
        <p className="text-muted-foreground mt-1.5 text-xs">{plan.voiceNotice}</p>
      )}
    </section>
  );
}
