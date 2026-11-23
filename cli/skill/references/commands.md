# vc 命令全集（参数 · 默认值 · 返回结构）

按 `vc --help` 与站点 `/cli/docs` 对齐，章节顺序与 SKILL.md 的业务主线一致，方便按阶段查。
**这里不写具体模型 key、站点域名、画布编号**：那些每次都不一样，现场用 `model list` / `whoami` 取。

所有命令都吃全局选项：

| 全局选项            | 作用                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `--json`            | 输出一行 `{"ok":true,"data":…}` 或 `{"ok":false,"error":{code,message}}`；进度仍写 stderr |
| `--base URL`        | 覆盖 API 地址（等价环境变量 `VC_API_BASE`），站点根或完整的 `/api/v1` 都行                |
| `--no-update-check` | 本次不查新版本（等价 `VC_NO_UPDATE_CHECK=1`）                                             |
| `-o, --output 文件` | 仅 `canvas graph` / `canvas export`：写文件；`-o -` 写 stdout                             |

退出码：`0` 成功 · `1` 业务/网络错误或任务失败 · `2` 用法错误（含「需要交互确认」被拒） ·
`3` 等待超时（任务仍在跑） · `4` 新建项目 / 节点级修改被取消。

---

## 一、接入：身份与会话

| 命令      | 参数                                     | 说明                                                                       |
| --------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `login`   | `--base URL`、`--name 名称`、`--no-open` | 设备码登录；授权地址与用户码写 stderr（`--json` 也一样）。登录态默认 30 天 |
| `logout`  | ——                                       | 只删本地凭据，不动服务端令牌                                               |
| `whoami`  | ——                                       | 实时调 `/me`，可当健康检查                                                 |
| `version` | `--json`                                 | 也可写 `--version` / `-v`；版本只读 `package.json`                         |

`login` 的轮询：服务端给 `slow_down` 时自动加间隔（限频，不是故障）；`denied` / `expired` / `consumed` / 超时都是退出码 1。

## 二、项目：读取、新建、备份与迁移

| 命令            | 参数                                              | 说明                                                     |
| --------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `canvas list`   | `--page N`、`--page-size N`                       | 返回 `{list,total,page,page_size}`                       |
| `canvas get`    | `<画布编号>`                                      | 节点在 `data.payload_json`                               |
| `canvas graph`  | `<画布编号>`、`-o 文件`                           | 只取 `{nodes, edges, viewport}`，可写回                  |
| `canvas create` | `--title`（默认「未命名画布」）、`--payload 文件` | **需终端确认**；payload 要 graph 形态                    |
| `canvas import` | `<导出文件.json>`                                 | **需终端确认**；只新建，不覆盖                           |
| `canvas export` | `<画布编号>`、`-o 文件`                           | 导出文档（`format`/`canvas`/`assets`），只给 `import` 用 |

新建与导入的确认：先打印标题、节点/连线数量（或素材份数）、来源，等终端输入 `yes`；
`--json` 与非交互终端一律拒绝（退出码 2），取消是退出码 4。没有 `--yes` 旁路。

## 三、素材：模型、积分、生成与等结果

| 命令         | 参数                               | 返回                                                                        |
| ------------ | ---------------------------------- | --------------------------------------------------------------------------- |
| `model list` | `--kind image\|video\|audio\|text` | 数组，元素含 `key` / `kind` / `label` / `hint` / `capabilities` / `pricing` |
| `model show` | `<模型key>`                        | 单个模型；人类可读输出逐条列参数（名、可选值或范围、默认）                  |
| `credits`    | ——                                 | `{balance, frozen, available}`                                              |

`model show` 读的是 `capabilities`：`ops` 是生成方式（如 t2i / i2v / omni），`params` 是「名字 → 字段」的对象
（`type` 为 `enum` / `number` / `boolean`），`refs` 是各类参考素材的开关与上限，`prompt.max` 是提示词字数上限。

