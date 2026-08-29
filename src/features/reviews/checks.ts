import type { CheckStatus, PrCheck } from "../../bindings";
import { checkStatusMeta } from "../../theme/colors";

/** The trailing catch-all section — skipped + other non-pass/fail outcomes. */
export const SKIPPED_KEY = "skipped";

/** One collapsible section of the Checks tab. */
export interface CheckSection {
  key: string;
  color: string;
  glyph: string;
  label: string;
  checks: PrCheck[];
}

/**
 * Split a PR's checks into the sections the Checks tab renders, most-actionable
 * first: failed, running, passed — then skipped/neutral collapsed into one
 * trailing group (they're rarely what you're looking for). Sections with no checks
 * are omitted entirely.
 */
export function groupChecks(checks: PrCheck[]): CheckSection[] {
  const of = (s: CheckStatus) => checks.filter((c) => c.status === s);
  const sections: CheckSection[] = [];

  for (const s of ["Failure", "Pending", "Success"] as CheckStatus[]) {
    const list = of(s);
    if (list.length > 0) {
      const m = checkStatusMeta[s];
      sections.push({ key: s, color: m.color, glyph: m.glyph, label: m.label, checks: list });
    }
  }

  const skipped = [...of("Skipped"), ...of("Neutral")];
  if (skipped.length > 0) {
    const m = checkStatusMeta.Skipped;
    sections.push({
      key: SKIPPED_KEY,
      color: m.color,
      glyph: m.glyph,
      label: SKIPPED_KEY,
      checks: skipped,
    });
  }

  return sections;
}

/** The counts a checks summary row reads out ("✓ 12 passing ✕ 1 failing"). */
export interface CheckTally {
  passing: number;
  failing: number;
  running: number;
  /** Skipped + neutral — everything that finished without a pass/fail verdict. */
  other: number;
}

/**
 * Tally a PR's checks by outcome, for the one-line summary above the list.
 *
 * Here rather than in the component so the summary and {@link groupChecks} can
 * never disagree about what counts as failing — they are the same classification
 * asked two different ways.
 */
export function tallyChecks(checks: PrCheck[]): CheckTally {
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  return {
    passing: count("Success"),
    failing: count("Failure"),
    running: count("Pending"),
    other: count("Skipped") + count("Neutral"),
  };
}

/**
 * Next collapsed-section set after clicking a section header. With `all`
 * (⌘/Ctrl-click), the clicked section's *resulting* state is mirrored onto every
 * section — collapsing an expanded one collapses all; expanding a collapsed one
 * expands all.
 */
export function toggleCollapsed(
  collapsed: ReadonlySet<string>,
  key: string,
  allKeys: string[],
  all: boolean,
): Set<string> {
  if (all) return collapsed.has(key) ? new Set() : new Set(allKeys);
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
