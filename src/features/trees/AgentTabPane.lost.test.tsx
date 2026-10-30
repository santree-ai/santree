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
 *
 * Also the same path under the Terminal/Conversation switch, which has to leave
 * the terminal — and the launch behind it — exactly as it was.
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
/** Settings → Experimental → Conversation view, dialled per test. */
const conversation = vi.hoisted(() => ({ on: true }));
vi.mock("../../lib/queries", async () => ({
  ...(await import("../terminal/testing")).layerQueries(world),
  useCheckTabResume: (repo: string) => ({
    mutateAsync: (vars: unknown) => check(repo, vars),
  }),
  useWorktreeTabLaunch: () => ({ data: undefined, isLoading: false }),
  // Which face a Claude tab opens on: never set, so its terminal.
  CLAUDE_TAB_FACE_KEY: "claude_tab_face",
  useSetting: () => ({ data: null }),
  useExperimental: (feature: string) => feature !== "Conversation" || conversation.on,
}));
vi.mock("../terminal/TauriBackend", async () => ({
  tauriBackend: (await import("../terminal/testing")).fakeTauriBackend(),
}));
vi.mock("../terminal/XtermRenderer", async () => ({
  XtermRenderer: (await import("../terminal/testing")).FakeXtermRenderer,
}));
const clearAgentLaunch = vi.hoisted(() => vi.fn());
vi.mock("../../state/AgentRuns", () => ({ useAgentRuns: () => ({ clearAgentLaunch }) }));
vi.mock("../conversation/ConversationView", () => ({
  ConversationView: () => <div data-testid="conversation" />,
}));
vi.mock("./model", () => ({ remoteControlTab: () => null }));
vi.mock("./useWorkLaunch", () => ({
  useWorkLaunch: () => ({ launching: false, initialSetup: false, hold: false, prompt: undefined }),
}));
// The launch pipeline's own state, kept to what the pane reads: `ended` once a
// pane it saw is gone, and `resume` re-arming the launch.
const relaunch = vi.hoisted(() => vi.fn());
const exited = vi.hoisted(() => vi.fn());
vi.mock("./useAgentTab", async () => {
  const { useEffect, useState } = await import("react");
  const { useTerminals } = await import("../terminal/TerminalsContext");
  return {
    useAgentTab: ({ refId, agent }: { refId: string; agent: string }) => {
      const live = useTerminals().tabs.some((t) => t.refId === refId);
      const [seen, setSeen] = useState(false);
      useEffect(() => {
        if (live) setSeen(true);
      }, [live]);
      return {
        preparing: false,
        ended: seen && !live,
        seed: "codex resume s1",
        onExited: exited,
        agent: { kind: agent, repo: "acme/web", termKey: refId },
        resume: () => {
          relaunch();
          setSeen(false);
        },
      };
    },
  };
});

import { toast } from "../../state/toast";
import { setAgentTabView } from "../conversation/viewMode";
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
  world.repos = [];
  conversation.on = true;
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

describe("switching an agent tab between its terminal and its conversation", () => {
  // The terminal used to be keyed by the face, so every switch remounted it: its
  // launch cleanup (`clearAgentLaunch`, which can drop a sibling tab's pending
  // started-task launch) ran again, and it was the remount that kept the exit
  // latch working. Settings → Experimental's switch is the same kind of move:
  // off, the tab shows its terminal whatever face it chose, and keeps the choice.
  test("leaves the terminal mounted: the launch is cleaned up once, and its exit is still seen", async () => {
    world.repos = [{ name: "acme/web", location: "Local", path: "/src/web" }];
    const row: WorktreeTab = { ...ROW, id: "t2", agentKind: "Claude", title: "Claude" };
    const tree = () => (
      <TerminalsProvider>
        <AgentTabPane repo="acme/web" worktree={WORKTREE} tab={row} tabs={[row]} />
        <TabCount />
        <TerminalLayer />
      </TerminalsProvider>
    );
    const { getByTestId, queryByTestId, rerender } = render(tree());
    await waitFor(() => expect(backend.seed).toHaveBeenCalledTimes(1));
    expect(clearAgentLaunch).toHaveBeenCalledTimes(1);

    for (const face of ["conversation", "terminal", "conversation"] as const) {
      act(() => setAgentTabView("tree:wt1:tab:t2", face));
      await act(async () => {});
    }
    expect(getByTestId("conversation")).toBeInTheDocument();

    conversation.on = false;
    rerender(tree());
    await act(async () => {});
    expect(queryByTestId("conversation")).not.toBeInTheDocument();
    conversation.on = true;
    rerender(tree());
    await act(async () => {});
    expect(getByTestId("conversation")).toBeInTheDocument();
    expect(clearAgentLaunch).toHaveBeenCalledTimes(1);
    expect(backend.open).toHaveBeenCalledTimes(1);
    expect(backend.seed).toHaveBeenCalledTimes(1);

    // The agent exits while its conversation is up: that is seen, and a switch
    // after it opens nothing — only a click relaunches an agent.
    act(() => (backend.open.mock.calls[0][1] as OutputHandlers).onExit());
    await waitFor(() => expect(getByTestId("tabs")).toHaveTextContent("0"));
    expect(exited).toHaveBeenCalledTimes(1);
    act(() => setAgentTabView("tree:wt1:tab:t2", "terminal"));
    await act(async () => {});
    expect(backend.open).toHaveBeenCalledTimes(1);
  });
});
