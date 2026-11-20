import { describe, expect, test } from "bun:test";

import type { AssetDto } from "@/api/asset/type";
import {
  filterOfficialVoices,
  voiceDisplayName,
  voiceGroupLabel,
  voiceGroupOf,
} from "@/utils/assets/official-voices";

type VoiceFields = {
  fileName: string | null;
  scope?: string;
  voiceAge?: string;
  voiceGender?: string;
  voiceLang?: string;
};

const voice = (id: string, fields: VoiceFields): AssetDto => ({
  id,
  kind: "audio",
  url: `/files/o0/${id}.wav`,
  mimeType: "audio/wav",
  byteSize: 1,
  width: null,
  height: null,
  durationMs: 5000,
  ...fields,
});

const ALL = [
  voice("1", {
    fileName: "少儿故事",
    scope: "ark-cn",
    voiceAge: "teen",
    voiceGender: "female",
    voiceLang: "zh",
  }),
  voice("2", {
    fileName: "Big Boogie",
    scope: "byteplus",
    voiceAge: "young",
    voiceGender: "male",
    voiceLang: "en",
  }),
  voice("3", {
    fileName: "魅力女友",
    scope: "ark-cn",
    voiceAge: "young",
    voiceGender: "female",
    voiceLang: "zh",
  }),
  voice("4", {
    fileName: "懒音绵宝",
    scope: "ark-cn",
    voiceAge: "child",
    voiceGender: "male",
    voiceLang: "zh",
  }),
  voice("5", {
    fileName: "Clown Man",
    scope: "ark-cn",
    voiceAge: "older",
    voiceGender: "male",
    voiceLang: "zh",
  }),
];

const ids = (items: AssetDto[]) => items.map((item) => item.id);

describe("voiceGroupOf：官方年龄段收成四类人群", () => {
  test("儿童与少年归童声，青年/中年/老年归成人", () => {
    expect(voiceGroupOf({ voiceAge: "child", voiceGender: "male" })).toBe("boy");
    expect(voiceGroupOf({ voiceAge: "teen", voiceGender: "female" })).toBe("girl");
    expect(voiceGroupOf({ voiceAge: "young", voiceGender: "male" })).toBe("man");
    expect(voiceGroupOf({ voiceAge: "middle", voiceGender: "female" })).toBe("woman");
    expect(voiceGroupOf({ voiceAge: "older", voiceGender: "male" })).toBe("man");
  });

  test("没有性别（老数据、非公开音色）时不归类，角标也不显示", () => {
    expect(voiceGroupOf({ voiceAge: "young", voiceGender: "" })).toBeNull();
    expect(voiceGroupLabel({ voiceAge: "young" })).toBe("");
    expect(voiceGroupLabel({ voiceAge: "child", voiceGender: "female" })).toBe("女孩");
  });
});

describe("filterOfficialVoices：大类别（语言）+ 子类别（人群）+ 关键词", () => {
  test("不带条件返回全部且顺序不变", () => {
    expect(ids(filterOfficialVoices(ALL))).toEqual(["1", "2", "3", "4", "5"]);
    expect(ids(filterOfficialVoices(ALL, { lang: "all", group: "all", query: "  " }))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  test("大类别：中文 / English 各自一套", () => {
    expect(ids(filterOfficialVoices(ALL, { lang: "zh" }))).toEqual(["1", "3", "4", "5"]);
    expect(ids(filterOfficialVoices(ALL, { lang: "en" }))).toEqual(["2"]);
  });

  test("子类别：男孩 / 女孩 / 男生 / 女生", () => {
    expect(ids(filterOfficialVoices(ALL, { group: "boy" }))).toEqual(["4"]);
    expect(ids(filterOfficialVoices(ALL, { group: "girl" }))).toEqual(["1"]);
    expect(ids(filterOfficialVoices(ALL, { group: "man" }))).toEqual(["2", "5"]);
    expect(ids(filterOfficialVoices(ALL, { group: "woman" }))).toEqual(["3"]);
  });

  test("两级叠加：中文 + 女生", () => {
    expect(ids(filterOfficialVoices(ALL, { lang: "zh", group: "woman" }))).toEqual(["3"]);
    expect(ids(filterOfficialVoices(ALL, { lang: "en", group: "woman" }))).toEqual([]);
  });

  test("关键词按名字匹配，忽略大小写与首尾空白", () => {
    expect(ids(filterOfficialVoices(ALL, { query: "女友" }))).toEqual(["3"]);
    expect(ids(filterOfficialVoices(ALL, { query: " BIG " }))).toEqual(["2"]);
  });

  test("关键词也认分类词：男孩 / 女生 / 中文 / 老年", () => {
    expect(ids(filterOfficialVoices(ALL, { query: "男孩" }))).toEqual(["4"]);
    expect(ids(filterOfficialVoices(ALL, { query: "女生" }))).toEqual(["3"]);
    expect(ids(filterOfficialVoices(ALL, { query: "中文" }))).toEqual(["1", "3", "4", "5"]);
    expect(ids(filterOfficialVoices(ALL, { query: "老年" }))).toEqual(["5"]);
  });

  test("关键词与分类同时生效", () => {
    expect(ids(filterOfficialVoices(ALL, { query: "男", lang: "zh" }))).toEqual(["4", "5"]);
    expect(filterOfficialVoices(ALL, { query: "不存在的声音" })).toEqual([]);
  });

  test("大类别以来源为基准：方舟 = 中文，BytePlus = English，分类字段空着也认", () => {
    const bare = [
      voice("a", { fileName: "只标了来源的方舟音色", scope: "ark-cn" }),
      voice("b", { fileName: "source only byteplus", scope: "byteplus" }),
    ];
    expect(ids(filterOfficialVoices(bare, { lang: "zh" }))).toEqual(["a"]);
    expect(ids(filterOfficialVoices(bare, { lang: "en" }))).toEqual(["b"]);

    // 来源说得清楚时以来源为准，不会被写错的分类字段带偏
    const conflict = [voice("c", { fileName: "冲突", scope: "byteplus", voiceLang: "zh" })];
    expect(ids(filterOfficialVoices(conflict, { lang: "en" }))).toEqual(["c"]);
    expect(ids(filterOfficialVoices(conflict, { lang: "zh" }))).toEqual([]);
  });

  test("没有分类字段的老数据只在「全部」里出现，不会被误归到某个人群", () => {
    const legacy = [voice("9", { fileName: "老音色" })];
    expect(ids(filterOfficialVoices(legacy, { group: "man" }))).toEqual([]);
    expect(ids(filterOfficialVoices(legacy, { lang: "zh" }))).toEqual([]);
    expect(ids(filterOfficialVoices(legacy, { query: "老音色" }))).toEqual(["9"]);
  });
});

describe("voiceDisplayName：卡片上显示的名字", () => {
  test("BytePlus 去掉「年龄 - 性别 - 」前缀，信息交给角标", () => {
    expect(voiceDisplayName({ fileName: "Teen - Female - Shiny" })).toBe("Shiny");
    expect(voiceDisplayName({ fileName: "Middle-aged - Male - Adam" })).toBe("Adam");
  });

  test("方舟的中文名原样显示，含连字符的名字不被误切", () => {
    expect(voiceDisplayName({ fileName: "魅力女友" })).toBe("魅力女友");
    expect(voiceDisplayName({ fileName: "Neo - The One" })).toBe("Neo - The One");
  });

  test("名字为空时给兜底名字", () => {
    expect(voiceDisplayName({ fileName: null })).toBe("音色");
    expect(voiceDisplayName({ fileName: "   " })).toBe("音色");
  });
});
