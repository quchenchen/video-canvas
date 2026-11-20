import type { AssetDto } from "@/api/asset/type";

/** 公开音色的资源域：方舟国内站与 BytePlus 各一套素材库，asset-xxx 只在同域内有效。 */
export const VOICE_SCOPE_LABEL: Record<string, string> = {
  "ark-cn": "方舟",
  byteplus: "BytePlus",
};

/** 大类别：语言。方舟国内是中文音色，BytePlus 是英文音色。 */
export type VoiceLang = "zh" | "en";
export type VoiceLangFilter = VoiceLang | "all";

/** 子类别：人群。男孩/女孩是童声（儿童、少年），男生/女生是成人（青年、中年、老年）。 */
export type VoiceGroup = "boy" | "girl" | "man" | "woman";
export type VoiceGroupFilter = VoiceGroup | "all";

export const VOICE_LANG_OPTIONS: { value: VoiceLangFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

export const VOICE_GROUP_OPTIONS: { value: VoiceGroupFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "boy", label: "男孩" },
  { value: "girl", label: "女孩" },
  { value: "man", label: "男生" },
  { value: "woman", label: "女生" },
];

const GROUP_LABEL: Record<VoiceGroup, string> = {
  boy: "男孩",
  girl: "女孩",
  man: "男生",
  woman: "女生",
};

const AGE_LABEL: Record<string, string> = {
  child: "儿童",
  teen: "少年",
  young: "青年",
  middle: "中年",
  older: "老年",
};

/** 童声的两个年龄段；其余（青年/中年/老年）都算成人。 */
const KID_AGES = new Set(["child", "teen"]);

/** 大类别以来源为基准：方舟国内那套是中文音色，BytePlus 那套是英文音色。 */
const SCOPE_LANG: Record<string, VoiceLang> = { "ark-cn": "zh", byteplus: "en" };

/**
 * 音色的大类别（语言）。按来源定：方舟国内 = 中文，BytePlus = 英文；
 * 来源认不出时才退回数据里的 voice_lang，都没有就是空（只在「全部」里出现）。
 * 这样分类的基准就是用户实际看到的两套素材，不依赖分类字段有没有回填。
 */
export function voiceLangOf(asset: Pick<AssetDto, "scope" | "voiceLang">): VoiceLang | "" {
  const byScope = SCOPE_LANG[asset.scope ?? ""];
  if (byScope) return byScope;
  return asset.voiceLang === "zh" || asset.voiceLang === "en" ? asset.voiceLang : "";
}

/**
 * 音色的人群归类：男孩/女孩（童声）或男生/女生（成人）。
 * 官方标签里的 5 个年龄段在界面上收成 4 类，年龄本身仍存在数据里，以后想细分再加筛选即可。
 * 没有性别字段（老数据、或非公开音色）时返回 null，不参与分类筛选。
 */
export function voiceGroupOf(asset: Pick<AssetDto, "voiceAge" | "voiceGender">): VoiceGroup | null {
  if (asset.voiceGender !== "male" && asset.voiceGender !== "female") return null;
  const kid = KID_AGES.has(asset.voiceAge ?? "");
  if (asset.voiceGender === "male") return kid ? "boy" : "man";
  return kid ? "girl" : "woman";
}

/** 卡片角标上的子类别文字；没有性别信息时返回空串（不显示角标）。 */
export function voiceGroupLabel(asset: Pick<AssetDto, "voiceAge" | "voiceGender">): string {
  const group = voiceGroupOf(asset);
  return group ? GROUP_LABEL[group] : "";
}

/** BytePlus 的名字带着「Age - Gender - 」前缀，信息已由角标表达，展示时去掉。 */
const NAME_PREFIX = /^(Child|Teen|Young|Middle-aged|Older) - (Male|Female) - /;

/** 去掉 BytePlus 的「年龄 - 性别 - 」前缀，其它名字原样返回（首尾空白已去掉）。 */
export function stripVoicePrefix(fileName: string | null | undefined): string {
  return (fileName ?? "").replace(NAME_PREFIX, "").trim();
}

/**
 * 卡片和试听里显示的名字：BytePlus 去掉年龄性别前缀（Teen - Female - Shiny → Shiny），
 * 方舟的名字本来就只是名字；空名字给个兜底。
 */
export function voiceDisplayName(asset: Pick<AssetDto, "fileName">): string {
  return stripVoicePrefix(asset.fileName) || "音色";
}

/** 一条音色参与搜索的文本：名字、来源、语言、人群、年龄段，都小写。 */
function searchTextOf(asset: AssetDto): string {
  const lang = voiceLangOf(asset);
  return [
    asset.fileName ?? "",
    VOICE_SCOPE_LABEL[asset.scope ?? ""] ?? "",
    lang === "zh" ? "中文" : lang === "en" ? "英文 english" : "",
    voiceGroupLabel(asset),
    AGE_LABEL[asset.voiceAge ?? ""] ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/** 音色的组合筛选条件：关键词 + 大类别（语言）+ 子类别（人群）。 */
export interface OfficialVoiceFilter {
  /** 搜索词，空表示不按关键词过滤 */
  query?: string;
  /** 大类别：zh / en；all 或不传表示全部 */
  lang?: VoiceLangFilter;
  /** 子类别：boy / girl / man / woman；all 或不传表示全部 */
  group?: VoiceGroupFilter;
}

/**
 * 过滤公开音色，资产页与素材选择器共用一套规则。
 * 关键词忽略大小写与首尾空白，除名字外也认来源、语言、人群、年龄段这些词
 * （搜「女孩」「英文」都能直接收窄）；语言与人群各自独立过滤，结果保持原顺序。
 * @param items 全量音色
 * @param filter 关键词与大类别/子类别
 */
export function filterOfficialVoices(
  items: readonly AssetDto[],
  filter: OfficialVoiceFilter | string = {},
): AssetDto[] {
  const {
    query = "",
    lang = "all",
    group = "all",
  } = typeof filter === "string" ? { query: filter } : filter;
  const q = query.trim().toLowerCase();
  return items.filter((asset) => {
    if (lang !== "all" && voiceLangOf(asset) !== lang) return false;
    if (group !== "all" && voiceGroupOf(asset) !== group) return false;
    if (q && !searchTextOf(asset).includes(q)) return false;
    return true;
  });
}
