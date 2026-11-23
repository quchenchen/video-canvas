# 连镜命令行（video-canvas-cli）beta

给人和脚本用的命令行：设备码登录，不用把密码或长期令牌交给脚本；画布、生成任务、运行记录都走已有的 HTTP 接口。

零第三方依赖，Node 18+。装好后有两个等价的命令名：`vc` 与 `video-canvas-cli`。

> **beta 渠道**：相当一段时间内保持测试状态。命令名与参数会尽量稳定，但输出格式、提示语、
> 新增子命令仍可能调整。每次运行会在后台查一次最新版本，有新版本时在 stderr 提示一行升级命令
> （`--json` 与非交互终端不打扰脚本，`VC_NO_UPDATE_CHECK=1` 或 `--no-update-check` 可彻底关掉）。

```text
身份与会话
  login [--base URL] [--name 名称] [--no-open]    设备授权登录（在浏览器里确认）
  logout                                           删除本地凭据（不动服务端令牌）
  whoami                                           校验令牌并打印当前身份
  version [--json]                                 打印 CLI 版本（与站点版本独立）

读画布
  canvas list [--page N] [--page-size N]           我名下的画布，分页
  canvas get <code>                                详情：标题、版本、节点与连线
  canvas graph <code> [-o 文件]                    只要 nodes / edges（可写回的形态）
  canvas export <code> [-o 文件]                   导出文档（含素材引用），备份 / 迁移用

改画布
  canvas create --title <标题> [--payload 文件]    新建；--payload 要 graph 的形态
  canvas save <code> --payload 文件 [--revision N] 整图保存（乐观锁）
  canvas node add <code> --kind <种类> [--label 标题] [--text 正文] [--prompt 提示词]
                        [--model 模型] [--at x,y]  新增单个节点（需终端确认）
  canvas node set <code> <节点id> [--label 标题] [--text 正文] [--prompt 提示词] [--model 模型]
                                                   修改单个节点（需终端确认）
  canvas node rm <code> <节点id>...                删除节点，连带清理连线与引用（需终端确认）
  canvas import <导出文件.json>                     从导出文档新建一张画布

查生成任务
  task get <id|task_ref>                           查一次任务
  task wait <id|task_ref> [--timeout 600] [--interval 3]
                                                   阻塞到终态，可安全用于脚本

运行记录（转发 scripts/agent-trace）
  trace pull [--since 7d] [--feedback down] ...
  trace show <run_id>
  trace compare --by harness_key [--since 30d]

全局选项
  --json               输出一行 JSON（{ok,data} / {ok:false,error}），供脚本与 Agent 解析
  --base URL           覆盖 API 地址（也可用环境变量 VC_API_BASE）
  --no-update-check    本次不检查新版本（也可用 VC_NO_UPDATE_CHECK=1）
  -o, --output 文件     仅 canvas graph / export：写文件；`-o -` 表示写 stdout
```

`-o` 与 `--output` 完全等价。写成 `-o -` 表示把内容输出到 stdout；此时不能再加 `--json`，
因为 stdout 只能放一种内容（会直接报用法错误）。

## 能力总览

CLI 覆盖的是「画布本身」和「任务的查询」，**不生产素材**。先看这张表再翻命令细节：

| 我想做的事                     | 用什么                                   | 说明                                             |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------ |
| 登录 / 换站点 / 看当前身份     | `login`、`logout`、`whoami`              | 设备码授权，凭据存本机；与网页登录同一套 JWT     |
| 找画布、看画布里有什么         | `canvas list`、`canvas get`、`canvas graph` | 只读，随便跑                                     |
| 备份 / 迁移整张画布            | `canvas export` → `canvas import`        | 带素材引用，导入会复制素材到新画布               |
| 整图改稿后写回                 | `canvas graph` → 编辑 → `canvas save`    | 需要 `--revision` 才是严格乐观锁                 |
| 改一两个节点（加/改/删）       | `canvas node add/set/rm`                 | **必须在终端里人工确认**，没有脚本旁路           |
| 看生成任务跑到哪了             | `task get`、`task wait`                  | 只查不提交；生成入口在画布界面或后端接口         |
| 拉线上 Agent 运行记录          | `trace pull/show/compare`                | 转发仓库里的 agent-trace 脚本                    |
| 生成图片 / 视频                | ——                                       | **没有** `generate`；见「边界与限制」            |
| 合成成片                       | ——                                       | **没有** `compose`；见「边界与限制」             |
| 删除整张画布                   | ——                                       | **没有** `canvas delete`；只能在前端删           |

