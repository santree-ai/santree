import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TriageActionSection } from "./Actions";

// Settings → Actions is a leaf view over the settings hooks: mock the data layer
// (and AppContext) so the panel can render without a Tauri backend.
let triageOn = false;

vi.mock("../../../lib/queries", () => ({
  EFFORT_LEVELS: ["low", "high"],
  PERMISSION_MODES: [{ value: "acceptEdits", label: "Accept edits" }],
  INVESTIGATE_AGENT_KEY: "investigate.agent",
  INVESTIGATE_EFFORT_KEY: "investigate.effort",
  INVESTIGATE_MODEL_KEY: "investigate.model",
  INVESTIGATE_REMOTE_CONTROL_KEY: "investigate.remoteControl",
  TRIAGE_GOOD_CITIZEN_KEY: "triage.goodCitizen",
  TRIAGE_SNOOZED_KEY: "triage.snoozed",
  WORK_AGENT_KEY: "work.agent",
  WORK_EFFORT_KEY: "work.effort",
  WORK_MODEL_KEY: "work.model",
  WORK_PERMISSION_MODE_KEY: "work.permissionMode",
  WORK_QUEUE_KEY: "work.queue",
  useAgents: () => ({
    data: [{ key: "Claude", label: "Claude", short: "Claude", available: true }],
  }),
  useBoolSetting: () => ({ value: false }),
  useClaudeModels: () => ({ data: ["opus"] }),
  useResolvedSetting: () => ({ data: null }),
  useSetSetting: () => ({ mutate: vi.fn() }),
  useSetting: () => ({ data: null }),
}));

vi.mock("../../../state/AppContext", () => ({
  useApp: () => ({
    settings: { integrations: { linear: true, triage: triageOn }, agents: [] },
    toggleIntegration: vi.fn(),
  }),
}));

describe("app-scope Triage settings", () => {
  beforeEach(() => {
    triageOn = false;
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
