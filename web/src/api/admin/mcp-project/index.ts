import service from "@/utils/requests/service";

import { adminMCPProjectEndpoints as ep } from "./endpoints";
import type {
  IssueMCPTokenReq,
  IssuedMCPToken,
  MCPProjectItem,
  MCPProjectList,
  MCPProjectReq,
  MCPTokenItem,
  MCPTokenList,
} from "./type";

/**
 * 项目列表；items 缺失时补成空数组
 * @returns 全部项目，新的在前
 */
export const listMCPProjects = async (): Promise<MCPProjectItem[]> =>
  ((await service.get<MCPProjectList | null>(ep.list(), undefined)) ?? { items: [] }).items ?? [];

/**
 * 新建项目
 * @param data 名称、归属用户、画布、权限档位
 */
export const createMCPProject = (data: MCPProjectReq) =>
  service.post<MCPProjectItem>(ep.create(), data);

/**
 * 修改项目（含启停）
 * @param id 项目 ID
 * @param data 完整字段；enabled 不传表示保持原状
 */
export const updateMCPProject = (id: string, data: MCPProjectReq) =>
  service.put<MCPProjectItem>(ep.update(id), data);

/**
 * 删除项目：令牌一并删除，不可恢复
 * @param id 项目 ID
 */
export const removeMCPProject = (id: string) => service.delete<void>(ep.remove(id));

/**
 * 项目令牌列表
 * @param id 项目 ID
 * @returns 该项目的令牌，新的在前
 */
export const listMCPTokens = async (id: string): Promise<MCPTokenItem[]> =>
  ((await service.get<MCPTokenList | null>(ep.tokens(id), undefined)) ?? { items: [] }).items ?? [];

/**
 * 签发令牌。明文只在这次响应里返回，展示后不要再保存
 * @param id 项目 ID
 * @param data 用途（1–64 字）与有效天数（1–90）
 */
export const issueMCPToken = (id: string, data: IssueMCPTokenReq) =>
  service.post<IssuedMCPToken>(ep.issueToken(id), data);

/**
 * 取回令牌明文：列表里「复制」用。只对未注销、未过期、当初存了密文的令牌有效
 * @param id 项目 ID
 * @param tokenId 令牌 ID
 */
export const getMCPTokenSecret = async (id: string, tokenId: string): Promise<string> =>
  (await service.get<{ token: string } | null>(ep.tokenSecret(id, tokenId), undefined))?.token ??
  "";

/**
 * 注销令牌：立即失效，不可恢复
 * @param id 项目 ID
 * @param tokenId 令牌 ID
 */
export const revokeMCPToken = (id: string, tokenId: string) =>
  service.delete<void>(ep.revokeToken(id, tokenId));
