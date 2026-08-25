import { fireEvent, render, screen } from "@testing-library/react";
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
  estimate: null,
  project: null,
  projectColor: null,
  projectIcon: null,
  projectTargetDate: null,
  dueDate: null,
  sortOrder: null,
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
        agentKinds={["Codex"]}
        agentStates={[]}
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

  it("shows real project delivery and estimate signals on queue cards", () => {
    render(
      <QueueRow
        ticket={{
          ...ticket,
          estimate: 3,
          project: "Agent Knowledge",
          projectColor: "#3b82f6",
          projectTargetDate: "2099-09-30",
        }}
        active={false}
        selectable
        selected={false}
        investigating={false}
        agentKinds={[]}
        agentStates={[]}
        onSelect={vi.fn()}
        onToggleSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    expect(screen.getByTitle("3 point estimate")).toBeInTheDocument();
    expect(screen.getByText("Agent Knowledge")).toBeInTheDocument();
    expect(screen.getByTitle(/Project target date/)).toBeInTheDocument();
  });

  it("shows structured provider activity on a queue card", () => {
    render(
      <QueueRow
        ticket={ticket}
        active={false}
        selectable={false}
        selected={false}
        investigating
        agentKinds={["Codex"]}
        agentStates={[
          {
            agentKind: "Codex",
            sessionId: "codex-session",
            state: "active",
            event: "turn/started",
            cwd: "/repo",
            message: null,
            transcriptPath: null,
            updatedAtMs: 1,
            repo: "owner/repo",
            termKey: `triage:${ticket.id}`,
          },
        ]}
        onSelect={vi.fn()}
        onToggleSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByTitle("Running")).toBeInTheDocument();
  });

  it("offers accessible keyboard movement only in writable manual mode", () => {
    const onMove = vi.fn();
    const { rerender } = render(
      <QueueRow
        ticket={ticket}
        active={false}
        selectable
        selected={false}
        investigating={false}
        agentKinds={[]}
        agentStates={[]}
        manual
        onManualMove={onMove}
        onSelect={vi.fn()}
        onToggleSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder SAN-1" }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(onMove).toHaveBeenCalledWith("SAN-1", 1);

    rerender(
      <QueueRow
        ticket={ticket}
        active={false}
        selectable
        selected={false}
        investigating={false}
        agentKinds={[]}
        agentStates={[]}
        manual
        manualDisabled
        onManualMove={onMove}
        onSelect={vi.fn()}
        onToggleSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Reorder SAN-1" })).toBeDisabled();
  });
});
