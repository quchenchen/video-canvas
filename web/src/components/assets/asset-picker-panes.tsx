import { useEffect, useState, type MutableRefObject } from "react";
import { motion } from "motion/react";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { AssetDto } from "@/api/asset/type";
import type { AssetKind, LibraryItemDto } from "@/api/asset-library/type";
import { listAllOfficialVoices } from "@/api/official-voice";
import { EmptyMark } from "@/components/home/empty-mark";
import { TAP_CARD } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FilingStatus } from "@/components/virtual-human/filing-status";
import { VoiceFilterChips } from "@/components/assets/voice-filter-chips";
import type { AssetFoldersState } from "@/hooks/use-asset-folders";
import { useAssetLibrary } from "@/hooks/use-asset-library";
import { useGeneratedAssets } from "@/hooks/use-generated-assets";
import { useVirtualHumans } from "@/hooks/use-virtual-humans";
import { hasActiveFilter, type GeneratedFilter } from "@/utils/assets/generated-filter";
import type { PagedList } from "@/utils/assets/paged-list";
import {
  filterOfficialVoices,
  VOICE_GROUP_OPTIONS,
  VOICE_LANG_OPTIONS,
  voiceDisplayName,
  voiceGroupLabel,
  type VoiceGroupFilter,
  type VoiceLangFilter,
} from "@/utils/assets/official-voices";
import { canToggle } from "@/utils/assets/picker-selection";
import type { PickerView } from "@/utils/assets/picker-state";
import type { UploadTask } from "@/utils/assets/upload-queue";
import { humanPickGroups } from "@/utils/virtual-human/virtual-human";

import { AssetCover, HistoryAssetCard, LibraryAssetCard, type CardSelect } from "./asset-card";
import { AssetGrid, LoadMoreFooter } from "./asset-grid";
import { FolderCard } from "./folder-card";
import { UploadCard } from "./upload-card";

/** 弹框里空状态的占位：高度比资产页矮，免得撑出滚动 */
const EMPTY_CLASS = "min-h-56 flex-1 text-center";

/** 弹框内容区的加载态：居中转圈，不用骨架屏 */
function PaneLoading() {
  return (
    <div
      role="status"
      aria-label="加载中"
      className={`${EMPTY_CLASS} flex items-center justify-center`}
    >
      <Loader2 className="text-muted-foreground size-6 animate-spin motion-reduce:animate-none" />
    </div>
  );
}

/** 选择规则：一次最多选几个，以及某个素材不能选的原因（标在卡片上并禁用） */
export type PickRules = {
  /** 一次最多选几个，缺省 20；1 是单选 */
  limit?: number;
  /** 某个素材不能选的原因；null 表示可以选 */
  reasonOf?: (asset: AssetDto) => string | null;
};

/** 一张卡片的选择状态：已选的可取消，没选的在已选满后或有不可选原因时禁用 */
function selectOf(
  selected: AssetDto[],
  asset: AssetDto,
  onToggle: (asset: AssetDto) => void,
  rules: PickRules,
): CardSelect {
  const index = selected.findIndex((item) => item.id === asset.id);
  const checked = index >= 0;
  const reason = checked ? null : (rules.reasonOf?.(asset) ?? null);
  const full = !canToggle(selected, asset, rules.limit);
  return {
    selected: checked,
    order: checked ? index + 1 : undefined,
    disabled: !!reason || full,
    reason: reason ?? (full && rules.limit !== undefined ? "已达上限" : null),
    onToggle: () => onToggle(asset),
  };
}

/**
 * 弹框里「生成历史」来源的内容：按类型与筛选条件分页，卡片可勾选。
 * 状态沿用资产页：加载转圈、失败重试、筛选无结果可清除、滚动到底加载下一页。
 * @param kind 类型标签
 * @param filter 筛选状态（关键字已防抖）
 * @param selected 当前选择
 * @param onToggle 勾选或取消一个素材
 * @param onClearFilters 「清除筛选」
 */
