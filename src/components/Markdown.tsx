/**
 * Markdown renderer for issue descriptions and comments. Linear issue bodies are
 * GitHub-flavored markdown and may embed images, so we render with `remark-gfm`
 * and theme each element to match the dark UI. Images get a framed, max-width
 * treatment; code is monospaced in a subtle well.
 */
import { memo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

// Linear-CDN images are inlined by the backend as `data:` URIs; react-markdown's
// default URL sanitizer drops `data:` URLs, so allow image data URIs through
// while keeping the default safety checks for everything else.
const urlTransform = (url: string) =>
  url.startsWith("data:image/") ? url : defaultUrlTransform(url);

const components: Components = {
  p: ({ children }) => <p className="mb-2.5 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mt-3 mb-1.5 text-[14px] font-semibold text-fg-bright">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-1.5 text-[13px] font-semibold text-fg-bright">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2.5 mb-1 text-[12px] font-semibold tracking-[.02em] text-fg-2 uppercase">
      {children}
    </h3>
  ),
  ul: ({ children }) => <ul className="mb-2.5 ml-1 space-y-1">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mb-2.5 ml-4 list-decimal space-y-1 marker:text-muted-4">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="relative pl-3.5 before:absolute before:left-0 before:text-muted-4 before:content-['–']">
      {children}
    </li>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-dotted underline-offset-2"
      style={{ color: "var(--accent)" }}
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg-bright">{children}</strong>,
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      className="my-2.5 max-w-full rounded-lg border border-line-3"
    />
  ),
  // Block code is `<pre><code>`; the `pre` supplies the box so multi-line
  // fenced blocks render correctly even when they carry no language. `code`
  // styles inline snippets only (block code is detected by a language class or
  // an embedded newline, and rendered plain so the `pre` chrome isn't doubled).
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const block = (className ?? "").includes("language-") || text.includes("\n");
    if (block) return <code className="font-mono">{children}</code>;
    return (
      <code className="rounded border border-line-2 bg-input px-1 py-px font-mono text-[11px] text-fg-2">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2.5 overflow-x-auto rounded-lg border border-line-2 bg-input p-3 font-mono text-[11.5px] leading-[1.55] whitespace-pre text-fg-3">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-muted-2 italic">
      {children}
    </blockquote>
  ),
};

/**
 * Linear's editor serializes to slightly off-spec markdown — e.g. a non-breaking
 * space before a closing `**` (so `**Description: **` won't bold under
 * CommonMark) and stray lone `**` lines. Normalize those so bold renders the way
 * Linear shows it.
 */
function normalizeLinearMarkdown(md: string): string {
  return (
    md
      // NBSP → regular space.
      .replace(new RegExp(String.fromCharCode(160), "g"), " ")
      // Move whitespace that sits just inside bold delimiters to the outside, so
      // `**Description: **` → `**Description:** `.
      .replace(/\*\*([ \t]*)([^*\n]+?)([ \t]*)\*\*/g, "$1**$2**$3")
      // Drop lines that are only a stray `**`.
      .replace(/^[ \t]*\*\*[ \t]*$/gm, "")
  );
}

// Parsing markdown (especially issue bodies with inline base64 images) is the
// single most expensive render in the app. Memoize on the source string so an
// unrelated re-render (selection change, resize) never re-parses an already
// rendered body — only a genuinely new string pays the cost.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[12.5px] leading-[1.6] text-fg-2 [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
        urlTransform={urlTransform}
      >
        {normalizeLinearMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
});
