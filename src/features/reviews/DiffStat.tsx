/**
 * The diffstat beside a pull request's tabs: `+1,602 −1`.
 *
 * It carried GitHub's five squares splitting the change between additions and
 * deletions. They went: at this size they are five green pixels that say roughly
 * what the two numbers beside them already say exactly, and on a strip that also
 * carries a comment count, a check rollup and a file count they were the one
 * mark competing for attention without adding a fact.
 *
 * This is the literal shape of the diff, not a review-effort estimate — the two
 * disagree on purpose, since a 2,000-line regenerated lockfile is a big diff and
 * a small review. Anything that ranks PRs by how much of an afternoon they cost
 * belongs in the inbox's own signals, not here.
 */

function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** The spoken form of the diffstat. The `+`/`−` signs don't survive a screen
 *  reader, so both totals are spelled out in words. */
export function diffStatLabel(additions: number, deletions: number): string {
  return `${count(additions, "addition")} and ${count(deletions, "deletion")}`;
}

export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  const label = diffStatLabel(additions, deletions);
  return (
    // `role="img"` so the label replaces the run rather than being read after it:
    // "+1,602 −1" spoken literally is a plus sign, a number, a minus sign and
    // another number.
    <span
      role="img"
      className={`flex flex-none items-center gap-1.5 font-mono text-[11px] ${className ?? ""}`}
      aria-label={label}
      title={label}
    >
      <span className="text-status-green">+{additions.toLocaleString()}</span>
      <span className="text-status-red">−{deletions.toLocaleString()}</span>
    </span>
  );
}
