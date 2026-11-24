import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  createMCPProject,
  getMCPTokenSecret,
  issueMCPToken,
  listMCPProjects,
  listMCPTokens,
  removeMCPProject,
  revokeMCPToken,
  updateMCPProject,
} from "@/api/admin/mcp-project";
import type {
  IssuedMCPToken,
  MCPProjectItem,
  MCPProjectReq,
  MCPTokenItem,
} from "@/api/admin/mcp-project/type";
import { expandMCPScopes } from "@/utils/admin/mcp-project";
import {
  createMyMCPProject,
  getMyMCPTokenSecret,
  issueMyMCPToken,
  listMyMCPProjects,
  listMyMCPTokens,
  removeMyMCPProject,
  revokeMyMCPToken,
  updateMyMCPProject,
} from "@/api/mcp";

/** 谁在用这套状态：admin = 后台代管全部项目；self = 用户自己的接入（归属固定为本人）。 */
export type MCPProjectsAudience = "admin" | "self";

/**
 * 两套接口形状完全一致，只有「归属用户」的处理不同：
 * admin 能指定别人的归属，self 一律是当前登录用户，请求体里也不带 owner_user_id。
 */
const APIS = {
  admin: {
    list: listMCPProjects,
    create: createMCPProject,
    update: updateMCPProject,
    remove: removeMCPProject,
    tokens: listMCPTokens,
    issue: issueMCPToken,
    revoke: revokeMCPToken,
    secret: getMCPTokenSecret,
  },
  self: {
    list: listMyMCPProjects,
    create: createMyMCPProject,
    update: updateMyMCPProject,
    remove: removeMyMCPProject,
    tokens: listMyMCPTokens,
    issue: issueMyMCPToken,
    revoke: revokeMyMCPToken,
    secret: getMyMCPTokenSecret,
  },
} as const;

/** 新建项目表单的字段；归属用户与默认画布都留空时后端按「算自己名下、不设默认画布」处理。 */
export type ProjectForm = {
  name: string;
  ownerUserId: string;
  canvasCode: string;
  scopes: string[];
};

/** 新建表单的初始值：默认只给只读，写与合成要管理员主动勾。 */
export const emptyProjectForm = (): ProjectForm => ({
  name: "",
  ownerUserId: "",
  canvasCode: "",
  scopes: expandMCPScopes(["canvas:read"]),
});

/** MCP 接入页的数据与动作：页面本身不藏状态，便于单独验证。 */
export type MCPProjectsState = ReturnType<typeof useMCPProjects>;

/**
 * MCP 接入页的数据层：项目列表、单个项目的令牌、新建 / 修改 / 启停 / 删除、重新生成令牌。
 *
 * 一个项目就是一个接入点，只有一枚令牌，所以没有「令牌列表」这一层：
 * 建项目时服务端就把令牌签好（明文在创建响应里），之后要换只走「重新生成」。
 *
 * @param audience admin = 后台代管（列表看全部项目、显示归属）；self = 用户自助（只看自己的）
 */
