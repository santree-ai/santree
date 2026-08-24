/**
 * The review brief: the AI's orientation for a PR — what it does, what order to
 * read it in, where to look hardest, and what to ask the author.
 *
 * Lives at the top of the {@link PrInfoPanel} rail rather than in a tab of its
 * own, because the reading order is only useful *while* you're reading: the rail
 * spans the whole detail area, so the plan stays beside the diff on every tab.
 * Clicking any entry jumps the diff to that file (and line).
 *
 * Written by the AI review session ({@link AiReviewSessionPane}) through santree's
 * own tools, and cached against the PR's head commit — so it costs nothing on a PR
 * you only glance at, and goes stale honestly when the author pushes. Advice about
 * code that has since changed is worse than none, because it reads as current.
 */
import { useState } from "react";

import type { AgentKind, ReviewBrief, ReviewPr } from "../../bindings";
import {
  AgentIcon,
  ChevronDownIcon,
  CopyIcon,
  RefreshIcon,
  WarningIcon,
} from "../../components/icons";
import { Button, Pill, RunningStatus } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { REVIEW_AGENT_KEY, usePrReviewBrief, useResolvedSetting } from "../../lib/queries";
import { toast } from "../../state/toast";
import { alpha, palette, readingRoleMeta, watchOutMeta } from "../../theme/colors";
import { agentProvider } from "../terminal/agentProvider";
import { useTerminals } from "../terminal/TerminalsContext";
import { aiReviewTermKey } from "./AiReviewSessionPane";
import { useReviewsModel } from "./model";

export function ReviewBriefSection({
  pr,
  activeReviewAgent,
}: {
  pr: ReviewPr;
  activeReviewAgent: AgentKind | null;
}) {
  const { repo, focusFile, openAiReview } = useReviewsModel();
  const { data: configuredAgent } = useResolvedSetting(repo, REVIEW_AGENT_KEY);
  const defaultAgent = (configuredAgent as AgentKind | null) ?? "Codex";
  const { data: brief, isLoading } = usePrReviewBrief(pr.repo, pr.number);
  // A live session is the "it's being written right now" state: the brief arrives
  // through the MCP, so there's no mutation here to be pending.
  const { tabs } = useTerminals();
  const displayedAgent = brief?.agentKind ?? defaultAgent;
  const actionAgent = activeReviewAgent ?? defaultAgent;
  const actionProvider = agentProvider(actionAgent);
  const liveSession = tabs.some(
    (tab) =>
      tab.source === "review" &&
      tab.refId === `${aiReviewTermKey(pr)}::${actionAgent.toLowerCase()}`,
  );

  // A brief written against an older head describes code that no longer exists.
  const stale = !!brief && !!pr.headSha && brief.headSha !== pr.headSha;

  const run = () => {
    if (!pr.headSha) {
      toast.error("This PR has no commits to review.");
      return;
    }
    openAiReview();
  };

  if (isLoading) return null;

  return (
    <div className="mb-6 border-b border-hairline pb-4">
      <div className="mb-2.5 flex items-center gap-1.5">
        <AgentIcon kind={displayedAgent} size={11} className="text-muted-3" />
        <span className="font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
          Review brief
        </span>
        {brief && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={run}
            title={
              liveSession
                ? `Show the ${actionProvider.label} review session`
                : `Pick the ${actionProvider.label} review session back up and ask it to look again`
            }
          >
            {liveSession ? <AgentIcon kind={actionAgent} size={10} /> : <RefreshIcon size={10} />}
            {liveSession ? `Open ${actionProvider.label} review` : "Review again"}
          </Button>
        )}
      </div>

      {liveSession && !brief && (
        <div className="rounded-lg border border-line-2 bg-raised px-3 py-3">
          <RunningStatus
            active
            label="Reading the pull request…"
            // A big diff on a capable model runs for minutes. Say so at the point
            // the wait starts feeling wrong, instead of leaving the user to guess.
            slowLabel="Still reading. A large diff takes a few minutes."
          />
          <Button size="sm" variant="ghost" className="mt-2" onClick={run}>
            Open {actionProvider.label} review
          </Button>
        </div>
      )}

      {!brief && !liveSession && (
        <div className="rounded-lg border border-line-2 bg-raised px-3 py-3">
          <p className="mb-2.5 text-[11.5px] leading-[1.6] text-muted-2">
            {agentProvider(defaultAgent).label} reads the PR and writes a brief here, plus draft
            comments in the diff. You edit them and decide which ones to send.
          </p>
          <Button size="sm" variant="primary" onClick={run}>
            <AgentIcon kind={defaultAgent} size={11} />
            Start {agentProvider(defaultAgent).label} review
          </Button>
        </div>
      )}

      {brief && <BriefBody brief={brief} stale={stale} onJump={focusFile} />}
    </div>
  );
}

function BriefBody({
  brief,
  stale,
  onJump,
}: {
  brief: ReviewBrief;
  stale: boolean;
  onJump: (path: string, line?: number | null) => void;
}) {
  return (
    <div>
      {stale && (
        <div
          className="mb-2.5 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] leading-[1.5]"
          style={{ color: palette.amber, borderColor: alpha(34, palette.amber) }}
        >
          <WarningIcon size={11} className="mt-[2px] flex-none" />
          <span>New commits have landed since this brief. Review again to cover them.</span>
        </div>
      )}
      {brief.truncated && (
        <div className="mb-2.5 flex items-start gap-1.5 text-[10.5px] leading-[1.5] text-muted-4">
          <WarningIcon size={10} className="mt-[2px] flex-none" />
          <span>The diff was too large to send whole. This covers only part of the PR.</span>
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
        Written <RelativeTime ms={brief.generatedAtMs} />. Suggestions only, nothing was posted.
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
