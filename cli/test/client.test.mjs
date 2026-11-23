import assert from "node:assert/strict";
import test from "node:test";

import { APIError, normalizeBase, request, siteRootOf } from "../src/client.mjs";
import { parseArgs } from "../src/commands.mjs";

test("normalizeBase：只给站点根时补 /api/v1，末尾斜杠去掉", () => {
  assert.equal(normalizeBase("https://example.com"), "https://example.com/api/v1");
  assert.equal(normalizeBase("https://example.com/"), "https://example.com/api/v1");
  assert.equal(normalizeBase("https://example.com/api/v1/"), "https://example.com/api/v1");
});

test("normalizeBase：拒绝空值与非 http 地址", () => {
  assert.throws(() => normalizeBase(""), APIError);
  assert.throws(() => normalizeBase("example.com"), APIError);
  assert.throws(() => normalizeBase("ftp://example.com"), APIError);
});

test("siteRootOf 与 normalizeBase 互逆", () => {
  assert.equal(siteRootOf(normalizeBase("https://example.com")), "https://example.com");
});

test("parseArgs：带值与布尔开关、= 写法都识别", () => {
  const { positional, flags } = parseArgs([
    "get",
    "abc",
    "--json",
    "--page-size=20",
    "--title",
    "标题",
  ]);
  assert.deepEqual(positional, ["get", "abc"]);
  assert.equal(flags.json, true);
  assert.equal(flags["page-size"], "20");
  assert.equal(flags.title, "标题");
});

test("request：成功时返回 data", async () => {
  const fake = async () =>
    new Response(JSON.stringify({ code: 0, msg: "success", data: { id: "x" } }), { status: 200 });
  const data = await request({ base: "https://h/api/v1", path: "/canvas", fetchImpl: fake });
  assert.deepEqual(data, { id: "x" });
});

test("request：code 非 0 时抛 APIError，带后端文案", async () => {
  const fake = async () =>
    new Response(JSON.stringify({ code: 30001, msg: "画布不存在" }), { status: 404 });
  await assert.rejects(
    () => request({ base: "https://h/api/v1", path: "/canvas/x", fetchImpl: fake }),
    (err) => err instanceof APIError && err.code === 30001 && err.message === "画布不存在",
  );
});

test("request：401 提示重新登录", async () => {
  const fake = async () => new Response(JSON.stringify({ code: 20003, msg: "x" }), { status: 401 });
  await assert.rejects(
    () => request({ base: "https://h/api/v1", path: "/me", fetchImpl: fake }),
    (err) => err instanceof APIError && /重新执行/.test(err.message),
  );
});

test("request：查询参数拼进 URL", async () => {
  let seen = "";
  const fake = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 });
  };
  await request({
    base: "https://h/api/v1",
    path: "/canvas",
    query: { page: 2, empty: "" },
    fetchImpl: fake,
  });
  assert.match(seen, /page=2/);
  assert.doesNotMatch(seen, /empty=/);
});
