import { CodexLogo } from "~/components/icons";
import { ViewShell } from "../chrome";
import {
  AI_REVIEW,
  type DemoPr,
  type DiffLine,
  REVIEW_DIFF,
  REVIEW_META,
  REVIEW_MINE,
  REVIEW_REQUESTED,
} from "../data";
import {
  BranchGlyph,
  CheckGlyph,
  CopyGlyph,
  DiffStat,
  Dot,
  GitHubMark,
  InitialsAvatar,
} from "../widgets";

/** Reviews: the PR inbox — "Needs your review" then "My PRs" in the rail,
 * the selected PR's header + Pull request/Checks tabs + diff with an AI
 * review comment anchored to the hunk in the main pane. */

const DECISION_META = {
  approved: { color: "var(--color-status-green)", label: "approved" },
  required: { color: "var(--color-status-amber)", label: "review required" },
} as const;

function PrRow({ pr }: { pr: DemoPr }) {
  const decision = DECISION_META[pr.decision];
  return (
    <div
      className="mb-[3px] flex flex-col gap-[5px] rounded-[9px] px-[11px] py-2"
      style={
        pr.active
          ? {
              border: "1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)",
              background: "color-mix(in srgb, var(--color-accent) 6%, transparent)",
            }
          : { border: "1px solid transparent" }
      }
    >
      <div className="flex items-center gap-1.5">
        <Dot color={decision.color} size={6} />
        <span className="font-mono text-[10.5px] text-muted-2">#{pr.num}</span>
        <span className="ml-auto">
          <CheckGlyph state={pr.checks} />
        </span>
      </div>
      <div
        className="truncate text-[12px] leading-[1.3]"
        style={{ color: pr.active ? "var(--color-accent)" : "rgba(242,242,244,0.88)" }}
      >
        {pr.title}
      </div>
      <div className="flex items-center gap-2 font-mono text-[10px] text-muted-4">
        <span>{pr.waiting}</span>
        <span>{pr.size}</span>
        <span className="truncate">{pr.ticket}</span>
        {pr.comments != null && <span className="ml-auto">💬 {pr.comments}</span>}
      </div>
    </div>
  );
}

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

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold text-fg/90">
      <span className="truncate">{title}</span>
      <span className="ml-auto font-mono text-[10px] font-normal text-muted-4">{count}</span>
    </div>
  );
}

export function ReviewsView({ live: _live }: { live: boolean }) {
  return (
    <ViewShell
      sidebar={
        <div className="min-h-0 flex-1 overflow-hidden p-2">
          <div className="mb-3">
            <SectionTitle title="Needs your review" count={REVIEW_REQUESTED.length} />
            {REVIEW_REQUESTED.map((pr) => (
              <PrRow key={pr.num} pr={pr} />
            ))}
          </div>
          <div className="mb-3">
            <SectionTitle title="My PRs" count={REVIEW_MINE.length} />
            <div className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-4">
              santree
            </div>
            {REVIEW_MINE.map((pr) => (
              <PrRow key={pr.num} pr={pr} />
            ))}
          </div>
        </div>
      }
      main={
        <div className="flex min-h-0 flex-1 flex-col">
          {/* PR header: repo · #number, branch chip + actions right, then
              title, then author · decision · checks · diffstat. */}
          <div className="shrink-0 border-b border-hairline px-5 pb-2 pt-3.5">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[12px] text-muted-2">{REVIEW_META.repo}</span>
              <span className="font-mono text-[12px] text-accent">#{REVIEW_META.num}</span>
              <span className="ml-auto flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-md border border-line-2 bg-white/3 px-2 py-1 font-mono text-[10.5px] text-term-cyan/80">
                  <BranchGlyph size={11} className="shrink-0" />
                  <span className="max-w-[220px] truncate">{REVIEW_META.branch}</span>
                  <CopyGlyph size={11} className="shrink-0 text-muted-4" />
                </span>
                <span className="flex items-center gap-1.5 rounded-md border border-line-2 bg-white/3 px-2.5 py-1 text-[11px] font-medium text-muted">
                  <CodexLogo size={11} className="text-accent" />
                  Codex review
                </span>
                <span className="flex items-center gap-1.5 rounded-md border border-line-2 bg-white/3 px-2.5 py-1 text-[11px] font-medium text-muted">
                  <GitHubMark size={11} />
                  Open
                </span>
              </span>
            </div>
            <h3 className="mb-2 text-[16px] font-semibold leading-[1.3] text-fg">
              {REVIEW_META.title}
            </h3>
            <div className="flex items-center gap-2.5 text-[11px]">
              <span className="flex items-center gap-1.5 text-muted-2">
                <InitialsAvatar initials={REVIEW_META.authorInitials} size={16} />
                {REVIEW_META.author}
              </span>
              <span
                className="rounded px-1.5 py-px text-[10px] font-medium"
                style={{
                  color: DECISION_META.required.color,
                  background: "color-mix(in srgb, var(--color-status-amber) 12%, transparent)",
                  border:
                    "1px solid color-mix(in srgb, var(--color-status-amber) 30%, transparent)",
                }}
              >
                {DECISION_META.required.label}
              </span>
              <span className="flex items-center gap-1 font-mono text-status-green">
                ✓ checks passing
              </span>
              <span className="ml-auto flex items-center gap-2 font-mono text-muted-2">
                <DiffStat add={REVIEW_META.add} del={REVIEW_META.del} />
                <span className="text-[9px] text-muted-4">{REVIEW_META.files} files</span>
              </span>
            </div>
          </div>
          {/* Pull request / Checks tabs */}
          <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-5">
            <span
              className="-mb-px border-b-2 px-3 py-2 text-[12px] font-medium text-fg"
              style={{ borderColor: "var(--color-accent)" }}
            >
              Pull request
            </span>
            <span className="flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[12px] text-muted-2">
              Checks
              <span className="font-mono text-[11px] text-status-green">✓</span>
            </span>
          </div>
          {/* Diff */}
          <div className="min-h-0 flex-1 overflow-hidden px-4 py-3 font-mono text-[10.5px] leading-[1.6]">
            <div className="flex items-center gap-2">
              <span className="text-fg/85">{REVIEW_DIFF.file}</span>
              <DiffStat add={9} del={2} />
            </div>
            <div className="mt-1 text-term-cyan/80">{REVIEW_DIFF.hunk}</div>
            <div className="mt-1.5">
              {REVIEW_DIFF.lines.map((line) => (
                <DiffRow key={`${line.kind}-${line.old}-${line.new}`} line={line} />
              ))}
            </div>
            {/* AI review thread, anchored to the hunk */}
            <div className="mt-3 max-w-[520px] rounded-lg border border-accent/30 bg-accent/4 px-3 py-2.5 font-sans">
              <div className="flex items-center gap-1.5">
                <span className="text-accent">
                  <CodexLogo size={10} />
                </span>
                <span className="text-[10px] font-medium text-fg">Codex</span>
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