```
generate <image|video|audio|text> --model <模型key>
         [--canvas <画布编号> --node <节点id>] [--prompt <提示词>]
         [--param 名=值]... [--input '<json>'|@文件|-]
         [--ref-image <素材id>]... [--ref-video <素材id>]... [--ref-audio <素材id>]...
         [--count 1] [--wait] [--timeout 600] [--interval 3]
         [--idempotency-key <值>]
```

| 参数                       | 默认           | 规则                                                                                  |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `<kind>`                   | 必填（第一项） | 只收 `image` / `video` / `audio` / `text`；`agent` 类模型不能提交生成                 |
| `--model`                  | 必填           | 从 `model list` 取                                                                    |
| `--canvas`                 | ——             | 与 `--node` **必须成对**；都不给＝临时任务                                            |
| `--node`                   | ——             | 任务绑在这个节点上，用于画布回填与生成记录                                            |
| `--prompt`                 | ——             | 等价 `input.prompt`                                                                   |
| `--param`                  | ——             | 可重复；值先按 JSON 解释，失败按字符串                                                |
| `--input`                  | ——             | JSON 字符串 / `@文件` / `-`（stdin）；与 `--param`、`--prompt` 合并（后者覆盖同名键） |
| `--ref-*`                  | ——             | 可重复或逗号分隔；落进 `input.images` / `videos` / `audios`，值须为纯数字素材 id      |
| `--count`                  | `1`（≤8）      | 拆成 N 个任务，全部绑同一个节点；无 `--node` 时不能用                                 |
| `--wait`                   | 不加           | 阻塞到终态；不加就只提交并打印任务号                                                  |
| `--timeout` / `--interval` | `600` / `3`    | 只在 `--wait` 时生效                                                                  |
| `--idempotency-key`        | 随机 UUID      | 重试时复用它才不会建出两个任务                                                        |

返回：`{items: [{node_id, task?, error?}]}`。全部失败时命令直接报错（退出码 1）；部分失败会打印失败项，
成功的照常生成。`--wait` 后 `data.tasks` 是终态任务（含 `outputs[].url`）。

等结果与查任务：

| 命令        | 参数                                        | 说明                                                                             |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `task get`  | `<id\|task_ref>`                            | 纯数字走 `/generation-tasks/:id`，编码串按 `ids=` 查                             |
| `task wait` | `<id\|task_ref>`、`--timeout`、`--interval` | 终态 `succeeded` / `failed` / `canceled` / `expired`；失败退出码 1，超时退出码 3 |

`task_ref` 是任务 id 的 32 位十六进制编码，界面与日志里显示的就是它。

## 四、画布：节点级修改与整图写回

| 命令              | 参数                                                                                                       | 说明                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `canvas node add` | `<画布编号>`、`--kind script\|image\|video\|audio`、`--label`、`--text`、`--prompt`、`--model`、`--at x,y` | **需终端确认**                                                                               |
| `canvas node set` | `<画布编号>`、`<节点id>`、`--label` / `--text` / `--prompt` / `--model`                                    | **需终端确认**；只提交差异                                                                   |
| `canvas node rm`  | `<画布编号>`、`<节点id>...`                                                                                | **需终端确认**；连带清连线、分镜挂接、成片顺序；组不能删                                     |
| `canvas save`     | `<画布编号>`、`--payload 文件`、`--revision N`                                                             | 整图保存；不给 revision 先读当前值（「尽力而为」），给了才是严格乐观锁（冲突 409 / `30002`） |

节点级编辑的确认流程：读当前图 → 逐行列出要改什么 → 等 `yes` → 带读到的 `revision` 提交（期间被改则 409）。
`--json` 与非交互终端一律拒绝；脚本批量改走 `canvas graph` + `canvas save`。

## 五、成片：合成、对账与取消

```
canvas compose <画布编号> --node <成片节点id> [--assets id,id] [--seqs 1,2,3]
               [--mode storyboard|compose|selection] [--wait] [--timeout 900] [--interval 5]
canvas compose-status <画布编号> [--job <任务id> | --node <成片节点id> [--assets id,id]]
canvas compose-cancel <画布编号> --job <任务id>
```

