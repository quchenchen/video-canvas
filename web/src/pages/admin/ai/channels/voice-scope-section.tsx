import { OptionSelect } from "@/components/admin-ui/option-select";
import { Tag } from "@/components/admin-ui/tag";
import { VOICE_SCOPE_OPTIONS, voiceScopeHint } from "@/utils/admin/channel-form";

/**
 * 渠道弹窗里的「公开素材资源域」：方舟国内站与 BytePlus 国际站各有一套公开音色，
 * asset ID 只在同一资源域内通用，跨域上游直接报 asset not found。
 * 自动推断只认官方域名；自建代理、私有网关要在这里显式声明，否则该渠道的 音色库只能按音频文件传。
 * @param value 表单里的 voice_scope（空串 = 按 Base URL 推断）
 * @param disabled 保存中
 * @param onChange 改表单字段
 */
export function VoiceScopeSection({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">公开素材资源域</span>
        <Tag tone="neutral" className="ml-auto">
          音色库
        </Tag>
      </div>
      <OptionSelect
        id="channel-voice-scope"
        value={value}
        options={VOICE_SCOPE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
        disabled={disabled}
        aria-label="公开素材资源域"
        onValueChange={onChange}
      />
      <p className="text-muted-foreground text-xs">
        {voiceScopeHint(value)}；只有最终视频模型也在这个域，音色才按 asset
        地址传，否则按音频文件传。
      </p>
    </div>
  );
}
