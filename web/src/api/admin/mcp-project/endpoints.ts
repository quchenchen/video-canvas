/**
 * MCP 接入的后台接口路径集中在这一个文件（前缀 /api/v1 由 axios baseURL 提供）。
 * 只接受登录 JWT，需要 admin / super_admin；删除项目仅 super_admin。
 *
 *   GET    /admin/mcp/projects                     项目列表（带令牌数与最近使用）
 *   POST   /admin/mcp/projects                     新建项目
 *   PUT    /admin/mcp/projects/:id                 修改项目（含启停）
 *   DELETE /admin/mcp/projects/:id                 删除项目（令牌一并删除）
 *   GET    /admin/mcp/projects/:id/tokens          令牌列表（不含明文）
 *   POST   /admin/mcp/projects/:id/tokens          签发，body = {name, days}；明文只在这次响应里返回
 *   DELETE /admin/mcp/projects/:id/tokens/:tokenId 注销
 */
const P = "/admin/mcp/projects";

export const adminMCPProjectEndpoints = {
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
