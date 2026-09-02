import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "./SettingsView";

// The view is the settings *frame*: the scope switch, the section nav and the
// one pane it opens. Every pane is stubbed so the assertions are about the nav
// structure alone, and the data layer is mocked so it renders without a backend.
let searchParams: { section?: string } = {};

vi.mock("@tanstack/react-router", () => ({
  useCanGoBack: () => false,
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn() } }),
  useSearch: () => searchParams,
}));

vi.mock("../../lib/queries", () => ({
  useRepos: () => ({ data: [{ name: "acme/app" }] }),
}));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ activeRepo: "acme/app", accent: "#000000" }),
}));

vi.mock("../../components/shell/Sidebar", () => ({ TRAFFIC_LIGHTS_INSET: 78 }));

// Each pane is a stub naming itself, so a click can be checked by what appears.
// The factories are inline because `vi.mock` is hoisted above any local helper.
vi.mock("./sections/Actions", () => ({
  ReviewActionSection: () => <div>Reviews pane</div>,
  TriageActionSection: () => <div>Triage pane</div>,
}));
vi.mock("./sections/Agents", () => ({
  ClaudeAgentSection: () => <div>Claude Code pane</div>,
  CodexAgentSection: () => <div>Codex pane</div>,
}));
vi.mock("./sections/EnglishTutor", () => ({
  EnglishTutorSection: () => <div>English tutor pane</div>,
}));
vi.mock("./sections/Environment", () => ({
  EnvironmentSection: () => <div>Environment pane</div>,
}));
vi.mock("./sections/General", () => ({ GeneralSection: () => <div>General pane</div> }));
vi.mock("./sections/GitHub", () => ({ GitHubSection: () => <div>GitHub pane</div> }));
vi.mock("./sections/Linear", () => ({ LinearSection: () => <div>Linear pane</div> }));
vi.mock("./sections/Prompts", () => ({ PromptsSection: () => <div>Prompts pane</div> }));
vi.mock("./sections/RepoLinear", () => ({ RepoLinearSection: () => <div>Repo Linear pane</div> }));
vi.mock("./sections/Terminal", () => ({ TerminalSection: () => <div>Terminal pane</div> }));
vi.mock("./sections/Usage", () => ({ UsageSection: () => <div>Usage pane</div> }));
vi.mock("./sections/Work", () => ({ WorkSection: () => <div>Work pane</div> }));

/** The nav item buttons under a group's heading. */
const groupItems = (group: string): string[] => {
  const heading = screen.getByRole("heading", { name: group, level: 2 });
  const section = heading.closest("section");
  if (!section) throw new Error(`"${group}" heading is not inside a section`);
  return within(section)
    .getAllByRole("button")
    .map((b) => b.textContent ?? "");
};

describe("Settings → nav", () => {
  beforeEach(() => {
    searchParams = {};
  });

  it("groups the two integrations under an Integrations heading", () => {
    render(<SettingsView />);
    expect(groupItems("Integrations")).toEqual(["Linear", "GitHub"]);
  });

  it("groups the two harnesses under an Agents heading", () => {
    render(<SettingsView />);
    expect(groupItems("Agents")).toEqual(["Claude Code", "Codex"]);
  });

  it("keeps Usage top-level rather than inside a group", () => {
    render(<SettingsView />);
    const usage = screen.getByRole("button", { name: "Usage" });
    expect(usage).toBeInTheDocument();
    expect(usage.closest("section")).toBeNull();
  });

  it("offers no Cursor or OpenCode harness", () => {
    render(<SettingsView />);
    expect(screen.queryByRole("button", { name: /cursor/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /opencode/i })).toBeNull();
  });

  it("opens the pane the nav item names", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(screen.getByText("GitHub pane")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("Codex pane")).toBeInTheDocument();
  });

  it("lands the retired ?section deep-links on their replacements", () => {
    searchParams = { section: "agents" };
    render(<SettingsView />);
    expect(screen.getByText("Claude Code pane")).toBeInTheDocument();

    searchParams = { section: "integrations" };
    render(<SettingsView />);
    expect(screen.getByText("Linear pane")).toBeInTheDocument();
  });

  it("swaps in the per-repo nav under the Repo scope", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: "Repo" }));

    // The repo scope keeps its own, shorter list — no app-level integrations or
    // harnesses, and the Linear item is the per-repo org picker.
    expect(screen.getByText("Repo Linear pane")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GitHub" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agents", level: 2 })).toBeNull();
    expect(groupItems("Workflow defaults")).toEqual(["Triage", "Work", "Reviews"]);
  });
});
