import { describe, expect, it } from "vitest";

import type { SessionSubagent } from "../../bindings";
import {
  buildSubagentTree,
  compactPath,
  countSubagentNodes,
  type SubagentNode,
} from "./sessionDetail";

function agent(agentId: string, parentAgentId: string | null, depth = 1): SessionSubagent {
  return {
    agentId,
    parentAgentId,
    depth,
    agentType: "general-purpose",
    description: agentId,
    messageCount: 1,
    status: "Completed",
    lastActivityMs: null,
    sampled: false,
  };
}

/** The tree as `id(child, child)` strings, so a shape assertion reads as one. */
function shape(nodes: SubagentNode[]): string {
  return nodes
    .map((n) => (n.children.length ? `${n.agent.agentId}(${shape(n.children)})` : n.agent.agentId))
    .join(",");
}

describe("buildSubagentTree", () => {
  /** The differentiator: the sidecars carry `parentAgentId` and `spawnDepth`,
   *  so a depth-2 agent belongs under the depth-1 agent that spawned it. */
  it("nests a spawned agent under its parent, keeping sibling order as listed", () => {
    const tree = buildSubagentTree([
      agent("a", null),
      agent("b", "a", 2),
      agent("c", "b", 3),
      agent("z", "a", 2),
      agent("d", null),
    ]);
    expect(shape(tree)).toBe("a(b(c),z),d");
    expect(countSubagentNodes(tree)).toBe(5);
  });

  /** A parent whose transcript was pruned (or is still being written) must not
   *  take its child down with it — the badge counts the files on disk, so a
   *  dropped row makes the count and the list disagree. */
  it("renders an orphan or a self-parenting sidecar at the top level rather than dropping it", () => {
    const tree = buildSubagentTree([agent("b", "gone", 2), agent("c", null), agent("s", "s")]);
    expect(shape(tree)).toBe("b,c,s");
    expect(countSubagentNodes(tree)).toBe(3);
  });

  /** Two sidecars naming each other leave neither one a root, so the walk would
   *  render nothing at all. The first listed is promoted, which both breaks the
   *  cycle and keeps every row exactly once. */
  it("breaks a cycle instead of losing both rows", () => {
    const tree = buildSubagentTree([agent("a", "b"), agent("b", "a")]);
    expect(shape(tree)).toBe("a(b)");
    expect(countSubagentNodes(tree)).toBe(2);
  });
});

describe("compactPath", () => {
  it("keeps the last two segments of a long path, and leaves a short one alone", () => {
    expect(compactPath("/Users/me/repo/.santree/worktrees/AK-1")).toBe("…/worktrees/AK-1");
    expect(compactPath("/tmp/x")).toBe("/tmp/x");
  });
});
