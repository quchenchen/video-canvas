import { useCallback, useEffect, useState } from "react";
import { CircleCheckBig, CircleSlash, Loader2, Terminal } from "lucide-react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import {
  approveCLIDevice,
  denyCLIDevice,
  getCLIDevice,
  type CLIDeviceInfo,
} from "@/api/auth/cli-device";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** 页面阶段：输入码 / 读取中 / 待确认 / 已同意 / 已拒绝 / 读不到 */
type Phase = "input" | "loading" | "ready" | "approved" | "denied" | "error";

/** 把后端的 RFC3339 时间展示成本地时间；不依赖「现在」，避免渲染期读时钟。 */
function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString("zh-CN", { hour12: false });
}

/**
 * 命令行登录的授权页：CLI 申请一对码后把用户引到这里，用户确认后命令行才拿到令牌。
 *
 * 这一页不接收密码、也不签发令牌——令牌只在命令行轮询时下发，页面只做「同意 / 拒绝」。
 * 用户码可以从 URL 带进来，也可以手输：命令行打印的地址带 code，用户自己打开站点时则要手输。
 */
export default function CLIAuthorize() {
  const [params] = useSearchParams();
  const queryCode = params.get("code") ?? "";
  const [code, setCode] = useState(queryCode);
  const [device, setDevice] = useState<CLIDeviceInfo | null>(null);
  const [phase, setPhase] = useState<Phase>(queryCode ? "loading" : "input");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setPhase("input");
      return;
    }
    setPhase("loading");
    try {
      const info = await getCLIDevice(trimmed);
      setDevice(info);
      // 已经处理过的码（刷新页面、重复打开）直接显示结果，不再让用户点一次
      if (info.status === "approved" || info.status === "consumed") setPhase("approved");
      else if (info.status === "denied") setPhase("denied");
      else setPhase("ready");
    } catch {
      setDevice(null);
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (queryCode) void load(queryCode);
  }, [queryCode, load]);

  const decide = async (allow: boolean) => {
    if (!device) return;
    setSubmitting(true);
    try {
      if (allow) {
        await approveCLIDevice(device.user_code);
        setPhase("approved");
      } else {
        await denyCLIDevice(device.user_code);
        setPhase("denied");
      }
    } catch {
      toast.error("操作失败，请在命令行重新执行登录");
    } finally {
      setSubmitting(false);
    }
  };

  const expired = device?.status === "expired" || device?.status === "consumed";

  return (
    <main className="bg-background grid min-h-svh place-items-center p-6">
      <section className="bg-card flex w-full max-w-md flex-col gap-4 rounded-2xl border p-8">
        <div className="flex items-center gap-3">
          <div className="bg-muted grid size-10 place-items-center rounded-full">
            <Terminal className="size-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold">授权命令行登录</h1>
            <p className="text-muted-foreground text-xs">
              确认后，命令行会以你的身份访问画布与生成任务
            </p>
          </div>
        </div>

        {phase === "input" || phase === "loading" || phase === "error" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void load(code);
            }}
          >
            <label className="text-sm" htmlFor="cli-user-code">
              命令行上显示的用户码
            </label>
            <Input
              id="cli-user-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="ABCD-EFGH"
              autoComplete="off"
              autoFocus
              spellCheck={false}
            />
            {phase === "error" ? (
              <p className="text-destructive text-xs">
                用户码不对或已过期，请在命令行重新执行登录。
              </p>
            ) : null}
            <Button type="submit" disabled={phase === "loading" || !code.trim()}>
              {phase === "loading" ? <Loader2 className="size-4 animate-spin" /> : null}
              继续
            </Button>
          </form>
        ) : null}

        {phase === "ready" && device ? (
          <>
            <dl className="bg-muted/50 grid gap-2 rounded-xl p-4 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">设备</dt>
                <dd className="truncate font-medium">{device.client_name || "命令行工具"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">用户码</dt>
                <dd className="font-mono">{device.user_code}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">到期时间</dt>
                <dd>{formatTime(device.expires_at)}</dd>
              </div>
            </dl>
            {expired ? (
              <p className="text-destructive text-xs">
                这次申请已失效（过期或已被使用），请在命令行重新执行登录。
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                如果不是你本人发起，请点「拒绝」。授权后命令行会拿到和网页登录同等的权限。
              </p>
            )}
            <div className="flex gap-3">
              <Button
                className="flex-1"
                disabled={submitting || expired}
                onClick={() => void decide(true)}
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                同意授权
              </Button>
              <Button
                className="flex-1"
                variant="outline"
                disabled={submitting}
                onClick={() => void decide(false)}
              >
                拒绝
              </Button>
            </div>
          </>
        ) : null}

        {phase === "approved" || phase === "denied" ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            {phase === "approved" ? (
              <CircleCheckBig className="text-status-success size-10" />
            ) : (
              <CircleSlash className="text-muted-foreground size-10" />
            )}
            <p className="text-sm font-medium">{phase === "approved" ? "已授权" : "已拒绝"}</p>
            <p className="text-muted-foreground text-xs">
              {phase === "approved"
                ? "可以关闭这个页面，回到命令行继续操作。"
                : "命令行不会拿到令牌，可以关闭这个页面。"}
            </p>
          </div>
        ) : null}
      </section>
    </main>
  );
}
