import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { RefStrip as RefStripType } from "@/components/canvas/ref-strip";
import { installDom, type DomEnv } from "@/tests/helpers/dom";

/**
 * 引用条：点上游缩略图是把画布视口飞到那个源节点，不再往提示词里插 chip。
 */

// 整模块替换，所以官方音色接口的每个导出都要给出来：缺一个，同样 import 该模块的
// 其他测试文件（bun 的 mock 会跨文件生效）就会在加载时报「Export named ... not found」。
mock.module("@/api/official-voice", () => ({
  listOfficialVoices: async () => ({ items: [], total: 0 }),
  listAllOfficialVoices: async () => [],
}));

const located: string[] = [];
const focusNodeModule = await import("@/components/canvas-editor/use-focus-node");
mock.module("@/components/canvas-editor/use-focus-node", () => ({
  ...focusNodeModule,
  useLocateNode: () => (id: string) => {
    located.push(id);
    return true;
  },
}));

let dom: DomEnv;
let RefStrip: typeof RefStripType;
beforeAll(async () => {
  dom = await installDom();
  RefStrip = (await import("@/components/canvas/ref-strip")).RefStrip;
});
afterAll(() => dom.restore());

describe("引用条上的上游缩略图", () => {
  test("点击定位到画布上的源节点，不插入到提示词", async () => {
    const { container, unmount } = await dom.mount(
      <RefStrip
        items={[
          { id: "n1", kind: "image", label: "图片", src: "https://example.com/a.png", used: true },
        ]}
        manual={[]}
        candidates={() => []}
        onLink={() => {}}
        onUnlink={() => {}}
        uploadKinds={[]}
        onUpload={() => {}}
        onRemoveManual={() => {}}
        errors={[]}
      />,
    );
    const thumb = container.querySelector('button[aria-label^="引用：图片"]');
    expect(thumb?.getAttribute("aria-label")).not.toContain("插入到提示词");
    await dom.click(thumb);
    expect(located).toEqual(["n1"]);
    await unmount();
  });

  test("模型支持参考音频时，+ 菜单提供 音色库入口", async () => {
    const { container, unmount } = await dom.mount(
      <RefStrip
        items={[]}
        manual={[]}
        candidates={() => []}
        onLink={() => {}}
        onUnlink={() => {}}
        uploadKinds={[]}
        onUpload={() => {}}
        officialVoice={{ onPick: () => {} }}
        onRemoveManual={() => {}}
        errors={[]}
      />,
    );
    await dom.click(container.querySelector('button[aria-label="引用画布里的素材"]'));
    await dom.flush();
    expect(dom.win.document.body.textContent).toContain("音色库");
    await unmount();
  });
});
