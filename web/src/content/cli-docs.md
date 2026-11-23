# 连镜命令行（video-canvas-cli）beta

给人和脚本用的命令行：设备码登录，不用把密码或长期令牌交给脚本；画布、生成任务、运行记录都走已有的 HTTP 接口。

零第三方依赖，Node 18+。装好后有两个等价的命令名：`vc` 与 `video-canvas-cli`。

> **beta 渠道**：相当一段时间内保持测试状态。命令名与参数会尽量稳定，但输出格式、提示语、
> 新增子命令仍可能调整。每次运行会在后台查一次最新版本，有新版本时在 stderr 提示一行升级命令
> （`--json` 与非交互终端不打扰脚本，`VC_NO_UPDATE_CHECK=1` 或 `--no-update-check` 可彻底关掉）。

```text
登录
  login [--base URL] [--name 名称] [--no-open]   设备授权登录（在浏览器里确认）
  logout                                          删除本地凭据
  whoami                                          查看当前身份

画布
  canvas list [--page N] [--page-size N]
  canvas get <code>
  canvas create --title <标题> [--payload 文件]
  canvas import <导出文件.json>
  canvas export <code> [-o 文件]        导出文档（含素材引用），用于备份 / 迁移
  canvas graph <code> [-o 文件]         只要 nodes / edges，用于改稿后写回
  canvas save <code> --payload 文件 [--revision N]
                                        要 graph 的输出，不接受 export 的导出文档

生成任务
  task get <id|task_ref>
  task wait <id|task_ref> [--timeout 600] [--interval 3]

运行记录（转发 scripts/agent-trace；独立安装包用 --script 或 VC_AGENT_TRACE 指定）
  trace pull [--since 7d] [--feedback down]
  trace show <run_id>
  trace compare --by harness_key [--since 30d]

全局选项
  --json          输出一行 JSON（{ok,data} / {ok:false,error}），供脚本与 Agent 解析
  --base URL      覆盖 API 地址（也可用环境变量 VC_API_BASE）

版本
  version         打印 CLI 版本（与站点版本独立）；加 --json 输出机器可读信息
```

`-o` 与 `--output` 完全等价。写成 `-o -` 表示把内容输出到 stdout；此时不能再加 `--json`，
因为 stdout 只能放一种内容（会直接报用法错误）。

## 安装

CLI 单独发版，版本号与站点版本**无关**。它没有发布到 npm，安装包由你自己的站点提供，
需要 Node 18 及以上（脚本会先检查）。

### macOS / Linux

```bash
curl -fsSL https://你的站点/api/v1/cli/install.sh | sh
```

装到 `~/.local/share/video-canvas-cli/<版本>`，并链接到 `~/.local/bin/{vc,video-canvas-cli}`。
`~/.local/bin` 不在 PATH 里时，脚本会打印一行加 PATH 的命令。

### Windows

```powershell
irm https://你的站点/api/v1/cli/install.ps1 | iex
```

装到 `%LOCALAPPDATA%\video-canvas-cli\<版本>`：写入 `vc.cmd` / `video-canvas-cli.cmd` 转发到
node，并把 bin 目录加进用户 PATH（重开终端生效）。

### 手动下载 / 离线

```bash
curl -fsSL https://你的站点/api/v1/cli/download?os=unix -o video-canvas-cli.tgz     # macOS / Linux
curl -fsSL https://你的站点/api/v1/cli/download?os=windows -o video-canvas-cli.zip  # Windows
```

包内就是 `package.json`、`bin/`、`src/`，解压后 `node <目录>/bin/vc.mjs` 直接能跑。

### 可覆盖的参数

| 变量         | 作用                                                   |
| ------------ | ------------------------------------------------------ |
| `VC_BASE`    | 站点地址；脚本默认已经填好当前站点                     |
| `VC_VERSION` | 指定版本，默认取服务端最新                             |
| `VC_PREFIX`  | Unix 安装前缀（默认 `~/.local`）；Windows 下是安装目录 |

