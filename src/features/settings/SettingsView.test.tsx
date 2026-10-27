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
  // RepoAvatar asks for a Daedalus project's icon; none here.
  useDaedalusIcon: () => ({ data: null, status: "success" }),
  useRepos: () => ({ data: [{ name: "acme/app" }] }),
}));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ accent: "#000000" }),
}));

vi.mock("../../components/shell/Sidebar", () => ({ TRAFFIC_LIGHTS_INSET: 78 }));

// Each pane is a stub naming itself, so a click can be checked by what appears.
// The factories are inline because `vi.mock` is hoisted above any local helper.
// Settings is outside the shell, so it carries the server banner itself.
vi.mock("../../components/shell/ServerBanner", () => ({
  ServerBanner: () => <div>server banner</div>,
}));
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
vi.mock("./sections/Daedalus", () => ({ DaedalusSection: () => <div>Daedalus pane</div> }));
vi.mock("./sections/Linear", () => ({ LinearSection: () => <div>Linear pane</div> }));
vi.mock("./sections/Jira", () => ({ JiraSection: () => <div>Jira pane</div> }));
vi.mock("./sections/TickTick", () => ({ TickTickSection: () => <div>TickTick pane</div> }));
vi.mock("./sections/Prompts", () => ({ PromptsSection: () => <div>Prompts pane</div> }));
vi.mock("./sections/RepoTracker", () => ({
  RepoTrackerSection: () => <div>Repo tracker pane</div>,
}));
vi.mock("./sections/Terminal", () => ({ TerminalSection: () => <div>Terminal pane</div> }));
vi.mock("./sections/Usage", () => ({ UsageSection: () => <div>Usage pane</div> }));
vi.mock("./sections/Web", () => ({ WebSection: () => <div>Web pane</div> }));
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

  it("shows the server banner: the shell that normally carries it is not around", () => {
    render(<SettingsView />);
    expect(screen.getByText("server banner")).toBeInTheDocument();
  });

  it("groups the user scope by what each provider is for", () => {
    render(<SettingsView />);
    expect(groupItems("Issue trackers")).toEqual(["Linear", "Jira", "TickTick"]);
    expect(groupItems("Code hosting")).toEqual(["GitHub", "Daedalus"]);
    expect(groupItems("AI harness")).toEqual(["Claude Code", "Codex"]);
    expect(groupItems("Environment")).toEqual(["Variables", "Terminal"]);
    expect(groupItems("Extra")).toEqual(["Web", "English tutor", "Usage"]);
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
    // harnesses, and the tracker item picks where its tickets come from.
    expect(screen.getByText("Repo tracker pane")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GitHub" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agents", level: 2 })).toBeNull();
    expect(groupItems("Workflow defaults")).toEqual(["Triage", "Work", "Reviews"]);
  });
});