export function HistoryPane({
  kind,
  filter,
  selected,
  onToggle,
  rules,
  onClearFilters,
}: {
  kind: PickerView["kind"];
  filter: GeneratedFilter;
  selected: AssetDto[];
  onToggle: (asset: AssetDto) => void;
  rules: PickRules;
  onClearFilters: () => void;
}) {
  const { list, state } = useGeneratedAssets(kind, filter);
  const { items } = state;

  if (state.status === "loading") return <PaneLoading />;
  if (state.status === "error") {
    return (
      <EmptyMark
        className={EMPTY_CLASS}
        title="加载失败"
        hint={
          <Button variant="outline" size="sm" onClick={list.retry}>
            重试
          </Button>
        }
      />
    );
  }
  if (items.length === 0) {
    return hasActiveFilter(filter) ? (
      <EmptyMark
        className={EMPTY_CLASS}
        title="没有符合条件的素材"
        hint={
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            清除筛选
          </Button>
        }
      />
    ) : (
      <EmptyMark
        className={EMPTY_CLASS}
        title="暂无相关资产"
        hint="在「创作」里生成的内容会出现在这里"
      />
    );
  }
  return (
    <>
      <AssetGrid>
        {items.map((item) => (
          <HistoryAssetCard
            key={item.asset.id}
            item={item}
            select={selectOf(selected, item.asset, onToggle, rules)}
          />
        ))}
      </AssetGrid>
      <LoadMoreFooter
        hasMore={state.nextCursor !== ""}
        loading={state.loadingMore}
        failed={state.moreFailed}
        onLoadMore={list.loadMore}
      />
    </>
  );
}

/**
 * 弹框里「个人资产库」来源的内容：根目录显示文件夹卡片，点进去出现面包屑；
 * 搜索跨文件夹平铺并隐藏文件夹卡片。素材卡可勾选；弹框内上传中的文件显示成上传卡。
 * @param view 当前位置（所在文件夹）
 * @param q 文件名关键字（已防抖）
 * @param folders 文件夹列表状态，由弹框持有（上传完成要调整它的计数）
 * @param tasks 弹框内上传中的任务
 * @param selected 当前选择
 * @param listRef 弹框用它在上传完成时把新素材插进当前列表
 * @param onToggle 勾选或取消一个素材
 * @param onOpenFolder 进入文件夹
 * @param onLeaveFolder 回到根目录（面包屑；文件夹已不存在时也用它）
 * @param onCancelUpload 取消上传或移除失败的任务
 * @param onRetryUpload 重试失败的上传
 */
export function LibraryPane({
  view,
  q,
  folders,
  tasks,
  selected,
  kind,
  rules,
  listRef,
  onToggle,
  onOpenFolder,
  onLeaveFolder,
  onCancelUpload,
  onRetryUpload,
}: {
  view: PickerView;
  q: string;
  folders: AssetFoldersState;
  tasks: UploadTask[];
  selected: AssetDto[];
  /** 锁定素材种类：个人资产库只列这一种；不给则各种类混列（原有行为） */
  kind?: AssetKind;
  rules: PickRules;
  listRef: MutableRefObject<PagedList<LibraryItemDto> | null>;
  onToggle: (asset: AssetDto) => void;
  onOpenFolder: (folder: string) => void;
  onLeaveFolder: () => void;
  onCancelUpload: (id: string) => void;
  onRetryUpload: (id: string) => void;
}) {
  const { folder } = view;
  const searching = q.trim() !== "";
  const { list, state } = useAssetLibrary(folder, q, kind);
  const { items } = state;
  const currentFolder = (folder && folders.folders?.find((entry) => entry.id === folder)) || null;

  /** 把列表交给弹框：上传完成时它要往里插新素材 */
  useEffect(() => {
    listRef.current = list;
    return () => {
      if (listRef.current === list) listRef.current = null;
    };
  }, [list, listRef]);

  /** 当前文件夹已经不存在（别处删了）：回到根目录并提示 */
  useEffect(() => {
    if (folder && folders.folders && !currentFolder) {
      toast.error("该内容已不存在");
      onLeaveFolder();
    }
  }, [folder, folders.folders, currentFolder, onLeaveFolder]);

  /** 该位置正在上传的任务；搜索结果里不显示，它们不属于搜索结果 */
  const pendingUploads = searching ? [] : tasks.filter((task) => task.folderId === folder);
  /** 根目录要等文件夹卡片一起到，不然会先闪一下「还没有资产」 */
  const foldersPending = folder === null && !searching && folders.loading;
  const folderList = folder === null && !searching ? (folders.folders ?? []) : [];

  const crumb =
    folder || searching ? (
      <nav aria-label="当前位置" className="mb-3 flex h-8 items-center gap-1 text-sm">
        <button
          type="button"
          onClick={onLeaveFolder}
          className="text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:ring-ring/50 h-8 rounded-full px-3 transition-colors outline-none focus-visible:ring-3"
        >
          个人资产库
        </button>
        <ChevronRight aria-hidden className="text-muted-foreground size-4" />
        <h2 className="truncate font-semibold">
          {searching ? "搜索结果" : (currentFolder?.name ?? "…")}
        </h2>
      </nav>
    ) : null;

  if (state.status === "loading" || foldersPending) {
    return (
      <>
        {crumb}
        <PaneLoading />
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        {crumb}
        <EmptyMark
          className={EMPTY_CLASS}
          title="加载失败"
          hint={
            <Button variant="outline" size="sm" onClick={list.retry}>
              重试
            </Button>
          }
        />
      </>
    );
  }

  const empty = items.length === 0 && pendingUploads.length === 0 && folderList.length === 0;
  return (
    <>
      {crumb}
      {empty ? (
        searching ? (
          <EmptyMark
            className={EMPTY_CLASS}
            title={`没有找到“${q.trim()}”`}
            hint="换个关键词试试"
          />
        ) : folder ? (
          <EmptyMark
            className={EMPTY_CLASS}
            title="这个文件夹是空的"
            hint="点右上角「上传」添加素材"
          />
        ) : (
          <EmptyMark
            className={EMPTY_CLASS}
            title="还没有资产"
            hint="点右上角「上传」，或先在资产页把生成历史加入资产库"
          />
        )
      ) : (
        <>
          <AssetGrid>
            {folderList.map((entry) => (
              <FolderCard key={entry.id} folder={entry} onOpen={() => onOpenFolder(entry.id)} />
            ))}
            {pendingUploads.map((task) => (
              <UploadCard
                key={task.id}
                task={task}
                onCancel={() => onCancelUpload(task.id)}
                onRetry={() => onRetryUpload(task.id)}
              />
            ))}
            {items.map((item) => (
              <LibraryAssetCard
                key={item.id}
                item={item}
                select={selectOf(selected, item.asset, onToggle, rules)}
              />
            ))}
          </AssetGrid>
          {items.length === 0 && (
            <p className="text-muted-foreground mt-6 text-center text-[13px]">
              {searching ? "没有符合的素材" : "这里还没有素材"}
            </p>
          )}
          <LoadMoreFooter
            hasMore={state.nextCursor !== ""}
            loading={state.loadingMore}
            failed={state.moreFailed}
            onLoadMore={list.loadMore}
          />
        </>
      )}
    </>
  );
}

