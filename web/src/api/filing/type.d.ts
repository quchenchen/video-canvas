/** 备案状态：none 未备案 / pending 已提交 / active 已备案 / failed 失败 */
export type FilingStatus = "none" | "pending" | "processing" | "active" | "failed";

/** 归集来源类型：短剧拆解角色卡 / 个人资产库图片 */
export type VirtualAvatarSource = "drama_character" | "library_asset";

/** 后端虚拟人像库归集条目（snake_case）；id 是十六进制串 */
export type BackendVirtualAvatar = {
  id: string;
  user_id: number;
  source_type: VirtualAvatarSource;
  source_ref: string;
  name: string;
  asset_id: string;
  url: string;
  filing_status: FilingStatus;
  filing_model_key: string;
  ark_asset_id: string;
  error: string;
  created_at: string;
  updated_at: string;
};

/** 前端虚拟人像库归集条目 */
export type VirtualAvatar = {
  id: string;
  userId: number;
  sourceType: VirtualAvatarSource;
  sourceRef: string;
  name: string;
  assetId: string;
  url: string;
  filingStatus: FilingStatus;
  filingModelKey: string;
  arkAssetId: string;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type CollectVirtualAvatarInput = {
  source_type: VirtualAvatarSource;
  source_ref: string;
  name?: string;
  asset_id?: string;
  url: string;
};

/** 模型配置 capabilities.filing 段：管理员在「能力与参数」页签里配 */
export type ModelFilingConfig = {
  enabled: boolean;
  site: string; // ark_cn / byteplus
  group_id: string; // 方舟素材组 ID
  project_name: string;
};

// ---- 以下为旧 mock 期类型，保留兼容，待角色卡入口迁移完成后可删 ----
export type BackendFilingDto = {
  asset_id: string;
  status: FilingStatus;
  filing_id: string;
  error: string;
  source_url: string;
  updated_at: number;
};
export type FilingDto = {
  assetId: string;
  status: FilingStatus;
  filingId: string;
  error: string;
  sourceUrl: string;
  updatedAt: number;
};
export type ListFilingsResp = { items: BackendFilingDto[] };
