import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LaunchPanel } from "./LaunchPanel";

// The tray is a leaf over the Issues model + settings hooks: mock both so it
// renders without a Tauri backend. `resolved` records how the model was looked
// up — the regression this guards is the tray resolving a model for the
// *configured* agent while a different one was chosen in the tray.
const resolved = vi.fn();
let launchAgent = "Codex";

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
}));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ activeRepo: "acme/app" }),
}));

vi.mock("./model", () => ({
  useIssues: () => ({
    selectedEligible: [
      { id: "AK-1", ready: true },
      { id: "AK-2", ready: true },
    ],
    clearSelection: vi.fn(),
    launchAgent,
    setLaunchAgent: vi.fn(),
    launch: vi.fn(),
  }),
}));

describe("LaunchPanel", () => {
  beforeEach(() => {
    resolved.mockClear();
    launchAgent = "Codex";
  });

  it("shows the Settings model for the agent chosen in the tray, not the configured one", () => {
    render(<LaunchPanel />);

    expect(resolved).toHaveBeenCalledWith("acme/app", "work_model", "Codex", "work_agent");
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.queryByText(/opus/)).not.toBeInTheDocument();
  });

  it("offers no model choice at launch time — only the agent", () => {
    render(<LaunchPanel />);
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));

    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveValue("Codex");
  });
});
