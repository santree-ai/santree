/**
 * What a `lost` pane's two buttons do once the layer has wired them. The view's
 * own rendering is pinned in `TerminalView.test.tsx`; what matters here is the
 * assembled path — Close goes through the tab's one close path, and Resume is a
 * click that hands the agent to the same "open this agent" route the sidebar
 * uses, with nothing starting before the click.
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { PaneLink } from "../../bindings";
import type { LayerWorld } from "./testing";
import type { OutputHandlers } from "./types";

const openAgent = vi.hoisted(() => vi.fn());
vi.mock("../agents/useOpenAgent", () => ({ useOpenAgent: () => openAgent }));
const world = vi.hoisted((): LayerWorld => ({ repos: [], server: undefined }));
vi.mock("../../lib/queries", async () => (await import("./testing")).layerQueries(world));
vi.mock("./TauriBackend", async () => ({
  tauriBackend: (await import("./testing")).fakeTauriBackend(),
}));
vi.mock("./XtermRenderer", async () => ({
  XtermRenderer: (await import("./testing")).FakeXtermRenderer,
}));

import type { WorktreeTab } from "../../bindings";
import { useTabSessions } from "../trees/useTabSessions";
import type { TerminalTabs } from "./orchestrator";
import { tauriBackend } from "./TauriBackend";
import { TerminalLayer } from "./TerminalLayer";
import { resetAdoption, TerminalsProvider, useTerminals } from "./TerminalsContext";
import { useEmbeddedTerminal } from "./useEmbeddedTerminal";

const backend = vi.mocked(tauriBackend);

/** Opens a pane the way a view does. */
function Opener({ refId, agent }: { refId: string; agent?: boolean }) {
  const { ensure } = useTerminals();
  useLayoutEffect(() => {
    ensure({
      title: refId,
      source: "issue",
      refId,
      agent: agent ? { kind: "Codex", repo: "acme/web", termKey: refId } : undefined,
    });
  }, [ensure, refId, agent]);
  return null;
}

/** Opens a pane the way a surface with its own "session ended" offer does: its
 *  embed carries the surface's Resume. */
function SurfaceHost({ refId, onResume }: { refId: string; onResume: () => void }) {
  const { hostRef } = useEmbeddedTerminal({
    spec: {
      title: refId,
      source: "triage",
      refId,
      agent: { kind: "Codex", repo: "acme/web", termKey: refId },
    },
    onResume,
  });
  return <div ref={hostRef} />;
}

function TabCount() {
  const { tabs } = useTerminals();
  return <output data-testid="tabs">{tabs.length}</output>;
}

const tree = (refId: string, agent: boolean) => (
  <TerminalsProvider>
    <Opener refId={refId} agent={agent} />
    <TabCount />
    <TerminalLayer />
  </TerminalsProvider>
);

const mountLost = async (refId: string, agent: boolean) => {
  const utils = render(tree(refId, agent));
  await waitFor(() => expect(backend.open).toHaveBeenCalled());
  const handlers = backend.open.mock.calls[0][1] as OutputHandlers;
  // The pane's handle registers once its session is open; `close` needs it.
  await act(async () => {});
  act(() => handlers.onLink?.("lost" satisfies PaneLink));
  return { ...utils, again: () => utils.rerender(tree(refId, agent)) };
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAdoption();
  world.server = undefined;
});

/** A surface's pane, embedded and gone `lost`. */
const mountLostSurface = async (refId: string, onResume: () => void) => {
  const tree = () => (
    <TerminalsProvider>
      <SurfaceHost refId={refId} onResume={onResume} />
      <TabCount />
      <TerminalLayer />
    </TerminalsProvider>
  );
  const utils = render(tree());
  await waitFor(() => expect(backend.open).toHaveBeenCalled());
  const handlers = backend.open.mock.calls[0][1] as OutputHandlers;
  await act(async () => {});
  act(() => handlers.onLink?.("lost" satisfies PaneLink));
  return { ...utils, again: () => utils.rerender(tree()) };
};

const ROW_KEY = "triage:AK-1:tab:t1";
const ROW: WorktreeTab = {
  id: "t1",
  worktreeId: "triage:AK-1",
  kind: "agent",
  agentKind: "Codex",
  title: "Codex",
  pr: null,
  account: null,
  url: null,
};

