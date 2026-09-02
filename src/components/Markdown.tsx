/**
 * Markdown renderer for issue descriptions and comments. Linear issue bodies are
 * GitHub-flavored markdown and may embed images, so we render with `remark-gfm`
 * and theme each element to match the dark UI. Images get a framed, max-width
 * treatment; code is monospaced in a subtle well.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { type CSSProperties, createContext, memo, type ReactNode, useContext } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { highlightToHtml, langForFence } from "../lib/highlight";
import { MermaidDiagram } from "./MermaidDiagram";
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

/**
 * Signed links for the `user-attachments` assets a GitHub body points at, by id.
 *
 * A screenshot in a PR description is written as
 * `https://github.com/user-attachments/assets/<id>`, and on a private repo that
 * URL is served only to a browser session — the webview has none, so every one
 * of them rendered as a broken icon while GitHub's own page showed them fine.
 * The backend reads GitHub's pre-signed CDN links out of the same PR query
 * (`PrDetail.attachments`), and this is how they reach the `<img>`: a context
 * rather than a prop, because the swap has to happen in a body, a comment, a
 * review and a draft alike, and threading a map through all four would put the
 * detail in every caller instead of in the one component that renders images.
 *
 * The links expire in about five minutes, so they are never stored — the map
 * lives exactly as long as the read that produced it.
 */
const AttachmentContext = createContext<Record<string, string>>({});

export function MarkdownAttachments({
  attachments,
  children,
}: {
  attachments: { id: string; url: string }[] | undefined;
  children: ReactNode;
}) {
  // Rebuilt per render on purpose: the array is a query result, so it is
  // referentially stable between refetches and changes exactly when the links do.
  const map: Record<string, string> = {};
  for (const a of attachments ?? []) map[a.id] = a.url;
  return <AttachmentContext.Provider value={map}>{children}</AttachmentContext.Provider>;
}

/** The id in `https://github.com/user-attachments/assets/<id>`, or null for any
 *  other image. Matched on the parsed URL, not a prefix: `github.com.evil.test`
 *  starts with the same characters. */
export function attachmentId(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.host !== "github.com") return null;
  const [, first, second, id, ...rest] = url.pathname.split("/");
  if (first !== "user-attachments" || second !== "assets" || rest.length > 0) return null;
  return id || null;
}

/**
 * One image in a body.
 *
 * A GitHub attachment is swapped for the signed link that will actually load it;
 * everything else (a Linear `data:` URI, a public image) is rendered as written.
 * An attachment with no link in the map is *not* rendered as a broken icon —
 * that is the state this whole path exists to remove — but as its own alt text,
 * which is what the author wrote the image to say.
 */
function BodyImage({ src, alt }: { src: string | undefined; alt: string | undefined }) {
  const attachments = useContext(AttachmentContext);
  const id = src ? attachmentId(src) : null;
  const resolved = id ? attachments[id] : src;

  if (id && !resolved) {
    return (
      <span
        className="my-2.5 flex items-center gap-1.5 rounded-lg border border-dashed border-line-3 px-2.5 py-2 text-[11px] text-muted-4"
        title="This attachment is private to the repository, and its signed link hasn't arrived yet."
      >
        {alt || "Attachment"}
      </span>
    );
  }
  return (
    <img
      src={resolved}
      alt={alt ?? ""}
      className="my-2.5 max-w-full rounded-lg border border-line-3"
    />
  );
}

/** A hast node, structurally — enough to walk a `<pre>` without pulling in the
 *  full hast types for two fields. */