- 不给 `--assets` 时读一次画布推导顺序（`composeOrder` 优先，其余按 (y,x)，每段取 `activeOutputId` 对应版本），
  并把 SEQ / ASSET / NODE / LABEL 四列打出来；没有可用素材时报错而不提交。
- 任务字段：`id`、`status`（`queued` / `running` / `succeeded` / `failed` / `canceled`）、`segment_count`、
  `duration_ms`、`result_asset_id`、`result_asset_url`、`error`。
- `compose-status --node` 不带 `--assets` 时不判断「是否过期」；带上才返回 `stale`。
- 同一节点同时只允许一个未落终态的任务。

## 六、画布 Agent（小镜）

```
agent run <画布编号> --message "…" [--selection 节点id,节点id] [--budget 积分]
          [--session 会话编号] [--watch] [--interval 2] [--timeout 600]
agent events <会话编号> [--after 序号]
agent approve <审批编号> [--items 0,1] [--reject] [--answer 文本]
agent cancel <运行编号>
```

- `run` 返回 `{session_id, run:{id, session_id, status}}`。不发 `--session` 时复用该画布已有的会话（没有就新建一条，
  标题「命令行」）；网页与命令行看的是同一条会话。
- `--selection` 是节点 id 列表，圈定这次允许它动的范围；不给由它自己读画布。
- `--budget` 换算成这一轮的花费上限（积分），不给用服务端默认。
- `--watch` 从会话**当前序号之后**开始跟：只打印本轮新事件，不重放历史；遇到「有正文的回复」「审批」「运行结束」
  任一情况就返回，不会干等到超时。退出码 3 表示等到 `--timeout` 仍未出现上述三种。
- 事件形如 `{session_id, canvas_id, run_id, seq, type, data, created_at}`。`type` 常见值：
  `message.user`、`run.status`、`tool.start` / `tool.end`、`message.done`（`data.text` 是正文）、
  `approval.created`（`data.id` 是审批编号，`data.payload` 是要批准的动作）、`run.usage`、`run.finished`。
- `approve`：`decision` 为 `approve` / `reject`；`--items` 只批指定序号（不传表示整批通过），
  `--answer` 回答它顺带提出的问题。返回审批视图（`id` / `kind` / `status` / `payload` / `quote_credits` / `expires_at`）。
- `cancel` 只停这一轮；它已经提交的生成任务在服务端继续跑完、产物照常写回节点。

## 七、短剧（只读 + 任务控制）

| 命令               | 参数                                 | 说明                                                                                         |
| ------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `drama list`       | `--keyword`、`--page`、`--page-size` | 返回 `{list,total,page,page_size}`                                                           |
| `drama get`        | `<短剧编号>`、`--episodes 10`        | 集多时只列前 N 集（`0` 全部）；含 `canvas_id`、`phase`、暂停原因                             |
| `drama units`      | `<短剧编号>`、`--from`、`--to`       | 单元号区间；服务端返回 `{items:[…]}`，字段 `no` / `title` / `chars`                          |
| `drama unit`       | `<短剧编号>`、`<单元号>`             | 单个单元正文                                                                                 |
| `drama jobs`       | `<短剧编号>`、`--active`             | 字段 `step` / `status` / `progress` / `episodes` / `lane` / `credits`；集号超过 6 个自动压缩 |
| `drama job-cancel` | `<短剧编号>`、`--job`                | 取消未落终态的任务                                                                           |

短剧编号与画布编号同一套编码（32 位十六进制）。建项目、规划、生成剧本、分集出片不在 CLI 范围。

## 贯穿：运行记录

`trace pull` / `trace show` / `trace compare` 原样转发 `scripts/agent-trace/agent-trace.mjs`。
独立安装包不带该脚本，需 `--script <路径>` 或环境变量 `VC_AGENT_TRACE`。
