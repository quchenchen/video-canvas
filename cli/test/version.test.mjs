import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// 版本与 beta 标记：安装包、`vc --version`、站点界面读的是同一份 package.json。
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "vc.mjs");
const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));

const run = (...args) =>
  execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, VC_NO_UPDATE_CHECK: "1" } }).trim();

test("--version 打印 package.json 里的版本并带 beta 标记", () => {
  assert.equal(run("--version"), `video-canvas-cli ${pkg.version} (beta)`);
});

test("version --json 给脚本一行可解析的信息", () => {
  const body = JSON.parse(run("version", "--json"));
  assert.equal(body.ok, true);
  assert.equal(body.data.name, "video-canvas-cli");
  assert.equal(body.data.version, pkg.version);
  assert.equal(body.data.channel, "beta");
  assert.match(body.data.node, /^v\d+/);
  assert.equal(typeof body.data.os, "string");
});

test("--help 里写明 beta 与关闭升级检查的开关", () => {
  const help = run("--help");
  assert.match(help, /beta/);
  assert.match(help, /--no-update-check/);
  assert.match(help, /VC_NO_UPDATE_CHECK/);
});
