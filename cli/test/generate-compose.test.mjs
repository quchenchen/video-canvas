import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 生成 / 合成 / 短剧三类命令的请求体与输出：用真实 HTTP 的假站点，
// 断言的是「CLI 实际发了什么」，而不是「代码看起来像是对的」。

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "vc.mjs");

const MODELS = [
  {
    key: "agnes-image",
    kind: "image",
    label: "Agnes 图片",
    hint: "通用出图",
    capabilities: {
      ops: ["text2image"],
      // 接口里 params 是「名字 -> 字段」的对象，键序就是画布参数面板的顺序
      params: { ratio: { type: "enum", options: ["1:1", "16:9"], label: "画幅" } },
    },
  },
  {
    key: "agnes-video",
    kind: "video",
    label: "Agnes 视频",
    hint: "",
    capabilities: {
      ops: ["text2video"],
      params: { duration: { type: "number", min: 1, max: 10, label: "时长" } },
    },
  },
];

async function fakeSite() {
  const state = { posts: [], headers: [], polls: 0, task: null, compose: null };
  const send = (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/v1/models") {
      const kind = url.searchParams.get("kind");
      return send(res, { code: 0, data: kind ? MODELS.filter((m) => m.kind === kind) : MODELS });
    }
    if (req.method === "GET" && p === "/api/v1/credits") {
      return send(res, { code: 0, data: { balance: 120, frozen: 20, available: 100 } });
    }
    if (req.method === "POST" && p === "/api/v1/generation-tasks") {
      const body = await readBody(req);
      state.posts.push(body);
      state.headers.push({ idempotency: req.headers["idempotency-key"] });
      const count = (body.node_ids || [body.node_id]).filter(Boolean).length || 1;
      const items = Array.from({ length: count }, (_, i) => ({
        node_id: body.node_id || "",
        task: {
          id: 500 + i,
          task_ref: `t${500 + i}`,
          status: "queued",
          kind: body.kind,
          model_id: body.model_id,
          credits: 5,
          progress: 0,
        },
      }));
      return send(res, { code: 0, data: { items } }, 202);
    }
    if (req.method === "GET" && /^\/api\/v1\/generation-tasks\/\d+$/.test(p)) {
      state.polls++;
      return send(res, { code: 0, data: state.task });
    }
    if (req.method === "GET" && /^\/api\/v1\/canvas\/[^/]+$/.test(p)) {
      return send(res, {
        code: 0,
        data: { id: "c1", title: "成片测试", revision: 2, payload_json: GRAPH },
      });
    }
    if (req.method === "POST" && /^\/api\/v1\/canvas\/[^/]+\/compose$/.test(p)) {
      state.posts.push(await readBody(req));
      return send(res, {
        code: 0,
        data: {
          id: "job1",
          canvas_id: "c1",
          node_id: "c_node",
          status: "queued",
          fingerprint: "f",
          duration_ms: 0,
          segment_count: 2,
        },
      });
    }
    if (req.method === "GET" && /^\/api\/v1\/canvas\/[^/]+\/compose\/[^/]+$/.test(p)) {
      return send(res, { code: 0, data: state.compose });
    }
    if (req.method === "GET" && p === "/api/v1/dramas") {
      return send(res, {
        code: 0,
        data: {
          list: [
            {
              id: "d1",
              title: "雪夜归途",
              status: "planning",
              phase: "running",
              episode_count: 12,
              locked_count: 3,
              updated_at: "2026-11-23T10:00:00Z",
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        },
      });
    }
    if (req.method === "GET" && p === "/api/v1/dramas/d1") {
      return send(res, {
        code: 0,
        data: {
          id: "d1",
          title: "雪夜归途",
          status: "planning",
          phase: "done",
          canvas_id: "c9",
          source_chars: 5200,
          units_total: 40,
          unit_kind: "scene",
          target_episodes: 12,
          episode_seconds: 60,
          ratio: "9:16",
          // 12 集：默认只列前 10 集，验证不会把整季刷满终端
          episodes: Array.from({ length: 12 }, (_, i) => ({
            no: i + 1,
            title: `第${i + 1}集`,
            unit_from: i + 1,
            unit_to: i + 1,
            script_status: "draft",
          })),
        },
      });
    }
    if (req.method === "GET" && p === "/api/v1/dramas/d1/units") {
      // 真实接口把列表包在 items 里，不是裸数组；按裸数组解析会得到「(没有单元)」
      return send(res, {
        code: 0,
        data: {
          items: [
            { no: 1, title: "开场", chars: 420 },
            { no: 2, title: "冲突", chars: 380 },
          ],
        },
      });
    }
    if (req.method === "GET" && p === "/api/v1/dramas/d1/units/1") {
      return send(res, {
        code: 0,
        data: { no: 1, title: "开场", text: "雪夜里，她推开了那扇门。" },
      });
    }
    if (req.method === "GET" && p === "/api/v1/dramas/d1/jobs") {
      return send(res, {
        code: 0,
        data: {
          items: [
            {
              id: "j1",
              step: "plan",
              status: "running",
              progress: 40,
              episodes: Array.from({ length: 96 }, (_, i) => i + 1),
              lane: "plan",
              credits: 3,
            },
          ],
        },
      });
    }
    if (req.method === "POST" && p === "/api/v1/dramas/d1/jobs/j1/cancel") {
      return send(res, {
        code: 0,
        data: {
          id: "j1",
          step: "plan",
          status: "canceled",
          progress: 40,
          episodes: [1],
          credits: 3,
        },
      });
    }
    return send(res, { code: 404, msg: "not found" }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
  return state;
}

// 成片节点连了三个上游：两个视频（v1 在 v2 上面）与一个图片；composeOrder 把 v2 提到前面，
// v1 走 activeOutputId → outputs 里那一版（111），而不是老字段 assetId（101）。
const GRAPH = {
  nodes: [
    {
      id: "v1",
      type: "canvas",
      position: { x: 0, y: 100 },
      data: {
        kind: "video",
        label: "镜头1",
        assetId: "101",
        activeOutputId: "o1",
        outputs: [{ id: "o1", assetId: "111" }],
      },
    },
    {
      id: "v2",
      type: "canvas",
      position: { x: 0, y: 200 },
      data: { kind: "video", label: "镜头2", assetId: "202" },
    },
    {
      id: "img",
      type: "canvas",
      position: { x: 0, y: 50 },
      data: { kind: "image", label: "首图", assetId: "900" },
    },
    {
      id: "c_node",
      type: "canvas",
      position: { x: 300, y: 100 },
      data: { kind: "compose", label: "成片", composeOrder: ["v2"] },
    },
  ],
  edges: [
    { id: "e1", source: "v1", target: "c_node" },
    { id: "e2", source: "v2", target: "c_node" },
    { id: "e3", source: "img", target: "c_node" },
  ],
};

function tempConfig(base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-gen-"));
  fs.mkdirSync(path.join(dir, "video-canvas"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "video-canvas", "credentials.json"),
    JSON.stringify({ base: `${base}/api/v1`, token: "t", role: "user" }),
  );
  return dir;
}

/** 一律异步：假服务跑在本进程里，spawnSync 会把事件循环卡住，请求永远等不到响应。 */
function run(args, env) {
  return runAsync(args, env);
}

/** 要等终态的命令必须异步跑：假服务在本进程里，spawnSync 会把事件循环卡死。 */
function runAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, VC_NO_UPDATE_CHECK: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("model list：按种类过滤并打印表头", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const all = await run(["model", "list"], env);
    assert.equal(all.code, 0);
    assert.match(all.stdout, /^KEY\tKIND\tLABEL/m);
    assert.match(all.stdout, /agnes-image/);
    assert.match(all.stdout, /agnes-video/);

    const onlyVideo = await run(["model", "list", "--kind", "video", "--json"], env);
    const body = JSON.parse(onlyVideo.stdout);
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.data.map((m) => m.key),
      ["agnes-video"],
    );
  } finally {
    await site.close();
  }
});