export function useMCPProjects(audience: MCPProjectsAudience = "admin") {
  const api = useMemo(() => APIS[audience], [audience]);
  const [items, setItems] = useState<MCPProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 当前展开配置的项目 id
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tokens, setTokens] = useState<MCPTokenItem[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  // 刚签发（含新建项目时自动签发）的令牌：明文只在这一份状态里存在
  const [issued, setIssued] = useState<IssuedMCPToken | null>(null);

  /** 拉项目列表并把结果写进状态；不碰 loading，首次加载由 useEffect 直接调它（effect 里不能同步 setState）。 */
  const reload = useCallback(async () => {
    try {
      setItems(await api.list());
    } catch {
      toast.error("项目列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  /** 用户主动刷新：带上 loading 状态。 */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await reload();
    } finally {
      setLoading(false);
    }
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 拉某个项目的令牌列表。 */
  const loadTokens = useCallback(
    async (projectId: string) => {
      setTokensLoading(true);
      try {
        setTokens(await api.tokens(projectId));
      } catch {
        toast.error("令牌列表加载失败");
      } finally {
        setTokensLoading(false);
      }
    },
    [api],
  );

  /** 展开 / 收起令牌面板；展开时清掉上一次的明文。 */
  const toggleTokens = useCallback(
    (projectId: string) => {
      setIssued(null);
      if (selectedId === projectId) {
        setSelectedId(null);
        setTokens([]);
        return;
      }
      setSelectedId(projectId);
      void loadTokens(projectId);
    },
    [loadTokens, selectedId],
  );

  /** 把项目字段转成请求体：归属用户与画布只在填了的时候才带，后端按「算自己名下 / 沿用原归属」处理。 */
  const toReq = useCallback(
    (form: ProjectForm, enabled?: boolean): MCPProjectReq => ({
      name: form.name.trim(),
      ...(form.ownerUserId.trim() ? { owner_user_id: form.ownerUserId.trim() } : {}),
      ...(form.canvasCode.trim() ? { canvas_code: form.canvasCode.trim() } : {}),
      scopes: form.scopes,
      ...(enabled === undefined ? {} : { enabled }),
    }),
    [],
  );

  /**
   * 新建项目：只要一个名字，归属落在自己名下，能力用默认的只读，建完再在「编辑」里调。
   * 服务端会把首枚令牌一起签好，这里直接把明文摆出来——用户建完就能复制配置。
   */
  const create = useCallback(
    async (form: ProjectForm) => {
      if (!form.name.trim()) {
        toast.error("先给它起个名字");
        return false;
      }
      setBusy(true);
      try {
        const created = await api.create(toReq(form));
        setIssued(created.issued);
        setSelectedId(created.item.id);
        toast.success("项目已创建，下面的配置可以直接复制");
        await reload();
        await loadTokens(created.item.id);
        return true;
      } catch {
        toast.error("创建失败");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, loadTokens, reload, toReq],
  );

  /** 修改项目（名称、画布、权限）。 */
  const update = useCallback(
    async (item: MCPProjectItem, form: ProjectForm) => {
      setBusy(true);
      try {
        await api.update(item.id, toReq(form, item.enabled));
        toast.success("项目已保存");
        await refresh();
        return true;
      } catch {
        toast.error("保存失败");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, refresh, toReq],
  );

  /** 启停项目：停用后该项目全部令牌立刻失效。 */
  const setEnabled = useCallback(
    async (item: MCPProjectItem, enabled: boolean) => {
      setBusy(true);
      try {
        await api.update(item.id, {
          name: item.name,
          ...(item.canvas_code ? { canvas_code: item.canvas_code } : {}),
          scopes: item.scopes,
          enabled,
        });
        toast.success(enabled ? "已启用" : "已停用，该项目全部令牌立刻失效");
        await refresh();
      } catch {
        toast.error(enabled ? "启用失败" : "停用失败");
      } finally {
        setBusy(false);
      }
    },
    [api, refresh],
  );

  /** 删除项目与它的令牌。 */
  const remove = useCallback(
    async (item: MCPProjectItem) => {
      setBusy(true);
      try {
        await api.remove(item.id);
        toast.success(`「${item.name}」已删除`);
        if (selectedId === item.id) {
          setSelectedId(null);
          setTokens([]);
          setIssued(null);
        }
        await refresh();
      } catch {
        toast.error("删除失败");
      } finally {
        setBusy(false);
      }
    },
    [api, refresh, selectedId],
  );

  /**
   * 重新生成令牌：一个项目只留一枚，新的签发成功后旧的立刻失效。
   * 用途与有效期都走服务端默认（名字固定、天数取「注册设置」里的默认有效期），不再单独填表。
   */
  const rotate = useCallback(
    async (projectId: string) => {
      setBusy(true);
      try {
        const out = await api.issue(projectId, {});
        setIssued(out);
        await loadTokens(projectId);
        await refresh();
        toast.success("新令牌已生成，旧令牌立刻失效");
      } catch {
        toast.error("重新生成失败");
      } finally {
        setBusy(false);
      }
    },
    [api, loadTokens, refresh],
  );

  /** 注销令牌。 */
  const revoke = useCallback(
    async (projectId: string, token: MCPTokenItem) => {
      setBusy(true);
      try {
        await api.revoke(projectId, token.id);
        toast.success("令牌已注销，立刻失效");
        await loadTokens(projectId);
        await refresh();
      } catch {
        toast.error("注销失败");
      } finally {
        setBusy(false);
      }
    },
    [api, loadTokens, refresh],
  );

  /** 取回某枚令牌的明文：列表里「复制」用，明文不进页面状态。 */
  const tokenSecret = useCallback(
    (projectId: string, token: MCPTokenItem) => api.secret(projectId, token.id),
    [api],
  );

  /** 清掉刚签发的明文（用户点「我已复制」之后）。 */
  const clearIssued = useCallback(() => setIssued(null), []);

  return {
    items,
    loading,
    busy,
    selectedId,
    tokens,
    tokensLoading,
    issued,
    refresh,
    toggleTokens,
    create,
    update,
    setEnabled,
    remove,
    rotate,
    revoke,
    tokenSecret,
    clearIssued,
  };
}
