# video-canvas-cli（beta）

连镜（video-canvas）的命令行。用设备码登录，不用把密码或长期令牌交给脚本；画布、模型与积分、生成任务、
成片合成、短剧只读、运行记录都走已有的 HTTP 接口。

**beta 渠道**：相当一段时间内保持测试状态，命令与参数尽量稳定，但输出格式与子命令仍可能调整。
每次运行会在后台查一次新版本，有更新时在 stderr 提示升级命令（`VC_NO_UPDATE_CHECK=1` 可关掉）。

> 完整参考（安装、5 分钟上手、输出契约、退出码表、排障）在站点 `/cli/docs`，
> 正文是 `web/src/content/cli-docs.md`，改文档改那一份即可。

## 安装

独立发版，版本看 `package.json`（**与站点版本无关**）。没有发布到 npm，安装包由站点提供：

```bash
# macOS / Linux：装到 ~/.local，再链接 vc / video-canvas-cli
curl -fsSL https://你的站点/api/v1/cli/install.sh | sh

# Windows PowerShell：装到 %LOCALAPPDATA% 并写入用户 PATH
irm https://你的站点/api/v1/cli/install.ps1 | iex
```

零第三方依赖，Node 18+。仓库里也能直接跑：`node cli/bin/vc.mjs --help`；
`vc --version` 打印自己的版本，`vc --version --json` 给脚本读。

## 登录

```bash
video-canvas-cli login --base https://你的站点
```

1. 终端打印一个用户码（形如 `ABCD-EFGH`）和授权地址，并尝试自动打开浏览器（`--no-open` 可关掉）。
2. 在网页上确认授权（页面在 `/cli/authorize`，需要已登录）。
3. 命令行拿到 JWT，存到 `~/.config/video-canvas/credentials.json`（目录 `0700`、文件 `0600`）。

`--base` 只给站点根即可，会自动补 `/api/v1`；也可以写进环境变量 `VC_API_BASE`。
**必须带 `http://` 或 `https://`**——只写域名会直接报错，不做猜测补全。

```bash
video-canvas-cli whoami     # 验证令牌是否仍然有效
video-canvas-cli logout     # 删除本地凭据
```

令牌与网页登录是同一套 JWT：改密码会让 CLI 令牌一起失效，服务端没有额外的吊销列表。
有效期不同：命令行登录态**默认 30 天**（后台「注册设置 → 命令行登录有效期」可改，1–365 天），
网页会话按 `jwt.expire_hours`。它与「设备码 10 分钟」「MCP 令牌天数」「MCP 单次调用超时」「--wait 本地等待」
都是不同的数，别混。

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

`-o` 与 `--output` 等价；`-o -` 把内容写到 stdout（此时不能再加 `--json`）。

**`graph` 和 `export` 不是一回事**：`graph` 输出 `{nodes, edges, viewport}`，是 `save` / `create --payload`
要的形态；`export` 输出带 `format` / `canvas` / `assets` 的导出文档，只能喂给 `import`。
把导出文档喂给 `save` 会被拒绝（早期版本会整份写进画布，把结构弄坏）。

`export` 不给 `-o` 时默认写当前目录的 `canvas-<编号>.json`，在项目目录里跑记得显式指定。

`canvas save` 走整图保存 + `revision` 乐观锁：不给 `--revision` 就先读一次当前版本。

## 节点级编辑

只提交差异，由服务端按与 Agent 相同的图语义应用，CLI 不自己拼图。**每次都要在终端里确认**：

```bash
video-canvas-cli canvas node add <code> --kind script --label "旁白" --text "第一句"
video-canvas-cli canvas node add <code> --kind image --label "关键帧1" --prompt "草原上的风机" --at 600,100
video-canvas-cli canvas node set <code> <节点id> --label "新标题"
video-canvas-cli canvas node rm <code> <节点id>
```

- 能建的种类只有 `script` / `image` / `video` / `audio`；角色卡、分镜表、成片、导演台要在画面上建。
- 文本节点的正文用 `--text`（服务端写进节点正文），其它节点的提示词用 `--prompt`。
- `rm` 会连带清理连线、分镜里的挂接、成片顺序，由服务端统一处理。
- 流程是「读当前图 → 逐行列出要改什么 → 等你输入 yes → 带同一个 revision 提交」。
  确认期间画布被别人改了，服务端返回 409，不会覆盖你没看过的版本。
- **没有 `--yes` 之类的旁路，也不能和 `--json` 一起用**：脚本无法在无人确认时做节点级修改。
  要用脚本批量改，走 `canvas graph` + `canvas save`。

## 模型、积分与生成

