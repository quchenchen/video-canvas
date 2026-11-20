import { describe, expect, test } from "bun:test";

import type { ChannelView } from "@/api/admin/ai/type";
import {
  buildChannelRequest,
  channelFormFromView,
  checkBaseUrl,
  checkHeaders,
  emptyChannelForm,
  filingSiteOf,
  isOfficialFilingHost,
  showFilingSwitch,
  formatLoad,
  formatRateLimit,
  MAX_CHANNEL_HEADERS,
  type ChannelFormState,
} from "@/utils/admin/channel-form";

const view = (extra: Partial<ChannelView> = {}): ChannelView => ({
  key: "openai-main",
  name: "OpenAI 主渠道",
  base_url: "https://api.openai.com",
  headers: { "User-Agent": "video-canvas-test" },
  rate_limit: { rps: 5, max_concurrency: 0 },
  sort: 10,
  enabled: true,
  secret_set: true,
  secret_key_set: false,
  updated_by: 1,
  updated_at: "",
  created_at: "",
  ...extra,
});

const newForm = (extra: Partial<ChannelFormState> = {}): ChannelFormState => ({
  ...emptyChannelForm(),
  name: "我的渠道",
  baseUrl: "https://api.example.com",
  ...extra,
});

describe("emptyChannelForm", () => {
  test("默认启用、没有请求头、限流留空", () => {
    expect(emptyChannelForm()).toEqual({
      name: "",
      baseUrl: "",
      headers: [],
      enabled: true,
      rps: "",
      maxConcurrency: "",
      maxRunning: "",
      filingEnabled: false,
      filingGroupId: "",
      filingProjectName: "",
      voiceScope: "",
    });
  });
});

describe("channelFormFromView", () => {
  test("渠道视图转表单：请求头展开成逐行，0 限流留空", () => {
    expect(channelFormFromView(view())).toEqual({
      name: "OpenAI 主渠道",
      baseUrl: "https://api.openai.com",
      headers: [{ name: "User-Agent", value: "video-canvas-test" }],
      enabled: true,
      rps: "5",
      maxConcurrency: "",
      maxRunning: "",
      filingEnabled: false,
      filingGroupId: "",
      filingProjectName: "",
      voiceScope: "",
    });
  });

  test("公开素材资源域读进表单；旧后端没有这个字段时按空串（按 Base URL 推断）", () => {
    expect(channelFormFromView(view({ voice_scope: "byteplus" })).voiceScope).toBe("byteplus");
    expect(channelFormFromView(view({ voice_scope: undefined })).voiceScope).toBe("");
  });

  test("headers 为空或缺失时没有行", () => {
    expect(channelFormFromView(view({ headers: {} })).headers).toEqual([]);
    expect(channelFormFromView(view({ headers: null as never })).headers).toEqual([]);
  });
});

describe("checkBaseUrl", () => {
  test("合法的 http / https 地址通过", () => {
    expect(checkBaseUrl("https://api.example.com")).toBeNull();
    expect(checkBaseUrl("http://10.0.0.1:8080/v1")).toBeNull();
  });

  test("空值、非法、非 http、带账号密码、带查询参数或片段都拒绝", () => {
    expect(checkBaseUrl("  ")).toContain("Base URL");
    expect(checkBaseUrl("not a url")).toBeTruthy();
    expect(checkBaseUrl("ftp://example.com")).toBeTruthy();
    expect(checkBaseUrl("https://user:pw@example.com")).toBeTruthy();
    expect(checkBaseUrl("https://example.com/v1?key=1")).toBeTruthy();
    expect(checkBaseUrl("https://example.com/v1#top")).toBeTruthy();
  });
});

