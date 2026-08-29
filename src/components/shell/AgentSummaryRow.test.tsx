import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentKind } from "../../bindings";
import type { AttentionLevel } from "../../lib/attention";
import { AgentSummaryRow } from "./AgentSummaryRow";
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

function renderRow(agents: AgentNode[], expanded = false) {
  return render(
    <AgentSummaryRow agents={agents} expanded={expanded} onToggle={vi.fn()} indent={20} />,
  );
}

describe("AgentSummaryRow", () => {
  /** The dots and logomarks say nothing out loud, so the button's name has to
   *  carry what they show — otherwise the collapsed state is opaque to a screen
   *  reader in exactly the case it matters (something is waiting on you). */
  it("names what the chips show", () => {
    renderRow([agent("needs-you"), agent("idle"), agent("idle")]);
    expect(
      screen.getByRole("button", { name: "Expand agents. 3 agents: 1 needs you, 2 idle" }),
    ).toBeTruthy();
  });

  it("draws one chip per attention level, most urgent first", () => {
    const { container } = renderRow([agent("idle"), agent("needs-you")]);
    const dots = [...container.querySelectorAll("[role='img']")].map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(dots).toEqual(["Needs you", "Idle"]);
  });

  /** Five sessions of one provider is one mark and a count. The alternative —
   *  five identical marks — spends the whole row saying nothing. */
  it("collapses repeats of one provider into a count", () => {
    const { container } = renderRow([
      agent("idle", "Claude"),
      agent("idle", "Claude"),
      agent("idle", "Claude"),
    ]);
    expect(container.textContent).toContain("+2");
  });

  it("shows both providers when both are working", () => {
    const { container } = renderRow([agent("working", "Claude"), agent("working", "Codex")]);
    expect(container.querySelectorAll("svg[aria-hidden]").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain("+");
  });

  /** Expanded, the list underneath is saying all of it — repeating the chips
   *  above it would be the same fact twice. */
  it("gives way to a plain count once expanded", () => {
    const { container } = renderRow([agent("idle"), agent("working")], true);
    expect(container.textContent).toContain("2 agents");
    expect(container.querySelector("[role='img']")).toBeNull();
  });
});
