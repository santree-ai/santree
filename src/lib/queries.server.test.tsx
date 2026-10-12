/**
 * The local server's status in the query cache: seeded by the read, re-read on
 * each event (as the Daedalus link is), and nudged to `Starting` by a "Start
 * server" click that a refusal puts back.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerStatus } from "../bindings";

const world = vi.hoisted(() => ({
  status: { state: { kind: "Down", reason: "stopped" }, draining: [] } as ServerStatus,
  startResult: { status: "ok", data: null } as
    | { status: "ok"; data: null }
    | { status: "error"; error: string },
  handler: undefined as ((e: { payload: ServerStatus }) => void) | undefined,
  /** Holds `listen` open until released: the window in which registration is pending. */
  listenGate: undefined as Promise<void> | undefined,
  /** Holds the next `serverStatus` answer until released. */
  statusGate: undefined as Promise<void> | undefined,
}));

vi.mock("../bindings", () => ({
  commands: {
    serverStatus: vi.fn(async () => {
      const answer = world.status;
      await world.statusGate;
      return answer;
    }),
    serverStart: vi.fn(async () => world.startResult),
  },
  events: {
    serverStateChanged: {
      listen: vi.fn(async (cb: typeof world.handler) => {
        await world.listenGate;
        world.handler = cb;
        return () => {};
      }),
    },
  },
}));

import { commands } from "../bindings";
import { queryKeys, useServerStatus, useServerStatusWatcher, useStartServer } from "./queries";

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (qc: QueryClient) => (props: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: qc }, props.children);

const running = (liveSessions: number): ServerStatus => ({
  state: {
    kind: "Running",
    revision: 1,
    version: "0.1.0",
    pid: 9,
    startedAtMs: 0,
    liveSessions,
  },
  draining: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  world.handler = undefined;
  world.status = { state: { kind: "Down", reason: "stopped" }, draining: [] };
  world.startResult = { status: "ok", data: null };
  world.listenGate = undefined;
  world.statusGate = undefined;
});

describe("useServerStatus + its watcher", () => {
  it("is seeded by the read, then re-read on each event", async () => {
    const qc = client();
    const { result } = renderHook(
      () => {
        useServerStatusWatcher();
        return useServerStatus();
      },
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data?.state.kind).toBe("Down"));
    await waitFor(() => expect(world.handler).toBeDefined());

    world.status = running(1);
    act(() => world.handler?.({ payload: running(1) }));
    await waitFor(() =>
      expect(result.current.data?.state).toMatchObject({ kind: "Running", liveSessions: 1 }),
    );
    world.status = running(2);
    act(() => world.handler?.({ payload: running(2) }));
    await waitFor(() =>
      expect(result.current.data?.state).toMatchObject({ kind: "Running", liveSessions: 2 }),
    );
  });
});

describe("a transition the first read could not see", () => {
  const both = () => {
    useServerStatusWatcher();
    return useServerStatus();
  };

  it("is read once the listener is registered, not lost in the gap before it", async () => {
    // The listener registers asynchronously; the server moves while it does.
    let open: () => void = () => {};
    world.listenGate = new Promise<void>((r) => {
      open = r;
    });
    const qc = client();
    const { result } = renderHook(both, { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data?.state.kind).toBe("Down"));

    world.status = running(1);
    open();
    await waitFor(() => expect(result.current.data?.state.kind).toBe("Running"));
  });

  it("is not overwritten by a read that was already in flight when the event came", async () => {
    let answer: () => void = () => {};
    world.statusGate = new Promise<void>((r) => {
      answer = r;
    });
    const qc = client();
    const { result } = renderHook(both, { wrapper: wrap(qc) });
    await waitFor(() => expect(world.handler).toBeDefined());

    // The read was issued against `Down`; the event is newer than that answer.
    world.status = running(3);
    act(() => world.handler?.({ payload: running(3) }));
    world.statusGate = undefined;
    answer();
    await waitFor(() => expect(result.current.data?.state.kind).toBe("Running"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(qc.getQueryData<ServerStatus>(queryKeys.serverStatus)?.state).toMatchObject({
      kind: "Running",
      liveSessions: 3,
    });
    expect(result.current.data?.state.kind).toBe("Running");
  });
});

describe("useStartServer", () => {
  it("reads Starting at the click and keeps what the server then says", async () => {
    const qc = client();
    qc.setQueryData(queryKeys.serverStatus, world.status);
    const { result } = renderHook(() => useStartServer(), { wrapper: wrap(qc) });

    act(() => result.current.mutate());
    await waitFor(() =>
      expect(qc.getQueryData<ServerStatus>(queryKeys.serverStatus)?.state.kind).toBe("Starting"),
    );
    await waitFor(() => expect(commands.serverStart).toHaveBeenCalledTimes(1));
  });

  it("puts the status back when the start is refused", async () => {
    world.startResult = { status: "error", error: "the launcher is not trusted" };
    const qc = client();
    qc.setQueryData(queryKeys.serverStatus, world.status);
    const { result } = renderHook(() => useStartServer(), { wrapper: wrap(qc) });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<ServerStatus>(queryKeys.serverStatus)?.state).toEqual({
      kind: "Down",
      reason: "stopped",
    });
  });
});
