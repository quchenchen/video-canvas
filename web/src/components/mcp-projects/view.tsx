import { useState } from "react";
import { Cable, KeyRound, Plus } from "lucide-react";

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
import { Notice } from "@/components/admin-ui/notice";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderTitle,
} from "@/components/admin-ui/page-header";
import { RowAction } from "@/components/admin-ui/row-action";
import { Tag } from "@/components/admin-ui/tag";
import { Button } from "@/components/ui/button";
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
                aria-label={`${item.name} 的接入配置`}
                onClick={() => state.toggleTokens(item.id)}
              >
                配置
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

/**
 * 接入配置：一个项目一块，不再往下套一层「令牌列表」。
 *
 * 一个项目只有一枚令牌，用户真正要的是能粘进客户端的片段，所以展开就是片段本身：
 * 刚新建或刚重新生成时直接用响应里的明文，其余时候点一下按需取回（库里存的是 AES-GCM 密文）。
 */
function AccessPanel({
  state,
  project,
  now,
}: {
  state: MCPProjectsState;
  project: MCPProjectItem;
  now: number;
}) {
  const token = project.token ?? null;
  const issuedHere =
    state.issued && state.issued.item.project_id === project.id ? state.issued : null;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [failed, setFailed] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpointPath = issuedHere?.endpoint ?? "/api/v1/mcp";
  const plain = issuedHere?.token ?? revealed;
  const snippet = plain ? mcpConfigSnippet(plain, endpointPath, origin) : "";

  /** 按需取回明文：不自动拉，避免明文在用户没打算复制时也躺在屏幕上。 */
  const reveal = async () => {
    if (!token) return;
    setFetching(true);
    setFailed(false);
    try {
      setRevealed(await state.tokenSecret(project.id));
    } catch {
      setFailed(true);
    } finally {
      setFetching(false);
    }
  };

  const placeholder = fetching
    ? "正在取回令牌…"
    : failed
      ? "明文取不回来（这枚令牌签发时还没存密文），点下面「重新生成令牌」换一枚"
      : token
        ? "点「显示配置片段」取回令牌明文，才拼得出配置"
        : "这个项目还没有令牌，点「生成令牌」生成一枚";

  return (
    <section className={PANEL} data-slot="mcp-access-panel">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="size-4" aria-hidden="true" />「{project.name}」的接入配置
      </h2>
      <p className="text-muted-foreground mb-3 text-xs">
        端点{" "}
        <code className="font-mono">
          {origin}
          {endpointPath}
        </code>
        ；一个项目只有一枚令牌，重新生成会让旧令牌立刻失效。
      </p>
      {!project.enabled && (
        <Notice tone="warning" className="mb-3" title="项目已停用">
          外部工具现在连不上，配置片段先留着，启用后立即恢复。
        </Notice>
      )}
      <CopyBlock>
        <CopyBlockHeader>
          <CopyBlockTitle>客户端配置（粘进 Claude Desktop / Codex 等）</CopyBlockTitle>
          {snippet && <CopyButton text={snippet} />}
        </CopyBlockHeader>
        <CopyBlockCode>{snippet || placeholder}</CopyBlockCode>
      </CopyBlock>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {token ? <TokenStatusTag token={token} now={now} /> : null}
        {token && (
          <span className="text-muted-foreground text-xs tabular-nums">
            前缀 {token.prefix}… · 到期 {formatMCPTime(token.expires_at)} · 最近使用{" "}
            {formatMCPTime(token.last_used_at)}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {!plain && token?.has_secret && (
            <Button variant="outline" size="sm" disabled={fetching} onClick={() => void reveal()}>
              显示配置片段
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy}
            onClick={() =>
              void confirm({
                title: token ? "重新生成令牌？" : "生成令牌？",
                description: token
                  ? "现在这枚会立刻失效，正在用它的外部工具要换成新的才能连上"
                  : "给这个项目生成一枚令牌，生成后就能复制配置",
                destructive: !!token,
                confirmLabel: token ? "重新生成" : "生成",
                onConfirm: () => state.rotate(project.id),
              })
            }
          >
            <KeyRound />
            {token ? "重新生成令牌" : "生成令牌"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * MCP 接入页：说明、新建项目、项目表格、选中项目的接入配置。
 * 一个项目就是一个接入点，建项目时令牌已经签好；配置片段在展开的那一块里，不再单独分层。
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
        <PageHeaderHeading className="flex items-center gap-2">
          <PageHeaderTitle>{mode === "admin" ? "MCP 接入" : "我的 MCP 接入"}</PageHeaderTitle>
          <Tag tone="warning" mono>
            Beta
          </Tag>
        </PageHeaderHeading>
        <PageHeaderActions>
          <Button onClick={() => setTarget({ kind: "new" })}>
            <Plus />
            新建接入项目
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <Notice tone="info" title="外部 AI 工具怎么连" className="mb-4">
        这套能力还在 Beta：工具集合与权限档位会随反馈调整，接入方以本页生成的配置片段为准。
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

      {selected && <AccessPanel state={state} project={selected} now={now} />}

      {target && <ProjectDialog target={target} state={state} onClose={() => setTarget(null)} />}
    </DataPage>
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