let registry: TerminalTabs;
/** A triage ticket's own agent tab: a row its strip keeps in step with the pane
 *  (`useTabSessions`), and a pane whose embed carries the tab's own Resume. */
function RowSurface({
  onResume,
  closeTab,
}: {
  onResume: () => void;
  closeTab: (id: string) => void;
}) {
  registry = useTerminals();
  useTabSessions("triage:AK-1", [ROW], closeTab);
  const { hostRef } = useEmbeddedTerminal({
    spec: {
      title: "Codex",
      source: "triage",
      refId: ROW_KEY,
      agent: { kind: "Codex", repo: "acme/web", termKey: ROW_KEY },
    },
    onResume,
  });
  return <div ref={hostRef} />;
}

const mountLostRow = async (onResume: () => void, closeTab: (id: string) => void) => {
  const tree = () => (
    <TerminalsProvider>
      <RowSurface onResume={onResume} closeTab={closeTab} />
      <TabCount />
      <TerminalLayer />
    </TerminalsProvider>
  );
  const utils = render(tree());
  await waitFor(() => expect(backend.open).toHaveBeenCalled());
  const handlers = backend.open.mock.calls[0][1] as OutputHandlers;
  await act(async () => {});
  act(() => handlers.onLink?.("lost" satisfies PaneLink));
  return { ...utils, again: () => utils.rerender(tree()) };
};

describe("a lost triage tab", () => {
  test("one click resumes it once, in place: the row survives the pane closing", async () => {
    const onResume = vi.fn();
    const closeTab = vi.fn();
    const { getByTestId, findByRole, again } = await mountLostRow(onResume, closeTab);
    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(getByTestId("tabs")).toHaveTextContent("0"));
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    // Neither the sidebar's reopen (which would select a deleted row) nor a
    // second resume.
    expect(openAgent).not.toHaveBeenCalled();
    again();
    await new Promise((r) => setTimeout(r, 50));
    expect(onResume).toHaveBeenCalledTimes(1);
    // The row, and the conversation bound to it, are kept for the relaunch.
    expect(closeTab).not.toHaveBeenCalled();
    expect(registry.heldRows.has(ROW_KEY)).toBe(true);

    // The relaunch opens the tab's pane again: the hold ends, and the row is
    // the tab's again — its next exit closes it as any other.
    act(() => {
      registry.ensure({
        title: "Codex",
        source: "triage",
        refId: ROW_KEY,
        agent: { kind: "Codex", repo: "acme/web", termKey: ROW_KEY },
      });
    });
    expect(registry.heldRows.has(ROW_KEY)).toBe(false);
    await waitFor(() => expect(getByTestId("tabs")).toHaveTextContent("1"));
    expect(closeTab).not.toHaveBeenCalled();
    const relaunched = registry.tabs[0].key;
    act(() => registry.close(relaunched));
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("t1"));
  });

  test("a refused resume lets the row go the way a closed pane's does", async () => {
    const onResume = vi.fn();
    const closeTab = vi.fn();
    const { findByRole } = await mountLostRow(onResume, closeTab);
    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(closeTab).not.toHaveBeenCalled();
    act(() => registry.releaseRow(ROW_KEY));
    await waitFor(() => expect(closeTab).toHaveBeenCalledTimes(1));
    expect(closeTab).toHaveBeenCalledWith("t1");
  });

  test("Close still closes the row", async () => {
    const closeTab = vi.fn();
    const { findByRole } = await mountLostRow(vi.fn(), closeTab);
    fireEvent.click(await findByRole("button", { name: "Close this terminal" }));
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("t1"));
    expect(registry.heldRows.size).toBe(0);
  });
});

