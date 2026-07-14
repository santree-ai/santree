/**
 * Which Linear ticket a PR belongs to — read from the PR itself, since GitHub has
 * no link back to Linear. Used by the Reviews "Issue" tab and by Fix-CI (which
 * names the worktree after it), so a *wrong* id is worse than none: it sends both
 * after a ticket that doesn't exist.
 */

/** Uppercase only, so prose like "service-ticket" can't false-match. */
const TITLE_TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

/**
 * The one shape a branch actually carries a ticket in: the last path segment opens
 * with the lower-cased id, followed by the title slug. Both conventions that
 * generate these branches agree on it — Linear's "copy git branch name"
 * (`jonathansandoval/msg-5033-ai-explanation`) and santree's own worktrees
 * (`santree/ak-123-login-throttling`).
 *
 * The anchor and the trailing slug are the whole point: a loose `<word>-<number>`
 * search anywhere in the branch reads `you/pr-483` as "PR-483" and `bump-node-20`
 * as "NODE-20".
 */
const BRANCH_TICKET = /^([a-z][a-z0-9]{1,9})-(\d+)-[a-z0-9]/i;

/**
 * The ticket id for a PR: the `[AK-123]` tag in the title (what santree's own PR
 * flow writes), else the head branch's id. `null` when neither carries one — the
 * Issue tab then shows its "No linked ticket" empty state.
 */
export function ticketIdFor(pr: { title: string; headRef: string }): string | null {
  const fromTitle = pr.title.match(TITLE_TICKET)?.[1];
  if (fromTitle) return fromTitle;
  // Only the namespaced form counts: an un-namespaced branch is hand-made, and
  // hand-made names (`release-2-0-1`, `node-20-upgrade`) look exactly like ids.
  const slash = pr.headRef.lastIndexOf("/");
  if (slash === -1) return null;
  const m = pr.headRef.slice(slash + 1).match(BRANCH_TICKET);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}
