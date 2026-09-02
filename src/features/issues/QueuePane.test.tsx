import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "../../bindings";
import { QueuePane } from "./QueuePane";

// The pane is a leaf over the Issues model + settings hooks: mock both so it
// renders without a Tauri backend. `resolved` records how each card looked its
// model up — the regression this guards is a card resolving a model for the
// *configured* agent while the card's own pick is a different one.
const resolved = vi.fn();
const model = {
  setQueueAgent: vi.fn(),
  toggle: vi.fn(),
  setFocus: vi.fn(),
  setRailTab: vi.fn(),
  clearSelection: vi.fn(),
  launch: vi.fn(),
};

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Do ${id}`,
    project: "Ingest",
    projectMilestone: null,
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    parentId: null,
    priority: "High",
    estimate: null,
    cycle: null,
    dueDate: null,
    status: "Todo",
    ready: true,
    blockedBy: [],
    actionable: true,
    assignee: null,
    assigneeAvatarUrl: null,
    x: 0,
    y: 0,
    ...over,
  };
}

let queued: Task[] = [];

vi.mock("../../lib/queries", () => ({
  WORK_AGENT_KEY: "work_agent",
  WORK_MODEL_KEY: "work_model",
  useAgents: () => ({
    data: [
      { key: "Claude", label: "Claude Code", short: "Claude", available: true, models: ["opus"] },
      { key: "Codex", label: "Codex", short: "Codex", available: true, models: ["gpt-5.6-sol"] },
    ],
  }),
  useResolvedProviderSetting: (repo: string, key: string, agent: string, agentKey: string) => {
    resolved(repo, key, agent, agentKey);
    return { data: agent === "Codex" ? "gpt-5.6-sol" : "opus", isFetched: true };
  },
  useTaskNote: () => ({ data: "" }),
  useSetTaskNote: () => ({ mutate: vi.fn() }),
}));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ activeRepo: "acme/app" }),
}));

vi.mock("./model", () => ({
  useIssues: () => ({
    ...model,
    selectedEligible: queued,
    baseFor: () => null,
    launchAgent: "Claude",
    // AK-2 carries its own pick; AK-1 runs on the configured agent.
    agentFor: (id: string) => (id === "AK-2" ? "Codex" : "Claude"),
  }),
}));

describe("QueuePane", () => {
  beforeEach(() => {
    resolved.mockClear();
    for (const fn of Object.values(model)) fn.mockClear();
    queued = [task("AK-1"), task("AK-2")];
  });

  it("resolves each card's model for that card's agent, and offers no model choice", () => {
    render(<QueuePane />);

    expect(resolved).toHaveBeenCalledWith("acme/app", "work_model", "Claude", "work_agent");
    expect(resolved).toHaveBeenCalledWith("acme/app", "work_model", "Codex", "work_agent");
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /model/i })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Agent for AK-2" })).toHaveValue("Codex");
  });

  /** Picking the configured agent is not an override: the pick is dropped. */
  it("stores a pick only when it differs from the configured agent", () => {
    render(<QueuePane />);

    fireEvent.change(screen.getByRole("combobox", { name: "Agent for AK-1" }), {
      target: { value: "Codex" },
    });
    expect(model.setQueueAgent).toHaveBeenCalledWith("AK-1", "Codex");

    fireEvent.change(screen.getByRole("combobox", { name: "Agent for AK-2" }), {
      target: { value: "Claude" },
    });
    expect(model.setQueueAgent).toHaveBeenCalledWith("AK-2", null);
  });

  it("opens a card's ticket in the ticket pane without taking it out of the queue", () => {
    render(<QueuePane />);

    fireEvent.click(screen.getByRole("button", { name: /Do AK-1/ }));
    expect(model.setFocus).toHaveBeenCalledWith("AK-1");
    expect(model.setRailTab).toHaveBeenCalledWith("issue");
    expect(model.toggle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove AK-1 from the queue" }));
    expect(model.toggle).toHaveBeenCalledWith("AK-1");
  });

  it("launches the queue from its one button, and says so when empty", () => {
    const { unmount } = render(<QueuePane />);
    fireEvent.click(screen.getByRole("button", { name: /Launch 2 agents/ }));
    expect(model.launch).toHaveBeenCalledTimes(1);
    unmount();

    queued = [];
    render(<QueuePane />);
    expect(screen.getByText("Nothing queued")).toBeInTheDocument();
  });
});
