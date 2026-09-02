/**
 * What the view owns on its own: which ticket the route names against which
 * the queue holds, the focus handoff's timing against that route, and the one
 * gate every launch goes through.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentKind, TriageTicket } from "../../bindings";
import { triageTicket } from "../../test/fixtures";

const state = vi.hoisted(() => ({
  search: undefined as string | undefined,
  queue: [] as TriageTicket[],
  loading: false,
  focus: null as { ticket: string; agent?: AgentKind } | null,
  consumeTriageFocus: vi.fn(),
  requestTriageFocus: vi.fn(),
  repo: "acme/app" as string | null,
  repoLoading: false,
  setRepo: vi.fn(),
  openAgent: vi.fn(),
  active: "linear" as string,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({ ticket: state.search }),
}));
vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ triageEnabled: true }),
  useAppUi: () => ({
    triageFocus: state.focus,
    consumeTriageFocus: state.consumeTriageFocus,
    requestTriageFocus: state.requestTriageFocus,
  }),
}));
vi.mock("../../lib/queries", () => ({
  INVESTIGATE_AGENT_KEY: "investigate.agent",
  useTriageOrgRepo: () => "acme/app",
  useTriageQueue: () => ({
    active: state.queue,
    snoozed: [],
    goodCitizen: false,
    loading: state.loading,
  }),
  useTriageRepo: () => ({
    repo: state.repo,
    attached: false,
    defaultRepo: state.repo,
    loading: state.repoLoading,
    setRepo: state.setRepo,
  }),
  useResolvedSetting: () => ({ data: null }),
  useSetting: () => ({ data: null }),
  useTriageDetail: () => ({ data: undefined }),
  useRepos: () => ({ data: [{ name: "acme/app", path: "/src/app" }] }),
}));
// The page and the panes are their own tests; here they are the slots the
// view fills. The page renders its host action so the gate can be driven.
vi.mock("../../components/IssuePage", () => ({
  IssuePage: ({ actions }: { actions: ReactNode }) => <div data-testid="issue-page">{actions}</div>,
}));
vi.mock("../../components/IssueDiscussion", () => ({
  DiscussionSkeleton: () => <div data-testid="skeleton" />,
}));
vi.mock("./InvestigatePane", () => ({
  InvestigatePane: ({ agentKind }: { agentKind: AgentKind }) => (
    <div data-testid="investigate">{agentKind}</div>
  ),
}));
vi.mock("./TriageTerminal", () => ({ TriageTerminal: () => <div data-testid="shell" /> }));
vi.mock("./TriageSidePanel", () => ({
  DEFAULT_W: 400,
  TriageSidePanel: () => <aside data-testid="rail" />,
}));
vi.mock("./TriageTabBar", () => ({ TriageTabBar: () => <div data-testid="tab-bar" /> }));
vi.mock("./useTriageTabs", () => ({
  agentTabKind: (tab: string) => (tab.startsWith("agent:") ? tab.slice("agent:".length) : null),
  useTriageTabs: () => ({
    active: state.active,
    select: vi.fn(),
    providers: [],
    hasStored: () => false,
    openAgent: state.openAgent,
    closeAgent: vi.fn(),
    hasShell: false,
    openShell: vi.fn(),
    closeShell: vi.fn(),
  }),
}));

import { TriageView } from "./TriageView";

const ticket = (id: string) => triageTicket(id);

describe("TriageView", () => {
  beforeEach(() => {
    state.search = undefined;
    state.queue = [ticket("AK-1"), ticket("AK-2")];
    state.loading = false;
    state.focus = null;
    state.repo = "acme/app";
    state.repoLoading = false;
    state.active = "linear";
    state.consumeTriageFocus.mockClear();
    state.requestTriageFocus.mockClear();
    state.setRepo.mockClear();
    state.openAgent.mockClear();
  });

  it("opens the ticket the route names", () => {
    state.search = "AK-2";
    render(<TriageView />);
    expect(screen.getByTestId("issue-page")).toBeInTheDocument();
    expect(screen.getByTestId("rail")).toBeInTheDocument();
  });

  /** Named by the route but not in the queue: snoozed out by a filter, or
   *  triaged since. Saying which beats a generic "pick one" beside a sidebar
   *  with nothing lit. */
  it("says which ticket is no longer in triage", () => {
    state.search = "AK-9";
    render(<TriageView />);
    expect(screen.getByText("AK-9 is no longer in triage")).toBeInTheDocument();
  });

  it("does not call a ticket gone while the queue is still loading", () => {
    state.search = "AK-9";
    state.loading = true;
    render(<TriageView />);
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/no longer in triage/)).toBeNull();
  });

  /** The regression: the search param lags a navigation by a render, so the
   *  "drop a focus the queue can't land" effect saw the PREVIOUS ticket in the
   *  route and consumed B's focus before B's workspace ever mounted. */
  it("keeps a focus for another ticket until the route names it, then lands on its tab", async () => {
    state.search = "AK-1";
    state.focus = { ticket: "AK-2", agent: "Codex" };
    const { rerender } = render(<TriageView />);
    expect(state.consumeTriageFocus).not.toHaveBeenCalled();
    expect(state.openAgent).not.toHaveBeenCalled();

    // The route catches up.
    state.search = "AK-2";
    rerender(<TriageView />);

    await waitFor(() => expect(state.openAgent).toHaveBeenCalledWith("Codex"));
    expect(state.consumeTriageFocus).toHaveBeenCalledTimes(1);
  });

  it("drops a focus for a ticket the queue does not hold, once the route names it", () => {
    state.search = "AK-9";
    state.focus = { ticket: "AK-9", agent: "Codex" };
    render(<TriageView />);
    expect(state.consumeTriageFocus).toHaveBeenCalledTimes(1);
    expect(state.openAgent).not.toHaveBeenCalled();
  });

  it("holds a handoff until the ticket's project is known", async () => {
    state.search = "AK-1";
    state.focus = { ticket: "AK-1", agent: "Claude" };
    state.repoLoading = true;
    const { rerender } = render(<TriageView />);
    expect(state.consumeTriageFocus).not.toHaveBeenCalled();

    state.repoLoading = false;
    rerender(<TriageView />);
    await waitFor(() => expect(state.openAgent).toHaveBeenCalledWith("Claude"));
    expect(state.consumeTriageFocus).toHaveBeenCalledTimes(1);
  });

  /** Every launch goes through one gate: with no project the button asks, a
   *  pick attaches and then runs, and a cancel runs nothing. */
  it("asks for a project before the first launch, and runs on the pick", async () => {
    state.search = "AK-1";
    state.repo = null;
    render(<TriageView />);

    fireEvent.click(screen.getByRole("button", { name: /Investigate with/ }));
    expect(state.openAgent).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Attach a project" });
    expect(dialog).toHaveTextContent(/Investigating with Codex needs a project/);

    fireEvent.click(screen.getByRole("option", { name: /app/ }));
    expect(state.setRepo).toHaveBeenCalledWith("acme/app", { asDefault: false });
    await waitFor(() => expect(state.openAgent).toHaveBeenCalledWith("Codex"));
  });

  it("runs nothing when the ask is cancelled", async () => {
    state.search = "AK-1";
    state.repo = null;
    render(<TriageView />);

    fireEvent.click(screen.getByRole("button", { name: /Investigate with/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.openAgent).not.toHaveBeenCalled();
    expect(state.setRepo).not.toHaveBeenCalled();
  });

  it("launches straight away once a project is attached", () => {
    state.search = "AK-1";
    render(<TriageView />);
    fireEvent.click(screen.getByRole("button", { name: /Investigate with/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.openAgent).toHaveBeenCalledWith("Codex");
  });

  /** A pane that spawned before the project's path was known would spawn a
   *  cwd-less shell, and the orchestrator would then hand every later mount
   *  that same pane instead of the agent. */
  it("holds an investigation pane until the project's path is known", () => {
    state.search = "AK-1";
    state.active = "agent:Codex";
    state.repoLoading = true;
    const { rerender } = render(<TriageView />);
    expect(screen.queryByTestId("investigate")).toBeNull();
    expect(screen.getByRole("status", { name: "Attaching the project…" })).toBeInTheDocument();

    state.repoLoading = false;
    rerender(<TriageView />);
    expect(screen.getByTestId("investigate")).toHaveTextContent("Codex");
  });
});
