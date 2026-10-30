/** Text that can run long — a pasted log, a command's output, a file read — shown
 *  to a few lines with a way to the rest. Counted in lines and characters of the
 *  text rather than measured, so it costs no layout read and a test sees what a
 *  user sees. The font is the caller's: prose stays sans, output says mono. */
import { useState } from "react";

/** Past this many characters a text is cut even when it has few lines (one
 *  line of minified JSON can be the whole screen). */
const CHAR_CAP = 4000;

export function Clamped({
  text,
  lines = 12,
  className,
}: {
  text: string;
  lines?: number;
  /** The text's look: font, size, color, box. */
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const all = text.split("\n");
  const long = all.length > lines || text.length > CHAR_CAP;
  const head = all.slice(0, lines).join("\n");
  const shown = open || !long ? text : head.length > CHAR_CAP ? head.slice(0, CHAR_CAP) : head;
  return (
    <div className="min-w-0">
      <div className={`selectable whitespace-pre-wrap break-words ${className}`}>{shown}</div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 cursor-pointer text-xs font-medium text-muted-3 hover:text-fg-2"
        >
          {open
            ? "Show less"
            : all.length > lines
              ? `Show all ${all.length.toLocaleString()} lines`
              : "Show all"}
        </button>
      )}
    </div>
  );
}
