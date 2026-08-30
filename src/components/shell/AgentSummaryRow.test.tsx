import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentKind } from "../../bindings";
import type { AttentionLevel } from "../../lib/attention";
import { AgentSummaryRow } from "./AgentSummaryRow";
import type { AgentNode } from "./useProjectTree";

let seq = 0;
/** `kind` is required and nullable: a `= "Claude"` default both closed the
 *  unattributable-session case (the type would not even accept `null`) and hid
 *  which provider each assertion below is actually naming. */
function agent(level: AttentionLevel, kind: AgentKind | null): AgentNode {
  seq += 1;
  return {
    entry: { sessionId: `s${seq}`, agentKind: kind } as AgentNode["entry"],
    unseen: false,
    attention: { level, at: seq },
  };
}

function renderRow(agents: AgentNode[], expanded = false) {
  return render(
    <AgentSummaryRow agents={agents} expanded={expanded} onToggle={vi.fn()} indent={20} />,
  );
}

/** The chips' state, in chip order — each dot's label is its level. */
function chipStates(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll("[role='img']")].map((el) => el.getAttribute("aria-label"));
}

describe("AgentSummaryRow", () => {
  /** The dots and logomarks say nothing out loud, so the button's name has to
   *  carry what they show — otherwise the collapsed state is opaque to a screen
   *  reader in exactly the case it matters (something is waiting on you). */
  it("names what the chips show", () => {
    renderRow([agent("needs-you", "Codex"), agent("idle", "Claude"), agent("idle", "Claude")]);
    expect(
      screen.getByRole("button", {
        name: "Expand agents. 3 agents: 1 Codex needs you, 2 Claude idle",
      }),
    ).toBeTruthy();
  });

  it("draws one chip per provider, the one that needs you first", () => {
    const { container } = renderRow([agent("idle", "Claude"), agent("needs-you", "Codex")]);
    expect(chipStates(container)).toEqual(["Needs you", "Idle"]);
    // Two provider marks plus the row's own chevron.
    expect(container.querySelectorAll("svg").length).toBe(3);
  });

  /** The colour is the busiest agent's, not the newest one's or the group's
   *  first — the same `highest` the worktree's own dot is drawn from. */
  it("colours a provider's chip by its busiest agent", () => {
    const { container } = renderRow([agent("idle", "Claude"), agent("needs-you", "Claude")]);
    expect(chipStates(container)).toEqual(["Needs you"]);
  });

  /** Five sessions of one provider is one mark and its count. The alternative —
   *  five identical marks — spends the whole row saying nothing. */
  it("counts repeats of one provider on that provider's chip", () => {
    const { container } = renderRow([
      agent("idle", "Claude"),
      agent("idle", "Claude"),
      agent("idle", "Claude"),
    ]);
    expect(chipStates(container)).toEqual(["Idle"]);
    expect(container.textContent).toContain("3");
  });

  /** One is what the mark already says; a "1" beside every chip would be noise
   *  on the common row. */
  it("leaves a single agent's chip uncounted", () => {
    const { container } = renderRow([agent("working", "Claude"), agent("working", "Codex")]);
    expect(container.textContent).toBe("");
  });

  /** More providers than the row has room for fold into a count of agents, so
   *  the number beside the chips is never a number of tools. */
  it("folds the providers that do not fit into a trailing count", () => {
    const { container } = renderRow([
      agent("needs-you", "Claude"),
      agent("done", "Codex"),
      agent("working", "Cursor"),
      agent("idle", "Opencode"),
      agent("idle", "Opencode"),
    ]);
    expect(chipStates(container)).toEqual(["Needs you", "Just finished", "Working"]);
    expect(container.textContent).toContain("+2");
  });

  /** A session santree cannot attribute to a provider still gets a chip: the
   *  mark's slot stays empty rather than the chip collapsing onto its dot, so a
   *  row of them keeps one shape. `agentKind: null` is the state the registry
   *  reports when the row that named the provider is gone. */
  it("keeps the mark's slot when a session has no provider", () => {
    const { container } = renderRow([agent("needs-you", "Codex"), agent("idle", null)]);
    expect(chipStates(container)).toEqual(["Needs you", "Idle"]);
    // One provider mark plus the row's own chevron — the second chip draws none.
    expect(container.querySelectorAll("svg").length).toBe(2);
    // ...but both chips still reserve the mark's slot, so the row keeps one shape.
    expect(container.querySelectorAll('[class*="size-3.5"]').length).toBe(2);
    expect(
      screen.getByRole("button", {
        name: "Expand agents. 2 agents: 1 Codex needs you, 1 agent idle",
      }),
    ).toBeTruthy();
  });

  /** Expanded, the list underneath is saying all of it — repeating the chips
   *  above it would be the same fact twice. */
  it("gives way to a plain count once expanded", () => {
    const { container } = renderRow([agent("idle", "Claude"), agent("working", "Claude")], true);
    expect(container.textContent).toContain("2 agents");
    expect(container.querySelector("[role='img']")).toBeNull();
  });
});
