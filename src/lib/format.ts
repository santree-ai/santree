/** Small presentation helpers shared across views. */
import type { AgentDef } from "../bindings";

/** Whether an agent harness is wired up today — the catalog's own
 *  `available` flag (see `crates/core/src/config.rs`), not a frontend guess. */
export const agentAvailable = (agent: Pick<AgentDef, "available">): boolean => agent.available;

/** A diff size as `+540 −121` (note the real minus sign, matching the design). */
export function diffLabel(add: number, del: number): string {
  return `+${add} −${del}`;
}