一条心智模型：**读的多、写的少**。写操作分三档，风险从低到高——
`create`（新建）< `save`（整图覆盖，有乐观锁）< `node rm`（删数据，有交互确认 + 乐观锁）。
三档都带 `revision`，都不会静默覆盖别人刚写的内容。


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

# 6.5 只改一两个节点时不用整图：用 canvas node，它会先把差异摆出来让你确认
vc canvas node add <画布编号> --kind script --label "旁白" --text "第一句"

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
| 4      | 节点级修改被取消（没输入 `yes`，或非交互终端被拒绝）     | 想要就重跑并在终端里确认                      |

**超时与失败必须分开**：把超时当失败会导致「任务其实成功了，脚本却重跑一遍，白烧积分」。
这是实测踩过的坑，所以单独给了退出码 3。

### 等待与轮询

`task wait` 默认每 3 秒查一次，600 秒超时；可用 `--interval`（1–3600 秒）、`--timeout`（1–86400 秒）调。
数值写错（如 `--timeout abc`）会直接报用法错误，不会静默退回默认值。
登录轮询按服务端给的 `interval` 走；服务端返回 `slow_down` 时自动加 5 秒，这是限频，不是故障。

## 命令参考

按能力分五组。每组先给参数表，再给这一组特有的坑。

### 身份与会话

| 命令        | 参数                  | 默认                        | 说明                                             |
| ----------- | --------------------- | --------------------------- | ------------------------------------------------ |
| `login`     | `--base URL`          | 已保存的地址或 `VC_API_BASE` | 站点根或完整的 `/api/v1` 都可以                  |
|             | `--name 名称`         | `video-canvas-cli@主机名`   | 授权页上显示是谁在登录，最长 64 字               |
|             | `--no-open`           | 自动开浏览器                | 只打印授权地址，不拉起浏览器                     |
| `logout`    | 无                    | ——                          | **只删本地凭据**；服务端 JWT 是自包含的          |
| `whoami`    | 无                    | ——                          | 实时调 `/me`，令牌失效会立刻报错，可当健康检查   |
| `version`   | `--json`              | ——                          | 也可写 `--version` / `-v`                        |

- `login` 的授权地址与用户码**始终写 stderr**，`--json` 时也一样；stdout 只留最后一行结果。
- `login` 会轮询到用户确认或 10 分钟过期。`denied` / `expired` / `consumed` / 超时都是退出码 1。
- `logout` 不会让服务端令牌失效：真吊销靠网页改密码（改完所有设备一起失效）。
- `version --json` 的 `data` 是 `{name, version, channel, node, os, arch}`，版本号只读 `package.json`。

### 读画布

| 命令            | 参数                          | 说明                                                        |
| --------------- | ----------------------------- | ----------------------------------------------------------- |
| `canvas list`   | `--page N`、`--page-size N`   | page ≥ 1（默认 1）；page-size 不传是 10，服务端上限 50  |
| `canvas get`    | `<code>`                      | 详情；`--json` 的节点在 `data.payload_json`                 |
| `canvas graph`  | `<code>`、`-o 文件`           | 只要 `{nodes, edges, viewport}`；不给 `-o` 就打印到 stdout  |
| `canvas export` | `<code>`、`-o 文件`           | 导出文档；默认写当前目录 `canvas-<编号>.json`               |

- `canvas list --json` 的 `data` 是 `{list,total,page,page_size}`；人类可读输出是 CODE/REV/UPDATED/TITLE 四列。
- `canvas get` **没有** `-o`：它输出的是画布对象，落盘请用 `canvas export` 或 `canvas graph`。
- `canvas export --json` 的 `data` 是 `{file, skipped_assets}`；`skipped_assets` 是导出时读不到内容的素材数，
  导出的文档因此仍可导入，但会少那几个素材。
- 只读命令不会有副作用，可以随便跑；唯一例外是 `export` 不给 `-o` 时会在当前目录写文件。

### 改画布

| 命令            | 参数                                                     | 说明                                      |
| --------------- | -------------------------------------------------------- | ----------------------------------------- |
| `canvas create` | `--title 标题`（默认「未命名画布」）、`--payload 文件`   | `--payload` 要 `graph` 的形态             |
| `canvas save`   | `<code>`、`--payload 文件`、`--revision N`               | 整图保存；不给 revision 就先读一次当前值  |
| `canvas node add` | `<code>`、`--kind`、`--label`、`--text`、`--prompt`、`--model`、`--at x,y` | 新增一个节点，**需终端确认** |
| `canvas node set` | `<code>`、`<节点id>`、`--label`、`--text`、`--prompt`、`--model` | 改一个节点，**需终端确认**     |
| `canvas node rm`  | `<code>`、`<节点id>...`                                  | 删节点，连带清理引用，**需终端确认**      |
| `canvas import` | `<导出文件.json>` 或 `--file`、`--json`                  | 从导出文档建**新**画布，不覆盖已有画布    |

