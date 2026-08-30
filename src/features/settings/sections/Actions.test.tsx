import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  effortOptionsFor,
  ReviewActionSection,
  TriageActionSection,
  WorkActionConfig,
} from "./Actions";

// Settings → Actions is a leaf view over the settings hooks: mock the data layer
// (and AppContext) so the panel can render without a Tauri backend.
let triageOn = false;
let settingValues: Record<string, string | null> = {};

vi.mock("../../../lib/queries", () => ({
  COMMIT_MESSAGE_AGENT_KEY: "commit.agent",
  COMMIT_MESSAGE_MODEL_KEY: "commit.model",
  DEFAULT_HELPER_MODEL: "haiku",
  EFFORT_LEVELS: ["low", "high"],
  PERMISSION_MODES: [{ value: "acceptEdits", label: "Accept edits" }],
  PR_BODY_AGENT_KEY: "pr.agent",
  PR_BODY_MODEL_KEY: "pr.model",
  INVESTIGATE_AGENT_KEY: "investigate.agent",
  INVESTIGATE_EFFORT_KEY: "investigate.effort",
  INVESTIGATE_MODEL_KEY: "investigate.model",
  INVESTIGATE_PERMISSION_MODE_KEY: "investigate.permissionMode",
  INVESTIGATE_REMOTE_CONTROL_KEY: "investigate.remoteControl",
  REVIEW_EFFORT_KEY: "review.effort",
  REVIEW_AGENT_KEY: "review.agent",
  REVIEW_MODEL_KEY: "review.model",
  REVIEW_PERMISSION_MODE_KEY: "review.permissionMode",
  SYNC_VIEWED_KEY: "syncViewed",
  TRIAGE_GOOD_CITIZEN_KEY: "triage.goodCitizen",
  TRIAGE_SNOOZED_KEY: "triage.snoozed",
  WORK_AGENT_KEY: "work.agent",
  WORK_ASK_BASE_KEY: "work.askBase",
  WORK_EFFORT_KEY: "work.effort",
  WORK_MODEL_KEY: "work.model",
  WORK_PERMISSION_MODE_KEY: "work.permissionMode",
  WORK_QUEUE_KEY: "work.queue",
  providerSettingKey: (key: string, agent: string) => `${key}__${agent.toLowerCase()}`,
  useAgents: () => ({
    data: [
      { key: "Claude", label: "Claude Code", short: "Claude", available: true, models: ["opus"] },
      { key: "Codex", label: "Codex", short: "Codex", available: true, models: ["gpt-5.6-sol"] },
    ],
  }),
  useBoolSetting: () => ({ value: false }),
  useClaudeModels: () => ({ data: ["opus"] }),
  useCodexModels: () => ({
    data: [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 SOL",
        description: "",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { effort: "low", description: "Fast" },
          { effort: "ultra", description: "Most thorough" },
        ],
      },
    ],
  }),
  useGithubStatus: () => ({ data: { authenticated: false } }),
  useResolvedSetting: () => ({ data: null }),
  useSetSetting: () => ({ mutate: vi.fn() }),
  useSetSyncViewed: () => ({ mutate: vi.fn() }),
  useSetting: (_scope: string, key: string) => ({ data: settingValues[key] ?? null }),
}));

vi.mock("../../../state/AppContext", () => ({
  useApp: () => ({
    settings: {
      defaultAgent: "Codex",
      integrations: { linear: true, triage: triageOn },
      agents: [
        { key: "Claude", model: "opus" },
        { key: "Codex", model: "" },
      ],
    },
    toggleIntegration: vi.fn(),
  }),
}));

describe("app-scope Triage settings", () => {
  beforeEach(() => {
    triageOn = false;
    settingValues = {};
  });

  it("really disables every control in the panel while triage is off", () => {
    render(<TriageActionSection />);

    // `pointer-events-none` on the wrapper only stops the mouse — without a real
    // `disabled` a keyboard user tabs straight in and mutates a setting the UI
    // shows as off.
    for (const select of screen.getAllByRole("combobox")) expect(select).toBeDisabled();
    // The switches below the master toggle (which stays live — it's what turns
    // triage back on).
    const switches = screen.getAllByRole("switch");
    expect(switches[0]).toBeEnabled();
    for (const s of switches.slice(1)) expect(s).toBeDisabled();
  });

  it("leaves them all live once triage is on", () => {
    triageOn = true;
    render(<TriageActionSection />);

    for (const select of screen.getAllByRole("combobox")) expect(select).toBeEnabled();
    for (const s of screen.getAllByRole("switch")) expect(s).toBeEnabled();
  });
});

describe("app-scope Reviews settings", () => {
  beforeEach(() => {
    settingValues = {};
  });

  it("offers an agent picker for the default review provider", () => {
    render(<ReviewActionSection />);
    expect(screen.getByText("Default agent")).toBeInTheDocument();
  });

  it("configures the default provider's model and effort", () => {
    render(<ReviewActionSection />);
    expect(screen.getAllByText("Model")).toHaveLength(1);
    expect(screen.getAllByText("Effort")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "CLI default (low)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ultra" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "high" })).toBeNull();
  });

  it("switches to that provider's saved model instead of keeping a cross-provider model", () => {
    settingValues = {
      "review.agent": "Claude",
      "review.model": "gpt-5.6-sol",
    };
    render(<ReviewActionSection />);

    const agent = screen.getByLabelText("Default agent");
    const model = screen.getByLabelText("Model");
    expect(model).toHaveValue("opus");
    expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).toBeNull();

    fireEvent.change(agent, { target: { value: "Codex" } });
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-5.6-sol");
  });
});

describe("provider effort capabilities", () => {
  it("uses only efforts advertised by the selected Codex model", () => {
    expect(
      effortOptionsFor("Codex", {
        id: "gpt-test",
        displayName: "Test",
        description: "",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { effort: "medium", description: "Balanced" },
          { effort: "ultra", description: "Deep" },
        ],
      }),
    ).toEqual([
      { value: "medium", description: "Balanced" },
      { value: "ultra", description: "Deep" },
    ]);
  });

  it("keeps Claude's CLI effort scale independent from Codex models", () => {
    expect(effortOptionsFor("Claude").map(({ value }) => value)).toEqual(["low", "high"]);
  });

  it("does not guess Codex efforts before the model capabilities load", () => {
    expect(effortOptionsFor("Codex")).toEqual([]);
  });
});

describe("app-scope Work settings", () => {
  beforeEach(() => {
    settingValues = {};
  });

  it("separates provider profiles from the three independent agent assignments", () => {
    settingValues = {
      "work.agent": "Claude",
      "commit.agent": "Codex",
      "pr.agent": "Claude",
      "commit.model__codex": "gpt-5.6-sol",
    };
    render(<WorkActionConfig />);

    expect(screen.queryByText("Default agent")).toBeNull();
    expect(screen.getByLabelText("Work model")).toHaveValue("opus");
    expect(screen.getByLabelText("Commit message model")).toHaveValue("haiku");
    expect(screen.getByLabelText("Work agent")).toHaveValue("Claude");
    expect(screen.getByLabelText("Commit message agent")).toHaveValue("Codex");
    expect(screen.getByLabelText("PR description agent")).toHaveValue("Claude");

    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByLabelText("Work model")).toHaveValue("gpt-5.6-sol");
    expect(screen.getByLabelText("Commit message model")).toHaveValue("gpt-5.6-sol");
  });
});
