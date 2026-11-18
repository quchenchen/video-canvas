import {
  BadgeCheck,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldPlus,
  type LucideIcon,
} from "lucide-react";

import type { FilingStatus } from "@/api/filing";

/**
 * 备案状态的单一规范：所有出现位置（角色卡按钮、角色详情、虚拟人像库、个人资产库角标）
 * 都从这里取图标、颜色、文案，保证标识一致。要改样式只改这一处。
 *
 * 规范：未备案灰盾牌加号 / 进行中黄色转圈 / 已备案绿色对勾 / 失败红色警示。
 */
export const FILING_STATUS_META: Record<
  FilingStatus,
  { label: string; tone: string; Icon: LucideIcon; spin?: boolean }
> = {
  none: { label: "真人备案", tone: "text-muted-foreground", Icon: ShieldPlus },
  pending: { label: "备案中", tone: "text-status-warning", Icon: Loader2, spin: true },
  processing: { label: "处理中", tone: "text-status-warning", Icon: Loader2, spin: true },
  active: { label: "已备案", tone: "text-status-success", Icon: BadgeCheck },
  failed: { label: "备案失败", tone: "text-status-danger", Icon: ShieldAlert },
};

/** 失败态的重试用图标（可重试按钮用，属于规范的一部分）。 */
export const FILING_RETRY_ICON = RefreshCw;

/** 取某状态的展示元数据；未识别的状态按未备案处理。 */
export function filingMeta(status: FilingStatus | undefined) {
  return FILING_STATUS_META[status ?? "none"] ?? FILING_STATUS_META.none;
}
