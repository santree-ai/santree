import { ViewShell } from "../chrome";
import { AI_REVIEW, type DiffLine, REVIEW_DIFF, REVIEW_META, REVIEW_PRS } from "../data";
import { CheckGlyph, ClaudeSpark, DiffStat } from "../widgets";

/** Reviews: PR dashboard — sidebar, diff hunk, AI companion comment. */

function DiffRow({ line }: { line: DiffLine }) {
  const tint =
    line.kind === "add"
      ? "bg-status-green/8 text-fg/85"
      : line.kind === "del"
        ? "bg-status-red/8 text-fg/60"
        : "text-fg/70";
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const markerColor =
    line.kind === "add"
      ? "text-status-green"
      : line.kind === "del"
        ? "text-status-red"
        : "text-muted-4";
  return (
    <div className={`flex ${tint}`}>
      <span className="w-8 shrink-0 pr-1 text-right text-muted-4/60 tabular-nums">
        {line.old ?? ""}
      </span>
      <span className="w-8 shrink-0 pr-2 text-right text-muted-4/60 tabular-nums">
        {line.new ?? ""}
      </span>
      <span className={`w-4 shrink-0 ${markerColor}`}>{marker}</span>
      <span className="whitespace-pre">{line.text}</span>
    </div>
  );
}

export function ReviewsView({ live: _live }: { live: boolean }) {
  return (
    <ViewShell
      sidebar={
        <>
          <div className="px-3 pb-1.5 pt-3 text-[11px] font-medium text-fg">My PRs</div>
          <div className="flex flex-col gap-0.5 px-1.5">
            {REVIEW_PRS.map((pr) => (
              <div
                key={pr.num}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${pr.active ? "bg-white/5" : ""}`}
              >
                <CheckGlyph state={pr.checks} />
                <span className="font-mono text-[9px] text-muted-4">#{pr.num}</span>
                <span className="truncate text-[10.5px] text-fg/90">{pr.title}</span>
              </div>
            ))}
          </div>
          <div className="px-3 pb-1.5 pt-4 text-[11px] font-medium text-muted-2">
            Review requests
          </div>
          <div className="px-3 text-[10px] text-muted-4">Inbox zero. Nice.</div>
        </>
      }
      main={
        <div className="flex min-h-0 flex-1 flex-col">
          {/* PR header */}
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-2.5">
            <span className="text-[12px] font-medium text-fg">{REVIEW_META.title}</span>
            <span
              className="rounded-full px-1.5 py-px font-mono text-[9px] text-status-green"
              style={{ background: "color-mix(in srgb, currentcolor 12%, transparent)" }}
            >
              open
            </span>
            <span className="ml-auto flex items-center gap-2">
              <DiffStat add={REVIEW_META.add} del={REVIEW_META.del} />
              <span className="font-mono text-[9px] text-muted-4">{REVIEW_META.files} files</span>
            </span>
          </div>
          {/* Diff */}
          <div className="min-h-0 flex-1 overflow-hidden px-4 py-3 font-mono text-[10.5px] leading-[1.6]">
            <div className="text-muted-2">{REVIEW_DIFF.file}</div>
            <div className="mt-1 text-term-cyan/80">{REVIEW_DIFF.hunk}</div>
            <div className="mt-1.5">
              {REVIEW_DIFF.lines.map((line) => (
                <DiffRow key={`${line.kind}-${line.old}-${line.new}`} line={line} />
              ))}
            </div>
            {/* AI companion comment, anchored to the hunk */}
            <div className="mt-3 max-w-[520px] rounded-lg border border-accent/30 bg-accent/4 px-3 py-2.5 font-sans">
              <div className="flex items-center gap-1.5">
                <span className="text-accent">
                  <ClaudeSpark size={10} />
                </span>
                <span className="text-[10px] font-medium text-fg">Claude</span>
                <span
                  className="rounded px-1 py-px font-mono text-[8px] uppercase tracking-wide text-status-red"
                  style={{ background: "color-mix(in srgb, currentcolor 12%, transparent)" }}
                >
                  {AI_REVIEW.label}
                </span>
              </div>
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">{AI_REVIEW.text}</p>
              <div className="mt-2 flex gap-1.5">
                <span className="rounded-md bg-white/6 px-2 py-1 text-[9px] text-fg">Reply</span>
                <span className="rounded-md border border-hairline px-2 py-1 text-[9px] text-muted-2">
                  Resolve
                </span>
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}