### 升级与卸载

- 升级：重跑同一条安装命令。脚本每次都向 `/api/v1/cli/release` 要最新版本，不用记版本号。
- 卸载：Unix 删 `~/.local/share/video-canvas-cli` 与 `~/.local/bin/{vc,video-canvas-cli}`；
  Windows 删 `%LOCALAPPDATA%\video-canvas-cli`，并从用户 PATH 里去掉那条。

### 自检

```bash
vc --version          # video-canvas-cli 0.1.0
vc --version --json   # {"ok":true,"data":{...,"node":"v22.22.2","os":"darwin","arch":"x64"}}
```

`cli/package.json` 的 `version` 是唯一来源：安装包名、`vc --version`、站点 `/cli` 页显示的版本
都读它，不存在三处各写一个数。源码里也能直接跑：`node cli/bin/vc.mjs --help`。

## 5 分钟上手

```bash
# 1. 登录：打印用户码并打开浏览器，在网页上点「允许」
vc login --base https://你的站点

# 2. 确认身份（打印用户名与角色）
vc whoami

# 3. 看看自己有哪些画布
vc canvas list

# 4. 建一张空画布，记下返回的画布编号
vc canvas create --title "临时验证"

# 5. 取节点与连线：这才是可以改、可以写回的形态
vc canvas graph <画布编号> -o 画布.json

# 6. 改完写回；带 --revision 才是乐观锁，别处改过会直接失败
vc canvas save <画布编号> --payload 画布.json --revision 3

# 7. 备份或迁移整张画布（含素材引用）走 export / import，不要喂给 save
vc canvas export <画布编号> -o 备份.json
vc canvas import 备份.json

# 8. 提交一个生成任务，再等它结束（阻塞到出结果或超时）
vc task wait <任务ID> --timeout 600

# 9. 收工：删掉本机凭据
vc logout
```

画布编号是 32 位十六进制串（`idcodec` 编出来的对外编号），不是数据库自增 id。

**`graph` 与 `export` 别混**：`graph` 是 `{nodes, edges, viewport}`，给 `save` / `create --payload` 用；
`export` 是带 `format` / `canvas` / `assets` 的导出文档，给 `import` 用。把导出文档喂给 `save` 会被直接拒绝
（早期版本会把它整份写进画布，结构就坏了）。

`export` 不给 `-o` 时默认写当前目录的 `canvas-<编号>.json`。在仓库或项目目录里跑脚本时建议总是显式给 `-o`，
避免多出一个未跟踪文件。

## 多站点与凭据

凭据存在 `$XDG_CONFIG_HOME/video-canvas/credentials.json`（没设 XDG 就是 `~/.config/video-canvas/`），
目录 `0700`、文件 `0600`，里面有站点地址、令牌、过期时间、设备名。

| 想做什么       | 怎么做                                                    |
| -------------- | --------------------------------------------------------- |
| 换到另一个站点 | `vc login --base https://另一站点`，覆盖旧凭据            |
| 临时指定地址   | `--base` 或环境变量 `VC_API_BASE`，优先级高于已保存的地址 |
| 看登录的是谁   | `vc whoami`                                               |
| 清掉本地凭据   | `vc logout`                                               |

`--base` 给站点根（`https://host`）或完整的 `https://host/api/v1` 都可以，两种写法等价。
**必须带 `http://` 或 `https://`**：只写 `lj.example.com` 会直接报「API 地址必须以 http:// 或 https:// 开头」，
不做猜测补全。

## 协议契约

### stdout 与 stderr 的分工

| 流     | 内容                                                     |
| ------ | -------------------------------------------------------- |
| stdout | 只有结果：人类可读的表格，或 `--json` 时的一行 JSON      |
| stderr | 进度、提示、等待状态。`task wait` 的每次状态变化都写这里 |

所以 `vc canvas list --json | jq '.data.list'` 可以直接用，不会被进度日志污染。

