import type { FormEvent } from "react";
import { useState } from "react";
import { Cable, KeyRound, Plus, Terminal } from "lucide-react";

import type { MCPProjectItem, MCPTokenItem } from "@/api/admin/mcp-project/type";
import { confirm } from "@/components/admin-ui/confirm-dialog";
import {
  CopyBlock,
  CopyBlockCode,
  CopyBlockHeader,
  CopyBlockTitle,
} from "@/components/admin-ui/copy-block";
import { CopyButton } from "@/components/admin-ui/copy-button";
import { DataPage, DataPanel, DataPanelBody } from "@/components/admin-ui/data-panel";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/admin-ui/empty-state";
import { FormField } from "@/components/admin-ui/form-field";
import { Notice } from "@/components/admin-ui/notice";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderTitle,
} from "@/components/admin-ui/page-header";
import { RowAction } from "@/components/admin-ui/row-action";
import {
  SecretReveal,
  SecretRevealActions,
  SecretRevealCode,
  SecretRevealHint,
  SecretRevealTitle,
  SecretRevealValue,
} from "@/components/admin-ui/secret-reveal";
import { Tag } from "@/components/admin-ui/tag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TOKEN_STATUS_LABEL,
  formatMCPTime,
  mcpConfigSnippet,
  scopeLabel,
  tokenStatus,
} from "@/utils/admin/mcp-project";
import { useNow } from "@/hooks/use-now";

import { CopySecretButton } from "./copy-secret-button";
import { ProjectDialog, type ProjectDialogTarget } from "./project-dialog";
import type { MCPProjectsAudience, MCPProjectsState } from "./use-mcp-projects";

const PANEL =
  "bg-chrome ring-chrome-border mb-4 rounded-3xl p-4 shadow-lg ring-1 backdrop-blur-xl backdrop-saturate-150";

