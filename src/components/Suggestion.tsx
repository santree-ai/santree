/**
 * GitHub's "Suggested change" panel — the ```suggestion fenced block a review
 * comment can carry, rendered as the diff it describes rather than as code: the
 * lines it would replace in red above the ones it proposes in green.
 *
 * The replaced lines aren't in the comment body (GitHub derives them from the
 * thread's anchor), so they arrive through {@link SuggestionOriginal} rather than
 * a prop: the block is reached through {@link Markdown}'s renderer, which is
 * generic and shouldn't grow review-specific props. Without a provider the panel
 * shows the suggestion alone, which is what the sidebar's file-less thread list
 * and any non-review markdown get.
 */
import { createContext, use } from "react";

import { alpha, palette } from "../theme/colors";

/** The lines a suggestion in this subtree would replace, in order. */
export const SuggestionOriginal = createContext<string[] | null>(null);

function Row({ sign, text, color }: { sign: string; text: string; color: string }) {
  return (
    <div
      className="flex min-h-[1.55em] px-2.5"
      style={{ background: alpha(sign === "+" ? 11 : 10, color) }}
    >
      <span className="w-3 flex-none select-none" style={{ color }} aria-hidden>
        {sign}
      </span>
      <span className="whitespace-pre">{text}</span>
    </div>
  );
}

export function SuggestedChange({ text }: { text: string }) {
  const original = use(SuggestionOriginal);
  // The fence's trailing newline is the delimiter, not a line. An otherwise empty
  // suggestion is a deletion — GitHub's meaning too — so it renders as no green
  // rows rather than one blank one.
  const body = text.replace(/\n$/, "");
  const suggested = body === "" ? [] : body.split("\n");

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-line-2">
      <div className="border-b border-line-2 bg-input px-2.5 py-1 text-[10.5px] font-medium text-muted-2">
        Suggested change
      </div>
      <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55] text-fg-3">
        {original?.map((line, i) => (
          <Row key={`o${i}-${line}`} sign="-" text={line} color={palette.red} />
        ))}
        {suggested.map((line, i) => (
          <Row key={`n${i}-${line}`} sign="+" text={line} color={palette.green} />
        ))}
      </div>
    </div>
  );
}
