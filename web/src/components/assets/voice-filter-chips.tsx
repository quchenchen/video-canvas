import { cn } from "@/lib/utils";

/**
 * 音色的一组筛选胶囊（单选）：资产页和素材选择器共用。
 * 用在工具条里靠 className 调间距；选中项反色，其余悬停变色。
 * @param label 这组筛选项的名字（读屏用）
 * @param options 可选项，第一项通常是「全部」
 * @param value 当前选中项
 * @param onChange 选中变化
 * @param className 外层附加样式
 */
export function VoiceFilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-1", className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
            "focus-visible:ring-ring/60 focus-visible:ring-2 focus-visible:outline-none",
            value === option.value
              ? "bg-foreground text-background border-transparent"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
