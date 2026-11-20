import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { mapAsset, type BackendAssetDto } from "@/api/asset";
import type { AssetDto } from "@/api/asset/type";
import { HistoryAssetCard, type CardSelect } from "@/components/assets/asset-card";
import { OfficialVoicePickCard } from "@/components/assets/asset-picker-panes";
import type { GeneratedItemDto } from "@/api/asset-library/type";

const raw: BackendAssetDto = {
  id: 10,
  kind: "audio",
  url: "/files/o0/202611/a.wav",
  thumbnail_url: "/files/o0/202611/a.png",
  official_asset_id: "asset-20260908172134-jdrd2",
};

describe("音色库字段映射", () => {
  test("缩略图地址与官方 ID 从后端 snake_case 映射到前端", () => {
    const got = mapAsset(raw);
    expect(got.thumbnailUrl).toBe("/files/o0/202611/a.png");
    expect(got.officialAssetId).toBe("asset-20260908172134-jdrd2");
  });

  test("普通素材没有这两个字段时为空串，不报错", () => {
    const got = mapAsset({ id: 1, kind: "image", url: "/files/u1/a.png" });
    expect(got.thumbnailUrl ?? "").toBe("");
    expect(got.officialAssetId ?? "").toBe("");
  });
});

const baseDto = (overrides: Partial<AssetDto> = {}): AssetDto => ({
  id: "10",
  kind: "audio",
  url: "/files/o0/a.wav",
  mimeType: "audio/wav",
  byteSize: 1,
  width: null,
  height: null,
  durationMs: 7566,
  fileName: "Big Boogie",
  ...overrides,
});

describe("音色库卡片封面", () => {
  const item = (asset: AssetDto): GeneratedItemDto => ({
    asset,
    prompt: "音色库",
    modelLabel: "",
    canvas: null,
    createdAt: "2026-11-19T00:00:00Z",
    libraryItemId: null,
  });
  const render = (a: AssetDto) =>
    renderToStaticMarkup(
      <HistoryAssetCard
        item={item(a)}
        onPreview={() => {}}
        onAddToLibrary={() => {}}
        onOpenCanvas={() => {}}
      />,
    );

  test("音频有缩略图时渲染图片，不再只显示音符占位", () => {
    const out = render(baseDto({ thumbnailUrl: "/files/o0/a.png" }));
    expect(out).toContain("v=thumb");
  });

  test("音频没有缩略图时仍是音符占位，不发图片请求", () => {
    const out = render(baseDto());
    expect(out).not.toContain("v=thumb");
  });
});

describe("音色库选择卡", () => {
  test("整张卡是按钮，点头像和名字都在同一个点击区里", () => {
    const select: CardSelect = { selected: false, disabled: false, onToggle: () => {} };
    const out = renderToStaticMarkup(
      <OfficialVoicePickCard
        asset={baseDto({ thumbnailUrl: "/files/o0/a.png" })}
        select={select}
      />,
    );
    expect(out).toContain('data-slot="official-voice-pick"');
    expect(out).toContain("v=thumb");
    expect(out.match(/<button/g)?.length ?? 0).toBe(1);
  });
});
