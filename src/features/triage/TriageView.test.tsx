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
  focus: null as { ticket: string; agent?: AgentKind; tab?: string } | null,
  consumeTriageFocus: vi.fn(),
  requestTriageFocus: vi.fn(),
  repo: "acme/app" as string | null,
  repoLoading: false,
  setRepo: vi.fn(),
  openAgent: vi.fn(),
  select: vi.fn(),
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
  useAgentAuth: () => ({ data: { connected: true } }),
  useCodexAccount: () => ({ data: { connected: true } }),
  useCodexHealth: () => ({ data: { available: true } }),
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
vi.mock("./TriageTabPane", () => ({ TriageTabPane: () => <div data-testid="tab-pane" /> }));
vi.mock("./TriageSidePanel", () => ({
  DEFAULT_W: 400,
  TriageSidePanel: () => <aside data-testid="rail" />,
}));
vi.mock("./TriageTabBar", () => ({ TriageTabBar: () => <div data-testid="tab-bar" /> }));
vi.mock("./useTriageTabs", () => ({
  agentTabKind: (tab: string) => (tab.startsWith("agent:") ? tab.slice("agent:".length) : null),
  rowTab: (id: string) => `tab:${id}`,
  rowTabId: (tab: string) => (tab.startsWith("tab:") ? tab.slice("tab:".length) : null),
  useTriageTabs: () => ({
    active: state.active,
    select: state.select,
    providers: [],
    hasStored: () => false,
    openAgent: state.openAgent,
    closeAgent: vi.fn(),
    rows: [],
    addTab: vi.fn(),
    closeTab: vi.fn(),
    renameTab: vi.fn(),
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
    state.select.mockClear();
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

  /** A sidebar row for one of the ticket's own tabs names the row, not a
   *  provider: it is selected, never launched — the row is stored, and the
   *  strip resolves to it once the rows land. */
  it("lands a focus that names a row on that row", async () => {
    state.search = "AK-1";
    state.focus = { ticket: "AK-1", tab: "6f9a" };
    render(<TriageView />);
    await waitFor(() => expect(state.select).toHaveBeenCalledWith("tab:6f9a"));
    expect(state.openAgent).not.toHaveBeenCalled();
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

  /** The main tab strip and the rail's own icon strip are both `CHROME.subBar`
   *  tall and are meant to sit side by side on one baseline — see `CHROME`,
   *  which says so. That only holds if they are siblings in a row. Triage put
   *  the strip in a column *above* the row that held the rail, so the strip
   *  stretched across the rail as well and pushed the rail's icons onto a
   *  second line; the two never lined up, unlike Trees and Reviews.
   *
   *  Asserted structurally rather than visually because jsdom computes no
   *  layout — and structure is what was actually wrong: in the broken shape the
   *  strip's own parent contains the rail. */
  it("keeps the tab strip beside the rail, not stretched over it", () => {
    state.search = "AK-1";
    render(<TriageView />);
    const strip = screen.getByTestId("tab-bar");
    const rail = screen.getByTestId("rail");
    // The strip's column is the content area only — the rail is outside it…
    expect(strip.parentElement).not.toContainElement(rail);
    // …and beside it, in the row they share.
    expect(strip.parentElement?.parentElement).toContainElement(rail);
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
