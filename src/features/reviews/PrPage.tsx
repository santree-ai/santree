/**
 * The pull request as a page: its header ({@link ReviewHeader}: title · #number
 * · state · what it merges where) above the sections GitHub itself opens with —
 * **Conversation** (the description, then everything said since, with the box to
 * add to it), **Commits** (what is being merged, oldest first), **Checks** (the
 * head commit's CI and its job logs) and **Files changed** (the per-file
 * diff with inline review comments). Each carries its own count, and the diffstat
 * rides on Files changed, so the shape of the pull request is readable before
 * you open anything.
 *
 * **Conversation leads**, as it does on GitHub: it is the orientation you want
 * before the diff, and it is the only place the description is readable at full
 * width.
 *
 * One page, two hosts. In Reviews it is the "Pull Request" tab — what that view
 * *is*; in Trees it is the "GitHub PR" tab a worktree's own PR expands into from
 * the rail. It reads no view model, so it renders under either host's or none:
 * everything a host decides comes in as a prop — which section is showing, the
 * jump into the diff, and whether the header offers to check the PR out (never
 * for your own).
 */
import type { ReviewPr } from "../../bindings";
import {
  CheckIcon,
  CommitIcon,
  FilesIcon,
  MessageSquareIcon,
  SparklesIcon,
} from "../../components/icons";
import { MarkdownAttachments } from "../../components/Markdown";
import { Badge, Skeleton, Tabs } from "../../components/primitives";
import { usePrDetail, useReviewDrafts } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { checkRollupMeta, palette } from "../../theme/colors";
import { ChecksPane } from "./ChecksPane";
import { DiffStat } from "./DiffStat";
import type { FileFocus } from "./model";
import type { PrCheckout } from "./PrCheckout";
import { PrCommitsPane } from "./PrCommitsPane";
import { PrConversationPane } from "./PrConversationPane";
import { PrReviewPane } from "./PrReviewPane";
import { PR_COLUMN } from "./prLayout";
import { ReviewHeader } from "./ReviewHeader";

/** The page's sections. */
export type PrTab = "conversation" | "commits" | "checks" | "files";

/** A tab's count, as a badge — or nothing at all while its read is in flight.
 *  A `0` there is a claim ("no checks on this PR"), and a pending fetch has not
 *  earned it. */
function countBadge(n: number | undefined) {
  return n === undefined ? undefined : <Badge color="var(--color-muted-3)">{n}</Badge>;
}

