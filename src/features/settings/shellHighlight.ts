/**
 * Minimal bash syntax highlighter for the setup-script editor.
 *
 * `refractor` (Prism) tokenizes to a hast tree; we serialize it to an HTML string
 * for `react-simple-code-editor`'s `highlight` prop. We hand-roll the serializer
 * because `hast-util-to-html` isn't a dependency and Prism only emits `<span>` +
 * text nodes — token colors come from `.shell-editor .token.*` in `styles.css`.
 */
import { refractor } from "refractor";

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

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

/** Highlight bash source as an HTML string; falls back to escaped plain text. */
export function highlightShell(code: string): string {
  try {
    const tree = refractor.highlight(code, "bash");
    return serialize(tree.children as HastNode[]);
  } catch {
    return escapeHtml(code);
  }
}
