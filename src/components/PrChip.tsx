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
import { prStateMeta } from "../theme/colors";
import { GitHubLogo } from "./icons";
import { Pill } from "./primitives";

type Pr = { number: number; url: string; state: PrState };

/** One state for a set of PRs: purple only when every PR is merged (the
 *  worktree is then safe to delete); otherwise gray if any is still open, else red. */
function aggregateState(prs: Pr[]): PrState {
  if (prs.every((p) => p.state === "Merged")) return "Merged";
  return prs.some((p) => p.state === "Open") ? "Open" : "Closed";
}

/** The PR a click on the set should land on: an open one if there is one.
 *
 *  Exported because "which of a worktree's PRs is *the* one" has to have exactly
 *  one answer — the sidebar mark and the Trees PR pane both ask, and a second
 *  implementation is how they end up pointing at different pull requests.
 *  Structurally typed, so it takes a `WorktreePr` as readily as a chip's row. */
export function primaryPr<T extends Pr>(prs: T[]): T | undefined {
  return prs.find((p) => p.state === "Open") ?? prs[0];
}

/** Shared size/type styling for the single chip and the multi-PR summary — only
 *  the color (via {@link Pill}) and gap differ between them. */
const PILL_CLASS = "gap-1 px-[5px] py-px font-mono text-[9px] font-semibold tracking-wide";

/** Whether the chip is clickable. `false` renders the identical pill as a plain
 *  `<span>` — for callers whose whole row is already one button (the Agents
 *  panel), where a nested `<button>` is invalid HTML and gives the row two
 *  competing actions. Those surfaces link the PR from their detail pane instead. */
interface Interactive {
  interactive?: boolean;
}

export function PrChip({ number, url, state, interactive = true }: Pr & Interactive) {
  const meta = prStateMeta[state];
  const openPr = useOpenPr();
  const title = interactive
    ? `Open PR #${number} (${meta.label}) in Reviews or on GitHub`
    : `PR #${number} (${meta.label})`;
  return (
    <Pill
      color={meta.color}
      className={PILL_CLASS}
      title={title}
      onClick={
        interactive
          ? (e) => {
              e.stopPropagation();
              openPr(url);
            }
          : undefined
      }
    >
      <GitHubLogo size={9} />#{number}
    </Pill>
  );
}

export function PrChips({ prs, interactive = true }: { prs: Pr[] } & Interactive) {
  if (prs.length === 0) return null;
  if (prs.length === 1) return <PrChip {...prs[0]} interactive={interactive} />;

  const color = prStateMeta[aggregateState(prs)].color;

  return (
    // Named group so it doesn't collide with the card's own `group` (checkbox).
    <span className="group/prs relative inline-flex">
      <Pill
        color={color}
        className={`${PILL_CLASS} cursor-default`}
        title={`${prs.length} pull requests`}
      >
        <GitHubLogo size={9} />
        {prs.length} PRs
      </Pill>
      {/* Touching the summary (top-full, no gap) so the hover stays alive while
          moving onto the list. High z so it floats over neighbouring cards/nodes.
          Hidden with opacity — not `invisible` — because visibility:hidden makes
          the chips unfocusable, which would make focus-within (the only keyboard
          way in: Tab onto a chip → the list appears) impossible to ever trigger. */}
      <span className="pointer-events-none absolute top-full right-0 z-50 flex flex-col items-end gap-1 rounded-lg border border-line-3 bg-raised p-1.5 opacity-0 shadow-lg group-focus-within/prs:pointer-events-auto group-focus-within/prs:opacity-100 group-hover/prs:pointer-events-auto group-hover/prs:opacity-100">
        {prs.map((p) => (
          <PrChip key={p.number} {...p} interactive={interactive} />
        ))}
      </span>
    </span>
  );
}

/**
 * A worktree's PRs as one plain GitHub mark — for a row with no room for a pill
 * (the sidebar's worktree cards), where "there is a PR" is all that has to be
 * read at a glance. Deliberately uncolored: the tree spends hue on agent state
 * only, so the PR's state and numbers ride in the tooltip. Clicking opens the
 * open PR, else the first.
 */
export function PrMark({
  prs,
  size = 12,
  interactive = true,
  onOpen,
  className: extra,
}: {
  prs: Pr[];
  size?: number;
  /** Override what a click does. The sidebar's worktree rows use this to open
   *  the PR pane beside the work instead of leaving for Reviews or github.com —
   *  the worktree *is* the PR's checkout, so that is where it belongs. */
  onOpen?: () => void;
  className?: string;
} & Interactive) {
  const openPr = useOpenPr();
  if (prs.length === 0) return null;
  const list = prs.map((p) => `#${p.number} (${prStateMeta[p.state].label})`).join(", ");
  const title = !interactive
    ? list
    : onOpen
      ? `Open ${list}`
      : `Open ${list} in Reviews or on GitHub`;
  const className = extra ?? "flex flex-none items-center justify-center rounded text-muted-4";
  if (!interactive) {
    return (
      <span className={className} title={title}>
        <GitHubLogo size={size} />
      </span>
    );
  }
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={extra ? className : `${className} cursor-pointer hover:bg-hover hover:text-fg-2`}
      onClick={(e) => {
        e.stopPropagation();
        if (onOpen) {
          onOpen();
          return;
        }
        const pr = primaryPr(prs);
        if (pr) openPr(pr.url);
      }}
    >
      <GitHubLogo size={size} />
    </button>
  );
}