describe("checkHeaders", () => {
  test("合法请求头无错误，完全空白的行被忽略", () => {
    expect(
      checkHeaders([
        { name: "User-Agent", value: "x" },
        { name: "", value: "" },
        { name: "X-Org", value: "acme" },
      ]),
    ).toEqual({});
  });

  test("名称为空但有值、名称不是合法 token", () => {
    const errors = checkHeaders([
      { name: "", value: "v" },
      { name: "bad name", value: "v" },
      { name: "中文", value: "v" },
    ]);
    expect(errors["headers.0"]).toContain("名称");
    expect(errors["headers.1"]).toContain("不合法");
    expect(errors["headers.2"]).toContain("不合法");
  });

  test("禁用头不区分大小写", () => {
    for (const name of [
      "Host",
      "content-length",
      "Transfer-Encoding",
      "CONNECTION",
      "Upgrade",
      "Authorization",
      "Proxy-Authorization",
      "Cookie",
    ]) {
      expect(checkHeaders([{ name, value: "v" }])["headers.0"]).toContain("不能设置");
    }
  });

  test("名称不区分大小写不得重复，错误挂在后出现的那行", () => {
    const errors = checkHeaders([
      { name: "X-Org", value: "a" },
      { name: "x-org", value: "b" },
    ]);
    expect(errors["headers.0"]).toBeUndefined();
    expect(errors["headers.1"]).toContain("重复");
  });

  test("值超过 1024 字符或含换行 / 控制字符", () => {
    expect(checkHeaders([{ name: "X-A", value: "a".repeat(1025) }])["headers.0"]).toContain("1024");
    expect(checkHeaders([{ name: "X-A", value: "a".repeat(1024) }])).toEqual({});
    expect(checkHeaders([{ name: "X-A", value: "a\nb" }])["headers.0"]).toContain("换行");
    expect(checkHeaders([{ name: "X-A", value: "a\u0007b" }])["headers.0"]).toContain("换行");
  });

  test("最多 32 条", () => {
    const rows = Array.from({ length: MAX_CHANNEL_HEADERS + 1 }, (_, i) => ({
      name: `X-H${i}`,
      value: "v",
    }));
    expect(checkHeaders(rows).headers).toContain("32");
    expect(checkHeaders(rows.slice(0, MAX_CHANNEL_HEADERS))).toEqual({});
  });
});

