/**
 * A triage ticket's own agent tab, when its pane's session is lost: the click
 * asks the backend whether the session is free and only then relaunches the tab
 * in place, once; a refusal lets the held row go.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { WorktreeTab } from "../../bindings";

const check = vi.hoisted(() => vi.fn());
vi.mock("../../lib/queries", () => ({
  useCheckTabResume: (repo: string) => ({
    mutateAsync: (vars: unknown) => check(repo, vars),
  }),
}));
const terminals = vi.hoisted(() => ({
  heldRows: new Set<string>(),
  releaseRow: vi.fn(),
}));
vi.mock("../terminal/TerminalsContext", () => ({ useTerminals: () => terminals }));
const agentTab = vi.hoisted(() => ({
  preparing: false,
  ended: false,
  seed: "codex resume s1",
  onExited: vi.fn(),
  agent: { kind: "Codex", repo: "acme/web", termKey: "triage:AK-1:tab:t1" },
  resume: vi.fn(),
}));
vi.mock("../trees/useAgentTab", () => ({ useAgentTab: () => agentTab }));
const terminal = vi.hoisted(() => ({ onResume: undefined as undefined | (() => void) }));
vi.mock("./TriageTerminal", () => ({
  TriageTerminal: (props: { onResume?: () => void }) => {
    terminal.onResume = props.onResume;
    return <div data-testid="terminal" />;
  },
}));

import { TriageTabPane } from "./TriageTabPane";

const tab: WorktreeTab = {
  id: "t1",
  worktreeId: "triage:AK-1",
  kind: "agent",
  agentKind: "Codex",
  title: "Codex",
  pr: null,
  account: null,
  url: null,
};

const mount = () =>
  render(<TriageTabPane repo="acme/web" ticketId="AK-1" cwd="/src/web" tab={tab} />);

beforeEach(() => {
  vi.clearAllMocks();
  terminals.heldRows = new Set();
  agentTab.ended = false;
  terminal.onResume = undefined;
});

describe("TriageTabPane", () => {
  test("Resume asks the backend about this tab, then relaunches it once", async () => {
    check.mockResolvedValue(null);
    mount();
    expect(check).not.toHaveBeenCalled();
    await act(async () => terminal.onResume?.());
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("acme/web", { owner: "triage:AK-1", tabId: "t1" });
    expect(agentTab.resume).toHaveBeenCalledTimes(1);
    expect(terminals.releaseRow).not.toHaveBeenCalled();
  });

  test("a refusal relaunches nothing and lets the row go", async () => {
    check.mockRejectedValue(new Error("Terminals are still reconnecting"));
    mount();
    await act(async () => terminal.onResume?.());
    expect(agentTab.resume).not.toHaveBeenCalled();
    expect(terminals.releaseRow).toHaveBeenCalledWith("triage:AK-1:tab:t1");
  });

  test("after a refusal the released row mounts no terminal while it goes", async () => {
    check.mockRejectedValue(new Error("That session is still running in another tab."));
    agentTab.ended = true;
    terminals.heldRows = new Set(["triage:AK-1:tab:t1"]);
    const { rerender } = mount();
    expect(screen.queryByTestId("terminal")).toBeNull();
    // The pane hands its Resume over before it closes; call it as the layer did.
    agentTab.ended = false;
    rerender(<TriageTabPane repo="acme/web" ticketId="AK-1" cwd="/src/web" tab={tab} />);
    await act(async () => terminal.onResume?.());
    agentTab.ended = true;
    terminals.heldRows = new Set();
    rerender(<TriageTabPane repo="acme/web" ticketId="AK-1" cwd="/src/web" tab={tab} />);
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  test("between the lost pane closing and the relaunch, no terminal is mounted", () => {
    agentTab.ended = true;
    terminals.heldRows = new Set(["triage:AK-1:tab:t1"]);
    mount();
    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(screen.getByText("Resuming…")).toBeInTheDocument();
  });
});
