/**
 * Prism/refractor tokenizing, shared by the file viewer (`CodeView`) and the
 * fenced code blocks inside rendered markdown.
 *
 * One extension→language table, one serializer, one escape: the two surfaces
 * would otherwise drift into highlighting the same file differently depending on
 * whether you opened it as source or as a preview. Token colors come from
 * `.code-hl .token.*` in `styles.css`; unknown languages fall back to plain,
 * escaped text.
 */
import { refractor } from "refractor";

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

/** File extension → refractor/Prism language id (only ones in the common set). */
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  dockerfile: "docker",
};

/** The aliases a fenced code block's info string uses that aren't file
 *  extensions — `shell`, `yml`, `console`. Everything else falls through to the
 *  extension table, which already covers `ts`, `rust`, `json` and friends. */
const FENCE_ALIAS: Record<string, string> = {
  shell: "bash",
  console: "bash",
  sh: "bash",
  "objective-c": "c",
  yml: "yaml",
  jsonc: "json",
  text: "",
  plaintext: "",
  txt: "",
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serialize(nodes: HastNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return escapeHtml(n.value ?? "");
      const cls = n.properties?.className?.join(" ") ?? "";
      return `<span class="${cls}">${serialize(n.children ?? [])}</span>`;
    })
    .join("");
}

/** The language for a file, by name. `Dockerfile` has no extension, so it is
 *  matched whole. */
export function langForFile(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile") return "docker";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  return EXT_LANG[ext];
}

/** The language for a markdown fence's info string (`ts`, `bash`, `rust`), or
 *  `undefined` when it names nothing we can tokenize. */
export function langForFence(info: string): string | undefined {
  const name = info
    .trim()
    .toLowerCase()
    .split(/[\s,:]/)[0];
  if (!name) return undefined;
  const alias = FENCE_ALIAS[name];
  if (alias !== undefined) return alias || undefined;
  return refractor.registered(name) ? name : EXT_LANG[name];
}

/**
 * `code` as HTML: Prism token spans when `lang` is one refractor knows, plain
 * escaped text otherwise.
 *
 * Always escaped — this is the only reason the result is safe to hand to
 * `dangerouslySetInnerHTML`, and it holds for both branches. Nothing from the
 * source ever reaches the output as markup.
 */
export function highlightToHtml(code: string, lang: string | undefined): string {
  if (lang && refractor.registered(lang)) {
    try {
      return serialize(refractor.highlight(code, lang).children as HastNode[]);
    } catch {
      // A grammar that throws on pathological input is a rendering problem, not
      // a reason to show nothing — fall through to plain text.
    }
  }
  return escapeHtml(code);
}
