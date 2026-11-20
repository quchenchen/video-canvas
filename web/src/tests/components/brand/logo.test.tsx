import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Logo } from "@/components/brand/logo";

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("Logo「ScriptNow」", () => {
  test("渲染 scriptnow mark 的 96×96 图形，书页、新芽、渐变都在", () => {
    const out = renderToStaticMarkup(<Logo size={32} />);
    expect(out).toContain('data-slot="logo"');
    expect(out).toContain('viewBox="0 0 96 96"');
    expect(out).toContain('width="32"');
    expect(out).toContain('height="32"');
    expect(count(out, "<path")).toBe(7);
    expect(count(out, "linearGradient")).toBe(4); // 2 个开标签 + 2 个闭标签
    expect(out).toContain("#365e4e");
    expect(out).toContain("#b45a33");
  });

  test("同一棵树里多个实例的渐变 id 不同，不互相撞", () => {
    const out = renderToStaticMarkup(
      <>
        <Logo />
        <Logo />
      </>,
    );
    const ids = [...out.matchAll(/id="([^"]*)-ground"/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("size 控制边长，断点不再区分大小尺寸", () => {
    const small = renderToStaticMarkup(<Logo size={20} />);
    const big = renderToStaticMarkup(<Logo size={48} />);
    expect(small).toContain('width="20"');
    expect(big).toContain('width="48"');
    expect(small).not.toContain("data-variant");
  });

  test("bright 是兼容 prop，不改变图形本身", () => {
    expect(renderToStaticMarkup(<Logo bright />)).toBe(renderToStaticMarkup(<Logo />));
  });

  test("animated 用单个 logo-anim 包裹整枚 mark，供整体进场动画驱动", () => {
    const out = renderToStaticMarkup(<Logo size={44} animated />);
    expect(out).toContain("logo-anim");
    expect(out).toMatch(/<span[^>]*class="[^"]*logo-anim[^"]*"[^>]*><svg/);
    expect(out).toContain('data-slot="logo"');
    // 旧的四层拆分结构不再存在
    expect(out).not.toContain("data-part");
  });
});