`login` 的**授权地址与用户码始终写在 stderr**，加了 `--json` 也一样：stdout 只留最后那一行结果 JSON，
但脚本或人必须知道去哪个地址点确认。早期版本把这段提示关在非 JSON 分支里，导致 `login --json` 只能干等到超时。

### JSON 输出

成功：

```json
{ "ok": true, "data": { "...": "..." } }
```

失败：

```json
{ "ok": false, "error": { "code": 40004, "message": "任务不存在" } }
```

`code` 是服务端错误码原样透出；网络层与本地参数错误用 `-1`，具体区别看退出码。

`task wait` 到失败终态时，`ok` 与退出码保持一致：

```json
{ "ok": false, "error": { "code": -1, "message": "video queue is full" }, "data": { "status": "failed" } }
```

早期版本这里输出 `ok: true` 却返回退出码 1，用 JSON 判断成败的脚本会误判成成功。

### 退出码

| 退出码 | 含义                                                     | 脚本里的处置                                  |
| ------ | -------------------------------------------------------- | --------------------------------------------- |
| 0      | 成功                                                     | 继续                                          |
| 1      | 业务错误、网络错误，或 `task wait` 等到了失败终态        | 读 stderr / `--json` 的 `error`，不要盲目重试 |
| 2      | 用法错误：参数缺失或非法、文件名写错、命令不存在、`--base` 写法错 | 修命令行本身                                  |
| 3      | `task wait` 等待超时，**任务仍在跑，不代表失败**         | 用 `task get` 继续查，或加大 `--timeout`      |

**超时与失败必须分开**：把超时当失败会导致「任务其实成功了，脚本却重跑一遍，白烧积分」。
这是实测踩过的坑，所以单独给了退出码 3。

### 等待与轮询

`task wait` 默认每 3 秒查一次，600 秒超时；可用 `--interval`（1–3600 秒）、`--timeout`（1–86400 秒）调。
数值写错（如 `--timeout abc`）会直接报用法错误，不会静默退回默认值。
登录轮询按服务端给的 `interval` 走；服务端返回 `slow_down` 时自动加 5 秒，这是限频，不是故障。

## 命令参考

| 命令            | 作用                                           | 注意                                                          |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `canvas list`   | 列出我名下的画布（编号、版本、更新时间、标题） | 只含自己创建的画布；`--json` 的 data 是 `{list,total,page,page_size}` |
| `canvas get`    | 画布详情，含节点与连线                         | 输出较大，配合 `--json`；节点与连线在 `data.payload_json`     |
| `canvas create` | 建画布，可带 `--payload` 直接灌图              | `--payload` 要 graph 的输出，不接受导出文档                   |
| `canvas import` | 从导出文件建**新**画布                         | 要用 `canvas export` 的输出；不会覆盖已有画布                 |
| `canvas export` | 整图导出为 JSON 文件                           | 默认写当前目录 `canvas-<编号>.json`；不含令牌与素材二进制     |
| `canvas graph`  | 只取 `payload_json`（节点与连线）              | 写回用这个；`--json` 时在 `data.graph`，与 get 的层级不同     |
| `canvas save`   | 整图保存                                       | 要 graph 的输出；走 `revision` 乐观锁，见下                   |
| `task get`      | 查一次生成任务                                 | 任务 ID 支持数字 id 与 `task_ref`                             |
| `task wait`     | 阻塞到任务终态                                 | 失败终态 `ok:false` + 退出码 1；等待超时退出码 3              |
| `trace *`       | 拉取线上 Agent 运行记录                        | 参数与 `scripts/agent-trace` 一致；独立安装包需 `--script`    |

`canvas get --json` 的节点在 `data.payload_json`，`canvas graph --json` 的在 `data.graph`。两者内容一样，
层级不同是历史原因，取数时按命令区分。要 feed 给 `save` 时，优先用 `canvas graph -o 文件`，别从 get 里手抠。

`canvas save` 的冲突语义：没给 `--revision` 时会先读一次当前版本再提交，这是「尽力而为」；
给了 `--revision` 才是严格乐观锁，画布在别处被改过就直接失败，**不会覆盖别人的修改**。

