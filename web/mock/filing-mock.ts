import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type FilingStatus = "pending" | "processing" | "active" | "failed";

type Filing = {
  asset_id: string;
  status: FilingStatus;
  filing_id: string;
  error: string;
  source_url: string;
  updated_at: number;
};

const store = new Map<string, Filing>();
const ACTIVE_MS = 2500;

function makeFilingId(assetId: string): string {
  const suffix =
    assetId
      .replace(/[^a-z0-9]/gi, "")
      .slice(-5)
      .toLowerCase() || "mock0";
  return `asset-${Date.now().toString().slice(-8)}-${suffix}`;
}

function advance(f: Filing): Filing {
  if (f.status !== "pending" && f.status !== "processing") return f;
  if (Date.now() - f.updated_at < ACTIVE_MS) return f;
  if (f.asset_id.toLowerCase().includes("fail") || f.asset_id.toLowerCase().includes("error")) {
    return { ...f, status: "failed", error: "模拟：素材审核未通过", updated_at: Date.now() };
  }
  return {
    ...f,
    status: "active",
    filing_id: makeFilingId(f.asset_id),
    error: "",
    updated_at: Date.now(),
  };
}

function send(res: ServerResponse, data: unknown, code = 0, msg = "ok"): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ code, msg, data }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(raw));
  });
}

/** 备案接口本地模拟：按 asset_id 存内存状态，查询时推进 pending→active/failed。asset_id 含 fail/error 则模拟失败。 */
export function filingMockPlugin(): Plugin {
  return {
    name: "filing-mock",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/v1/filings")) return next();

        if (req.method === "GET" && url.pathname === "/api/v1/filings") {
          const ids = (url.searchParams.get("asset_ids") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const items: Filing[] = ids.map((assetId) => {
            const f = store.get(assetId);
            return f
              ? advance(f)
              : {
                  asset_id: assetId,
                  status: "none" as FilingStatus,
                  filing_id: "",
                  error: "",
                  source_url: "",
                  updated_at: 0,
                };
          });
          items.forEach((f) => store.set(f.asset_id, f));
          return send(res, { items });
        }

        if (req.method === "POST" && url.pathname === "/api/v1/filings") {
          const raw = await readBody(req);
          let body: { asset_id?: string; source_url?: string } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            return send(res, undefined, 40001, "请求体不是合法 JSON");
          }
          if (!body.asset_id) return send(res, undefined, 40001, "缺少 asset_id");
          const f: Filing = {
            asset_id: body.asset_id,
            status: "pending",
            filing_id: "",
            error: "",
            source_url: body.source_url ?? "",
            updated_at: Date.now(),
          };
          store.set(f.asset_id, f);
          return send(res, f);
        }

        const retryMatch = url.pathname.match(/^\/api\/v1\/filings\/([^/]+)\/retry$/);
        if (req.method === "POST" && retryMatch) {
          const assetId = decodeURIComponent(retryMatch[1]);
          const f: Filing = {
            asset_id: assetId,
            status: "pending",
            filing_id: "",
            error: "",
            source_url: store.get(assetId)?.source_url ?? "",
            updated_at: Date.now(),
          };
          store.set(assetId, f);
          return send(res, f);
        }

        return send(res, undefined, 40401, "模拟接口未实现该路径");
      });
    },
  };
}
