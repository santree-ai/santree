/**
 * A santree draft is stored as two fields — the comment and, optionally, the exact
 * replacement lines — because the two are edited independently and only ever join
 * up at the end. GitHub has no such split: it reads one body with a ```suggestion
 * block in it.
 *
 * So the join happens twice, and the two must agree. `review_drafts.rs`'s
 * `compose_body` builds the body that gets posted; this builds the one the user
 * edits, and takes it back apart on save. A round trip through the editor must not
 * quietly turn a suggestion into prose.
 */
import type { ReviewDraft } from "../../bindings";

/** The longest run of backticks anywhere in `s`. */
function longestFence(s: string): number {
  let longest = 0;
  let run = 0;
  for (const c of s) {
    run = c === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** One editable text from a draft's two fields. Mirrors `compose_body` in
 *  `src-tauri/src/review_drafts.rs` — the fence grows past any backticks in the
 *  suggested code, so suggesting a Markdown file can't end the block early. */
export function composeDraftBody(draft: Pick<ReviewDraft, "body" | "suggestion">): string {
  const body = draft.body.trim();
  const suggestion = draft.suggestion?.trim();
  if (!suggestion) return body;
  const fence = "`".repeat(Math.max(longestFence(suggestion) + 1, 3));
  const block = `${fence}suggestion\n${suggestion}\n${fence}`;
  return body ? `${body}\n\n${block}` : block;
}

/** Take an edited body back apart. Only a suggestion block at the very end is
 *  lifted out: one in the middle is the user writing *about* a suggestion, and
 *  hoisting it would move their words around. */
export function splitDraftBody(text: string): { body: string; suggestion: string | null } {
  const match = text.trimEnd().match(/(^|\n)(`{3,})suggestion[^\n]*\n([\s\S]*?)\n?\2\s*$/);
  if (!match) return { body: text.trim(), suggestion: null };
  const body = text.slice(0, match.index).trim();
  const suggestion = match[3];
  return { body, suggestion: suggestion.length > 0 ? suggestion : null };
}