/** 项目表格。 */
function ProjectTable({
  state,
  mode,
  onEdit,
}: {
  state: MCPProjectsState;
  mode: MCPProjectsAudience;
  onEdit: (item: MCPProjectItem) => void;
}) {
  if (state.items.length === 0) {
    return (
      <EmptyState className="m-4">
        <EmptyStateIcon>
          <Cable />
        </EmptyStateIcon>
        <EmptyStateTitle>还没有接入项目</EmptyStateTitle>
      </EmptyState>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableHead className="px-4">名称</TableHead>
          <TableHead>能力</TableHead>
          <TableHead>令牌</TableHead>
          <TableHead>最近使用</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="w-40 px-4 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.items.map((item) => (
          <TableRow key={item.id} data-project-id={item.id}>
            {/* 归属用户与默认画布是「一个项目就一个」的配置项，各占一列等于重复铺排，
                压成名称下面的一行副标题，主列留给真正会扫的信息（能力 / 令牌 / 使用 / 状态） */}
            <TableCell className="px-4 py-3">
              <div className="font-medium">{item.name}</div>
              <div className="text-muted-foreground text-xs">
                {mode === "admin" && <>{item.owner_name || `#${item.owner_user_id}`} · </>}
                {item.canvas_code ? (
                  <span title={item.canvas_code}>
                    默认画布「{item.canvas_title || `${item.canvas_code.slice(0, 8)}…`}」
                  </span>
                ) : (
                  "每次调用指定画布"
                )}
              </div>
            </TableCell>
            <TableCell className="py-3">
              <div className="flex flex-wrap gap-1">
                {item.scopes.length === 0 ? (
                  <span className="text-muted-foreground text-xs">未开放</span>
                ) : (
                  item.scopes.map((s) => (
                    <Tag key={s} tone="neutral">
                      {scopeLabel(s)}
                    </Tag>
                  ))
                )}
              </div>
            </TableCell>
            <TableCell className="py-3 tabular-nums">{item.token_count}</TableCell>
            <TableCell className="text-muted-foreground py-3 tabular-nums">
              {formatMCPTime(item.last_used_at)}
            </TableCell>
            <TableCell className="py-3">
              <Tag tone={item.enabled ? "success" : "neutral"}>
                {item.enabled ? "启用中" : "已停用"}
              </Tag>
            </TableCell>
            <TableCell className="px-4 py-3 text-right whitespace-nowrap">
              <RowAction aria-label={`编辑 ${item.name}`} onClick={() => onEdit(item)}>
                编辑
              </RowAction>
              <RowAction
                aria-label={`${item.name} 的令牌`}
                onClick={() => state.toggleTokens(item.id)}
              >
                令牌
              </RowAction>
              <RowAction
                aria-label={item.enabled ? `停用 ${item.name}` : `启用 ${item.name}`}
                onClick={() => void state.setEnabled(item, !item.enabled)}
              >
                {item.enabled ? "停用" : "启用"}
              </RowAction>
              <RowAction
                tone="danger"
                aria-label={`删除 ${item.name}`}
                onClick={() =>
                  void confirm({
                    title: `删除「${item.name}」？`,
                    description: "令牌一并删除，外部工具立刻断开，不可恢复",
                    destructive: true,
                    confirmLabel: "删除",
                    onConfirm: () => state.remove(item),
                  })
                }
              >
                删除
              </RowAction>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** 令牌状态标签。 */
function TokenStatusTag({ token, now }: { token: MCPTokenItem; now: number }) {
  const status = tokenStatus(token, now);
  const tone = status === "active" ? "success" : status === "expired" ? "warning" : "neutral";
  return <Tag tone={tone}>{TOKEN_STATUS_LABEL[status]}</Tag>;
}

/** 刚签发令牌的明文块：明文只在这里出现，附可直接粘贴的配置片段。 */
function IssuedTokenPanel({
  state,
  project,
}: {
  state: MCPProjectsState;
  project: MCPProjectItem;
}) {
  if (!state.issued) return null;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const snippet = mcpConfigSnippet(state.issued.token, state.issued.endpoint, origin);
  return (
    <SecretReveal className="mb-4">
      <SecretRevealTitle>令牌已签发：明文只显示这一次</SecretRevealTitle>
      <SecretRevealValue>
        <SecretRevealCode>{state.issued.token}</SecretRevealCode>
        <CopyButton text={state.issued.token} variant="outline" />
      </SecretRevealValue>
      <SecretRevealHint>
        粘贴到外部 AI 工具的配置里即可连接；端点 {origin}
        {state.issued.endpoint}，默认画布「
        {project.canvas_title || project.canvas_code || "未设，调用时指定"}」。
      </SecretRevealHint>
      <SecretRevealActions>
        <CopyButton text={snippet} label="复制配置片段" variant="outline" />
        <Button variant="ghost" size="sm" onClick={state.clearIssued}>
          我已保存
        </Button>
      </SecretRevealActions>
    </SecretReveal>
  );
}

/** 令牌面板：签发表单 + 令牌列表。 */
function TokenPanel({
  state,
  project,
  now,
}: {
  state: MCPProjectsState;
  project: MCPProjectItem;
  now: number;
}) {
  const form = state.tokenForm;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void state.issue(project.id, form);
  };
  // 一个项目只留一枚令牌：已有就说明这次是轮换，旧令牌会立刻失效
  const rotating = state.tokens.length > 0;
  return (
    <section className={PANEL} data-slot="mcp-token-panel">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="size-4" aria-hidden="true" />「{project.name}」的令牌
      </h2>
      <IssuedTokenPanel state={state} project={project} />
      <form onSubmit={submit} noValidate className="mb-4 flex flex-wrap items-start gap-3">
        <FormField label="用途" htmlFor="mcp-token-name" className="min-w-44 flex-1">
          <Input
            id="mcp-token-name"
            value={form.name}
            placeholder="如：本机 Codex"
            onChange={(e) => state.setTokenForm({ ...form, name: e.target.value })}
          />
        </FormField>
        <FormField
          label="有效期（天，1–90）"
          htmlFor="mcp-token-days"
          hint="留空用后台配的默认值"
          className="w-40"
        >
          <Input
            id="mcp-token-days"
            type="number"
            inputMode="numeric"
            min={1}
            max={90}
            value={form.days}
            onChange={(e) => state.setTokenForm({ ...form, days: e.target.value })}
          />
        </FormField>
        <Button type="submit" disabled={state.busy} className="mt-[22px]">
          <Plus />
          {rotating ? "重新签发" : "签发"}
        </Button>
      </form>
      {state.tokensLoading ? (
        <p className="text-muted-foreground text-sm">加载中…</p>
      ) : state.tokens.length === 0 ? (
        <p className="text-muted-foreground text-sm">还没有令牌。签发一个，外部工具才连得上。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="px-4">用途</TableHead>
              <TableHead>前缀</TableHead>
              <TableHead>到期</TableHead>
              <TableHead>最近使用</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-20 px-4 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.tokens.map((token) => (
              <TableRow key={token.id} data-token-id={token.id}>
                <TableCell className="px-4 py-3 font-medium">{token.name}</TableCell>
                <TableCell className="py-3 font-mono text-xs">{token.prefix}…</TableCell>
                <TableCell className="py-3 tabular-nums">
                  {formatMCPTime(token.expires_at)}
                </TableCell>
                <TableCell className="text-muted-foreground py-3 tabular-nums">
                  {formatMCPTime(token.last_used_at)}
                </TableCell>
                <TableCell className="py-3">
                  <TokenStatusTag token={token} now={now} />
                </TableCell>
                <TableCell className="px-4 py-3 text-right whitespace-nowrap">
                  {token.has_secret && tokenStatus(token, now) === "active" && (
                    <CopySecretButton load={() => state.tokenSecret(project.id, token)} />
                  )}
                  {!token.revoked_at && (
                    <RowAction
                      tone="danger"
                      aria-label={`注销 ${token.name}`}
                      onClick={() =>
                        void confirm({
                          title: `注销「${token.name}」？`,
                          description: "立即失效，不可恢复",
                          destructive: true,
                          confirmLabel: "注销",
                          onConfirm: () => state.revoke(project.id, token),
                        })
                      }
                    >
                      注销
                    </RowAction>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/**
 * MCP 接入页：说明、新建表单、项目表格、选中项目的令牌面板。
 * 外部 AI 工具用这里签发的令牌连接 /api/v1/mcp；令牌明文只在签发后显示一次。
 *
 * @param mode admin = 后台代管（能指定归属用户、看全部项目）；self = 用户自己的接入
 */
export function MCPProjectsView({
  state,
  mode = "admin",
}: {
  state: MCPProjectsState;
  mode?: MCPProjectsAudience;
}) {
  const now = useNow(true, 60_000);
  const selected = state.items.find((item) => item.id === state.selectedId) ?? null;
  // 新建 / 编辑共用一个弹窗，和后台其他配置页一致
  const [target, setTarget] = useState<ProjectDialogTarget | null>(null);
  return (
    <DataPage>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>{mode === "admin" ? "MCP 接入" : "我的 MCP 接入"}</PageHeaderTitle>
        </PageHeaderHeading>
        <PageHeaderActions>
          <Button onClick={() => setTarget({ kind: "new" })}>
            <Plus />
            新建接入项目
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <Notice tone="info" title="外部 AI 工具怎么连" className="mb-4">
        新建一个项目、勾上要开放的能力 → 签发令牌 → 把下面的配置片段贴进工具。 令牌代表你把
        <strong>自己名下</strong>的画布授权给这个工具，能看和改的范围由权限档位决定，
        具体操作哪块画布由每次调用指定（没指定就用项目的默认画布）。
        停用项目或注销令牌都会立刻断开。勾了「生成素材」，外部工具就能直接出图、出视频、出配音，
        花的是<strong>你名下</strong>的积分；删除节点不开放。
      </Notice>

      <AccessInfo />

      <DataPanel>
        <DataPanelBody>
          {state.loading ? (
            <p className="text-muted-foreground p-4 text-sm">加载中…</p>
          ) : (
            <ProjectTable
              state={state}
              mode={mode}
              onEdit={(item) => setTarget({ kind: "edit", item })}
            />
          )}
        </DataPanelBody>
      </DataPanel>

      {selected && <TokenPanel state={state} project={selected} now={now} />}

      <CLISetupPanel />

      {target && <ProjectDialog target={target} state={state} onClose={() => setTarget(null)} />}
    </DataPage>
  );
}

/**
 * 命令行（CLI）：与 MCP 并列的第二种接入方式，但它不是 MCP 的替代品。
 *
 * MCP 是给「AI 工具」用的长期令牌，令牌代表用户授权；CLI 是给「人和脚本」用的，
 * 走设备码登录换一枚自己的登录态，不经过令牌、也不消耗令牌有效期。
 * 两者共用同一套画布与生成能力，区别只在「谁来调」。
 */
function CLISetupPanel() {
  const origin = typeof window === "undefined" ? "" : window.location.origin.replace(/\/$/, "");
  const install = `# 在连镜仓库根目录执行（一次性）
npm i -g ./cli

# 不想全局安装，就直接跑
node ./cli/bin/vc.mjs --help`;
  const login = `# 打印一个用户码并自动打开浏览器确认
vc login --base ${origin}

# 确认后本地留存登录态，之后不用再带 --base
vc whoami`;
  const basics = `vc canvas list                  # 我的画布
vc canvas get <画布编号>         # 画布详情
vc canvas export <画布编号> -o 画布.json
vc task get <任务ID>             # 生成任务状态
vc task wait <任务ID>            # 阻塞到出结果
vc trace pull --since 7d         # 拉取线上 Agent 运行记录`;
  const scripting = `vc canvas list --json            # 一行 JSON：{ok,data} / {ok:false,error}
# 退出码：0 成功，1 业务或网络错误，2 用法错误`;
  return (
    <section className={`${PANEL} grid gap-3`} data-slot="cli-setup">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Terminal className="size-4" aria-hidden="true" /> 命令行（CLI）
      </h2>
      <p className="text-muted-foreground text-xs">
        独立于 MCP 的接入方式：MCP 令牌是发给<strong>AI 工具</strong>的，CLI 是给
        <strong>人或者脚本</strong>直接用的。CLI 不走令牌，登录时打开浏览器确认一次，
        换的是你自己的登录态，存在本机 <code>~/.config/video-canvas/</code>
        （目录 0700、文件 0600）。 两者能做的事一样：读写自己名下的画布、查生成任务、导运行记录。
      </p>
      <CopyBlock>
        <CopyBlockHeader>
          <CopyBlockTitle>安装（需要 Node 18+）</CopyBlockTitle>
          <CopyButton text={install} />
        </CopyBlockHeader>
        <CopyBlockCode>{install}</CopyBlockCode>
      </CopyBlock>
      <CopyBlock>
        <CopyBlockHeader>
          <CopyBlockTitle>登录（当前站点 {origin}）</CopyBlockTitle>
          <CopyButton text={login} />
        </CopyBlockHeader>
        <CopyBlockCode>{login}</CopyBlockCode>
      </CopyBlock>
      <CopyBlock>
        <CopyBlockHeader>
          <CopyBlockTitle>常用命令</CopyBlockTitle>
          <CopyButton text={basics} />
        </CopyBlockHeader>
        <CopyBlockCode>{basics}</CopyBlockCode>
      </CopyBlock>
      <CopyBlock>
        <CopyBlockHeader>
          <CopyBlockTitle>脚本与 Agent 调用</CopyBlockTitle>
          <CopyButton text={scripting} />
        </CopyBlockHeader>
        <CopyBlockCode>{scripting}</CopyBlockCode>
      </CopyBlock>
      <p className="text-muted-foreground text-xs">
        CLI 目前随仓库分发，没有发布到 npm；换机器就把仓库带过去重装一次。 登录态过期或用{" "}
        <code>vc logout</code> 后重新 <code>vc login</code> 即可。
      </p>
    </section>
  );
}

/**
 * 接入信息：端点和配置片段常驻，随时可复制。
 *
 * 令牌明文只在签发那一次显示，所以这里的片段用占位符——骨架（地址、请求头形式）随时要能抄，
 * 令牌用自己的那串填进去即可。
 */
function AccessInfo() {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = `${origin.replace(/\/$/, "")}/api/v1/mcp`;
  const snippet = mcpConfigSnippet("<你的令牌>", "/api/v1/mcp", origin);
  return (
    <section className={`${PANEL} grid gap-3`} data-slot="mcp-access-info">
      <h2 className="text-sm font-semibold">接入信息</h2>
      <p className="text-muted-foreground text-xs">
        timeout 是客户端最多等多久；服务端另有单次调用上限（管理员在「注册设置」里调，默认 60 秒），
        和令牌有效期不是一回事：有效期决定什么时候失效，超时决定一次调用最多等多久。
      </p>
      <CopyBlock>
        <CopyBlockHeader>
          <CopyBlockTitle>端点</CopyBlockTitle>
          <CopyButton text={endpoint} />
        </CopyBlockHeader>
        <CopyBlockCode>{endpoint}</CopyBlockCode>
      </CopyBlock>
      <CopyBlock>
        <CopyBlockHeader>
          <CopyBlockTitle>配置片段（把 &lt;你的令牌&gt; 换成签发的值）</CopyBlockTitle>
          <CopyButton text={snippet} />
        </CopyBlockHeader>
        <CopyBlockCode>{snippet}</CopyBlockCode>
      </CopyBlock>
    </section>
  );
}
