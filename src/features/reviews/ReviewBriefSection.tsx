/**
 * The review brief: the AI's orientation for a PR — what it does, what order to
 * read it in, where to look hardest, and what to ask the author.
 *
 * Lives at the top of the {@link PrInfoPanel} rail rather than in a tab of its
 * own, because the reading order is only useful *while* you're reading: the rail
 * spans the whole detail area, so the plan stays beside the diff on every tab.
 * Clicking any entry jumps the diff to that file (and line).
 *
 * Generated on demand and cached against the PR's head commit, so it costs nothing
 * on a PR you only glance at and goes stale honestly when the author pushes —
 * showing advice about code that has since changed would be worse than showing
 * none, because it reads as current.
 */
import { useState } from "react";

import type { ReviewBrief, ReviewPr } from "../../bindings";
import {
  ChevronDownIcon,
  ClaudeSparkIcon,
  CopyIcon,
  RefreshIcon,
  WarningIcon,
} from "../../components/icons";
import { Button, Pill, RunningStatus } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { useGenerateReviewBrief, usePrReviewBrief } from "../../lib/queries";
import { toast } from "../../state/toast";
import { alpha, palette, readingRoleMeta, watchOutMeta } from "../../theme/colors";
import { reviewTargetFor } from "./AiReviewPane";
import { useReviewsModel } from "./model";

export function ReviewBriefSection({ pr }: { pr: ReviewPr }) {
  const { repo, focusFile } = useReviewsModel();
  const { data: brief, isLoading } = usePrReviewBrief(pr.repo, pr.number);
  const { mutate: generate, isPending } = useGenerateReviewBrief(repo);
  const target = pr.headSha ? reviewTargetFor(pr) : null;

  // A brief generated against an older head describes code that no longer exists.
  const stale = !!brief && !!pr.headSha && brief.headSha !== pr.headSha;

  const run = () => {
    if (!target) {
      toast.error("This PR has no commits to build a brief from.");
      return;
    }
    generate(target);
  };

  if (isLoading) return null;

  return (
    <div className="mb-6 border-b border-hairline pb-4">
      <div className="mb-2.5 flex items-center gap-1.5">
        <ClaudeSparkIcon size={11} className="text-muted-3" />
        <span className="font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
          Review brief
        </span>
        {brief && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={isPending}
            onClick={run}
            title="Generate a fresh brief against the PR's current head commit"
          >
            <RefreshIcon size={10} />
            {isPending ? "Reading…" : "Regenerate"}
          </Button>
        )}
      </div>

      {isPending && (
        <div
          className={`rounded-lg border border-line-2 bg-raised px-3 py-3 ${brief ? "mb-2.5" : ""}`}
        >
          <RunningStatus
            active
            label="Reading the pull request…"
            // A big diff on a capable model runs for minutes. Say so at the point
            // the wait starts feeling wrong, instead of leaving the user to guess
            // whether it died (it used to, silently, at 120s).
            slowLabel="Still reading — a large diff takes a few minutes."
          />
        </div>
      )}

      {!brief && !isPending && (
        <div className="rounded-lg border border-line-2 bg-raised px-3 py-3">
          <p className="mb-2.5 text-[11.5px] leading-[1.6] text-muted-2">
            Get a summary, a suggested reading order, and the spots worth a closer look — before you
            open the diff.
          </p>
          <Button size="sm" variant="primary" onClick={run}>
            <ClaudeSparkIcon size={11} />
            Generate brief
          </Button>
        </div>
      )}

      {brief && <BriefBody brief={brief} stale={stale} onJump={focusFile} pending={isPending} />}
    </div>
  );
}

