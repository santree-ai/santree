/** Small presentation helpers shared across views. */

/** A diff size as `+540 −121` (note the real minus sign, matching the design). */
export function diffLabel(add: number, del: number): string {
  return `+${add} −${del}`;
}

/** The git branch a ticket's worktree uses, e.g. `santree/ak-165`. */
export function branchFor(id: string): string {
  return `santree/${id.toLowerCase()}`;
}
