/**
 * Markdown renderer for issue descriptions and comments. Linear issue bodies are
 * GitHub-flavored markdown and may embed images, so we render with `remark-gfm`
 * and theme each element to match the dark UI. Images get a framed, max-width
 * treatment; code is monospaced in a subtle well.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { SuggestedChange } from "./Suggestion";

// GitHub-flavored content embeds raw HTML — most visibly Linear's linkback, which
// wraps the issue body in a collapsible `<details><summary>…</summary>`. Without
// raw-HTML rendering those tags (and the `<!-- linear-linkback -->` comment) leak
// out as literal text and nothing collapses. We render the HTML (rehype-raw) but
// sanitize it first (rehype-sanitize, GitHub's default schema) so issue/PR bodies
// from arbitrary authors can't inject scripts. The schema is widened only to:
//  - allow `<details>`/`<summary>` + the `open` attribute (the disclosure), and
//  - permit `data:` image sources (Linear inlines images as data URIs).
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details ?? []), "open"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};

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
    <h3 className="mt-2.5 mb-1 text-[12px] font-semibold text-fg-2">{children}</h3>
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
  // Tauri's WKWebView doesn't route `target="_blank"` to the system browser (it
  // either no-ops or navigates the app's own webview), so intercept the click and
  // hand the URL to the opener plugin. Still render a real `href` for
  // accessibility and right-click-to-copy.
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        if (href) void openUrl(href);
      }}
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
  // A ```suggestion fence is a review suggestion, not code — GitHub renders it as
  // the diff it describes. Intercepted on the `pre` (not the `code`) because the
  // panel replaces the whole block, chrome included. The language class survives
  // rehype-sanitize, whose default schema allows `language-*` on `code`.
  pre: ({ children, node }) => {
    const code = node?.children?.[0];
    const cls = code?.type === "element" ? code.properties?.className : undefined;
    const lang = Array.isArray(cls) ? cls.join(" ") : String(cls ?? "");
    if (lang.split(/\s+/).includes("language-suggestion")) {
      const text = code?.type === "element" ? code.children[0] : undefined;
      return <SuggestedChange text={text?.type === "text" ? text.value : ""} />;
    }
    return (
      <pre className="mb-2.5 overflow-x-auto rounded-lg border border-line-2 bg-input p-3 font-mono text-[11.5px] leading-[1.55] whitespace-pre text-fg-3">
        {children}
      </pre>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-muted-2 italic">
      {children}
    </blockquote>
  ),
  // Native disclosure (GitHub-style): collapsed unless the source set `open`. The
  // `summary` is the always-visible, clickable header; the rest reveals on toggle.
  details: ({ children }) => (
    <details className="my-2 rounded-lg border border-line-2 bg-input px-3 py-2 [&[open]>summary]:mb-2">
      {children}
    </details>
  ),
  summary: ({ children }) => (
    <summary className="cursor-pointer font-medium text-fg-2 marker:text-muted-4">
      {children}
    </summary>
  ),
  // GFM tables (remark-gfm). Without these overrides the table parses but renders
  // as bare, borderless cells (just runs of text); style them to match Linear.
  table: ({ children }) => (
    <div className="mb-2.5 overflow-x-auto rounded-lg border border-line-2">
      <table className="w-full border-collapse text-[11.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-input">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-line-2 px-2.5 py-1.5 text-left font-semibold text-fg-2 [&:not(:last-child)]:border-r">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-t border-line-2 px-2.5 py-1.5 align-top text-fg-3 [&:not(:last-child)]:border-r">
      {children}
    </td>
  ),
};

// Real HTML element names. CommonMark parses ANY `<tagname …>` as raw HTML, so
// issue-template placeholders (`<Add any relevant attachments>`) and generics
// (`Vec<String>`) become HTML nodes whose unknown tag is then stripped by
// rehype-sanitize — the text silently vanishes. This set is the allowlist of
// tags we let through to rehype-raw as real HTML (the Linear linkback's
// `<details>/<summary>`, images, breaks…); everything else is downgraded to
// literal text by `literalizeUnknownHtml` below.
const HTML_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "s",
  "samp",
  "source",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "video",
]);

// remark plugin: walk the mdast and turn any `html` node that isn't a recognized
// HTML tag (or an HTML comment) into a plain `text` node, so it renders as the
// literal characters the author typed instead of being parsed-then-stripped.
// Code fences / inline code are `code`/`inlineCode` nodes, never `html`, so
// they're untouched.
function literalizeUnknownHtml() {
  const visit = (node: { type: string; value?: string; children?: unknown[] }) => {
    if (node.type === "html" && typeof node.value === "string") {
      const isComment = node.value.startsWith("<!--");
      const tag = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(node.value)?.[1];
      if (!isComment && (!tag || !HTML_TAGS.has(tag.toLowerCase()))) {
        node.type = "text";
      }
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child as typeof node);
    }
  };
  return visit;
}

/**
 * Linear's editor serializes to slightly off-spec markdown — e.g. a non-breaking
 * space before a closing `**` (so `**Description: **` won't bold under
 * CommonMark) and stray lone `**` lines. Normalize those so bold renders the way
 * Linear shows it. Exported for testing — see Markdown.test.ts.
 */
export function normalizeLinearMarkdown(md: string): string {
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
    <div className="selectable text-[12.5px] leading-[1.6] text-fg-2 [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, literalizeUnknownHtml]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={components}
        urlTransform={urlTransform}
      >
        {normalizeLinearMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
});