/**
 * 弹框里「真人库」来源的内容：按真人分组列出图片，备案可用的才能勾选，备案中、失败的置灰并标原因。
 * 选中的就是个人资产库里的那张素材，生成时后端会把备案可用的图换成 asset:// 引用。
 * @param q 搜索词（已防抖），按真人名称匹配
 * @param selected 当前选择
 * @param rules 选择规则（上限、调用方给的不可选原因）
 * @param onToggle 勾选或取消一个素材
 */
export function HumansPane({
  q,
  selected,
  rules,
  onToggle,
}: {
  q: string;
  selected: AssetDto[];
  rules: PickRules;
  onToggle: (asset: AssetDto) => void;
}) {
  const { humans, loading, error, reload } = useVirtualHumans(true);
  if (loading) return <PaneLoading />;
  if (error) {
    return (
      <EmptyMark
        className={EMPTY_CLASS}
        title="加载失败"
        hint={
          <Button variant="outline" size="sm" onClick={reload}>
            重试
          </Button>
        }
      />
    );
  }
  const groups = humanPickGroups(humans ?? [], q);
  if (groups.length === 0) {
    return (
      <EmptyMark
        className={EMPTY_CLASS}
        title={q.trim() ? `没有找到“${q.trim()}”` : "真人库是空的"}
      />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map(({ human, items }) => (
        <section key={human.id} aria-label={human.name} className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{human.name}</span>
            <FilingStatus status={human.status} />
          </h3>
          <AssetGrid>
            {items.map((item) => {
              // 备案还没可用的图优先标备案状态，其次才是调用方的原因（已是主图、已添加）
              const itemRules: PickRules = {
                ...rules,
                reasonOf: (asset) => item.reason ?? rules.reasonOf?.(asset) ?? null,
              };
              return (
                <LibraryAssetCard
                  key={item.imageId}
                  item={{
                    id: item.imageId,
                    asset: item.asset,
                    folderId: null,
                    createdAt: human.createdAt,
                  }}
                  select={selectOf(selected, item.asset, onToggle, itemRules)}
                />
              );
            })}
          </AssetGrid>
        </section>
      ))}
    </div>
  );
}

/**
 * 弹框里「音色库」来源的内容：列出方舟官方参考音色，按名字本地过滤，卡片可勾选。
 * 音色是系统公共素材（user_id=0），不进个人资产库；选中的是它的素材 ID，
 * 生成时由后端按插件分流换成 asset:// 官方地址（Seedance）或转存文件地址（其他模型）。
 * @param q 搜索词（已防抖），按音色名字匹配
 * @param selected 当前选择
 * @param rules 选择规则（上限、调用方给的不可选原因）
 * @param onToggle 勾选或取消一个音色
 */
