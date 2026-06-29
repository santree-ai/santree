/** PR status chips for a worktree/issue.
 *
 *  `PrChip` is one clickable pill: the GitHub mark + `#<number>`, tinted by merge
 *  state, opening the PR on GitHub (stops propagation so it doesn't trigger the
 *  parent card/graph-node click). Matches the Badge/Pill look so it sits next to
 *  WIP/RDY.
 *
 *  `PrChips` renders a worktree's PRs: a single chip when there's one, or a
 *  count chip that expands on hover into the full list when there are several
 *  (a branch can accumulate PRs — closed+reopened, re-targeted, …). Shared by the
 *  Trees sidebar cards and the Issues graph nodes. */
import type { PrState } from "../bindings";
import { useOpenPr } from "../lib/openPr";
import { alpha, prStateMeta } from "../theme/colors";
import { GitHubLogo } from "./icons";

type Pr = { number: number; url: string; state: PrState };

/** Tinted-pill styling shared by the single chip and the multi-PR summary. */
function pillStyle(color: string) {
  return {
    color,
    background: alpha(12, color),
    border: `1px solid ${alpha(34, color)}`,
  };
}

export function PrChip({ number, url, state }: Pr) {
  const meta = prStateMeta[state];
  const openPr = useOpenPr();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openPr(url);
      }}
      title={`PR #${number} (${meta.label}) — open in Reviews or on GitHub`}
      className="inline-flex flex-none cursor-pointer items-center gap-1 rounded px-[5px] py-px font-mono text-[9px] font-semibold tracking-wide"
      style={pillStyle(meta.color)}
    >
      <GitHubLogo size={9} />#{number}
    </button>
  );
}

export function PrChips({ prs }: { prs: Pr[] }) {
  if (prs.length === 0) return null;
  if (prs.length === 1) return <PrChip {...prs[0]} />;

  // The summary reflects the whole set: purple only when every PR is merged (the
  // worktree is then safe to delete); otherwise gray if any is still open, else red.
  const aggregate: PrState = prs.every((p) => p.state === "Merged")
    ? "Merged"
    : prs.some((p) => p.state === "Open")
      ? "Open"
      : "Closed";
  const color = prStateMeta[aggregate].color;

  return (
    // Named group so it doesn't collide with the card's own `group` (checkbox).
    <span className="group/prs relative inline-flex">
      <span
        className="inline-flex flex-none cursor-default items-center gap-1 rounded px-[5px] py-px font-mono text-[9px] font-semibold tracking-wide"
        style={pillStyle(color)}
        title={`${prs.length} pull requests`}
      >
        <GitHubLogo size={9} />
        {prs.length} PRs
      </span>
      {/* Touching the summary (top-full, no gap) so the hover stays alive while
          moving onto the list. High z so it floats over neighbouring cards/nodes. */}
      <span className="invisible absolute top-full right-0 z-50 flex flex-col items-end gap-1 rounded-lg border border-line-3 bg-raised p-1.5 shadow-lg group-hover/prs:visible">
        {prs.map((p) => (
          <PrChip key={p.number} {...p} />
        ))}
      </span>
    </span>
  );
}
