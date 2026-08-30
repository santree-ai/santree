/** Pure helpers behind the expanded Session-history row: the spawn tree the
 *  subagent sidecars describe, and the compact path the detail shows. Kept out
 *  of the component so the tree-shaping rules — the part that is real logic —
 *  are testable without rendering anything.
 *
 *  The row's "copy resume command" line is NOT here: it is the same invocation
 *  a launched session runs, so it comes from the provider's own launch spec
 *  (`terminal/agentProvider.ts` → `resumeInvocation`). */
import type { SessionSubagent } from "../../bindings";

/** One subagent with the agents it spawned. */
export interface SubagentNode {
  agent: SessionSubagent;
  children: SubagentNode[];
}

/**
 * Nest a session's subagents by `parentAgentId` into the tree the sidecars
 * actually describe — the depth-2 agents under the depth-1 agent that spawned
 * them, rather than one flat list.
 *
 * Three ways a row would otherwise be lost, all of which put it at the top level
 * instead: a **missing parent** (the sidecar names an agent whose transcript is
 * gone — a pruned or still-writing run), a **self-parent**, and a **cycle**
 * between sidecars. Nothing may drop a row: the count badge is derived from the
 * same file listing, so a dropped row makes the two disagree.
 *
 * Sibling order is the input's, which the backend sorts by file name — stable
 * across refetches, so an open tree doesn't reshuffle under the cursor.
 */
export function buildSubagentTree(agents: SessionSubagent[]): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>(
    agents.map((agent) => [agent.agentId, { agent, children: [] }]),
  );
  const roots: SubagentNode[] = [];
  for (const agent of agents) {
    const node = nodes.get(agent.agentId);
    if (!node) continue;
    const parentId = agent.parentAgentId;
    const parent = parentId && parentId !== agent.agentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // A cycle leaves every node in it reachable only from another cycle member, so
  // none of them is a root. Walk what the roots reach and promote the rest.
  const reachable = new Set<string>();
  const visit = (node: SubagentNode) => {
    if (reachable.has(node.agent.agentId)) return;
    reachable.add(node.agent.agentId);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  for (const agent of agents) {
    if (reachable.has(agent.agentId)) continue;
    const node = nodes.get(agent.agentId);
    if (!node) continue;
    // Detach it from the parent that can't be reached, or it would render twice.
    for (const other of nodes.values())
      other.children = other.children.filter((c) => c.agent.agentId !== agent.agentId);
    roots.push(node);
    visit(node);
  }
  return roots;
}

/** How many rows a tree renders — the flat count, for comparing against the
 *  session's own subagent badge. */
export function countSubagentNodes(nodes: SubagentNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countSubagentNodes(node.children), 0);
}

/** A path as its last `keep` segments (`…/worktrees/AK-1`), for a row that has
 *  no width for the whole thing. The full path belongs in a `title`. */
export function compactPath(path: string, keep = 2): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join("/")}`;
}