`canvas save` 的冲突语义：没给 `--revision` 时会先读一次当前版本再提交，这是「尽力而为」；
给了 `--revision` 才是严格乐观锁，画布在别处被改过就直接失败（409 / `30002`），**不会覆盖别人的修改**。

#### 节点级编辑（`canvas node`）

只提交差异，由服务端用与 Agent 相同的图语义应用，CLI 不自己拼图。能新建的种类：
`script`（文本）、`image`（图片）、`video`（视频）、`audio`（音频）。
角色卡、分镜表、成片、导演台要填内嵌结构，请在画面上创建。

```bash
# 加一个文本节点：文本的正文用 --text（服务端写进节点正文 data.text）
vc canvas node add <画布编号> --kind script --label "旁白" --text "第一句"

# 加一个图片节点：生成用提示词走 --prompt，还可以指定模型与位置
vc canvas node add <画布编号> --kind image --label "关键帧1" --prompt "草原上的风机" \
  --model nano-banana-pro --at 600,100

# 改标题 / 改正文 / 改提示词
vc canvas node set <画布编号> n_ab12cd34 --label "新标题"
vc canvas node set <画布编号> n_ab12cd34 --text "改过的正文"

# 删节点：连着它的线、分镜里的挂接、成片顺序会一起清掉
vc canvas node rm <画布编号> n_ab12cd34
```

**每一次都要人工确认**，这是硬约束：

1. 先读当前画布，把「要改什么」逐行打到终端（新建什么节点、改哪些字段、删几个节点连带几条连线）。
2. 等你在终端输入 `yes` 回车。输入其它内容、直接回车、按 Ctrl-C 都算取消，退出码 `4`，画布一个字节都不会改。
3. 确认后带着**刚才读到的那个 `revision`** 提交。如果这期间画布被别人改了，服务端返回 409，
   而不是把你没看过的版本覆盖掉。
4. 服务端返回的 `changes` 才是实际落库的差异，CLI 会把它打出来。

没有 `--yes`、没有 `--force`、也不能和 `--json` 一起用：**脚本无法在无人确认的情况下做节点级修改**。
脚本要批量改画布，用 `canvas graph` + `canvas save`（整图，带乐观锁）。

服务端会拒绝的情况（`10001`，消息里说明原因）：

- 节点 id 不存在，或想删的是组（组里还有成员，一次删除会静默拆散整组）。
- 按 `assetId` 建节点：素材归属不在这里校验，需要参考素材请用连线。
- 操作不合法（例如给导演台节点写提示词、给文本节点设模型）——与 Agent 的规则完全一致。

### 查生成任务

| 命令        | 参数                                         | 说明                                                     |
| ----------- | -------------------------------------------- | -------------------------------------------------------- |
| `task get`  | `<id\|task_ref>`                             | 数字走 `/generation-tasks/:id`，其它按 `ids=` 查         |
| `task wait` | `<id\|task_ref>`、`--timeout`、`--interval`  | timeout 1–86400（默认 600 秒），interval 1–3600（默认 3） |

- `task_ref` 是任务 id 的 32 位十六进制编码，**画布界面和日志里显示的就是它**，通常比数字 id 更好用。
- 终态是 `succeeded` / `failed` / `canceled` / `expired`。`failed` 会带上游的 `error_code` 与 `error_message`
  （例如 `video queue is full`），这是上游真实原因，不是 CLI 造的。
- `wait` 的状态变化写 stderr，最终结果写 stdout；`--json` 时 stdout 只有一行。
- **超时（退出码 3）不等于失败**：任务可能还在跑，用 `task get` 继续查或加大 `--timeout`。

### 运行记录

| 命令             | 说明                                                        |
| ---------------- | ----------------------------------------------------------- |
| `trace pull`     | 拉线上运行记录到 `.traces/`（已在 `.gitignore`，不要提交）  |
| `trace show`     | 看单次运行的完整记录                                        |
| `trace compare`  | 按 `harness_key` 等维度对比多次运行                         |