test("model show：打印参数可选值与范围，找不到时给出相近项", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const ok = await run(["model", "show", "agnes-image"], env);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /参数 ratio/);
    assert.match(ok.stdout, /1:1 \/ 16:9/);

    const miss = await run(["model", "show", "agnes-imag"], env);
    assert.equal(miss.code, 1);
    assert.match(miss.stderr, /相近的有：agnes-image/);
  } finally {
    await site.close();
  }
});

test("credits：三行数值一眼看清", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stdout } = await run(["credits"], env);
    assert.equal(code, 0);
    assert.match(stdout, /余额 120\s+冻结 20\s+可用 100/);
  } finally {
    await site.close();
  }
});

test("generate：prompt / param / 参考素材合成 input，count 落成 node_ids，带幂等键", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stdout } = await run(
      [
        "generate",
        "video",
        "--model",
        "agnes-video",
        "--canvas",
        "c1",
        "--node",
        "n1",
        "--prompt",
        "海边日出",
        "--param",
        "duration=5",
        "--param",
        "motion=strong",
        "--ref-image",
        "101,102",
        "--count",
        "2",
      ],
      env,
    );
    assert.equal(code, 0, stdout);
    assert.equal(site.posts.length, 1);
    const body = site.posts[0];
    assert.equal(body.kind, "video");
    assert.equal(body.model_id, "agnes-video");
    assert.equal(body.canvas_id, "c1");
    assert.deepEqual(body.node_ids, ["n1", "n1"]);
    assert.equal(body.input.prompt, "海边日出");
    assert.equal(body.input.duration, 5, "数字参数要按 JSON 解释成数字");
    assert.equal(body.input.motion, "strong", "解析不出来的按字符串");
    assert.deepEqual(body.input.images, ["101", "102"]);
    assert.ok(site.headers[0].idempotency, "必须带 Idempotency-Key");
    assert.match(stdout, /任务 t500/);
    assert.match(stdout, /冻结 5 积分/);
  } finally {
    await site.close();
  }
});

