/**
 * An adopted session id is spent by the pane that attaches to it. The map of
 * adopted sessions only grows, so a pane mounting later for the same address
 * (a Resume after the agent ended, a re-opened surface) must not be handed the
 * id of a session that is gone: it would attach to nothing and, because it
 * "adopted", never be seeded.
 */
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AdoptedSession, PaneLink } from "../../bindings";
import type { TerminalSpec, TerminalTabs } from "./orchestrator";
import type { LayerWorld } from "./testing";
import type { OutputHandlers } from "./types";

vi.mock("../agents/useOpenAgent", () => ({ useOpenAgent: () => vi.fn() }));
const world = vi.hoisted((): LayerWorld => ({ repos: [], server: undefined }));
vi.mock("../../lib/queries", async () => (await import("./testing")).layerQueries(world));
vi.mock("./TauriBackend", async () => ({
  tauriBackend: (await import("./testing")).fakeTauriBackend(),
}));
vi.mock("./XtermRenderer", async () => ({
  XtermRenderer: (await import("./testing")).FakeXtermRenderer,
}));

import { tauriBackend } from "./TauriBackend";
import { TerminalLayer } from "./TerminalLayer";
import { resetAdoption, TerminalsProvider, useAdoptAgain, useTerminals } from "./TerminalsContext";

const backend = vi.mocked(tauriBackend);

const REF = "triage:AK-1";
const adopted = (id: number): AdoptedSession => ({
  id,
  label: REF,
  agentKind: "Codex",
  cwd: "/Users/me/web",
  command: "codex",
});
const spec: TerminalSpec & { refId: string } = {
  title: "AK-1",
  source: "triage",
  refId: REF,
  seed: "codex --go",
  agent: { kind: "Codex", repo: "acme/web", termKey: REF },
};

let api: TerminalTabs;
let adoptAgain: () => Promise<void>;
function Grab() {
  api = useTerminals();
  adoptAgain = useAdoptAgain();
  return null;
}

const mount = () =>
  render(
    <TerminalsProvider>
      <Grab />
      <TerminalLayer />
    </TerminalsProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetAdoption();
});

describe("an adopted session id is spent by the pane that used it", () => {
  test("a new pane for the same address opens (and seeds) instead of attaching the dead id", async () => {
    backend.adoptSessions.mockResolvedValueOnce([adopted(5)]);
    mount();
    await waitFor(() => expect(api).toBeDefined());
    await waitFor(() => expect(api.tabs).toBeDefined());

    // The first pane takes over the adopted session.
    let first = "";
    act(() => {
      first = api.ensure(spec);
    });
    await waitFor(() => expect(backend.attach).toHaveBeenCalledTimes(1));
    expect(backend.attach.mock.calls[0][0]).toBe(5);
    expect(backend.open).not.toHaveBeenCalled();

    // The agent ends; the surface asks for the address again (a Resume).
    act(() => api.close(first));
    act(() => {
      api.ensure(spec);
    });

    await waitFor(() => expect(backend.open).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(backend.seed).toHaveBeenCalledWith(7, "codex --go"));
    // ...and never went back to attach the session that is gone.
    expect(backend.attach).toHaveBeenCalledTimes(1);
  });

  test("a lost pane takes a session adopted late for its address, once", async () => {
    mount();
    await waitFor(() => expect(api?.tabs).toBeDefined());
    act(() => {
      api.ensure(spec);
    });
    await waitFor(() => expect(backend.open).toHaveBeenCalledTimes(1));
    const handlers = backend.open.mock.calls[0][1] as OutputHandlers;
    await act(async () => {});
    act(() => handlers.onLink?.("lost" satisfies PaneLink));

    // The server comes up and the adoption that follows finds the agent's session.
    backend.adoptSessions.mockResolvedValueOnce([adopted(9)]);
    await act(async () => {
      await adoptAgain();
    });

    await waitFor(() => expect(backend.attach).toHaveBeenCalledTimes(1));
    expect(backend.attach.mock.calls[0][0]).toBe(9);
    // Nothing was opened beside it and nothing seeded into a running agent.
    expect(backend.open).toHaveBeenCalledTimes(1);
    expect(backend.seed).toHaveBeenCalledTimes(1); // the original open's seed only
  });
});
