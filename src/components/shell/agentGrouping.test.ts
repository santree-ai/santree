import { describe, expect, it } from "vitest";

import type { AgentKind } from "../../bindings";
import type { AttentionLevel } from "../../lib/attention";
import { describeAgents, groupByProvider, splitGroups } from "./agentGrouping";
import type { AgentNode } from "./useProjectTree";

let seq = 0;
/** `at` defaults to a rising sequence, so agents differ the way real events do;
 *  pass it explicitly to test what happens when two groups tie exactly. */
function agent(level: AttentionLevel, kind?: AgentKind, at?: number): AgentNode {
  seq += 1;
  return {
    entry: { sessionId: `s${seq}`, agentKind: kind } as AgentNode["entry"],
    unseen: false,
    attention: { level, at: at ?? seq },
  };
}

describe("groupByProvider", () => {
  /** The point of the whole regroup: a count belongs to a provider, not to a
   *  pile of marks. Two Claudes and a Codex is "Claude 2" and "Codex", never
   *  one chip with a "+2" nobody can attribute. */
  it("makes one group per provider, whatever state its agents are in", () => {
    const groups = groupByProvider([
      agent("idle", "Claude"),
      agent("working", "Claude"),
      agent("idle", "Codex"),
    ]);
    expect(groups.map((g) => [g.kind, g.agents.length])).toEqual([
      ["Claude", 2],
      ["Codex", 1],
    ]);
  });

  /** The chip's color has one source, and it is the same aggregation the
   *  worktree's own dot uses — `highest`, not a second reading of the agents. */
  it("takes a group's attention from the busiest agent in it", () => {
    const [group] = groupByProvider([agent("idle", "Claude"), agent("needs-you", "Claude")]);
    expect(group.attention.level).toBe("needs-you");
  });

  it("orders providers by the attention ladder, most urgent first", () => {
    const groups = groupByProvider([
      agent("idle", "Cursor"),
      agent("working", "Codex"),
      agent("needs-you", "Claude"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["Claude", "Codex", "Cursor"]);
  });

  /** A session santree can't attribute to a provider is its own chip — folding
   *  it into a real provider's count would attribute it by accident. */
  it("keeps an unattributable session out of a provider's count", () => {
    const groups = groupByProvider([agent("idle", "Claude", 5), agent("idle", undefined, 5)]);
    expect(groups.map((g) => [g.kind, g.agents.length])).toEqual([
      ["Claude", 1],
      [null, 1],
    ]);
  });

  it("breaks an exact tie on the order the providers arrived in", () => {
    const groups = groupByProvider([agent("idle", "Codex", 5), agent("idle", "Claude", 5)]);
    expect(groups.map((g) => g.kind)).toEqual(["Codex", "Claude"]);
  });

  it("has nothing to group with no agents", () => {
    expect(groupByProvider([])).toEqual([]);
  });
});

describe("splitGroups", () => {
  it("keeps every chip when they fit", () => {
    const { visible, hiddenAgents } = splitGroups([agent("needs-you", "Claude"), agent("idle")]);
    expect(visible.map((g) => g.kind)).toEqual(["Claude", null]);
    expect(hiddenAgents).toBe(0);
  });

  /** With more providers than room, the ones that fold away are always the
   *  least urgent — and they fold into a count of *agents*, never silently. */
  it("folds the least urgent providers into an agent count", () => {
    const { visible, hiddenAgents } = splitGroups([
      agent("needs-you", "Claude"),
      agent("done", "Codex"),
      agent("working", "Cursor"),
      agent("idle", "Opencode"),
      agent("idle", "Opencode"),
    ]);
    expect(visible.map((g) => g.kind)).toEqual(["Claude", "Codex", "Cursor"]);
    expect(hiddenAgents).toBe(2);
  });
});

describe("describeAgents", () => {
  /** The chips are silent: a dot has no text and a logomark has no name, so
   *  this sentence is the whole of what a screen reader gets. */
  it("names each chip's provider, count and state, in chip order", () => {
    expect(
      describeAgents([
        agent("idle", "Codex"),
        agent("working", "Claude"),
        agent("working", "Claude"),
      ]),
    ).toBe("3 agents: 2 Claude working, 1 Codex idle");
  });

  it("says plain 'agent' for a session with no provider", () => {
    expect(describeAgents([agent("needs-you"), agent("idle", "Claude")])).toBe(
      "2 agents: 1 agent needs you, 1 Claude idle",
    );
  });
});