describe("buildChannelRequest（新建）", () => {
  test("合法表单：生成 create 请求体，限流 0 表示不限", () => {
    const result = buildChannelRequest(
      newForm({ rps: "3", headers: [{ name: " User-Agent ", value: " ua " }] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    // 不带 key：渠道 key 由后端生成
    expect(result.create).toEqual({
      name: "我的渠道",
      base_url: "https://api.example.com",
      headers: { "User-Agent": "ua" },
      rate_limit: { rps: 3, max_concurrency: 0, max_running: 0 },
      enabled: true,
    });
  });

  test("名称、地址、请求头、限流错误一次报出", () => {
    const result = buildChannelRequest(
      newForm({
        name: "  ",
        baseUrl: "",
        rps: "-1",
        maxConcurrency: "1.5",
        maxRunning: "x",
        headers: [{ name: "Cookie", value: "v" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      ["baseUrl", "headers.0", "maxConcurrency", "maxRunning", "name", "rps"].sort(),
    );
  });
});

describe("buildChannelRequest（编辑）", () => {
  test("没改动：changed=false，update 为空", () => {
    const original = view();
    const result = buildChannelRequest(channelFormFromView(original), original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.update).toEqual({});
  });

  test("只带改过的字段", () => {
    const original = view();
    const form = { ...channelFormFromView(original), name: "新名字", enabled: false };
    const result = buildChannelRequest(form, original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update).toEqual({ name: "新名字", enabled: false });
  });

  test("请求头整体替换：改值、增删、清空都算变化；顺序不同不算", () => {
    const original = view({ headers: { A: "1", B: "2" } });
    const reordered = buildChannelRequest(
      {
        ...channelFormFromView(original),
        headers: [
          { name: "B", value: "2" },
          { name: "A", value: "1" },
        ],
      },
      original,
    );
    expect(reordered.ok && reordered.changed).toBe(false);

    const cleared = buildChannelRequest(
      { ...channelFormFromView(original), headers: [] },
      original,
    );
    expect(cleared.ok && cleared.update).toEqual({ headers: {} });

    const changed = buildChannelRequest(
      { ...channelFormFromView(original), headers: [{ name: "A", value: "9" }] },
      original,
    );
    expect(changed.ok && changed.update).toEqual({ headers: { A: "9" } });
  });

  test("限流整体替换：任一维度变了就带全部三个", () => {
    const original = view();
    const result = buildChannelRequest(
      { ...channelFormFromView(original), maxRunning: "4" },
      original,
    );
    expect(result.ok && result.update).toEqual({
      rate_limit: { rps: 5, max_concurrency: 0, max_running: 4 },
    });
  });

  test("编辑的 update 不含 key（渠道 key 创建后不可改）", () => {
    const original = view();
    const result = buildChannelRequest({ ...channelFormFromView(original), name: "x" }, original);
    expect(result.ok && "key" in result.update).toBe(false);
  });
});

describe("formatRateLimit", () => {
  test("没有任何限流写“不限”", () => {
    expect(formatRateLimit(null)).toBe("不限");
    expect(formatRateLimit({})).toBe("不限");
    expect(formatRateLimit({ rps: 0, max_concurrency: 0, max_running: 0 })).toBe("不限");
  });

  test("有任一限流就三项都写，没设的显示不限", () => {
    expect(formatRateLimit({ rps: 5, max_running: 3 })).toBe("rps 5 · 并发 不限 · 同时生成 3");
  });
});

describe("formatLoad", () => {
  test("生成中 / 上限 + 排队", () => {
    expect(formatLoad({ channel: "a", running: 2, waiting: 5 }, 4)).toBe("生成中 2/4 · 排队 5");
  });

  test("没有负载记录算空闲 0；上限为 0 或缺省写不限", () => {
    expect(formatLoad(undefined, 4)).toBe("生成中 0/4 · 排队 0");
    expect(formatLoad({ channel: "a", running: 1, waiting: 0 }, 0)).toBe("生成中 1/不限 · 排队 0");
    expect(formatLoad(undefined, undefined)).toBe("生成中 0/不限 · 排队 0");
  });
});

describe("虚拟人像库配置", () => {
  const official = "https://ark.cn-beijing.volces.com/api/v3";
  const filing = {
    enabled: true,
    group_id: "group-1",
    project_name: "",
    site: "cn-beijing",
    access_key_set: true,
    secret_key_set: true,
  };

  test("视图 → 表单：带上虚拟人像库；旧后端没有 filing 时按未启用", () => {
    const form = channelFormFromView(view({ filing }));
    expect(form.filingEnabled).toBe(true);
    expect(form.filingGroupId).toBe("group-1");
    expect(form.filingProjectName).toBe("");
    expect(channelFormFromView(view()).filingEnabled).toBe(false);
  });

  test("没改虚拟人像库时不带 filing；改了就整体带上（去首尾空白）", () => {
    const original = view({ filing, base_url: official });
    expect(buildChannelRequest(channelFormFromView(original), original)).toMatchObject({
      ok: true,
      changed: false,
    });
    const result = buildChannelRequest(
      { ...channelFormFromView(original), filingGroupId: " group-2 ", filingProjectName: " p " },
      original,
    );
    expect(result.ok && result.update.filing).toEqual({
      enabled: true,
      group_id: "group-2",
      project_name: "p",
    });
  });

  test("启用时素材组 ID 必填；关闭时不校验", () => {
    const original = view({
      base_url: official,
      filing: { ...filing, enabled: false, group_id: "" },
    });
    const on = buildChannelRequest(
      { ...channelFormFromView(original), filingEnabled: true },
      original,
    );
    expect(on.ok).toBe(false);
    expect(!on.ok && on.errors.filingGroupId).toBe("启用虚拟人像库时必须填写素材组 ID");
    const off = buildChannelRequest(channelFormFromView(original), original);
    expect(off.ok).toBe(true);
  });

  test("非官方地址的渠道不能启用；关闭不受限", () => {
    const original = view({ filing: { ...filing, enabled: false, group_id: "" } }); // api.openai.com
    const on = buildChannelRequest(
      { ...channelFormFromView(original), filingEnabled: true, filingGroupId: "g" },
      original,
    );
    expect(on.ok).toBe(false);
    expect(!on.ok && on.errors.baseUrl).toBe(
      "虚拟人像库只支持方舟 / BytePlus 官方地址（ark.cn-beijing.volces.com、ark.ap-southeast.bytepluses.com）",
    );
    expect(buildChannelRequest(channelFormFromView(original), original).ok).toBe(true);
    // 同时把地址改成官方域名就能过
    const fixed = buildChannelRequest(
      {
        ...channelFormFromView(original),
        baseUrl: official,
        filingEnabled: true,
        filingGroupId: "g",
      },
      original,
    );
    expect(fixed.ok).toBe(true);
  });

  test("新建渠道不带 filing（虚拟人像库在编辑时配置）", () => {
    const result = buildChannelRequest(newForm({ filingEnabled: true, filingGroupId: "g" }));
    expect(result.ok && "filing" in result.create).toBe(false);
  });
});

describe("filingSiteOf：备案站点", () => {
  test("域名带 byteplus 是国际站，其余按国内站", () => {
    expect(filingSiteOf("https://ark.cn-beijing.volces.com/api/v3")).toBe("cn-beijing");
    expect(filingSiteOf("https://ark.ap-southeast.bytepluses.com/api/v3")).toBe("ap-southeast-1");
    expect(filingSiteOf("ark.byteplus")).toBe("ap-southeast-1");
    expect(filingSiteOf("")).toBe("cn-beijing");
  });
});

describe("isOfficialFilingHost：方舟 / BytePlus 官方域名", () => {
  test("只认两个官方推理域名，整个域名相等，忽略大小写和端口", () => {
    expect(isOfficialFilingHost("https://ark.cn-beijing.volces.com/api/v3")).toBe(true);
    expect(isOfficialFilingHost(" https://ARK.AP-SOUTHEAST.BYTEPLUSES.COM ")).toBe(true);
    expect(isOfficialFilingHost("https://ark.cn-beijing.volces.com:443")).toBe(true);
    expect(isOfficialFilingHost("https://gw.example.com")).toBe(false);
    expect(isOfficialFilingHost("https://ark.cn-beijing.volces.com.evil.example.com")).toBe(false);
    expect(isOfficialFilingHost("https://example.com/ark.cn-beijing.volces.com")).toBe(false);
    expect(isOfficialFilingHost("ark.byteplus")).toBe(false);
    expect(isOfficialFilingHost("")).toBe(false);
  });
});

describe("showFilingSwitch：何时显示虚拟人像库开关", () => {
  test("官方地址显示；非官方地址隐藏，但已启用的要留着，免得关不掉", () => {
    expect(showFilingSwitch("https://ark.cn-beijing.volces.com/api/v3", false)).toBe(true);
    expect(showFilingSwitch("https://gw.example.com", false)).toBe(false);
    expect(showFilingSwitch("https://gw.example.com", true)).toBe(true);
  });
});

describe("公开素材资源域（voice_scope）", () => {
  test("新建：选了才带上，留空不传（后端按 Base URL 推断）", () => {
    const picked = buildChannelRequest(newForm({ voiceScope: "ark-cn" }));
    expect(picked.ok && picked.create.voice_scope).toBe("ark-cn");

    const auto = buildChannelRequest(newForm());
    expect(auto.ok && "voice_scope" in auto.create).toBe(false);
  });

  test("编辑：改值只带 voice_scope", () => {
    const original = view({ voice_scope: "ark-cn" });
    const result = buildChannelRequest(
      { ...channelFormFromView(original), voiceScope: "byteplus" },
      original,
    );
    expect(result.ok && result.changed).toBe(true);
    expect(result.ok && result.update).toEqual({ voice_scope: "byteplus" });
  });

  test("编辑：空串是有效改动（改回按 Base URL 推断）", () => {
    const original = view({ voice_scope: "byteplus" });
    const result = buildChannelRequest(
      { ...channelFormFromView(original), voiceScope: "" },
      original,
    );
    expect(result.ok && result.update).toEqual({ voice_scope: "" });
  });

  test("编辑：没动就不带", () => {
    const original = view({ voice_scope: "byteplus" });
    const result = buildChannelRequest(channelFormFromView(original), original);
    expect(result.ok && result.changed).toBe(false);
    expect(result.ok && result.update).toEqual({});
  });
});