describe("a lost pane in the layer", () => {
  test("does nothing by itself: the tab stays, nothing is closed or resumed", async () => {
    const { getByTestId, findByRole } = await mountLost("tree:AK-1:tab:t1", true);
    await findByRole("alert");
    await new Promise((r) => setTimeout(r, 250));
    expect(getByTestId("tabs")).toHaveTextContent("1");
    expect(backend.close).not.toHaveBeenCalled();
    expect(backend.seed).not.toHaveBeenCalled();
    expect(openAgent).not.toHaveBeenCalled();
  });

  test("Close ends the tab through the one close path", async () => {
    const { getByTestId, findByRole } = await mountLost("tree:AK-1:tab:t1", true);
    fireEvent.click(await findByRole("button", { name: "Close this terminal" }));
    await waitFor(() => expect(getByTestId("tabs")).toHaveTextContent("0"));
    expect(backend.close).toHaveBeenCalledWith(7);
    expect(openAgent).not.toHaveBeenCalled();
  });

  test("Resume closes the dead pane, then opens the agent as the sidebar would — on the click", async () => {
    const { getByTestId, findByRole } = await mountLost("tree:AK-1:tab:t1", true);
    expect(openAgent).not.toHaveBeenCalled();
    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(getByTestId("tabs")).toHaveTextContent("0"));
    await waitFor(() => expect(openAgent).toHaveBeenCalledTimes(1));
    expect(openAgent).toHaveBeenCalledWith({
      repo: "acme/web",
      origin: { kind: "tree-tab", ticket: "AK-1", tabId: "t1", pr: null },
      agentKind: "Codex",
    });
  });

  test("a plain shell has Close and no Resume", async () => {
    const { findByRole, queryByRole } = await mountLost("tree:AK-1:tab:t2", false);
    await findByRole("alert");
    expect(queryByRole("button", { name: "Resume this session" })).toBeNull();
    expect(queryByRole("button", { name: "Close this terminal" })).not.toBeNull();
  });

  test("an agent with no tab row (a surface's own session) opens as soon as the pane is gone", async () => {
    const { getByTestId, findByRole } = await mountLost("triage:AK-1", true);
    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(getByTestId("tabs")).toHaveTextContent("0"));
    await waitFor(() => expect(openAgent).toHaveBeenCalledTimes(1));
  });

  test("a surface's own agent hands its click to the surface, once, so the ended pane does not ask again", async () => {
    const surfaceResume = vi.fn();
    const { getByTestId, findByRole, again } = await mountLostSurface("triage:AK-1", surfaceResume);
    await findByRole("alert");
    // No click, no resume.
    await new Promise((r) => setTimeout(r, 100));
    expect(surfaceResume).not.toHaveBeenCalled();

    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await waitFor(() => expect(getByTestId("tabs")).toHaveTextContent("0"));
    await waitFor(() => expect(surfaceResume).toHaveBeenCalledTimes(1));
    // The surface resumes it; the sidebar's open is not asked as well.
    expect(openAgent).not.toHaveBeenCalled();
    // Once: later renders do not hand it over again.
    again();
    await new Promise((r) => setTimeout(r, 50));
    expect(surfaceResume).toHaveBeenCalledTimes(1);
  });

  /** Only a server that is running (or a build without one) can take a
   *  resumed agent; while it is anything else the click would launch into a
   *  host that cannot hold it, so the tab is kept and the reason said. */
  test("Resume is available only while the server is running or off", async () => {
    for (const kind of ["Down", "Failing", "Starting", "Stopping", "Running", "Off"]) {
      world.server = { state: { kind } } as LayerWorld["server"];
      const { findByRole, unmount } = await mountLost("tree:AK-1:tab:t1", true);
      const resume = await findByRole("button", { name: "Resume this session" });
      if (kind === "Running" || kind === "Off") {
        expect(resume, kind).toBeEnabled();
      } else {
        expect(resume, kind).toBeDisabled();
        // The reason is said beside it, and the button points at it.
        const hint = document.getElementById(resume.getAttribute("aria-describedby") ?? "");
        expect(hint?.textContent, kind).toMatch(/server/);
      }
      unmount();
      vi.clearAllMocks();
      resetAdoption();
    }
  });

  test("a click on a blocked Resume keeps the tab and starts nothing", async () => {
    world.server = { state: { kind: "Down" } } as LayerWorld["server"];
    const { getByTestId, findByRole } = await mountLost("tree:AK-1:tab:t1", true);
    fireEvent.click(await findByRole("button", { name: "Resume this session" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(getByTestId("tabs")).toHaveTextContent("1");
    expect(backend.close).not.toHaveBeenCalled();
    expect(openAgent).not.toHaveBeenCalled();
  });
});
