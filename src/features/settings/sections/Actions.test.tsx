import { fireEvent, render, screen, within } from "@testing-library/react";
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
// Mutable like `triageOn`: `linear` gates the master toggle and the panel's
// copy, and a hardcoded `true` here made the not-connected half unrenderable.
let linearOn = true;
let settingValues: Record<string, string | null> = {};
const setSetting = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/queries", () => ({
  TRIAGE_DEFAULT_REPO_KEY: "triage.defaultRepo",
  useRepos: () => ({
    data: [
      { name: "acme/app", path: "/src/app" },
      { name: "acme/web", path: "/src/web" },
    ],
  }),
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
  useSetSetting: () => ({ mutate: setSetting }),
  useSetSyncViewed: () => ({ mutate: vi.fn() }),
  useSetting: (_scope: string, key: string) => ({ data: settingValues[key] ?? null }),
}));

vi.mock("../../../state/AppContext", () => ({
  useApp: () => ({
    settings: {
      defaultAgent: "Codex",
      integrations: { linear: linearOn, triage: triageOn },
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
    linearOn = true;
    settingValues = {};
  });

  it("really disables every control in the panel while triage is off", () => {
    render(<TriageActionSection />);

    // `pointer-events-none` on the wrapper only stops the mouse — without a real
    // `disabled` a keyboard user tabs straight in and mutates a setting the UI
    // shows as off.
    for (const select of screen.getAllByRole("combobox")) expect(select).toBeDisabled();
    // The master toggle stays live — it's what turns triage back on.
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(1);
    expect(switches[0]).toBeEnabled();
  });

  /** The queue's Mine/All switch lives on the sidebar's Triage section, and the
   *  snoozed lane is a subsection there — a copy of either here would be two
   *  controls for one setting, disagreeing the moment one lagged. */
  it("offers no queue preferences — the sidebar section is the one control", () => {
    triageOn = true;
    render(<TriageActionSection />);

    expect(screen.queryByText("Be a good citizen")).toBeNull();
    expect(screen.queryByText("Show snoozed issues")).toBeNull();
    expect(screen.getByText(/Show the Triage section in the sidebar/)).toBeInTheDocument();
  });

  /** Triage has nothing to pull without Linear, so the master switch is dimmed —
   *  and dimming it is only honest if it is also really `disabled`. The panel's
   *  own rule (every control below takes the real attribute, not just
   *  `pointer-events-none`) has to hold for the switch that turns it all on. */
  it("really disables the master toggle while Linear is not connected", () => {
    linearOn = false;
    render(<TriageActionSection />);

    expect(screen.getByText(/Connect Linear first/)).toBeInTheDocument();
    expect(screen.getAllByRole("switch")[0]).toBeDisabled();
  });

  it("leaves them all live once triage is on", () => {
    triageOn = true;
    render(<TriageActionSection />);

    for (const select of screen.getAllByRole("combobox")) expect(select).toBeEnabled();
    for (const s of screen.getAllByRole("switch")) expect(s).toBeEnabled();
  });

  /** One setting for two things — where tickets run, and which Linear org the
   *  queue reads — so it is offered once, over the registry, with a real "None". */
  it("offers the registered projects as the triage default, None included", () => {
    triageOn = true;
    setSetting.mockClear();
    settingValues = { "triage.defaultRepo": "acme/web" };
    render(<TriageActionSection />);

    const select = screen.getByLabelText("Default project");
    expect(select).toHaveValue("acme/web");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["None", "acme/app", "acme/web"]);

    fireEvent.change(select, { target: { value: "acme/app" } });
    expect(setSetting).toHaveBeenCalledWith({
      scope: "app",
      key: "triage.defaultRepo",
      value: "acme/app",
    });
    fireEvent.change(select, { target: { value: "" } });
    expect(setSetting).toHaveBeenLastCalledWith({
      scope: "app",
      key: "triage.defaultRepo",
      value: null,
    });
  });

  /** A stored name the registry no longer has still shows, as itself: reading
   *  it as "None" would hide a row on disk that keeps pointing elsewhere. */
  it("keeps a default the registry no longer has on the list", () => {
    triageOn = true;
    settingValues = { "triage.defaultRepo": "gone/repo" };
    render(<TriageActionSection />);

    expect(screen.getByLabelText("Default project")).toHaveValue("gone/repo");
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