```bash
video-canvas-cli model list [--kind image|video|audio|text]
video-canvas-cli model show agnes-video-2.5        # 参数名、可选值、参考素材上限、计价
video-canvas-cli credits                           # 余额 / 冻结 / 可用

video-canvas-cli generate image --model agnes-image-2.5-flash \
  --prompt "一枚硬币躺在岩面上，侧光" --param aspect_ratio=16:9 \
  --canvas <code> --node <节点id> --wait --timeout 300
```

- **产物由画布回填到节点**：CLI 只把任务绑在节点上，与网页点生成同一条链路；打开画布时按节点拉取生成记录。
- `--canvas` 与 `--node` 要么都给、要么都不给（都不给是临时任务，产物只能从任务详情取地址）。
- `--param 名=值` 可给多次，值先按 JSON 解释；复杂结构用 `--input '{...}'`（也支持 `@文件`、`-` 读标准输入）。
- 参考素材用 `--ref-image / --ref-video / --ref-audio`，可给多次或逗号分隔。
- `--count N` 拆成 N 个任务，都绑同一个节点（需要 `--node`）。
- 普通提交是幂等的（自动带 `Idempotency-Key`），脚本重试要复用 `--idempotency-key`。

## 合成成片

```bash
video-canvas-cli canvas compose <code> --node <成片节点id>            # 只提交
video-canvas-cli canvas compose <code> --node <成片节点id> --wait     # 等到出片
video-canvas-cli canvas compose <code> --node <成片节点id> --assets 923,920 --wait
video-canvas-cli canvas compose-status <code> --job <任务id>
video-canvas-cli canvas compose-status <code> --node <成片节点id>
video-canvas-cli canvas compose-cancel <code> --job <任务id>
```

不给 `--assets` 时按与画布相同的规则推导：只收连进成片节点的视频节点，`composeOrder` 优先、其余按画布位置，
每段取当前生效的那一版；推导结果会先打印出来再提交。

## 短剧（只读 + 任务控制）

```bash
video-canvas-cli drama list [--keyword 关键词]
video-canvas-cli drama get <短剧编号>
video-canvas-cli drama units <短剧编号> [--from 1] [--to 20]
video-canvas-cli drama unit <短剧编号> <单元号>
video-canvas-cli drama jobs <短剧编号> [--active]
video-canvas-cli drama job-cancel <短剧编号> --job <任务id>
```

建项目、规划、生成剧本、分集出片仍在网页与 MCP：它们要长上下文、要逐步核对、要花大额积分。

## 生成任务

```bash
video-canvas-cli task get <id|task_ref>
video-canvas-cli task wait <id|task_ref> [--timeout 600] [--interval 3]
```

`task wait` 默认 600 秒超时、3 秒轮询；只在终端打印状态变化，最终结果走 stdout；`--json` 时 stdout 只有一行 JSON，可直接接管道。

- 任务**失败**终态：`ok:false` + 退出码 1。
- **等待超时**：退出码 3，任务可能还在跑，用 `task get` 继续查。别把超时当失败重跑，会白烧积分。
- `task_ref` 是任务 id 的 32 位十六进制编码，画布界面与日志里显示的就是它。

## 运行记录

`trace` 转发到 `scripts/agent-trace/agent-trace.mjs`，参数与原来一致：

```bash
video-canvas-cli trace pull --since 7d --feedback down
video-canvas-cli trace show <run_id>
video-canvas-cli trace compare --by harness_key --since 30d
```

**独立安装包不含这个脚本**。不在仓库里跑时，用 `--script <路径>` 或环境变量 `VC_AGENT_TRACE` 指定，
否则会明确报「独立安装包不包含运行记录脚本」。

拉下来的记录在 `.traces/`，**已在 `.gitignore` 里，不要提交**，也不要贴到 issue 或外部服务。

## 输出与退出码

- 默认人类可读；加 `--json` 输出 `{"ok":true,"data":...}`，失败输出 `{"ok":false,"error":{"code":...,"message":...}}`。
- 退出码：`0` 成功，`1` 业务/网络错误或任务失败，`2` 用法错误，`3` `--wait` / `task wait` 等待超时
  （任务仍在跑，不是失败），`4` 节点级修改被取消。

## 权限边界

CLI 用的令牌等同网页登录的权限：能访问该用户自己的画布、素材、生成任务与积分。管理员命令（渠道、模型、用户管理）没有封装进这一版，避免一个脚本令牌顺手改掉平台配置。

**不改节点产物字段**：生成与合成的产物由服务端与画布写回节点，CLI 不去改 `src` / `assetId` / `outputs`，
免得绕过画布的版本归并。**不删画布**，**不做短剧重活**。细节见站点 `/cli/docs` 的「边界与限制」。
