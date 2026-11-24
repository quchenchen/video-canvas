import service from "@/utils/requests/service";

import type {
  IssueMCPTokenReq,
  IssuedMCPToken,
  MCPProjectCreated,
  MCPProjectItem,
  MCPProjectList,
  MCPProjectReq,
  MCPTokenItem,
  MCPTokenList,
} from "@/api/admin/mcp-project/type";

import { selfMCPProjectEndpoints as ep } from "./endpoints";

/**
 * 我的接入项目列表
 * @returns 自己名下的项目，新的在前
 */
export const listMyMCPProjects = async (): Promise<MCPProjectItem[]> =>
  ((await service.get<MCPProjectList | null>(ep.list(), undefined)) ?? { items: [] }).items ?? [];

/**
 * 新建接入项目；归属固定为当前登录用户，请求体不用带 owner_user_id。
 * 服务端在建项目的同一次请求里签好首枚令牌，返回里直接带明文与端点。
 * @param data 名称、默认画布（可空）、权限档位
 */
export const createMyMCPProject = (data: MCPProjectReq) =>
  service.post<MCPProjectCreated>(ep.create(), data);

/**
 * 修改自己的项目（含启停）
 * @param id 项目 ID
 * @param data 完整字段；enabled 不传表示保持原状
 */
export const updateMyMCPProject = (id: string, data: MCPProjectReq) =>
  service.put<MCPProjectItem>(ep.update(id), data);

/**
 * 删除自己的项目：令牌一并删除，不可恢复
 * @param id 项目 ID
 */
export const removeMyMCPProject = (id: string) => service.delete<void>(ep.remove(id));

/**
 * 自己项目的令牌列表
 * @param id 项目 ID
 */
export const listMyMCPTokens = async (id: string): Promise<MCPTokenItem[]> =>
  ((await service.get<MCPTokenList | null>(ep.tokens(id), undefined)) ?? { items: [] }).items ?? [];

/**
 * 签发令牌；明文只在这次响应里返回
 * @param id 项目 ID
 * @param data 用途与有效天数（1–90）
 */
export const issueMyMCPToken = (id: string, data: IssueMCPTokenReq) =>
  service.post<IssuedMCPToken>(ep.issueToken(id), data);

/**
 * 注销令牌：立即失效
 * @param id 项目 ID
 * @param tokenId 令牌 ID
 */
export const revokeMyMCPToken = (id: string, tokenId: string) =>
  service.delete<void>(ep.revokeToken(id, tokenId));

/**
 * 取回自己项目令牌的明文：列表里「复制」用。服务端只对未注销、未过期、存了密文的令牌返回
 * @param id 项目 ID
 * @param tokenId 令牌 ID
 */
export const getMyMCPTokenSecret = async (id: string, tokenId: string): Promise<string> =>
  (await service.get<{ token: string } | null>(ep.tokenSecret(id, tokenId), undefined))?.token ??
  "";
