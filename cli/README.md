# video-canvas-cli

连镜（video-canvas）的命令行。用设备码登录，不用把密码或长期令牌交给脚本；画布与生成任务的读写都走已有的 HTTP 接口。

## 安装

仓库内直接运行：

```bash
node cli/bin/vc.mjs --help
```

想用 `video-canvas-cli` / `vc` 两个命令名，在仓库根执行一次：

```bash
cd cli && npm link
```

零第三方依赖，Node 18+。

## 登录

```bash
video-canvas-cli login --base https://你的站点
```

1. 终端打印一个用户码（形如 `ABCD-EFGH`）和授权地址，并尝试自动打开浏览器（`--no-open` 可关掉）。
2. 在网页上确认授权（页面在 `/cli/authorize`，需要已登录）。
3. 命令行拿到 JWT，存到 `~/.config/video-canvas/credentials.json`（目录 `0700`、文件 `0600`）。

`--base` 只给站点根即可，会自动补 `/api/v1`；也可以写进环境变量 `VC_API_BASE`。

```bash
video-canvas-cli whoami     # 验证令牌是否仍然有效
video-canvas-cli logout     # 删除本地凭据
```

令牌与网页登录是同一套 JWT：改密码会让 CLI 令牌一起失效，服务端没有额外的吊销列表。

## 画布

```bash
video-canvas-cli canvas list
video-canvas-cli canvas get <code>
video-canvas-cli canvas create --title "新项目" [--payload graph.json]
video-canvas-cli canvas import export.json
video-canvas-cli canvas export <code> -o export.json
video-canvas-cli canvas graph <code> -o graph.json      # 只取 payload_json
video-canvas-cli canvas save <code> --payload graph.json [--revision N]
```

`canvas save` 走整图保存 + `revision` 乐观锁：不给 `--revision` 就先读一次当前版本。节点级增量操作请用 Agent 会话或平台桥的 `canvas_apply_ops`，CLI 这一层刻意不复制那套语义。

## 生成任务

```bash
video-canvas-cli task get <id|task_ref>
video-canvas-cli task wait <id|task_ref> --timeout 900
```

`task wait` 只在终端打印状态变化，最终结果走 stdout；`--json` 时 stdout 只有一行 JSON，可直接接管道。

## 运行记录

`trace` 转发到 `scripts/agent-trace/agent-trace.mjs`，参数与原来一致：

```bash
video-canvas-cli trace pull --since 7d --feedback down
video-canvas-cli trace show <run_id>
video-canvas-cli trace compare --by harness_key --since 30d
```

拉下来的记录在 `.traces/`，**已在 `.gitignore` 里，不要提交**，也不要贴到 issue 或外部服务。

## 输出与退出码

- 默认人类可读；加 `--json` 输出 `{"ok":true,"data":...}`，失败输出 `{"ok":false,"error":{"code":...,"message":...}}`。
- 退出码：`0` 成功，`1` 业务或网络错误，`2` 用法错误。

## 权限边界

CLI 用的令牌等同网页登录的权限：能访问该用户自己的画布、素材、生成任务与积分。管理员命令（渠道、模型、用户管理）没有封装进这一版，避免一个脚本令牌顺手改掉平台配置。
