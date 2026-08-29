import { describe, expect, it } from "vitest";

import type { AgentKind } from "../../bindings";
import type { AttentionLevel } from "../../lib/attention";
import { describeAgents, groupByAttention, pickGroupIcons, splitGroups } from "./agentGrouping";
import type { AgentNode } from "./useProjectTree";

let seq = 0;
function agent(level: AttentionLevel, kind: AgentKind = "Claude"): AgentNode {
  seq += 1;
  return {
    entry: { sessionId: `s${seq}`, agentKind: kind } as AgentNode["entry"],
    unseen: false,
    attention: { level, at: seq },
  };
}

describe("groupByAttention", () => {
  it("orders groups by the attention ladder, not by arrival", () => {
    const groups = groupByAttention([
      agent("idle"),
      agent("working"),
      agent("needs-you"),
      agent("done"),
    ]);
    expect(groups.map((g) => g.level)).toEqual(["needs-you", "done", "working", "idle"]);
  });

  it("keeps every agent of a level together", () => {
    const groups = groupByAttention([agent("idle"), agent("idle"), agent("working")]);
    expect(groups.map((g) => [g.level, g.agents.length])).toEqual([
      ["working", 1],
      ["idle", 2],
    ]);
  });

  /** A level nobody is in must not render a chip — an empty chip reads as a
   *  state something is actually in. */
  it("omits levels with no agents", () => {
    expect(groupByAttention([agent("idle")]).map((g) => g.level)).toEqual(["idle"]);
    expect(groupByAttention([])).toEqual([]);
  });
});

describe("pickGroupIcons", () => {
  /** The whole reason for deduping: five Claude marks say nothing the count
   *  doesn't. Two providers and a "+3" says which tools are on the job. */
  it("shows one mark per provider, busiest provider first", () => {
    const agents = [
      agent("idle", "Codex"),
      agent("idle", "Claude"),
      agent("idle", "Claude"),
      agent("idle", "Claude"),
    ];
    const icons = pickGroupIcons(agents);
    expect(icons.map((a) => a.entry.agentKind)).toEqual(["Claude", "Codex"]);
    expect(agents.length - icons.length).toBe(2);
  });

  it("breaks a tie on the order the agents arrived in", () => {
    const icons = pickGroupIcons([agent("idle", "Codex"), agent("idle", "Claude")]);
    expect(icons.map((a) => a.entry.agentKind)).toEqual(["Codex", "Claude"]);
  });

  it("caps the marks it returns", () => {
    const agents = [agent("idle", "Claude"), agent("idle", "Codex")];
    expect(pickGroupIcons(agents, 1)).toHaveLength(1);
  });
});

describe("splitGroups", () => {
  it("keeps every group when they fit", () => {
    const { visible, hiddenAgents } = splitGroups([agent("needs-you"), agent("idle")]);
    expect(visible.map((g) => g.level)).toEqual(["needs-you", "idle"]);
    expect(hiddenAgents).toBe(0);
  });

  /** With four levels and room for three, the one that folds away is always the
   *  least urgent — and it folds into a count, never silently. */
  it("folds the least urgent level into a count", () => {
    const { visible, hiddenAgents } = splitGroups([
      agent("needs-you"),
      agent("done"),
      agent("working"),
      agent("idle"),
      agent("idle"),
    ]);
    expect(visible.map((g) => g.level)).toEqual(["needs-you", "done", "working"]);
    expect(hiddenAgents).toBe(2);
  });
});

describe("describeAgents", () => {
  it("spells the chips out for a screen reader, in chip order", () => {
    expect(describeAgents([agent("idle"), agent("needs-you"), agent("idle")])).toBe(
      "3 agents: 1 needs you, 2 idle",
    );
  });
});
