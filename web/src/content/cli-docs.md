# 连镜命令行（video-canvas-cli）

给人和脚本用的命令行：设备码登录，不用把密码或长期令牌交给脚本；画布、生成任务、运行记录都走已有的 HTTP 接口。

零第三方依赖，Node 18+。装好后有两个等价的命令名：`vc` 与 `video-canvas-cli`。

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
  canvas export <code> [-o 文件]
  canvas graph <code> [-o 文件]
  canvas save <code> --payload 文件 [--revision N]

生成任务
  task get <id|task_ref>
  task wait <id|task_ref> [--timeout 600] [--interval 3]

运行记录（转发 scripts/agent-trace）
  trace pull [--since 7d] [--feedback down]
  trace show <run_id>
  trace compare --by harness_key [--since 30d]

全局选项
  --json          输出一行 JSON（{ok,data} / {ok:false,error}），供脚本与 Agent 解析
  --base URL      覆盖 API 地址（也可用环境变量 VC_API_BASE）
```

## 安装

从源码装（当前唯一支持的方式）：

```bash
cd cli
npm link            # 之后可以直接敲 vc / video-canvas-cli
```

不装也能跑：

```bash
node cli/bin/vc.mjs --help
```

`npm link` 只是把仓库里的 `bin/vc.mjs` 链到全局 bin，不会联网下载任何东西，升级就是 `git pull`。

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

# 5. 把画布整图导到本地
vc canvas export <画布编号> -o 画布.json

# 6. 改完写回；带 --revision 才是乐观锁，别处改过会直接失败
vc canvas save <画布编号> --payload 画布.json --revision 3

# 7. 提交一个生成任务，再等它结束（阻塞到出结果或超时）
vc task wait <任务ID> --timeout 600

# 8. 收工：删掉本机凭据
vc logout
```

画布编号是 32 位十六进制串（`idcodec` 编出来的对外编号），不是数据库自增 id。

## 多站点与凭据

凭据存在 `$XDG_CONFIG_HOME/video-canvas/credentials.json`（没设 XDG 就是 `~/.config/video-canvas/`），
目录 `0700`、文件 `0600`，里面有站点地址、令牌、过期时间、设备名。

| 想做什么       | 怎么做                                                    |
| -------------- | --------------------------------------------------------- |
| 换到另一个站点 | `vc login --base https://另一站点`，覆盖旧凭据            |
| 临时指定地址   | `--base` 或环境变量 `VC_API_BASE`，优先级高于已保存的地址 |
| 看登录的是谁   | `vc whoami`                                               |
| 清掉本地凭据   | `vc logout`                                               |

`--base` 给站点根或完整的 `/api/v1` 都可以，两种写法等价。

## 协议契约

### stdout 与 stderr 的分工

| 流     | 内容                                                     |
| ------ | -------------------------------------------------------- |
| stdout | 只有结果：人类可读的表格，或 `--json` 时的一行 JSON      |
| stderr | 进度、提示、等待状态。`task wait` 的每次状态变化都写这里 |

所以 `vc canvas list --json | jq '.data[]'` 可以直接用，不会被进度日志污染。

### JSON 输出

成功：

```json
{ "ok": true, "data": { "...": "..." } }
```

失败：

```json
{ "ok": false, "error": { "code": 40004, "message": "任务不存在" } }
```

`code` 是服务端错误码原样透出；网络层失败用负数（`-1`）。

### 退出码

| 退出码 | 含义                                       | 脚本里的处置                                  |
| ------ | ------------------------------------------ | --------------------------------------------- |
| 0      | 成功                                       | 继续                                          |
| 1      | 业务错误或网络错误（含等待超时）           | 读 stderr / `--json` 的 `error`，不要盲目重试 |
| 2      | 用法错误：参数缺失、文件名写错、命令不存在 | 修命令行本身                                  |

### 等待与轮询