test("generate：参数不足与半截参数给用法错误，且不发请求", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const noKind = await run(["generate", "--model", "agnes-video"], env);
    assert.equal(noKind.code, 2);
    assert.match(noKind.stderr, /第一项要写生成种类/);

    const noInput = await run(
      ["generate", "video", "--model", "agnes-video", "--canvas", "c1", "--node", "n1"],
      env,
    );
    assert.equal(noInput.code, 2);
    assert.match(noInput.stderr, /至少要给一个生成参数/);

    const half = await run(["generate", "video", "--model", "agnes-video", "--canvas", "c1"], env);
    assert.equal(half.code, 2);
    assert.match(half.stderr, /--canvas 与 --node 要一起给/);

    const badRef = await run(
      ["generate", "image", "--model", "agnes-image", "--prompt", "x", "--ref-image", "abc"],
      env,
    );
    assert.equal(badRef.code, 2);
    assert.match(badRef.stderr, /要素材 id/);
    assert.equal(site.posts.length, 0);
  } finally {
    await site.close();
  }
});

test("generate --wait：成功时打印产物地址，退出码 0", async () => {
  const site = await fakeSite();
  try {
    site.task = {
      id: 500,
      task_ref: "t500",
      status: "succeeded",
      kind: "video",
      model_id: "agnes-video",
      credits: 5,
      progress: 100,
      outputs: [{ url: "https://cdn.test/a.mp4" }],
    };
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stdout } = await runAsync(
      ["generate", "video", "--model", "agnes-video", "--prompt", "x", "--wait", "--interval", "1"],
      env,
    );
    assert.equal(code, 0, stdout);
    assert.match(stdout, /https:\/\/cdn\.test\/a\.mp4/);
    assert.ok(site.polls >= 1);
  } finally {
    await site.close();
  }
});

test("generate --wait：任务失败时 ok:false 且退出码 1", async () => {
  const site = await fakeSite();
  try {
    site.task = {
      id: 500,
      task_ref: "t500",
      status: "failed",
      kind: "video",
      model_id: "agnes-video",
      credits: 5,
      progress: 100,
      error_code: 30001,
      error_message: "上游超时",
    };
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stdout } = await runAsync(
      [
        "generate",
        "video",
        "--model",
        "agnes-video",
        "--prompt",
        "x",
        "--wait",
        "--interval",
        "1",
        "--json",
      ],
      env,
    );
    assert.equal(code, 1);
    const body = JSON.parse(stdout);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /上游超时/);
  } finally {
    await site.close();
  }
});

test("canvas compose：不给 --assets 时按 composeOrder + 位置推导，并把顺序打出来", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stdout } = await run(["canvas", "compose", "c1", "--node", "c_node"], env);
    assert.equal(code, 0, stdout);
    const body = site.posts.find((item) => Array.isArray(item.asset_ids));
    assert.deepEqual(
      body.asset_ids,
      ["202", "111"],
      "composeOrder 先，其余按位置；v1 取 activeOutputId 那一版",
    );
    assert.equal(body.node_id, "c_node");
    assert.match(stdout, /SEQ\tASSET\tNODE\tLABEL/);
    assert.match(stdout, /job1/);
  } finally {
    await site.close();
  }
});

