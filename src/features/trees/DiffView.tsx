/** A worktree's diff: file hunks + commit panel, or a clean-tree state. */
import { useMemo, useState } from "react";

import { useCommitSuggestion, useWorktreeDiff } from "../../lib/queries";
import { useTrees } from "./model";

interface DiffRow {
  key: string;
  text: string;
  meta: string;
  color: string;
  bg: string;
  bold: boolean;
}

export function DiffView() {
  const { activeId } = useTrees();
  const { data: diff } = useWorktreeDiff(activeId);
  const { data: suggestion = "" } = useCommitSuggestion(activeId);
  const [draft, setDraft] = useState<string | null>(null);

  const rows = useMemo<DiffRow[]>(() => {
    if (!diff?.files) return [];
    const out: DiffRow[] = [];
    diff.files.forEach((f, fi) => {
      out.push({
        key: `f-${fi}`,
        text: `▾ ${f.path}`,
        meta: `${f.tag.toLowerCase()}  +${f.addLines} −${f.delLines}`,
        color: "var(--color-fg-3)",
        bg: "var(--color-raised-alt)",
        bold: true,
      });
      f.hunks.forEach((h, hi) => {
        out.push({
          key: `h-${fi}-${hi}`,
          text: h.header,
          meta: "",
          color: "var(--color-diff-hunk)",
          bg: "rgba(111,168,208,.06)",
          bold: false,
        });
        h.lines.forEach((ln, li) => {
          const isAdd = ln.kind === "Add";
          const isDel = ln.kind === "Del";
          out.push({
            key: `l-${fi}-${hi}-${li}`,
            text: `${isAdd ? "+ " : isDel ? "- " : "  "}${ln.text}`,
            meta: "",
            color: isAdd
              ? "var(--color-diff-add)"
              : isDel
                ? "var(--color-diff-del)"
                : "var(--color-muted-2)",
            bg: isAdd ? "rgba(63,185,80,.09)" : isDel ? "rgba(248,81,73,.09)" : "transparent",
            bold: false,
          });
        });
      });
    });
    return out;
  }, [diff]);

  if (!diff) return null;

  // Clean working tree — nothing to commit.
  if (diff.clean || diff.files.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 text-muted-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-[11px] border border-status-green/30 bg-status-green/10 text-[18px] text-status-green">
          ✓
        </div>
        <span className="text-[13px] text-muted">Working tree clean — nothing to commit</span>
        {diff.prNote && (
          <span className="font-mono text-[11px] text-status-green">{diff.prNote}</span>
        )}
      </div>
    );
  }

  const message = draft ?? suggestion;
  const fileCount = diff.files.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto py-1 font-mono text-[11.5px] leading-[1.55]">
        {rows.map((r) => (
          <div
            key={r.key}
            className="flex items-center gap-2.5 px-3.5 py-0.5 whitespace-pre"
            style={{ background: r.bg, color: r.color, fontWeight: r.bold ? 600 : 400 }}
          >
            <span className="flex-1 overflow-hidden text-ellipsis">{r.text}</span>
            {r.meta && (
              <span className="flex-none text-[10px] font-normal text-muted-2">{r.meta}</span>
            )}
          </div>
        ))}
      </div>

      <div className="flex-none border-t border-line bg-panel px-3.5 pt-[11px] pb-3.5">
        <div className="mb-[7px] flex items-center justify-between">
          <span className="font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
            Commit message
          </span>
          <button
            type="button"
            onClick={() => setDraft(suggestion)}
            className="flex cursor-pointer items-center gap-1.5 border-none bg-transparent text-[11px] hover:brightness-110"
            style={{ color: "var(--accent)" }}
          >
            <span className="text-[11px]">✦</span>Generate
          </button>
        </div>
        <input
          type="text"
          value={message}
          onChange={(e) => setDraft(e.target.value)}
          className="mb-2.5 w-full rounded-lg border border-line-3 bg-input px-[11px] py-2.5 font-mono text-[12px] text-fg-3"
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 cursor-pointer rounded-lg border border-line-3 bg-raised-2 py-2.5 text-[12.5px] text-fg-2 hover:border-line-strong"
          >
            Commit {fileCount} {fileCount === 1 ? "file" : "files"}
          </button>
          <button
            type="button"
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-none py-2.5 text-[12.5px] font-semibold text-[color:var(--on-accent)] hover:brightness-110"
            style={{ background: "var(--accent)" }}
          >
            <span className="text-[11px]">✦</span>Commit &amp; open PR
          </button>
        </div>
      </div>
    </div>
  );
}
