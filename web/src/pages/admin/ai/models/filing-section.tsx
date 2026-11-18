import { useState } from "react";
import { toast } from "sonner";

import { setFilingCredential } from "@/api/filing";
import type { ModelFilingValue } from "@/utils/admin/model-body";
import { FormField } from "@/components/admin-ui/form-field";
import {
  FormSection,
  FormSectionHeader,
  FormSectionTitle,
} from "@/components/admin-ui/form-section";
import { ToggleChip } from "@/components/admin-ui/toggle-chip";
import { Input } from "@/components/ui/input";

/**
 * 视频模型「能力与参数」里的虚拟人像库配置节。
 * 开关 / 素材组 / 项目名写进模型正文 capabilities.filing；
 * 备案站点不手选——后端按该模型渠道的 base_url 自动判定（方舟国内 / BytePlus 国际）。
 * AK / SK 单独走只写接口存 ai_secrets，永不回显、不进正文。
 */
export function FilingSection({
  value,
  modelKey,
  onChange,
}: {
  value: ModelFilingValue;
  modelKey?: string;
  onChange: (next: ModelFilingValue) => void;
}) {
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [saving, setSaving] = useState(false);

  const patch = (partial: Partial<ModelFilingValue>) => onChange({ ...value, ...partial });

  const saveCredential = async (kind: "access_key" | "secret_key", val: string) => {
    if (!modelKey) {
      toast.error("请先保存模型，再配置备案 AK/SK");
      return;
    }
    if (!val.trim()) return;
    setSaving(true);
    try {
      await setFilingCredential(modelKey, kind, val.trim());
      if (kind === "access_key") setAk("");
      else setSk("");
      toast.success(kind === "access_key" ? "备案 Access Key 已保存" : "备案 Secret Key 已保存");
    } catch {
      // 请求层已弹错误提示
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormSection>
      <FormSectionHeader>
        <FormSectionTitle>虚拟人像库</FormSectionTitle>
      </FormSectionHeader>
      <p className="text-muted-foreground -mt-1 text-xs">
        开启后，归集进虚拟人像库的角色图片可提交备案，生成时以 asset:// 传给 Seedance。
        备案站点随该模型渠道的 base_url 自动判定：方舟域名走方舟国内站，BytePlus
        域名走国际站，无需手选。
      </p>
      <div className="flex flex-wrap gap-2">
        <ToggleChip pressed={value.enabled} onClick={() => patch({ enabled: !value.enabled })}>
          {value.enabled ? "已开启" : "未开启"}
        </ToggleChip>
      </div>

      {value.enabled && (
        <div className="mt-4 grid gap-4">
          <FormField size="default" label="素材组 ID" htmlFor="model-filing-group">
            <Input
              id="model-filing-group"
              value={value.group_id}
              placeholder="方舟素材组 ID（CreateAsset 的 GroupId）"
              onChange={(e) => patch({ group_id: e.target.value })}
            />
          </FormField>

          <FormField size="default" label="项目名" htmlFor="model-filing-project">
            <Input
              id="model-filing-project"
              value={value.project_name}
              placeholder="留空用 default"
              onChange={(e) => patch({ project_name: e.target.value })}
            />
          </FormField>

          <div className="grid gap-3 rounded-lg border p-3 md:grid-cols-2">
            <FormField size="default" label="Access Key" htmlFor="model-filing-ak">
              <div className="flex gap-2">
                <Input
                  id="model-filing-ak"
                  type="password"
                  autoComplete="off"
                  value={ak}
                  placeholder="粘贴后自动保存"
                  onChange={(e) => setAk(e.target.value)}
                  onBlur={() => {
                    if (ak.trim()) void saveCredential("access_key", ak);
                  }}
                />
                <button
                  type="button"
                  disabled={saving || !ak.trim()}
                  className="border-input hover:bg-accent shrink-0 rounded-md border px-3 text-xs disabled:opacity-50"
                  onClick={() => void saveCredential("access_key", ak)}
                >
                  保存
                </button>
              </div>
            </FormField>
            <FormField size="default" label="Secret Key" htmlFor="model-filing-sk">
              <div className="flex gap-2">
                <Input
                  id="model-filing-sk"
                  type="password"
                  autoComplete="off"
                  value={sk}
                  placeholder="粘贴后自动保存"
                  onChange={(e) => setSk(e.target.value)}
                  onBlur={() => {
                    if (sk.trim()) void saveCredential("secret_key", sk);
                  }}
                />
                <button
                  type="button"
                  disabled={saving || !sk.trim()}
                  className="border-input hover:bg-accent shrink-0 rounded-md border px-3 text-xs disabled:opacity-50"
                  onClick={() => void saveCredential("secret_key", sk)}
                >
                  保存
                </button>
              </div>
            </FormField>
            <p className="text-muted-foreground md:col-span-2 text-[11px]">
              粘贴后离开输入框即自动保存（也可点右侧「保存」）。AK/SK
              走独立只写接口，不随「保存模型」提交、不进模型正文；加密存储、只写不读，保存后输入框自动清空。
            </p>
          </div>
        </div>
      )}
    </FormSection>
  );
}