test("canvas compose：显式 --assets 优先，不再读画布", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code } = await run(
      [
        "canvas",
        "compose",
        "c1",
        "--node",
        "c_node",
        "--assets",
        "7,8",
        "--seqs",
        "0,1",
        "--mode",
        "storyboard",
      ],
      env,
    );
    assert.equal(code, 0);
    const body = site.posts.find((item) => Array.isArray(item.asset_ids));
    assert.deepEqual(body.asset_ids, ["7", "8"]);
    assert.deepEqual(body.seqs, [0, 1]);
    assert.equal(body.mode, "storyboard");
  } finally {
    await site.close();
  }
});

test("canvas compose --wait：合成成功后打印成片地址", async () => {
  const site = await fakeSite();
  try {
    site.compose = {
      id: "job1",
      canvas_id: "c1",
      node_id: "c_node",
      status: "succeeded",
      fingerprint: "f",
      result_asset_id: "927",
      result_asset_url: "https://cdn.test/final.mp4",
      duration_ms: 60000,
      segment_count: 2,
    };
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stdout } = await runAsync(
      ["canvas", "compose", "c1", "--node", "c_node", "--assets", "7", "--wait", "--interval", "1"],
      env,
    );
    assert.equal(code, 0, stdout);
    assert.match(stdout, /成片地址：https:\/\/cdn\.test\/final\.mp4/);
    assert.match(stdout, /时长：60\.0 秒/);
  } finally {
    await site.close();
  }
});

test("canvas compose：节点不是成片节点时直接说清楚", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };
    const { code, stderr } = await run(["canvas", "compose", "c1", "--node", "v1"], env);
    assert.equal(code, 2);
    assert.match(stderr, /不是成片节点/);
    assert.equal(site.posts.length, 0);
  } finally {
    await site.close();
  }
});

test("drama：列表、详情、单元、任务四条都是只读", async () => {
  const site = await fakeSite();
  try {
    const env = { XDG_CONFIG_HOME: tempConfig(site.base) };

    const list = await run(["drama", "list"], env);
    assert.equal(list.code, 0);
    assert.match(list.stdout, /雪夜归途/);
    assert.match(list.stdout, /共 1 部/);

    const detail = await run(["drama", "get", "d1"], env);
    assert.equal(detail.code, 0);
    assert.match(detail.stdout, /单元：40 个/);
    assert.match(detail.stdout, /第 1 集/);
    // 12 集的短剧默认只列前 10 集（实测 96 集项目会打 175 行）
    assert.match(detail.stdout, /只列前 10/);
    assert.doesNotMatch(detail.stdout, /第 12 集  /);
    const allEpisodes = await run(["drama", "get", "d1", "--episodes", "0"], env);
    assert.match(allEpisodes.stdout, /第 12 集/);

    const units = await run(["drama", "units", "d1"], env);
    assert.equal(units.code, 0);
    assert.match(units.stdout, /NO\tTITLE\tCHARS/);
    assert.match(units.stdout, /开场/);

    const unit = await run(["drama", "unit", "d1", "1"], env);
    assert.equal(unit.code, 0);
    assert.match(unit.stdout, /雪夜里，她推开了那扇门/);

    const jobs = await run(["drama", "jobs", "d1", "--active"], env);
    assert.equal(jobs.code, 0);
    assert.match(jobs.stdout, /JOB\tSTEP\tSTATUS/);
    // 96 个集号要压缩成区间，否则一行表格被挤成两屏
    assert.match(jobs.stdout, /1,2,3…95,96（96 集）/);

    const cancel = await run(["drama", "job-cancel", "d1", "--job", "j1"], env);
    assert.equal(cancel.code, 0);
    assert.match(cancel.stdout, /canceled/);
  } finally {
    await site.close();
  }
});

test("parseArgs：多值 flag 收成数组，单值 flag 仍然后者生效", async () => {
  const { parseArgs } = await import("../src/commands.mjs");
  const { flags } = parseArgs([
    "--param",
    "a=1",
    "--param",
    "b=2",
    "--label",
    "第一次",
    "--label",
    "第二次",
  ]);
  assert.deepEqual(flags.param, ["a=1", "b=2"]);
  assert.equal(flags.label, "第二次");
});
