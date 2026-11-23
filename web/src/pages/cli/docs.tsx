import ReactMarkdown, { type Components } from "react-markdown";
import { ChevronLeft, FileText } from "lucide-react";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";

import { DataPage } from "@/components/admin-ui/data-panel";
import { GLASS_PANEL } from "@/components/admin-ui/glass";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderTitle,
} from "@/components/admin-ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import cliDocs from "@/content/cli-docs.md?raw";

/**
 * 命令行文档（/cli/docs 与 /admin/cli/docs）：完整参考，正文由
 * `web/src/content/cli-docs.md` 渲染，改文档只改那份 markdown。
 *
 * 用 react-markdown + remark-gfm 渲染：不渲染原始 HTML，仓库里的 markdown
 * 就算带了标签也不会变成可执行内容；表格（退出码、排障）靠 gfm。
 */
export default function CLIDocsPage() {
  return (
    <DataPage>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle className="flex items-center gap-2">
            <FileText className="size-6" aria-hidden="true" />
            命令行文档
          </PageHeaderTitle>
          <p className="text-muted-foreground mt-1 text-sm">
            安装、5 分钟上手、输出契约与退出码、排障。装之前先看
            <Link className="text-primary mx-1 underline underline-offset-2" to="/cli">
              命令行（CLI）
            </Link>
            那一页的登录方式。
          </p>
        </PageHeaderHeading>
        <PageHeaderActions>
          <Link to="/cli" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <ChevronLeft />
            返回指南
          </Link>
        </PageHeaderActions>
      </PageHeader>

      <section className={`${GLASS_PANEL} mb-4 p-5`} data-slot="cli-docs">
        <article className="mx-auto max-w-4xl">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={DOC_COMPONENTS}>
            {cliDocs}
          </ReactMarkdown>
        </article>
      </section>
    </DataPage>
  );
}

/** 文档排版：标题层级比聊天里的 markdown 大一号，代码块可横向滚动。 */
const DOC_COMPONENTS: Components = {
  h1: ({ node: _n, ...p }) => (
    <h2 className="mt-0 mb-3 text-lg font-semibold tracking-tight" {...p} />
  ),
  h2: ({ node: _n, ...p }) => (
    <h3 className="border-chrome-border mt-6 mb-2 border-b pb-1.5 text-base font-semibold" {...p} />
  ),
  h3: ({ node: _n, ...p }) => <h4 className="mt-4 mb-1.5 text-sm font-semibold" {...p} />,
  p: ({ node: _n, ...p }) => <p className="my-2 text-sm leading-7" {...p} />,
  strong: ({ node: _n, ...p }) => <strong className="font-semibold" {...p} />,
  ul: ({ node: _n, ...p }) => <ul className="my-2 list-disc space-y-1 pl-5 text-sm" {...p} />,
  ol: ({ node: _n, ...p }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-sm" {...p} />,
  li: ({ node: _n, ...p }) => <li className="leading-7" {...p} />,
  blockquote: ({ node: _n, ...p }) => (
    <blockquote
      className="border-chrome-border text-muted-foreground my-3 border-l-2 pl-3 text-sm"
      {...p}
    />
  ),
  hr: () => <hr className="border-chrome-border my-5" />,
  a: ({ node: _n, ...p }) => (
    <a
      className="text-primary underline underline-offset-2"
      target="_blank"
      rel="noreferrer noopener"
      {...p}
    />
  ),
  pre: ({ node: _n, ...p }) => (
    <pre
      className="bg-foreground/6 my-3 overflow-x-auto rounded-lg px-3 py-2.5 text-xs leading-relaxed"
      {...p}
    />
  ),
  code: ({ node: _n, className, ...p }) => (
    <code
      className={
        className
          ? `font-mono text-[12.5px] ${className}`
          : "bg-foreground/8 rounded px-1 py-0.5 font-mono text-[12.5px]"
      }
      {...p}
    />
  ),
  table: ({ node: _n, ...p }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...p} />
    </div>
  ),
  th: ({ node: _n, ...p }) => (
    <th
      className="border-chrome-border bg-foreground/4 border px-2 py-1.5 text-left font-medium"
      {...p}
    />
  ),
  td: ({ node: _n, ...p }) => <td className="border-chrome-border border px-2 py-1.5" {...p} />,
};
