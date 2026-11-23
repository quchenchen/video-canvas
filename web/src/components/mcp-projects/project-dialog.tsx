import { useState } from "react";

import type { MCPProjectItem } from "@/api/admin/mcp-project/type";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/admin-ui/dialog";
import { FormField } from "@/components/admin-ui/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { ScopeChecklist } from "./scope-fields";
import { emptyProjectForm, type MCPProjectsState } from "./use-mcp-projects";

/** 弹窗打开的对象：null 表示关闭；kind 决定是新建还是改已有项目。 */
export type ProjectDialogTarget = { kind: "new" } | { kind: "edit"; item: MCPProjectItem };

/**
 * 接入项目弹窗：新建与编辑共用一个表单，和后台其他配置页一致（列表页「新建」按钮 + 弹窗）。
 *
 * 新建时只填名称与能力：归属就是当前登录用户，默认画布留空——那两项不是新建时该做的决定。
 * 编辑时多给一个「默认画布」，因为它是「配一次、以后每次调用都用」的东西。
 *
 * @param target 打开的对象，null 表示关闭
 * @param state 页面数据层，保存走 state.create / state.update
 * @param onClose 关闭（保存成功也走这里）
 */
export function ProjectDialog({
  target,
  state,
  onClose,
}: {
  target: ProjectDialogTarget;
  state: MCPProjectsState;
  onClose: () => void;
}) {
  const editing = target.kind === "edit" ? target.item : null;
  const [form, setForm] = useState(() =>
    editing
      ? {
          name: editing.name,
          ownerUserId: String(editing.owner_user_id ?? ""),
          canvasCode: editing.canvas_code ?? "",
          scopes: editing.scopes,
        }
      : emptyProjectForm(),
  );

  const submit = async () => {
    const ok = editing ? await state.update(editing, form) : await state.create(form);
    if (ok) onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑「${editing.name}」` : "新建接入项目"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "改完立刻生效，已签发的令牌不用换。"
              : "归属就是你本人；默认画布留空，调用时自己带。"}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FormField label="名称" htmlFor="mcp-project-name">
            <Input
              id="mcp-project-name"
              value={form.name}
              maxLength={64}
              placeholder="如：本机 Codex"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </FormField>
          {editing && (
            <FormField
              label="默认画布"
              htmlFor="mcp-project-canvas"
              hint="可留空；填了之后外部调用没指定画布时就用它。只能填自己名下的画布"
            >
              <Input
                id="mcp-project-canvas"
                value={form.canvasCode}
                maxLength={32}
                spellCheck={false}
                className="font-mono"
                placeholder="画布地址末尾那串 32 位十六进制，可空"
                onChange={(e) => setForm({ ...form, canvasCode: e.target.value })}
              />
            </FormField>
          )}
          <ScopeChecklist
            scopes={form.scopes}
            onChange={(scopes) => setForm({ ...form, scopes })}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={state.busy}>
              {editing ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
