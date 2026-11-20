import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RefsBar } from "@/pages/drama/studio/refs-bar";
import type { RefView } from "@/utils/drama/segment-input";
import { Library } from "@/pages/drama/studio/library";
import { StudioContext, type Studio } from "@/pages/drama/studio/use-studio";

const asset = {
  id: "scene-1",
  type: "scene" as const,
  name: "卧室",
  look: "",
  label: "卧室",
  episodes: [1],
  kind: "image" as const,
  src: null,
  generating: false,
};

describe("片场资产库", () => {
  test.each([Library, RefsBar])("资产库和参考素材条只加载缩略图", (Component) => {
    const src = "/files/assets/scene.png";
    const html = renderToStaticMarkup(
      <StudioContext.Provider
        value={
          {
            assets: [{ ...asset, src }],
            assetsStatus: "ready",
            no: 1,
            plan: {
              imageCount: 1,
              imageMax: 9,
              refs: [{ ...asset, state: "image", voice: "none" } as RefView],
            },
          } as Studio
        }
      >
        <Component />
      </StudioContext.Provider>,
    );
    expect(html).toContain(`src="${src}?v=thumb"`);
    expect(html).not.toContain(`src="${src}"`);
    expect(html).toContain("object-cover");
    expect(html).toContain('data-slot="media-skeleton"');
  });

  test("资产只能拖入提示词，单击或键盘激活不会将其添加到右侧", () => {
    const html = renderToStaticMarkup(
      <StudioContext.Provider value={{ assets: [asset], assetsStatus: "ready", no: 1 } as Studio}>
        <Library />
      </StudioContext.Provider>,
    );
    const row = html.match(/<[^>]+draggable="true"[^>]*>/)?.[0];
    expect(row).toBeDefined();
    expect(row).toContain('title="拖到提示词里"');
    expect(row).not.toMatch(/^<button\b/);
    expect(row).not.toContain("tabindex");
    expect(html).toContain("卧室");
  });
});

/** 绑了音色的角色卡：音色要在参考素材条里单列成一条音频素材，并能试听 */
const voiced = {
  ...asset,
  id: "char-1",
  type: "character" as const,
  name: "林川",
  label: "林川",
  kind: "character" as const,
  src: "/files/assets/role.png",
  assetId: "1",
  character: {
    name: "林川",
    look: "",
    description: "",
    extras: [],
    voice: {
      mode: "audio" as const,
      assetId: "9",
      src: "/files/assets/9.mp3",
      origin: "library" as const,
    },
  },
};

const planWithVoice = {
  imageCount: 1,
  imageMax: 9,
  audioCount: 1,
  audioMax: 3,
  refs: [
    {
      id: "char-1",
      label: "林川",
      type: "character",
      state: "image",
      imageCount: 1,
      truncated: false,
      voice: "used",
    } as RefView,
  ],
};

describe("片场参考素材：角色音色", () => {
  test("音色单独一条素材，可试听，音频条数计入上限", () => {
    const html = renderToStaticMarkup(
      <StudioContext.Provider
        value={
          {
            assets: [voiced],
            assetsStatus: "ready",
            no: 1,
            plan: planWithVoice,
          } as unknown as Studio
        }
      >
        <RefsBar />
      </StudioContext.Provider>,
    );
    expect(html).toContain("林川 · 音色");
    expect(html).toContain("试听林川 · 音色");
    expect(html).toContain("音频 1/3");
  });

  test("音色有名字时素材条写成「角色名 · 音色名」", () => {
    const named = {
      ...voiced,
      character: {
        ...voiced.character,
        voice: { ...voiced.character.voice, name: "魅力女友" },
      },
    };
    const html = renderToStaticMarkup(
      <StudioContext.Provider
        value={
          {
            assets: [named],
            assetsStatus: "ready",
            no: 1,
            plan: planWithVoice,
          } as unknown as Studio
        }
      >
        <RefsBar />
      </StudioContext.Provider>,
    );
    expect(html).toContain("林川 · 魅力女友");
    expect(html).toContain("试听林川 · 魅力女友");
  });

  test("素材库里把绑定的音色名标在角色卡上", () => {
    const named = {
      ...voiced,
      character: {
        ...voiced.character,
        voice: { ...voiced.character.voice, name: "魅力女友" },
      },
    };
    const html = renderToStaticMarkup(
      <StudioContext.Provider
        value={{ assets: [named], assetsStatus: "ready", no: 1 } as unknown as Studio}
      >
        <Library />
      </StudioContext.Provider>,
    );
    expect(html).toContain("魅力女友");
  });

  test("没有绑音色的角色没有音频素材，也不显示音频计数", () => {
    const html = renderToStaticMarkup(
      <StudioContext.Provider
        value={
          {
            assets: [{ ...asset, src: "/files/assets/scene.png" }],
            assetsStatus: "ready",
            no: 1,
            plan: {
              imageCount: 1,
              imageMax: 9,
              audioCount: 0,
              audioMax: 3,
              refs: [{ ...asset, state: "image", voice: "none" } as RefView],
            },
          } as unknown as Studio
        }
      >
        <RefsBar />
      </StudioContext.Provider>,
    );
    expect(html).not.toContain("· 音色");
    expect(html).not.toContain("音频 ");
  });

  test("资产库给绑了音色的角色标出「音色」", () => {
    const html = renderToStaticMarkup(
      <StudioContext.Provider value={{ assets: [voiced], assetsStatus: "ready", no: 1 } as Studio}>
        <Library />
      </StudioContext.Provider>,
    );
    expect(html).toContain("音色");
  });
});
