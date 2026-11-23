import {
  MCP_SCOPES,
  MCP_SCOPE_GROUPS,
  dropMCPScope,
  expandMCPScopes,
  scopeRequiresLabel,
} from "@/utils/admin/mcp-project";

/**
 * 能力勾选：新建与编辑共用。
 *
 * 勾上会补全它依赖的档位，取消会连带关掉依赖它的档位——权限之间不互斥，
 * 界面上不会留下「给了写却没给读」这种配了也用不了的组合。
 *
 * 画布与短剧是两条并列的能力域，分块摆：MCP 是独立的能力出口，不是「画布的子功能」。
 *
 * @param scopes 当前勾选的档位
 * @param onChange 勾选结果变化时回调（已经补全依赖）
 */
export function ScopeChecklist({
  scopes,
  onChange,
}: {
  scopes: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (value: string, checked: boolean) =>
    onChange(checked ? expandMCPScopes([...scopes, value]) : dropMCPScope(scopes, value));
  return (
    <div className="grid gap-4">
      {MCP_SCOPE_GROUPS.map((group) => (
        <fieldset key={group.key}>
          <legend className="text-muted-foreground mb-2 text-xs">{group.label}能力</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {MCP_SCOPES.filter((scope) => scope.group === group.key).map((scope) => (
              <label key={scope.value} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={scopes.includes(scope.value)}
                  onChange={(e) => toggle(scope.value, e.target.checked)}
                />
                <span>
                  {scope.label}
                  <span className="text-muted-foreground block text-xs">{scope.hint}</span>
                  {scopeRequiresLabel(scope.value) && (
                    <span className="text-muted-foreground block text-xs">
                      需要：{scopeRequiresLabel(scope.value)}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