## 边界与限制

**这一版 CLI 只负责「画布读写 + 任务查询」，不负责生产素材。** 下面几条是刻意没做的，不是遗漏：

- **不生成图片 / 视频**。没有 `generate` 子命令。生成要走画布界面点生成，或直接调服务端的
  `POST /generation-tasks`（请求里必须带本画布的 `canvas_id` 与节点 `node_id`，产物才会落回节点）；
  Agent 会话里对应的是 `generate_media` 工具。CLI 能做的只是用 `task wait` 盯着任务跑完。
- **不合成成片**。没有 `compose` 子命令。成片要在画布成片节点上点「重新合成」，或调
  `POST /canvas/:id/compose`（`asset_ids` 的顺序就是成片顺序，服务端不猜）。
- **不删除画布**。没有 `canvas delete`。建错了的画布只能在前端删除，CLI 不会替你做不可逆操作。
- **不做节点级增删改**。CLI 只做整图读写；节点级语义在服务端 `canvas_apply_ops`（Agent 会话/平台桥）那套里，CLI 刻意不复制，避免两套语义各自漂移。
- **不封装管理端接口**。渠道、模型、用户管理这些管理员操作没有做进 CLI——脚本令牌不应该顺手改平台配置。
- **未发布到 npm**。安装包只由站点通过 `/api/v1/cli/download` 提供，不依赖任何公共包仓库，
  也不要求 `npm install`；离线环境可以下包后拷过去直接跑。
- **令牌等同网页登录态**。它和你浏览器里的登录是同一套 JWT：改密码会一起失效，服务端没有单独的吊销列表。

## 排障

| 现象                                             | 原因                                | 处置                                                       |
| ------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------- |
| `登录已过期或被撤销，请重新执行 login`           | 令牌过期，或改过密码                | `vc login` 重登                                            |
| `授权已过期，请重新执行登录`                     | 用户码超过 10 分钟                  | 重跑 `vc login`，用户码一次一换                            |
| `这个设备码已经被使用`                           | 同一个码被确认了两次                | 重跑 `vc login`                                            |
| `画布已在别处修改`（409）                        | 保存时 `revision` 落后              | 重新 `canvas graph` 取最新内容，合并后用新版本号再 save    |
| `缺少 API 地址`                                  | 既没 `--base`，也没登录过           | 首次使用就带 `--base`                                      |
| `API 地址必须以 http:// 或 https:// 开头`        | `--base` 只写了域名                 | 补上协议；不做猜测补全                                     |
| `收到的是 canvas export 的导出文档`              | 把 `export` 的输出喂给了 `save`     | 写回用 `canvas graph`；迁移用 `canvas import`              |
| `--timeout 需要 1–86400 的整数`                  | 数值参数写了非数字或越界            | 改成整数；不再静默退回默认值                               |
| `找不到 agent-trace`                             | 独立安装包不带运行记录脚本          | 用 `--script <仓库>/scripts/agent-trace/agent-trace.mjs` 或设 `VC_AGENT_TRACE` |
| 等待超时（退出码 3）                             | 任务仍在跑，不是失败                | 加大 `--timeout`，或 `task get <id>` 继续查                |

## 与 MCP 接入的区别

| 对比项   | MCP 接入                               | 命令行（CLI）                   |
| -------- | -------------------------------------- | ------------------------------- |
| 谁在用   | AI 工具（Claude、Cursor 等）           | 人和脚本                        |
| 凭据     | 项目令牌 `vcm_…`，有有效期，可随时注销 | 设备授权换来的登录态，存本机    |
| 怎么授权 | 在「MCP 接入」页签发令牌               | 执行 `vc login`，网页确认用户码 |
| 能力范围 | 按项目勾选的权限档位                   | 与网页登录同等，限本人名下数据  |

两者互不依赖：用 CLI 不需要建 MCP 项目，签发 MCP 令牌也不影响 CLI 的登录态。
