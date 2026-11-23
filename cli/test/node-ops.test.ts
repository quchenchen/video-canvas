import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Canvas } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "dist", "cli.js");

/** 假站点收到的请求体（结构随用例变化，测试里按需断言）。 */
type PostBody = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface FakeSite {
  canvas: Canvas;
  posts: PostBody[];
  base: string;
  close(): Promise<void>;
}

/**
 * 起一个只会干两件事的假服务：读画布、收节点级改动。
 * 用真实 HTTP，是为了验证 CLI 发的请求体（ops / revision / deleteNodeIds）真的对。
 */
async function fakeSite(): Promise<FakeSite> {
  const state: FakeSite = {
    canvas: {} as Canvas,
    posts: [],
    base: "",
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown, status = 200): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && /^\/api\/v1\/canvas\/[^/]+$/.test(url.pathname)) {
      return send({ code: 0, data: state.canvas });
    }
    if (req.method === "POST" && url.pathname.endsWith("/ops")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        state.posts.push(JSON.parse(raw) as PostBody);
        send({
          code: 0,
          data: {
            revision: 4,
            changes: [
              { kind: "node", op: "create", id: "n_new", after: { "data.label": "新旁白" } },
            ],
            id_map: { n1: "n_new" },
          },
        });
      });
      return undefined;
    }
    return send({ code: 404, msg: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  state.base = `http://127.0.0.1:${port}`;
  // fetch 会复用 keep-alive 连接；不主动断开的话 server.close 等不到回调，测试进程会挂住。
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  state.canvas = {
    id: "c1",
    title: "测试画布",
    revision: 3,
    payload_json: {
      nodes: [
        { id: "n_s", type: "canvas", data: { kind: "script", label: "旧旁白", text: "旧内容" } },
        { id: "n_v", type: "canvas", data: { kind: "video", label: "镜头1" } },
      ],
      edges: [{ id: "e1", source: "n_v", target: "n_s" }],
    },
  };
  return state;
}

/** 独立配置目录里塞一份指向假服务的凭据，不碰真实登录态。 */
function tempConfig(base: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-node-"));
  fs.mkdirSync(path.join(dir, "video-canvas"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "video-canvas", "credentials.json"),
    JSON.stringify({ base: `${base}/api/v1`, token: "t", role: "user" }),
  );
  return dir;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>): RunResult {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, VC_NO_UPDATE_CHECK: "1", ...env },
    input: "",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 用伪终端跑一次，模拟真人敲 yes/no；没有 python3 就跳过（pty 只有它能造）。 */
function runInPty(
  args: string[],
  env: Record<string, string>,
  input: string,
): Promise<{ code: number | null; out: string }> {
  const helper = path.join(here, "helpers", "pty_run.py");
  // 必须异步：假服务跑在本进程里，spawnSync 会把事件循环卡住，HTTP 请求永远等不到响应。
  return new Promise((resolve) => {
    const child = spawn("python3", [helper, process.execPath, bin, ...args], {
      env: { ...process.env, VC_NO_UPDATE_CHECK: "1", PTY_INPUT: input, ...env },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const hasPty = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0;

test("节点级修改：非交互终端直接拒绝，且不发出请求", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stderr } = run(
      ["canvas", "node", "add", "c1", "--kind", "script", "--text", "x"],
      env,
    );
    assert.equal(code, 2);
    assert.match(stderr, /需要交互确认/);
    assert.equal(site.posts.length, 0, "拒绝时不能发请求");
  } finally {
    await site.close();
  }
});

test("节点级修改：--json 一律拒绝（没有脚本旁路）", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stdout } = run(["canvas", "node", "rm", "c1", "n_v", "--json"], env);
    assert.equal(code, 2);
    // --json 下错误走 stdout 的单行 JSON（stdout 只放一种内容），所以断言这里
    assert.match(stdout, /不能与 --json 一起用/);
    assert.equal(site.posts.length, 0);
  } finally {
    await site.close();
  }
});

test("节点级修改：种类与字段不匹配时先报用法错误", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const bad = run(["canvas", "node", "add", "c1", "--kind", "storyboard"], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /要在画面上创建/);

    const wrongFlag = run(["canvas", "node", "add", "c1", "--kind", "image", "--text", "x"], env);
    assert.equal(wrongFlag.code, 2);
    assert.match(wrongFlag.stderr, /--prompt/);
    assert.equal(site.posts.length, 0);
  } finally {
    await site.close();
  }
});

test(
  "节点级修改：终端里输入 yes 才提交，并带上刚才读到的 revision",
  { skip: !hasPty && "需要 python3 造 pty" },
  async () => {
    const site = await fakeSite();
    try {
      const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
      const { code, out } = await runInPty(
        [
          "canvas",
          "node",
          "add",
          "c1",
          "--kind",
          "script",
          "--label",
          "新旁白",
          "--text",
          "第一句",
        ],
        env,
        "yes",
      );
      assert.equal(code, 0);
      assert.match(out, /已保存，版本 4/);
      assert.equal(site.posts.length, 1);
      const body = site.posts[0] as PostBody;
      assert.equal(body.revision, 3, "必须用确认时看到的版本提交");
      assert.equal(body.ops[0].op, "create_node");
      assert.equal(body.ops[0].kind, "script");
      assert.equal(body.ops[0].prompt, "第一句", "文本正文走 prompt 字段交给服务端写 data.text");
    } finally {
      await site.close();
    }
  },
);

test(
  "节点级修改：输入别的就取消，画布一个字节都不改",
  { skip: !hasPty && "需要 python3 造 pty" },
  async () => {
    const site = await fakeSite();
    try {
      const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
      const { code } = await runInPty(["canvas", "node", "rm", "c1", "n_v"], env, "no");
      assert.equal(code, 4);
      assert.equal(site.posts.length, 0);
    } finally {
      await site.close();
    }
  },
);

test(
  "节点级修改：删除会先算清连带删除的连线与引用",
  { skip: !hasPty && "需要 python3 造 pty" },
  async () => {
    const site = await fakeSite();
    try {
      site.canvas.payload_json?.nodes?.push({
        id: "n_sb",
        type: "canvas",
        data: { kind: "storyboard", storyboard: { shots: [{ scene: "a", videoNodeId: "n_v" }] } },
      });
      const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
      const { out } = await runInPty(["canvas", "node", "rm", "c1", "n_v"], env, "yes");
      assert.match(out, /同时删除 1 条连线/);
      assert.match(out, /同时清掉 1 处分镜 \/ 成片引用/);
      assert.deepEqual((site.posts[0] as PostBody).deleteNodeIds, ["n_v"]);
    } finally {
      await site.close();
    }
  },
);
