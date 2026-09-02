/**
 * Minimal Jinja/minijinja highlighter for the prompt editor.
 *
 * Colors the three template constructs — `{{ expr }}`, `{% tag %}`, and
 * `{# comment #}` — and escapes everything else as plain text. Token colors come
 * from `.prompt-editor .token.*` in `styles.css`. Deliberately not a full parser:
 * prompts are prose with a few interpolations, so delimiter-level coloring is
 * enough and can't mis-tokenize the surrounding natural language.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Sentinels the backend preview wraps around each `{{ … }}` interpolation (see
 *  `prompts.rs` `MARK_OPEN`/`MARK_CLOSE`). Private-use code points that never
 *  occur in real ticket text. */
const MARK_OPEN = String.fromCharCode(0xe000);
const MARK_CLOSE = String.fromCharCode(0xe001);

/** The rendered prompt with the substitution marks removed — the text the agent
 *  gets, for a view (the markdown one) that can't tint and must not show them. */
export function stripRenderMarks(output: string): string {
  return output.replace(new RegExp(`[${MARK_OPEN}${MARK_CLOSE}]`, "g"), "");
}

/** Highlight the *rendered* preview output as an HTML string: escape it, then tint
 *  the marker-wrapped spans (the values substituted from `{{ … }}`) so the
 *  issue-specific parts stand out from the template's static prose. Stray
 *  (unpaired) sentinels are dropped. */
export function highlightRendered(output: string): string {
  return escapeHtml(output)
    .replace(
      new RegExp(`${MARK_OPEN}([\\s\\S]*?)${MARK_CLOSE}`, "g"),
      '<span class="token var">$1</span>',
    )
    .replace(new RegExp(`[${MARK_OPEN}${MARK_CLOSE}]`, "g"), "");
}

/** Highlight prompt template source as an HTML string for
 *  `react-simple-code-editor`'s `highlight` prop. */
export function highlightJinja(code: string): string {
  // Split on the Jinja delimiters, keeping them (capturing group), so the parts
  // alternate between plain text and delimited constructs.
  const parts = code.split(/(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\})/g);
  return parts
    .map((p) => {
      if (p.startsWith("{{")) return `<span class="token var">${escapeHtml(p)}</span>`;
      if (p.startsWith("{%")) return `<span class="token tag">${escapeHtml(p)}</span>`;
      if (p.startsWith("{#")) return `<span class="token comment">${escapeHtml(p)}</span>`;
      return escapeHtml(p);
    })
    .join("");
}