`trace` 把参数原样转发给 `scripts/agent-trace/agent-trace.mjs`，所以它与那份脚本的能力完全一致；
`--json`、`--base`、`--script` 是 CLI 自己的选项，不会透传。

- 独立安装包不带 `scripts/`，需要用 `--script <仓库>/scripts/agent-trace/agent-trace.mjs`
  或设置 `VC_AGENT_TRACE`；都没给会得到一条可操作的提示（退出码 2），而不是一句「请在仓库内运行」。
- `vc trace --help` 会被 CLI 拦下来打印 CLI 自己的用法；要看 agent-trace 的帮助，
  直接 `node <仓库>/scripts/agent-trace/agent-trace.mjs --help`。

### 环境变量

运行时：

| 变量                 | 作用                                                       |
| -------------------- | ---------------------------------------------------------- |
| `VC_API_BASE`        | API 地址，优先级低于 `--base`、高于已保存的凭据            |
| `VC_NO_UPDATE_CHECK` | 设为 `1` 彻底关掉升级检查                                  |
| `VC_AGENT_TRACE`     | `agent-trace.mjs` 的路径，等价于 `--script`                |
| `XDG_CONFIG_HOME`    | 改凭据目录（默认 `~/.config`）                             |

安装时（只影响安装脚本）：

| 变量         | 作用                                                    |
| ------------ | ------------------------------------------------------- |
| `VC_BASE`    | 站点地址，脚本默认已填当前站点                          |
| `VC_VERSION` | 指定版本，默认取服务端最新                              |
| `VC_PREFIX`  | Unix 安装前缀（默认 `~/.local`）；Windows 下是安装目录  |


## 边界与限制

**这一版 CLI 只负责「画布读写 + 任务查询」，不负责生产素材。** 下面几条是刻意没做的，不是遗漏：

- **不生成图片 / 视频**。没有 `generate` 子命令。生成要走画布界面点生成，或直接调服务端的
  `POST /generation-tasks`（请求里必须带本画布的 `canvas_id` 与节点 `node_id`，产物才会落回节点）；
  Agent 会话里对应的是 `generate_media` 工具。CLI 能做的只是用 `task wait` 盯着任务跑完。
- **不合成成片**。没有 `compose` 子命令。成片要在画布成片节点上点「重新合成」，或调
  `POST /canvas/:id/compose`（`asset_ids` 的顺序就是成片顺序，服务端不猜）。
- **不删除画布**。没有 `canvas delete`。建错了的画布只能在前端删除，CLI 不会替你做不可逆操作。
- **不做批量节点编辑**。`canvas node` 一次只改一个节点（`rm` 可一次删多个 id），
  并且**必须由人在终端确认**——没有跳过确认的开关，脚本也绕不过去。要程序化批量改，用
  `canvas graph` + `canvas save` 整图写回（同样有 `revision` 乐观锁）。
- **不做节点级扩展字段**。角色卡、分镜表、成片、导演台要填内嵌结构（人物设定、镜头行、段落顺序），
  CLI 不支持创建它们；能建的只有文本 / 图片 / 视频 / 音频四类普通节点，改的也只有标题、正文/提示词、模型。
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
| `节点级修改需要交互确认`                         | stdout/stdin 不是终端（脚本、管道） | 在终端里手动执行；批量改走 `canvas graph` + `canvas save`  |
| 节点级修改退出码 4                               | 没输入 `yes`，或按了 Ctrl-C         | 重新执行并输入 `yes`；取消是预期行为，画布没动             |
| 节点级修改返回 409（`30002`）                    | 确认期间画布被别处改了              | 重新执行，让 CLI 读到新版本后重新展示差异                  |
| `不支持按 assetId 建节点`                        | 想用已有素材直接建图片节点          | 改成先建节点再连线，或在画面上传素材                       |

## 与 MCP 接入的区别

| 对比项   | MCP 接入                               | 命令行（CLI）                   |
| -------- | -------------------------------------- | ------------------------------- |
| 谁在用   | AI 工具（Claude、Cursor 等）           | 人和脚本                        |
| 凭据     | 项目令牌 `vcm_…`，有有效期，可随时注销 | 设备授权换来的登录态，存本机    |
| 怎么授权 | 在「MCP 接入」页签发令牌               | 执行 `vc login`，网页确认用户码 |
| 能力范围 | 按项目勾选的权限档位                   | 与网页登录同等，限本人名下数据  |

两者互不依赖：用 CLI 不需要建 MCP 项目，签发 MCP 令牌也不影响 CLI 的登录态。
