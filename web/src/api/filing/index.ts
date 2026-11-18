import service from "@/utils/requests/service";
import type { BackendVirtualAvatar, FilingDto, VirtualAvatar } from "./type";

export type {
  FilingStatus,
  VirtualAvatar,
  VirtualAvatarSource,
  CollectVirtualAvatarInput,
} from "./type";
export type { FilingDto } from "./type";

const mapAvatar = (raw: BackendVirtualAvatar): VirtualAvatar => ({
  id: raw.id,
  userId: raw.user_id,
  sourceType: raw.source_type,
  sourceRef: raw.source_ref,
  name: raw.name ?? "",
  assetId: raw.asset_id ?? "",
  url: raw.url ?? "",
  filingStatus: raw.filing_status ?? "none",
  filingModelKey: raw.filing_model_key ?? "",
  arkAssetId: raw.ark_asset_id ?? "",
  error: raw.error ?? "",
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

/** 列出当前用户归集的全部虚拟人像。
 *  refreshPending：先让后端把审核中的条目去方舟查一遍再返回（页面轮询用这个，否则 pending 永远不自己变 active）。 */
export const listVirtualAvatars = async (opts?: {
  refreshPending?: boolean;
}): Promise<VirtualAvatar[]> => {
  const rows = await service.get<BackendVirtualAvatar[]>(
    opts?.refreshPending ? "/virtual-avatars?refresh=pending" : "/virtual-avatars",
  );
  return (rows ?? []).map(mapAvatar);
};

/** 把一张角色图片归集进虚拟人像库（两类来源统一入口） */
export const collectVirtualAvatar = async (input: {
  source_type: string;
  source_ref: string;
  name?: string;
  asset_id?: string;
  url: string;
}): Promise<VirtualAvatar> =>
  mapAvatar(await service.post<BackendVirtualAvatar>("/virtual-avatars", input));

/** 从虚拟人像库移除（已备案的会同时删方舟资产） */
export const removeVirtualAvatar = async (id: string): Promise<void> => {
  await service.delete(`/virtual-avatars/${encodeURIComponent(id)}`);
};

/** 提交方舟备案：调 CreateAsset */
export const submitFiling = async (id: string, modelKey: string): Promise<VirtualAvatar> =>
  mapAvatar(
    await service.post<BackendVirtualAvatar>(`/virtual-avatars/${encodeURIComponent(id)}/submit`, {
      model_key: modelKey,
    }),
  );

/** 刷新备案状态：调 GetAsset */
export const refreshFiling = async (id: string): Promise<VirtualAvatar> =>
  mapAvatar(
    await service.post<BackendVirtualAvatar>(`/virtual-avatars/${encodeURIComponent(id)}/refresh`),
  );

/** 管理员：设置某模型的备案凭据（只写，空串清除由后端按空串处理）。路径在 /admin/ai 下。 */
export const setFilingCredential = async (
  modelKey: string,
  kind: "access_key" | "secret_key",
  value: string,
): Promise<void> => {
  await service.put(`/admin/ai/models/${encodeURIComponent(modelKey)}/filing/${kind}`, { value });
};

// ---- 兼容层：角色卡上的旧 FilingButton / FilingPanel 继续用下面的形状，底层已改成真后端 ----

const toLegacy = (v: VirtualAvatar): FilingDto => ({
  assetId: v.assetId || v.sourceRef,
  status: v.filingStatus === "pending" ? "pending" : v.filingStatus,
  filingId: v.arkAssetId,
  error: v.error,
  sourceUrl: v.url,
  updatedAt: new Date(v.updatedAt).getTime() || 0,
});

/** 按 assetId 批量查备案状态；先确保归集，再读真后端状态 */
export const listFilings = async (
  assetIds: string[],
  opts?: { refreshPending?: boolean },
): Promise<FilingDto[]> => {
  if (assetIds.length === 0) return [];
  const all = await listVirtualAvatars(opts);
  const byRef = new Map<string, VirtualAvatar>();
  for (const v of all) {
    if (v.assetId) byRef.set(v.assetId, v);
    byRef.set(v.sourceRef, v);
  }
  return assetIds.map((id) => {
    const found = byRef.get(id);
    return found
      ? toLegacy(found)
      : { assetId: id, status: "none", filingId: "", error: "", sourceUrl: "", updatedAt: 0 };
  });
};

/** 提交备案：先归集（角色卡来源）再调方舟 CreateAsset。modelKey 留空由后端自动挑开启了备案的视频模型。 */
export const createFiling = async (assetId: string, sourceUrl: string): Promise<FilingDto> => {
  const all = await listVirtualAvatars();
  const existing = all.find((v) => v.assetId === assetId || v.sourceRef === assetId);
  const row =
    existing ??
    (await collectVirtualAvatar({
      source_type: "drama_character",
      source_ref: assetId,
      asset_id: assetId,
      url: sourceUrl,
      name: assetId,
    }));
  return toLegacy(await submitFiling(row.id, ""));
};

/** 重新备案：对已归集条目重试提交 */
export const retryFiling = async (assetId: string): Promise<FilingDto> => {
  const all = await listVirtualAvatars();
  const row = all.find((v) => v.assetId === assetId || v.sourceRef === assetId);
  if (!row) throw new Error("未找到归集条目，无法重新备案");
  return toLegacy(await submitFiling(row.id, ""));
};
