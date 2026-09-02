/**
 * The right panel's PR pane: the pull request this worktree's branch is out for
 * review as, read beside the work rather than in a separate tab.
 *
 * Top to bottom it answers the questions in the order they get asked — is it open,
 * is CI green, what has anyone said. What to *do* about it is the next tab along
 * ({@link AiWorkPane}): the work queue and the AI's reading of the PR
 * that fills it, which at the bottom of this scroll nobody found. The code itself
 * is deliberately absent too — a diff belongs in the main area, and clicking
 * through from here opens it there. So does the whole pull request, at reading
 * width: the header's "Open in a tab" expands this pane into the same
 * {@link PrPage} Reviews shows for other people's PRs.
 *
 * Everything below the header is a component the Reviews tab already uses, given
 * this host's own callbacks — one implementation, two places to read it from.
 */

import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import type { ReviewPr, WorktreePr } from "../../bindings";
import {
  ChevronDownIcon,
  ExpandIcon,
  GitHubLogo,
  MoreIcon,
  RefreshIcon,
} from "../../components/icons";
import { Markdown, MarkdownAttachments, MarkdownTitle } from "../../components/Markdown";
import { Dropdown, MENU_ITEM, Pill, Skeleton } from "../../components/primitives";
import { queryKeys, usePrDetail, usePrSummary } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { toast } from "../../state/toast";
import { prStateMeta } from "../../theme/colors";
import { PrChecksSection } from "./PrChecksSection";
import { PrCommentsSection } from "./PrCommentsSection";

export function WorktreePrPane({
  pr,
  onExpand,
}: {
  pr: WorktreePr;
  /** Open the pull request as a main-area tab. Drawn only when a host offers it. */
  onExpand?: () => void;
}) {
  const { data: summary } = usePrSummary(pr.repo, pr.number);

  if (!summary) {
    return (
      <div className="space-y-2 px-3 py-3">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="mt-3 h-16 w-full rounded-md" />
      </div>
    );
  }
  return <Loaded pr={summary} onExpand={onExpand} />;
}

function Loaded({ pr, onExpand }: { pr: ReviewPr; onExpand?: () => void }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  // The same read the sections below already share, for its signed attachment
  // links: a screenshot in your own PR's description is behind the same auth
  // wall as one in somebody else's (see `MarkdownAttachments`).
  const { data: detail } = usePrDetail(owner, name, pr.number);
  return (
    <MarkdownAttachments attachments={detail?.attachments}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PrHeader pr={pr} onExpand={onExpand} />
        <PrDescription pr={pr} />
        <PrChecksSection pr={pr} />
        <PrCommentsSection pr={pr} />
      </div>
    </MarkdownAttachments>
  );
}

function PrHeader({ pr, onExpand }: { pr: ReviewPr; onExpand?: () => void }) {
  const qc = useQueryClient();
  const [owner, name] = splitRepoSlug(pr.repo);
  const state = prStateMeta[pr.state];

  // Scoped to this PR rather than `useRefreshExternal`: a refresh button on a PR
  // pane should re-pull the PR, not every Linear query in the app.
  function refresh() {
    for (const queryKey of [
      queryKeys.prSummary(pr.repo, pr.number),
      queryKeys.prDetail(owner, name, pr.number),
      queryKeys.reviewDrafts(pr.repo, pr.number),
    ]) {
      void qc.invalidateQueries({ queryKey });
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
      <GitHubLogo size={13} className="flex-none text-muted-3" />
      <button
        type="button"
        onClick={() => openUrl(pr.url)}
        title="Open this pull request on GitHub"
        className="flex-none cursor-pointer font-mono text-[11.5px] text-fg-2 hover:underline"
      >
        #{pr.number}
      </button>
      <Pill color={state.color} className="px-1.5 py-px text-[9px] font-semibold uppercase">
        {state.label}
      </Pill>
      {pr.isDraft && (
        <span className="rounded bg-input px-1 py-px text-[9px] text-muted-4">draft</span>
      )}
      <span className="min-w-1 flex-1" />
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          title="Open in a tab"
          aria-label="Open in a tab"
          className="flex-none cursor-pointer text-muted-4 transition-colors hover:text-fg-2"
        >
          <ExpandIcon size={12} />
        </button>
      )}
      <button
        type="button"
        onClick={refresh}
        title="Refresh this pull request"
        aria-label="Refresh this pull request"
        className="flex-none cursor-pointer text-muted-4 transition-colors hover:text-fg-2"
      >
        <RefreshIcon size={12} />
      </button>
      <Dropdown
        align="right"
        menuClassName="w-48 overflow-hidden"
        trigger={(toggle) => (
          <button
            type="button"
            onClick={toggle}
            title="More"
            aria-label="More pull request actions"
            className="flex-none cursor-pointer text-muted-4 transition-colors hover:text-fg-2"
          >
            <MoreIcon size={13} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                void openUrl(pr.url);
                close();
              }}
            >
              <GitHubLogo size={12} /> Open on GitHub
            </button>
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                void navigator.clipboard.writeText(pr.url);
                toast.success("Pull request URL copied.");
                close();
              }}
            >
              Copy URL
            </button>
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                void navigator.clipboard.writeText(pr.headRef);
                toast.success("Branch name copied.");
                close();
              }}
            >
              Copy branch
            </button>
          </>
        )}
      </Dropdown>
    </div>
  );
}

/** Title and body — collapsible, because on a PR you opened yourself the
 *  description is the part you already know. */
function PrDescription({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  const [open, setOpen] = useState(false);
  const body = detail?.body?.trim();

  return (
    <section className="border-b border-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start gap-1.5 px-3 py-2 text-left transition-colors hover:bg-hover"
      >
        <ChevronDownIcon
          size={11}
          className={`mt-[3px] flex-none text-muted-4 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <MarkdownTitle className="min-w-0 flex-1 text-[12px] leading-[1.45] text-fg-2">
          {pr.title}
        </MarkdownTitle>
      </button>
      {open && (
        <div className="selectable px-3 pb-2.5 pl-[26px] text-[11.5px]">
          {body ? <Markdown>{body}</Markdown> : <p className="text-muted-4">No description.</p>}
        </div>
      )}
    </section>
  );
}
