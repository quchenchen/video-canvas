#!/usr/bin/env node
// 从 `vc canvas graph <画布> -o graph.json` 的输出里挑节点 id。
//
// 为什么需要它：vc 没有 `canvas node ls`，而生成、合成、节点级编辑都要节点 id。
// 靠肉眼在几十个节点的 JSON 里找 id 容易抄错，抄错的后果是绑错节点或改错节点。
//
// 用法（需要 Node 22.18+，直接跑 .ts）：
//   node node-pick.ts <graph.json>                    列出全部节点
//   node node-pick.ts <graph.json> --kind image       按种类过滤（可逗号分隔）
//   node node-pick.ts <graph.json> --label 关键帧      按标题子串过滤（也接受正则）
//   node node-pick.ts <graph.json> --has-asset        只要已经有产物的（assetId 非空）
//   node node-pick.ts <graph.json> --kind compose --json
//
// 退出码：0 有匹配；1 没有匹配；2 用法或文件错误。

import fs from "node:fs";

type Flags = Record<string, string | true>;
type NodeData = {
  kind?: string;
  label?: string;
  assetId?: string | number;
  model?: string;
  status?: string;
};
type GraphNode = { id?: string; type?: string; data?: NodeData };
type Row = {
  id: string;
  kind: string;
  label: string;
  assetId: string;
  model: string;
  status: string;
};

function die(message: string, code = 2): never {
  process.stderr.write(`错误：${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const file = positional[0];
if (!file) {
  die(
    "用法：node node-pick.ts <graph.json> [--kind image] [--label 关键词] [--has-asset] [--json]",
  );
}

let graph: { nodes?: GraphNode[]; canvas?: { nodes?: GraphNode[] } };
try {
  graph = JSON.parse(fs.readFileSync(file, "utf8")) as typeof graph;
} catch (err) {
  die(`读取 ${file} 失败：${(err as Error).message}`);
}

// canvas graph 输出的是 {nodes, edges, viewport}；canvas get 的 payload_json 也是这个形态。
// 也接受直接喂导出文档（{canvas:{nodes}}），省一次转换。
const nodes = graph.nodes ?? graph.canvas?.nodes ?? [];
if (!Array.isArray(nodes) || nodes.length === 0) {
  die(`${file} 里没有节点（是不是喂了空画布或别的 JSON？）`);
}

const kinds =
  typeof flags.kind === "string"
    ? flags.kind
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

function labelMatcher(raw: string): (label: string) => boolean {
  if (!raw) return () => true;
  try {
    const re = new RegExp(raw);
    return (label) => re.test(label);
  } catch {
    // 正则写错就退回子串匹配：用户多半只是想搜个词
    return (label) => label.includes(raw);
  }
}

const matchLabel = labelMatcher(typeof flags.label === "string" ? flags.label : "");
const same = (a: unknown, b: unknown): boolean => String(a ?? "") === String(b ?? "");

const picked = nodes.filter((node) => {
  const data = node.data ?? {};
  const kind = data.kind ?? node.type ?? "";
  if (kinds.length && !kinds.some((k) => same(k, kind))) return false;
  if (!matchLabel(String(data.label ?? ""))) return false;
  if (flags["has-asset"] && !data.assetId) return false;
  return true;
});

const rows: Row[] = picked.map((node) => {
  const data = node.data ?? {};
  return {
    id: String(node.id ?? ""),
    kind: data.kind ?? node.type ?? "-",
    label: data.label ?? "",
    assetId: data.assetId ? String(data.assetId) : "",
    model: data.model ?? "",
    status: data.status ?? "",
  };
});

if (flags.json) {
  process.stdout.write(`${JSON.stringify({ ok: true, data: rows })}\n`);
} else if (rows.length) {
  const head = ["ID", "KIND", "ASSET", "LABEL", "MODEL"].join("\t");
  const body = rows.map((r) =>
    [r.id, r.kind, r.assetId || "-", r.label || "-", r.model || "-"].join("\t"),
  );
  process.stdout.write(`${[head, ...body].join("\n")}\n`);
  if (rows.length > 1) {
    process.stderr.write(
      `共 ${rows.length} 个匹配；生成/合成只认一个节点时，缩窄条件（--kind / --label）。\n`,
    );
  }
} else {
  process.stderr.write("没有匹配的节点。\n");
  process.exit(1);
}
