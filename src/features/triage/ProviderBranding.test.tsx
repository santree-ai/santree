import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentKind, TriageTicket } from "../../bindings";
import { IssueHeader } from "./IssueHeader";
import { QueueRow } from "./QueueRow";

vi.mock("../../components/icons", async () => {
  const actual =
    await vi.importActual<typeof import("../../components/icons")>("../../components/icons");
  return {
    ...actual,
    AgentIcon: ({ kind }: { kind: AgentKind }) => <span data-testid="agent-icon">{kind}</span>,
  };
});

const ticket: TriageTicket = {
  id: "SAN-1",
  title: "Provider branding",
  priority: "Medium",
  createdAtMs: null,
  meta: "owner@example.com",
  team: "SAN",
  slaBreachMs: null,
  snoozedUntilMs: null,
  mine: true,
};

describe("Triage provider branding", () => {
  it("uses the stored provider for a resumable queue row", () => {
    render(
      <QueueRow
        ticket={ticket}
        active={false}
        selectable
        selected={false}
        investigating={false}
        started
        agentKinds={["Codex"]}
        onSelect={vi.fn()}
        onToggleSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    expect(screen.getByTestId("agent-icon")).toHaveTextContent("Codex");
  });

  it("uses the resolved provider on the Investigate action", () => {
    render(
      <IssueHeader
        ticket={ticket}
        onSetState={vi.fn()}
        investigating={false}
        agentKind="Codex"
        onInvestigate={vi.fn()}
        onRefresh={vi.fn()}
        refreshing={false}
      />,
    );

    expect(screen.getByRole("button", { name: /Investigate/ })).toContainElement(
      screen.getByTestId("agent-icon"),
    );
    expect(screen.getByTestId("agent-icon")).toHaveTextContent("Codex");
  });
});
