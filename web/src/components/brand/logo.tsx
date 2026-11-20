import { useId, type SVGProps } from "react";

import { cn } from "@/lib/utils";

type LogoProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "width" | "height"> & {
  size?: number;
  bright?: boolean;
  animated?: boolean;
};

/**
 * ScriptNow 品牌 mark：一本正在生长的书，书页汇成故事路径与新芽。
 * 图形取自 creator 应用的 scriptnow-mark.svg（96×96）；这里内联进组件，
 * 渐变 id 用 useId 生成，避免同页多个实例互相撞 id。
 * size/bright/animated 保留是为了不动调用点：bright、animated 现在只影响包裹层，
 * 图形本身用自带配色，不随主题走。
 */
export function Logo({
  size = 32,
  bright: _bright = false,
  animated = false,
  className,
  ...props
}: LogoProps) {
  const uid = useId();
  const groundId = `${uid}-ground`;
  const pageId = `${uid}-page`;
  const svg = (
    <svg
      viewBox="0 0 96 96"
      width={size}
      height={size}
      aria-hidden="true"
      data-slot="logo"
      className={cn("shrink-0", className)}
      {...props}
    >
      <defs>
        <linearGradient
          id={groundId}
          x1="15"
          y1="10"
          x2="82"
          y2="88"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#365e4e" />
          <stop offset="1" stopColor="#203b32" />
        </linearGradient>
        <linearGradient id={pageId} x1="26" y1="29" x2="70" y2="73" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fffaf0" />
          <stop offset="1" stopColor="#eadfc9" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${groundId})`}
        d="M12 24C17 13 30 8 43 10l27 4c11 2 18 12 17 23l-3 30c-1 12-11 20-23 20H32C19 87 9 77 10 64l2-40Z"
      />
      <path fill="#b45a33" d="M46 23c0-6 4-11 10-13 1 7-2 12-10 13Z" />
      <path fill="#d68a62" d="M49 25c6-5 13-5 18-1-5 6-12 7-18 1Z" />
      <path fill="none" stroke="#e6a078" strokeLinecap="round" strokeWidth="3.5" d="M47 23v20" />
      <path
        fill={`url(#${pageId})`}
        d="M22 35c9-3 18-1 26 6v34c-8-6-17-8-26-5V35Zm52 0c-9-3-18-1-26 6v34c8-6 17-8 26-5V35Z"
      />
      <path fill="none" stroke="#2b4a3e" strokeLinecap="round" strokeWidth="3" d="M48 42v34" />
      <path
        fill="none"
        stroke="#a2532f"
        strokeLinecap="round"
        strokeWidth="3"
        d="M30 47c5-1 9 0 13 3m-13 8c5-1 9 0 13 3m23-14c-5-1-9 0-13 3m13 8c-5-1-9 0-13 3"
      />
    </svg>
  );

  if (animated) {
    return (
      <span
        aria-hidden="true"
        data-slot="logo"
        className={cn("logo-anim relative inline-block shrink-0", className)}
        style={{ width: size, height: size }}
      >
        {svg}
      </span>
    );
  }

  return svg;
}
