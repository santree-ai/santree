/**
 * A Trees agent tab (and a review checkout's, which is the same pane) whose
 * session is lost: Resume relaunches the tab where it is, on the click, once.
 *
 * The assembled path — the real layer, the strip's `useTabSessions` and the
 * pane — because the bug was in the hand-over between them: the pane closing
 * pruned the row, the row's removal deleted the conversation's binding, and the
 * reopen that followed looked the conversation up by that binding. It found it
 * only while the worktree's sessions were still cached; a fresh read lists a
 * pruned tab's conversation with no key. Nothing here reads that list: the row
 * is kept, so the relaunch finds the conversation still bound to it.
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { PaneLink, Worktree, WorktreeTab } from "../../bindings";
import type { LayerWorld } from "../terminal/testing";
import type { OutputHandlers } from "../terminal/types";

const openAgent = vi.hoisted(() => vi.fn());
vi.mock("../agents/useOpenAgent", () => ({ useOpenAgent: () => openAgent }));
const check = vi.hoisted(() => vi.fn());
const world = vi.hoisted((): LayerWorld => ({ repos: [], server: undefined }));
vi.mock("../../lib/queries", async () => ({
  ...(await import("../terminal/testing")).layerQueries(world),
  useCheckTabResume: (repo: string) => ({
    mutateAsync: (vars: unknown) => check(repo, vars),
  }),
  useWorktreeTabLaunch: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../terminal/TauriBackend", async () => ({
  tauriBackend: (await import("../terminal/testing")).fakeTauriBackend(),
}));
vi.mock("../terminal/XtermRenderer", async () => ({
  XtermRenderer: (await import("../terminal/testing")).FakeXtermRenderer,
}));
vi.mock("../../state/AgentRuns", () => ({ useAgentRuns: () => ({ clearAgentLaunch: vi.fn() }) }));
vi.mock("./model", () => ({ remoteControlTab: () => null }));
vi.mock("./useWorkLaunch", () => ({
  useWorkLaunch: () => ({ launching: false, initialSetup: false, hold: false, prompt: undefined }),
}));
// The launch pipeline's own state, kept to what the pane reads: `ended` once a
// pane it saw is gone, and `resume` re-arming the launch.
const relaunch = vi.hoisted(() => vi.fn());
vi.mock("./useAgentTab", async () => {
  const { useEffect, useState } = await import("react");
  const { useTerminals } = await import("../terminal/TerminalsContext");
  return {
    useAgentTab: ({ refId }: { refId: string }) => {
      const live = useTerminals().tabs.some((t) => t.refId === refId);
      const [seen, setSeen] = useState(false);
      useEffect(() => {
        if (live) setSeen(true);
      }, [live]);
      return {
        preparing: false,
        ended: seen && !live,
        seed: "codex resume s1",
        onExited: () => {},
        agent: { kind: "Codex", repo: "acme/web", termKey: refId },
        resume: () => {
          relaunch();
          setSeen(false);
        },
      };
    },
  };
});

import { toast } from "../../state/toast";
import { tauriBackend } from "../terminal/TauriBackend";
import { TerminalLayer } from "../terminal/TerminalLayer";
import { resetAdoption, TerminalsProvider, useTerminals } from "../terminal/TerminalsContext";
import { AgentTabPane } from "./AgentTabPane";
import { useTabSessions } from "./useTabSessions";

const backend = vi.mocked(tauriBackend);

const ROW: WorktreeTab = {
  id: "t1",
  worktreeId: "wt1",
  kind: "agent",
  agentKind: "Codex",
  title: "Codex",
  pr: null,
  account: null,
  url: null,
};
const WORKTREE = { id: "wt1", path: "/src/web-wt1", title: "wt1" } as Worktree;

function TabCount() {
  const { tabs, heldRows } = useTerminals();
  return (
    <>
      <output data-testid="tabs">{tabs.length}</output>
      <output data-testid="held">{heldRows.size}</output>
    </>
  );
}

/** A worktree's strip and the agent tab it shows. */
function Strip({ closeTab }: { closeTab: (id: string) => void }) {
  const { closeWithSession } = useTabSessions("wt1", [ROW], closeTab);
  return (
    <>
      <button type="button" onClick={() => closeWithSession(ROW)}>
        Close tab
      </button>
      <AgentTabPane repo="acme/web" worktree={WORKTREE} tab={ROW} tabs={[ROW]} />
    </>
  );
}

const mountLost = async (closeTab: (id: string) => void) => {
  const tree = () => (
    <TerminalsProvider>
      <Strip closeTab={closeTab} />
      <TabCount />
      <TerminalLayer />
    </TerminalsProvider>
  );
  const utils = render(tree());
  await waitFor(() => expect(backend.open).toHaveBeenCalledTimes(1));
  const handlers = backend.open.mock.calls[0][1] as OutputHandlers;
  await act(async () => {});
  act(() => handlers.onLink?.("lost" satisfies PaneLink));
  return { ...utils, again: () => utils.rerender(tree()) };
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAdoption();
  world.server = undefined;
});

describe("a lost Trees agent tab", () => {
  test("nothing happens until the click; one click resumes it once, in place, and the tab stays", async () => {
    check.mockResolvedValue(null);
    const closeTab = vi.fn();
    const { findByRole, getByTestId, again } = await mountLost(closeTab);
    // Nothing happens without the click: no check, no relaunch, no prune.
    await findByRole("alert");
    await new Promise((r) => setTimeout(r, 50));
    expect(check).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();

    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("acme/web", { owner: "wt1", tabId: "t1" });
    // The tab relaunches its own pane, on the same key.
    await waitFor(() => expect(backend.open).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getByTestId("tabs")).toHaveTextContent("1"));
    // The row was never pruned, and nothing went looking for the conversation
    // through the sidebar's reopen.
    expect(closeTab).not.toHaveBeenCalled();
    expect(openAgent).not.toHaveBeenCalled();

    again();
    await new Promise((r) => setTimeout(r, 50));
    expect(check).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(backend.open).toHaveBeenCalledTimes(2);
  });

  test("a refusal relaunches nothing and lets the row go", async () => {
    check.mockRejectedValue(new Error("That session is still running in another tab."));
    const closeTab = vi.fn();
    const { findByRole } = await mountLost(closeTab);
    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("t1"));
    expect(relaunch).not.toHaveBeenCalled();
    expect(backend.open).toHaveBeenCalledTimes(1);
    expect(openAgent).not.toHaveBeenCalled();
  });

  test("a relaunch that throws after the check lets the row go and says why", async () => {
    check.mockResolvedValue(null);
    relaunch.mockImplementationOnce(() => {
      throw new Error("could not relaunch");
    });
    const error = vi.spyOn(toast, "error");
    const closeTab = vi.fn();
    const { findByRole, getByTestId } = await mountLost(closeTab);
    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("t1"));
    expect(getByTestId("held")).toHaveTextContent("0");
    expect(error).toHaveBeenCalledWith("could not relaunch");
    expect(backend.open).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  test("closing the tab while its resume is being checked ends the hold", async () => {
    check.mockReturnValue(new Promise(() => {}));
    const closeTab = vi.fn();
    const { findByRole, getByRole, getByTestId } = await mountLost(closeTab);
    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(getByTestId("held")).toHaveTextContent("1"));
    fireEvent.click(getByRole("button", { name: "Close tab" }));
    expect(closeTab).toHaveBeenCalledWith("t1");
    await waitFor(() => expect(getByTestId("held")).toHaveTextContent("0"));
  });
});
