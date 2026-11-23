/**
 * 「我的 MCP 接入」接口路径（前缀 /api/v1 由 axios baseURL 提供）。
 * 只接受登录 JWT，作用范围永远是当前登录用户自己的项目——不需要也不允许指定归属用户。
 *
 *   GET    /me/mcp/projects                     我的项目列表
 *   POST   /me/mcp/projects                     新建（归属 = 自己）
 *   PUT    /me/mcp/projects/:id                 修改（含启停）
 *   DELETE /me/mcp/projects/:id                 删除（令牌一并删除）
 *   GET    /me/mcp/projects/:id/tokens           令牌列表（不含明文）
 *   POST   /me/mcp/projects/:id/tokens           签发，body = {name, days}；明文只返回一次
 *   DELETE /me/mcp/projects/:id/tokens/:tokenId  注销
 */
const P = "/me/mcp/projects";

export const selfMCPProjectEndpoints = {
  list: () => P,
  create: () => P,
  update: (id: string) => `${P}/${encodeURIComponent(id)}`,
  remove: (id: string) => `${P}/${encodeURIComponent(id)}`,
  tokens: (id: string) => `${P}/${encodeURIComponent(id)}/tokens`,
  issueToken: (id: string) => `${P}/${encodeURIComponent(id)}/tokens`,
  revokeToken: (id: string, tokenId: string) =>
    `${P}/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}`,
  tokenSecret: (id: string, tokenId: string) =>
    `${P}/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}/secret`,
};
