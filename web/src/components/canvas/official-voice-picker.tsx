import { useState } from "react";
import { Music2 } from "lucide-react";

import type { AssetDto } from "@/api/asset/type";
import { listOfficialVoices } from "@/api/official-voice";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** 打开菜单时才拉一次官方音色；资产页和画布入口共用。 */
export function useOfficialVoices() {
  const [items, setItems] = useState<AssetDto[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = () => {
    if (loaded) return;
    listOfficialVoices()
      .then((page) => setItems(page.items))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  };

  return { items, loaded, load };
}

/** 菜单里的内容：独立按钮和画布引用条的「+」子菜单共用同一套文案与列表。 */
export function OfficialVoiceMenuContent({
  items,
  loaded,
  onPick,
}: {
  items: AssetDto[];
  loaded: boolean;
  onPick: (asset: AssetDto) => void;
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>音色库</DropdownMenuLabel>
      {items.length === 0 && (
        <p className="text-muted-foreground px-1.5 py-2 text-xs">
          {loaded ? "暂无音色" : "加载中…"}
        </p>
      )}
      {items.map((asset) => (
        <DropdownMenuItem key={asset.id} onClick={() => onPick(asset)}>
          <span className="truncate">{asset.fileName ?? "音色"}</span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
}

/**
 * 参考音频里的「音色库」入口：列出 seedance 官方参考音色，选中后把它的素材 ID
 * 交给 RefCard 的 onAdd 写进 params.audios。Seedance 生成时后端换成 asset:// 官方地址，
 * 其他模型用转存后的文件地址（插件没标 filed 就走 URL）。
 */
export function OfficialVoicePicker({
  disabled,
  onPick,
}: {
  disabled?: boolean;
  onPick: (asset: AssetDto) => void;
}) {
  const { items, loaded, load } = useOfficialVoices();

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <DropdownMenuTrigger
        disabled={disabled}
        className="border-border bg-background hover:bg-muted inline-flex h-7 items-center gap-1.5 rounded-[min(var(--radius-md),10px)] border px-2 text-xs font-medium disabled:opacity-50"
      >
        <Music2 className="size-3.5" />
        音色库
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="start" sideOffset={6}>
        <OfficialVoiceMenuContent items={items} loaded={loaded} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