function BriefBody({
  brief,
  stale,
  pending,
  onJump,
}: {
  brief: ReviewBrief;
  stale: boolean;
  pending: boolean;
  onJump: (path: string, line?: number | null) => void;
}) {
  return (
    <div className={pending ? "opacity-50 transition-opacity" : undefined}>
      {stale && (
        <div
          className="mb-2.5 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] leading-[1.5]"
          style={{ color: palette.amber, borderColor: alpha(34, palette.amber) }}
        >
          <WarningIcon size={11} className="mt-[2px] flex-none" />
          <span>New commits have landed since this brief. Regenerate to cover them.</span>
        </div>
      )}
      {brief.truncated && (
        <div className="mb-2.5 flex items-start gap-1.5 text-[10.5px] leading-[1.5] text-muted-4">
          <WarningIcon size={10} className="mt-[2px] flex-none" />
          <span>The diff was too large to send whole — this covers only part of the PR.</span>
        </div>
      )}

      {brief.summary && (
        <p className="selectable mb-3 text-[12px] leading-[1.65] text-fg-2">{brief.summary}</p>
      )}

      {brief.readingOrder.length > 0 && (
        <Group label="Reading order">
          <ol className="flex flex-col gap-px">
            {brief.readingOrder.map((step, i) => {
              const meta = readingRoleMeta[step.role];
              return (
                <li key={`${step.path}-${i}`}>
                  <button
                    type="button"
                    onClick={() => onJump(step.path)}
                    title={`Jump to ${step.path}`}
                    className="group w-full cursor-pointer rounded-md px-1.5 py-1 text-left transition-colors hover:bg-hover"
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="w-3.5 flex-none text-right font-mono text-[9.5px] text-muted-4">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2 group-hover:text-[color:var(--accent)]">
                        {step.path}
                      </span>
                      <Pill
                        color={meta.color}
                        className="px-1 py-px font-mono text-[8.5px] uppercase"
                      >
                        {meta.label}
                      </Pill>
                    </div>
                    {step.why && (
                      <div className="mt-px pl-[22px] text-[10.5px] leading-[1.45] text-muted-3">
                        {step.why}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </Group>
      )}

      {brief.watchOuts.length > 0 && (
        <Group label="Worth a closer look">
          <div className="flex flex-col gap-px">
            {brief.watchOuts.map((w, i) => {
              const meta = watchOutMeta[w.kind];
              return (
                <button
                  key={`${w.path}-${w.line}-${i}`}
                  type="button"
                  onClick={() => onJump(w.path, w.line)}
                  title={`Jump to ${w.path}${w.line ? `:${w.line}` : ""}`}
                  className="group cursor-pointer rounded-md px-1.5 py-1 text-left transition-colors hover:bg-hover"
                >
                  <div className="mb-px flex items-baseline gap-1.5">
                    <Pill
                      color={meta.color}
                      className="px-1 py-px font-mono text-[8.5px] uppercase"
                    >
                      {meta.label}
                    </Pill>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-3 group-hover:text-[color:var(--accent)]">
                      {w.path}
                      {w.line != null && `:${w.line}`}
                    </span>
                  </div>
                  <div className="text-[11px] leading-[1.5] text-fg-3">{w.note}</div>
                </button>
              );
            })}
          </div>
        </Group>
      )}

      {brief.questions.length > 0 && (
        <Group label="Questions for the author">
          <div className="flex flex-col gap-1">
            {brief.questions.map((q) => (
              <CopyableQuestion key={q} question={q} />
            ))}
          </div>
        </Group>
      )}

      <div className="mt-3 text-[10px] text-muted-4">
        Generated <RelativeTime ms={brief.generatedAtMs} /> · suggestions only, nothing was posted.
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mb-1 flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-hover"
      >
        <ChevronDownIcon
          size={9}
          className={`flex-none text-muted-4 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
          {label}
        </span>
      </button>
      {open && children}
    </div>
  );
}

/** A question with a copy button — the only "act on this" affordance the brief
 *  offers. The AI drafts; the user posts, in their own words, under their name. */
function CopyableQuestion({ question }: { question: string }) {
  return (
    <div className="group flex items-start gap-1.5 rounded-md border border-line-2 bg-raised px-2 py-1.5">
      <span className="selectable min-w-0 flex-1 text-[11px] leading-[1.5] text-fg-3">
        {question}
      </span>
      <button
        type="button"
        title="Copy this question"
        onClick={() => {
          void navigator.clipboard.writeText(question);
          toast.success("Question copied.");
        }}
        className="flex-none cursor-pointer text-muted-4 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-fg-2"
      >
        <CopyIcon size={11} />
      </button>
    </div>
  );
}
