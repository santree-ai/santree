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

/** Shared size/type styling for the single chip and the multi-PR summary — only
 *  the color (via {@link Pill}) and gap differ between them. */
const PILL_CLASS = "gap-1 px-[5px] py-px font-mono text-[9px] font-semibold tracking-wide";

export function PrChip({ number, url, state }: Pr) {
  const meta = prStateMeta[state];
  const openPr = useOpenPr();
  return (
    <Pill
      color={meta.color}
      className={PILL_CLASS}
      title={`PR #${number} (${meta.label}) — open in Reviews or on GitHub`}
      onClick={(e) => {
        e.stopPropagation();
        openPr(url);
      }}
    >
      <GitHubLogo size={9} />#{number}
    </Pill>
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
          <PrChip key={p.number} {...p} />
        ))}
      </span>
    </span>
  );
}
