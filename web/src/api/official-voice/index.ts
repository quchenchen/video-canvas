import { mapAsset } from "@/api/asset";
import type { AssetDto, BackendAssetDto } from "@/api/asset/type";
import service from "@/utils/requests/service";

/** 音色库列表的一页：素材视图 + 总数 */
export interface OfficialVoicePageDto {
  items: AssetDto[];
  total: number;
}

interface BackendOfficialVoicePage {
  items: BackendAssetDto[];
  total: number;
}

/**
 * 列出官方参考音色（系统公共素材），供资产页与参考音频选择器使用。
 * @param offset 起始位置
 * @param limit 每页条数
 */
export const listOfficialVoices = async (
  offset = 0,
  limit = 100,
): Promise<OfficialVoicePageDto> => {
  const raw = await service.get<BackendOfficialVoicePage>("/assets/official", {
    kind: "audio",
    offset,
    limit,
  });
  return {
    items: (raw.items ?? []).map(mapAsset),
    total: raw.total ?? 0,
  };
};

/** 后端单页上限是 100，音色总数已超过它，这里按页取全量（方舟国内 80 + BytePlus 101）。 */
export const listAllOfficialVoices = async (): Promise<AssetDto[]> => {
  const pageSize = 100;
  const out: AssetDto[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await listOfficialVoices(offset, pageSize);
    out.push(...page.items);
    if (page.items.length === 0 || out.length >= page.total) break;
  }
  return out;
};
