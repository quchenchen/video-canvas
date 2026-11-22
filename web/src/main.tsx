import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { installStaleChunkGuard } from "./lib/stale-chunk.ts";

// 必须早于任何动态 import：发版后旧页面的 chunk 请求已经 404，
// 这里捕获后整页刷新去拿新版本，而不是把 "Failed to fetch" 丢给用户。
installStaleChunkGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