export function OfficialPane({
  q,
  selected,
  rules,
  onToggle,
}: {
  q: string;
  selected: AssetDto[];
  rules: PickRules;
  onToggle: (asset: AssetDto) => void;
}) {
  const [items, setItems] = useState<AssetDto[] | null>(null);
  const [error, setError] = useState(false);
  const [lang, setLang] = useState<VoiceLangFilter>("all");
  const [group, setGroup] = useState<VoiceGroupFilter>("all");

  useEffect(() => {
    let alive = true;
    listAllOfficialVoices()
      .then((all) => {
        if (alive) setItems(all);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (items === null) return <PaneLoading />;
  if (error) {
    return <EmptyMark className={EMPTY_CLASS} title="加载失败" hint="音色库加载失败，请稍后重试" />;
  }
  const query = q.trim();
  // 和资产页「音色库」共用一套过滤规则：大类别（语言）+ 子类别（人群）+ 关键词
  const shown = filterOfficialVoices(items, { query, lang, group });
  const filtering = query !== "" || lang !== "all" || group !== "all";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">
        中文音色来自方舟国内，English 来自 BytePlus，两套资源各自独立。只有最终视频模型是
        Seedance、且渠道与音色同属一个资源域时，才会按 asset
        地址引用；其他模型一律把音色当普通音频文件用。
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground w-10 shrink-0 text-xs">语言</span>
          <VoiceFilterChips
            label="语言"
            options={VOICE_LANG_OPTIONS}
            value={lang}
            onChange={setLang}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground w-10 shrink-0 text-xs">人群</span>
          <VoiceFilterChips
            label="人群"
            options={VOICE_GROUP_OPTIONS}
            value={group}
            onChange={setGroup}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyMark
          className={EMPTY_CLASS}
          title={query ? `没有找到“${query}”` : "这个分类下还没有音色"}
          hint={filtering ? "换个分类或清空搜索词再试" : undefined}
        />
      ) : (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-[repeat(auto-fill,minmax(88px,1fr))]">
          {shown.map((asset) => (
            <OfficialVoicePickCard
              key={asset.id}
              asset={asset}
              select={selectOf(selected, asset, onToggle, rules)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 紧凑的音色选择卡：整张卡都是点击区，点头像或名字都能勾选；方形缩略图 + 名字常显在下方，选中描边并标勾选序号。 */
export function OfficialVoicePickCard({ asset, select }: { asset: AssetDto; select: CardSelect }) {
  return (
    <motion.button
      type="button"
      data-slot="official-voice-pick"
      data-selected={select.selected || undefined}
      data-disabled={select.disabled || undefined}
      aria-label={voiceDisplayName(asset)}
      aria-pressed={select.selected}
      disabled={select.disabled}
      onClick={select.onToggle}
      whileTap={select.disabled ? undefined : TAP_CARD}
      className={cn(
        "bg-card group/card relative flex min-w-0 flex-col gap-1 rounded-lg border p-1.5 text-center transition-opacity",
        "focus-visible:ring-ring/60 focus-visible:ring-2",
        select.selected && "outline-foreground outline-2 outline-offset-2",
        select.disabled && "cursor-not-allowed opacity-45",
      )}
    >
      <span className="bg-muted relative block aspect-square w-full overflow-hidden rounded-md">
        <AssetCover asset={asset} />
        <span
          aria-hidden
          className={cn(
            "absolute top-1 left-1 z-10 grid size-4.5 place-items-center rounded-full text-[10px] font-semibold tabular-nums",
            select.selected
              ? "bg-foreground text-background"
              : "bg-cover-scrim ring-cover-foreground/70 ring-1",
          )}
        >
          {select.selected && select.order !== undefined ? (
            select.order
          ) : (
            <Check className="size-3 opacity-0" />
          )}
        </span>
      </span>
      <span className="block w-full truncate px-0.5 text-[11px] leading-tight">
        {voiceDisplayName(asset)}
      </span>
      {voiceGroupLabel(asset) && (
        <span className="bg-cover-scrim text-cover-foreground pointer-events-none absolute top-1 right-1 z-10 rounded-full px-1 text-[9px] leading-4">
          {voiceGroupLabel(asset)}
        </span>
      )}
      {select.reason && (
        <span className="bg-cover-scrim text-cover-foreground pointer-events-none absolute right-1 bottom-6 z-10 rounded-full px-1.5 py-0.5 text-[10px]">
          {select.reason}
        </span>
      )}
    </motion.button>
  );
}