interface HastLike {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

/** Every text descendant, concatenated. A fence's `<code>` is usually one text
 *  node, but rehype-raw can split it. */
function textOf(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

interface Fence {
  /** The fence's info string (`ts`, `mermaid`, `suggestion`), or `""`. */
  lang: string;
  text: string;
}

/** The info string + raw source of a fenced code block, from the `<pre>`'s own
 *  node. `null` when the `<pre>` isn't a fence — raw HTML can produce one, and
 *  it has no `<code>` to read a language off. The `language-*` class survives
 *  rehype-sanitize, whose default schema allows it on `code`. */
function codeFence(node: unknown): Fence | null {
  const pre = node as HastLike | undefined;
  const code = pre?.children?.find((c) => c.type === "element" && c.tagName === "code");
  if (!code) return null;
  const cls = code.properties?.className;
  const classes = Array.isArray(cls) ? cls.map(String) : String(cls ?? "").split(/\s+/);
  const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
  return { lang, text: textOf(code) };
}

const FENCE_CLASS =
  "mb-2.5 overflow-x-auto rounded-lg border border-line-2 bg-input p-3 font-mono text-[11.5px] leading-[1.55] whitespace-pre text-fg-3";

/** A fenced code block, tokenized when its info string names a language we know.
 *  Falls back to react-markdown's own children for a `<pre>` that isn't a fence,
 *  so raw HTML keeps rendering as it did. */
function CodeFence({ fence, children }: { fence: Fence | null; children?: ReactNode }) {
  if (!fence) return <pre className={FENCE_CLASS}>{children}</pre>;
  return (
    <pre
      className={`code-hl ${FENCE_CLASS}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized from our own escaped Prism tokens (see lib/highlight.ts).
      dangerouslySetInnerHTML={{ __html: highlightToHtml(fence.text, langForFence(fence.lang)) }}
    />
  );
}

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
  img: ({ src, alt }) => <BodyImage src={typeof src === "string" ? src : undefined} alt={alt} />,
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
  // panel replaces the whole block, chrome included. Everything else is
  // tokenized by its info string; an unlabelled or unknown fence renders as
  // plain escaped text, which is what it was before.
  pre: ({ children, node }) => {
    const fence = codeFence(node);
    if (fence?.lang === "suggestion") return <SuggestedChange text={fence.text} />;
    return <CodeFence fence={fence}>{children}</CodeFence>;
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
export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    // The trailing-margin reset is why a comment card doesn't end in a band of
    // dead space: paragraphs carry `last:mb-0` themselves, but a body ending in a
    // code block, list, table or `<details>` — which is most bot output — left its
    // block margin sitting inside the card's own padding.
    <div
      className={`selectable [overflow-wrap:anywhere] [&>*:last-child]:mb-0 ${className ?? "text-[12.5px] leading-[1.6] text-fg-2"}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, literalizeUnknownHtml]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={components}
        urlTransform={urlTransform}
      >
        {/* Trimmed: `remarkBreaks` turns a trailing blank line into a real `<br>`,
            and GitHub comment bodies routinely end with one or two. Untrimmed,
            every bot comment ends in a band of dead space inside its card. */}
        {normalizeLinearMarkdown(children.trim())}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A markdown *file*, rendered — the preview half of the file viewer's
 * Code/Preview toggle.
 *
 * Three deliberate differences from {@link Markdown}, which exists for issue and
 * PR comments:
 *
 *  - **No `remarkBreaks`.** A comment box treats every newline as a line break
 *    because that is how the person typing it meant it. A README is hard-wrapped
 *    prose, and breaking on every newline would shred every paragraph in it.
 *  - **No Linear normalization.** The source is the author's file, not Linear's
 *    editor output, so "fixing" its bold delimiters would be rewriting it.
 *  - **Diagrams render.** A ```mermaid fence becomes a diagram here and nowhere
 *    else; see `MermaidDiagram` for why that line is drawn at files.
 *
 * Headings step up a size too: a document is read at document scale, where a
 * comment card is glanced at inside a list.
 */
const documentComponents: Components = {
  ...components,
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2.5 border-b border-line pb-1.5 text-[19px] font-semibold tracking-[-.01em] text-fg-bright first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 border-b border-line pb-1.5 text-[15.5px] font-semibold text-fg-bright first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-[13.5px] font-semibold text-fg-2">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3.5 mb-1 text-[12.5px] font-semibold text-fg-2">{children}</h4>
  ),
  hr: () => <hr className="my-4 border-t border-line" />,
  pre: ({ children, node }) => {
    const fence = codeFence(node);
    if (fence?.lang === "mermaid") return <MermaidDiagram code={fence.text} />;
    if (fence?.lang === "suggestion") return <SuggestedChange text={fence.text} />;
    return <CodeFence fence={fence}>{children}</CodeFence>;
  },
};

export const MarkdownDocument = memo(function MarkdownDocument({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={`selectable [overflow-wrap:anywhere] [&>*:last-child]:mb-0 ${className ?? "text-[13px] leading-[1.65] text-fg-2"}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, literalizeUnknownHtml]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={documentComponents}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Compact markdown for entity names (Linear issues, worktrees and PRs). Titles
 * are inline content, so deliberately support only emphasis, deletion and code:
 * block structures would break card/button layout, and links would create nested
 * interactive elements on the many surfaces where a title is itself clickable.
 */
const inlineComponents: Components = {
  p: ({ children }) => <span>{children}</span>,
  strong: ({ children }) => <strong className="font-semibold text-fg-bright">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del>{children}</del>,
  code: ({ children }) => (
    <code className="break-all rounded border border-line-2 bg-input px-1 py-px font-mono text-[.9em] text-fg-2 [box-decoration-break:clone]">
      {children}
    </code>
  ),
};

export const MarkdownTitle = memo(function MarkdownTitle({
  children,
  className = "",
  style,
  title,
}: {
  children: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <span className={`[overflow-wrap:anywhere] ${className}`} style={style} title={title}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, literalizeUnknownHtml]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        allowedElements={["p", "strong", "em", "del", "code"]}
        unwrapDisallowed
        components={inlineComponents}
      >
        {normalizeLinearMarkdown(children)}
      </ReactMarkdown>
    </span>
  );
});
