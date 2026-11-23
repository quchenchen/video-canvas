import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APIError } from "../src/client.ts";
import { parseArgs, stringFlag, toInt } from "../src/commands.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// 测的是构建产物：用户装到的就是 dist/cli.js
const bin = path.join(here, "..", "dist", "cli.js");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一次 CLI，返回退出码与两个流；不抛异常，方便断言错误路径。 */
function run(args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, VC_NO_UPDATE_CHECK: "1", ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * 异步版：本地假服务需要和 CLI 并发跑，spawnSync 会卡住事件循环。
 */
function runAsync(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { encoding: "utf8", env: { ...process.env, VC_NO_UPDATE_CHECK: "1", ...env } },
      (err, stdout, stderr) =>
        resolve({
          code: err ? Number(err.code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });
}

/** 起一个只回固定任务的假服务，避免测试碰真站点、烧积分。 */
async function startTaskServer(task: Record<string, unknown>): Promise<{
  server: http.Server;
  base: string;
}> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, msg: "success", data: task }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** 隔离的凭据目录，base 指向必然连不上的本地端口——只测参数与本地校验，不发真请求。 */
function tempConfig(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-cli-test-"));
  const dir = path.join(root, "video-canvas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ base: "http://127.0.0.1:1/api/v1", token: "test-token" }),
  );
  return root;
}

test("parseArgs：-o 映射到 --output，且 - 当成值", () => {
  assert.equal(parseArgs(["-o", "/tmp/x.json"]).flags.output, "/tmp/x.json");
  assert.equal(parseArgs(["-o", "-"]).flags.output, "-");
  assert.equal(parseArgs(["-o"]).flags.output, true);
});

test("parseArgs：负数当参数值，不当开关", () => {
  assert.equal(parseArgs(["--page-size", "-1"]).flags["page-size"], "-1");
  assert.equal(parseArgs(["--revision", "-3"]).flags.revision, "-3");
});

test("parseArgs：--json=true 与 --json 等价", () => {
  assert.equal(parseArgs(["--json=true"]).flags.json, "true");
});

test("parseArgs：未登记的短选项原样留给 positional（trace 透传）", () => {
  const { positional } = parseArgs(["pull", "-n", "5"]);
  assert.deepEqual(positional, ["pull", "-n", "5"]);
});

test("toInt：非数字、布尔、小数、越界都算用法错误", () => {
  const badValues: Array<string | true> = ["abc", true, "1.5", "0", "-1"];
  for (const bad of badValues) {
    assert.throws(
      () => toInt(bad, "timeout", { max: 86400 }),
      (err: unknown) => err instanceof APIError && err.status === 2,
    );
  }
  assert.equal(toInt("600", "timeout", { max: 86400 }), 600);
  // 数字也认：内部调用会直接给 number
  assert.equal(toInt(30, "interval", { max: 3600 }), 30);
});

test("stringFlag：没给值或只写开关名时明确报错", () => {
  assert.throws(
    () => stringFlag({}, "payload", "用法"),
    (err: unknown) => err instanceof APIError && err.status === 2,
  );
  assert.throws(
    () => stringFlag({ payload: true }, "payload", "用法"),
    (err: unknown) => err instanceof APIError && err.status === 2,
  );
  assert.equal(stringFlag({ payload: "a.json" }, "payload", "用法"), "a.json");
});

test("--base 少了协议：报原始错误，而不是「无法连接 null」", () => {
  const { code, stderr } = run(["whoami", "--base", "example.com"], {
    XDG_CONFIG_HOME: tempConfig(),
  });
  assert.equal(code, 2);
  assert.match(stderr, /必须以 http:\/\/ 或 https:\/\//);
  assert.doesNotMatch(stderr, /无法连接 null/);
});

test("canvas export 的 --output - 与 --json 互斥", () => {
  const { code, stdout } = run(["canvas", "export", "abc", "--output", "-", "--json"], {
    XDG_CONFIG_HOME: tempConfig(),
  });
  assert.equal(code, 2);
  // --json 模式下错误信封走 stdout，这是既定契约
  assert.match(stdout, /冲突/);
});

test("canvas save 拒绝把 canvas export 的导出文档当 payload", () => {
  const root = tempConfig();
  const file = path.join(root, "export.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      format: "video-canvas/canvas",
      version: 1,
      canvas: { nodes: [], edges: [] },
      assets: {},
    }),
  );
  const { code, stderr } = run(["canvas", "save", "abc", "--payload", file], {
    XDG_CONFIG_HOME: root,
  });
  assert.equal(code, 2);
  assert.match(stderr, /canvas import/);
});

test("task wait：--timeout 非法值报用法错误，不静默退回 600", () => {
  const { code, stderr } = run(["task", "wait", "123", "--timeout", "abc"], {
    XDG_CONFIG_HOME: tempConfig(),
  });
  assert.equal(code, 2);
  assert.match(stderr, /--timeout/);
});

test("trace：--script 指到不存在的文件时给出明确路径", () => {
  const { code, stderr } = run(["trace", "show", "x", "--script", "/nonexistent/agent-trace.mjs"], {
    XDG_CONFIG_HOME: tempConfig(),
  });
  assert.equal(code, 2);
  assert.match(stderr, /找不到 agent-trace/);
  assert.match(stderr, /nonexistent/);
});

test("task wait 等待超时：退出码 3，JSON 为 ok:false，且不冒充任务失败", async () => {
  const { server, base } = await startTaskServer({ id: 1, status: "pending", progress: 10 });
  try {
    const { code, stdout } = await runAsync(
      ["task", "wait", "1", "--timeout", "1", "--interval", "1", "--json"],
      { XDG_CONFIG_HOME: tempConfig(), VC_API_BASE: base },
    );
    assert.equal(code, 3);
    assert.match(stdout, /"ok":false/);
    assert.match(stdout, /超时/);
  } finally {
    server.close();
  }
});

test("task wait 到失败终态：JSON 为 ok:false 且退出码 1", async () => {
  const { server, base } = await startTaskServer({
    id: 2,
    status: "failed",
    error_code: "upstream_full",
    error_message: "video queue is full",
  });
  try {
    const { code, stdout } = await runAsync(["task", "wait", "2", "--json"], {
      XDG_CONFIG_HOME: tempConfig(),
      VC_API_BASE: base,
    });
    assert.equal(code, 1);
    const body = JSON.parse(stdout.trim()) as {
      ok: boolean;
      error: { message: string };
      data: { status: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.error.message, "video queue is full");
    assert.equal(body.data.status, "failed");
  } finally {
    server.close();
  }
});

test("task wait 到成功终态：JSON 为 ok:true 且退出码 0", async () => {
  const { server, base } = await startTaskServer({ id: 3, status: "succeeded", progress: 100 });
  try {
    const { code, stdout } = await runAsync(["task", "wait", "3", "--json"], {
      XDG_CONFIG_HOME: tempConfig(),
      VC_API_BASE: base,
    });
    assert.equal(code, 0);
    assert.equal((JSON.parse(stdout.trim()) as { ok: boolean }).ok, true);
  } finally {
    server.close();
  }
});