`task wait` 默认每 3 秒查一次，600 秒超时；可用 `--interval`、`--timeout` 调。
登录轮询按服务端给的 `interval` 走；服务端返回 `slow_down` 时自动加 5 秒，这是限频，不是故障。

## 命令参考

| 命令            | 作用                                           | 注意                                          |
| --------------- | ---------------------------------------------- | --------------------------------------------- |
| `canvas list`   | 列出我名下的画布（编号、版本、更新时间、标题） | 只含自己创建的画布                            |
| `canvas get`    | 画布详情，含节点与连线                         | 输出较大，配合 `-o` 或 `--json`               |
| `canvas create` | 建画布，可带 `--payload` 直接灌图              | 不带 `--payload` 就是空画布                   |
| `canvas import` | 从导出文件建**新**画布                         | 不会覆盖已有画布                              |
| `canvas export` | 整图导出为 JSON 文件                           | 文件里不含令牌与素材二进制                    |
| `canvas graph`  | 只取 `payload_json`（节点与连线）              | 适合 diff、脚本处理                           |
| `canvas save`   | 整图保存                                       | 走 `revision` 乐观锁，见下                    |
| `task get`      | 查一次生成任务                                 | 任务 ID 支持数字 id 与 `task_ref`             |
| `task wait`     | 阻塞到任务终态                                 | 终态：succeeded / failed / canceled / expired |
| `trace *`       | 拉取线上 Agent 运行记录                        | 参数与 `scripts/agent-trace` 完全一致         |

`canvas save` 的冲突语义：没给 `--revision` 时会先读一次当前版本再提交，这是「尽力而为」；
给了 `--revision` 才是严格乐观锁，画布在别处被改过就直接失败，**不会覆盖别人的修改**。

## 边界与限制

- **不做节点级增删改**。CLI 只做整图读写；节点级语义在服务端 `canvas_apply_ops`（Agent 会话/平台桥）那套里，CLI 刻意不复制，避免两套语义各自漂移。
- **不封装管理端接口**。渠道、模型、用户管理这些管理员操作没有做进 CLI——脚本令牌不应该顺手改平台配置。
- **未发布到 npm**。随仓库分发，换机器就带仓库过去重装一次。
- **令牌等同网页登录态**。它和你浏览器里的登录是同一套 JWT：改密码会一起失效，服务端没有单独的吊销列表。

## 排障

| 现象                                   | 原因                      | 处置                                           |
| -------------------------------------- | ------------------------- | ---------------------------------------------- |
| `登录已过期或被撤销，请重新执行 login` | 令牌过期，或改过密码      | `vc login` 重登                                |
| `授权已过期，请重新执行登录`           | 用户码超过 10 分钟        | 重跑 `vc login`，用户码一次一换                |
| `这个设备码已经被使用`                 | 同一个码被确认了两次      | 重跑 `vc login`                                |
| `画布已在别处修改`（409）              | 保存时 `revision` 落后    | 重新 `canvas export` 合并后，用新版本号再 save |
| `缺少 API 地址`                        | 既没 `--base`，也没登录过 | 首次使用就带 `--base`                          |
| `找不到 agent-trace`                   | 不在仓库内运行            | `cd` 到仓库根再执行 `trace`                    |
| 等待超时                               | 任务确实没结束            | 加大 `--timeout`，或改用 `task get` 轮询       |

## 与 MCP 接入的区别

| 对比项   | MCP 接入                               | 命令行（CLI）                   |
| -------- | -------------------------------------- | ------------------------------- |
| 谁在用   | AI 工具（Claude、Cursor 等）           | 人和脚本                        |
| 凭据     | 项目令牌 `vcm_…`，有有效期，可随时注销 | 设备授权换来的登录态，存本机    |
| 怎么授权 | 在「MCP 接入」页签发令牌               | 执行 `vc login`，网页确认用户码 |
| 能力范围 | 按项目勾选的权限档位                   | 与网页登录同等，限本人名下数据  |

两者互不依赖：用 CLI 不需要建 MCP 项目，签发 MCP 令牌也不影响 CLI 的登录态。
