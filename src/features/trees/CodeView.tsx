/**
 * A read-only, syntax-highlighted view of a file's contents — used when a file
 * picked from the "All files" tab isn't a diff. Tokenizes with `refractor`
 * (Prism) by file extension and renders the spans; token colors come from
 * `.code-hl .token.*` in `styles.css`. Unknown languages fall back to plain text.
 */
import { useMemo } from "react";

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

function escapeHtml(s: string): string {
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

function langFor(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile") return "docker";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  return EXT_LANG[ext];
}

export function CodeView({ path, content }: { path: string; content: string }) {
  const html = useMemo(() => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const lang = langFor(name);
    if (lang && refractor.registered(lang)) {
      try {
        return serialize(refractor.highlight(content, lang).children as HastNode[]);
      } catch {
        // fall through to plain
      }
    }
    return escapeHtml(content);
  }, [path, content]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <pre
        className="code-hl selectable px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre text-fg-3"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized from our own escaped Prism tokens.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