export function PrPage({
  pr,
  tab,
  onTab,
  fileFocus,
  focusFile,
  checkout,
}: {
  pr: ReviewPr;
  /** Which section is showing. The host's, not the page's: a jump from its rail
   *  or an AI review's "show drafts" has to bring Files changed forward from
   *  outside the page. */
  tab: PrTab;
  onTab: (tab: PrTab) => void;
  /** The pending jump into the diff, and the way to make one — the conversation's
   *  index rows jump through it. Reviews keeps it in its model because the rail
   *  writes it from outside the page; Trees keeps it beside the page. */
  fileFocus: FileFocus | null;
  focusFile: (path: string, line?: number | null) => void;
  /** The PR's local checkout, when the host offers the header's tree actions.
   *  Omitted for the viewer's own PR — see {@link ReviewHeader}. */
  checkout?: PrCheckout;
}) {
  const checks = checkRollupMeta[pr.checks];
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  // A draft row exists only until it is published, so every one of them is open.
  // The same cached read the conversation below and the review tabs both use.
  const { data: drafts } = useReviewDrafts(pr.repo, pr.number);
  const openDrafts = drafts?.length ?? 0;

  return (
    // Every surface below renders GitHub prose, and a screenshot in any of them
    // is written as a link only a signed-in browser can fetch. The provider
    // carries the signed replacements the same read already brought back, so a
    // description, a comment and an AI draft all resolve one image the same way.
    <MarkdownAttachments attachments={detail?.attachments}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ReviewHeader pr={pr} checkout={checkout} />

        {/* The rule is the page's and spans it; the tabs are the column's and line
          up with the title above and the body below.
          The geometry has to mirror a pane's exactly or "centred" is off by the
          insets: a pane is `px-5` on its scroll container with the column inside
          it, so this is too. `-mx-3` then hangs each tab's own `px-3` outside the
          column, which is what puts the *first tab's label* on the column's edge
          rather than its padding — the underline is meant to overhang the word,
          the way it does on GitHub. */}
        <div className="flex-none border-b border-line px-5">
          <div className={PR_COLUMN}>
            <Tabs
              className="-mx-3"
              rule={false}
              value={tab}
              onChange={onTab}
              tabs={[
                {
                  value: "conversation",
                  label: "Conversation",
                  icon: <MessageSquareIcon size={12} />,
                  // The AI's unsent drafts lead the tab's own count, because they are
                  // the half still waiting on *you*: a published comment is on GitHub
                  // and done with, a draft is a decision you have not made. Same spark
                  // and same purple they wear in the conversation below and on the
                  // review tabs beside it. Hidden at zero — a nought here would claim
                  // an AI review ran and found nothing.
                  badge: (
                    <span className="flex items-center gap-2">
                      {openDrafts > 0 && (
                        <span
                          className="flex items-center gap-1 font-mono text-[10px]"
                          title={`${openDrafts} unsent AI comment${openDrafts === 1 ? "" : "s"}`}
                          style={{ color: palette.purple }}
                        >
                          <SparklesIcon size={10} />
                          {openDrafts}
                        </span>
                      )}
                      {countBadge(detail?.comments.length)}
                    </span>
                  ),
                },
                {
                  value: "commits",
                  label: "Commits",
                  icon: <CommitIcon size={12} />,
                  badge: countBadge(detail?.commits.length),
                },
                {
                  value: "checks",
                  label: "Checks",
                  icon: <CheckIcon size={12} />,
                  badge: (
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-[11px]" style={{ color: checks.color }}>
                        {checks.glyph}
                      </span>
                      {countBadge(detail?.checks.length)}
                    </span>
                  ),
                },
                {
                  value: "files",
                  label: "Files changed",
                  icon: <FilesIcon size={12} />,
                  // The diffstat belongs to this tab, the way the rollup glyph belongs
                  // to Checks — off on its own at the strip's edge it read as a stray
                  // control measuring the page. The count is GitHub's own total off the
                  // PR row, not the fetched list, which is capped.
                  //
                  // It trails the diffstat rather than leading it: every other tab's
                  // badge is the last thing on the tab, so a count sitting *inside*
                  // the row broke the one place the eye scans for "how many".
                  badge: (
                    <span className="flex items-center gap-2">
                      <DiffStat additions={pr.additions} deletions={pr.deletions} />
                      {countBadge(pr.changedFiles)}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </div>

        {tab === "conversation" && <PrConversationPane pr={pr} focusFile={focusFile} />}
        {tab === "commits" && <PrCommitsPane pr={pr} />}
        {tab === "files" && <PrReviewPane pr={pr} fileFocus={fileFocus} />}
        {tab === "checks" && <ChecksPane pr={pr} />}
      </div>
    </MarkdownAttachments>
  );
}

/** The page before the PR row it is built on has landed — shaped like the page
 *  (header band, tab row, a body of prose) so nothing shifts when it does. A host
 *  shows this rather than an empty state: "no pull request" is a claim, and a
 *  fetch in flight has not earned it. */
export function PrPageSkeleton() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-hidden>
      <div className="flex-none border-b border-hairline px-5 pt-3.5 pb-2">
        <div className={PR_COLUMN}>
          <Skeleton className="mb-2 h-6 w-1/2" />
          <Skeleton className="mb-2 h-3.5 w-2/3" />
        </div>
      </div>
      <div className="flex-none border-b border-line px-5 py-2.5">
        <div className={`${PR_COLUMN} flex gap-5`}>
          {[20, 14, 14, 24].map((w, i) => (
            <Skeleton key={i} className="h-3" style={{ width: `${w * 4}px` }} />
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 px-5 py-5">
        <div className={`${PR_COLUMN} space-y-2.5`}>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
    </div>
  );
}
