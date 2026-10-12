/**
 * "Relaunch adopts everything": a tab for each adopted session, and a second
 * adoption when the server comes up after the page did. The invariants pinned
 * here are the ones that keep it from doing harm — it adopts only on the move
 * INTO `Running` (the status is re-pushed whenever the session count moves), it
 * is idempotent, and it never closes anything.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AdoptedSession, ServerState, ServerStatus } from "../../bindings";

const world = vi.hoisted(() => ({
  status: undefined as ServerStatus | undefined,
  /** What each successive `terminal_adopt` call answers (then nothing). */
  answers: [] as unknown[][],
  orphans: [] as number[],
  inventoryFails: false,
  repos: [{ name: "acme/web", path: "/Users/me/web", location: "Local" }] as
    | {
        name: string;
        path: string | null;
        location: string;
      }[]
    | undefined,
}));

vi.mock("../../lib/queries", () => ({
  useServerStatus: () => ({ data: world.status }),
  useRepos: () => ({ data: world.repos, isFetched: true }),
  fetchTerminalInventory: async () => {
    if (world.inventoryFails) throw new Error("no answer");
    return { sessions: [], complete: true, orphans: world.orphans };
  },
}));

vi.mock("./TauriBackend", () => ({
  tauriBackend: {
    adoptSessions: vi.fn(async () => world.answers.shift() ?? []),
    close: vi.fn(),
    detach: vi.fn(),
  },
}));

import { tauriBackend } from "./TauriBackend";
import { TerminalAdoption } from "./TerminalAdoption";
import {
  resetAdoption,
  TerminalsProvider,
  useAdoptedSessions,
  useTerminals,
} from "./TerminalsContext";

const adopt = vi.mocked(tauriBackend.adoptSessions);

const status = (state: ServerState): ServerStatus => ({ state, draining: [] });
const running = (liveSessions: number): ServerState => ({
  kind: "Running",
  revision: 1,
  version: "0.0.0",
  pid: 10,
  startedAtMs: 0,
  liveSessions,
});

const wt = "/Users/me/web/.santree/worktrees";
const agent = (id: number, ticket: string): AdoptedSession => ({
  id,
  label: `tree:${ticket}`,
  agentKind: "Claude",
  cwd: `${wt}/${ticket}`,
  command: "claude",
});

/** Lists what the terminal registry holds and what adoption knows. */
function Probe() {
  const { tabs } = useTerminals();
  const { sessions, ready } = useAdoptedSessions();
  return (
    <div data-testid="probe" data-ready={ready}>
      {tabs.map((t) => (
        <span key={t.key} data-testid="tab" data-ref={t.refId} data-kind={t.agent?.kind}>
          {t.agent?.repo}
        </span>
      ))}
      <span data-testid="held">{sessions.size}</span>
    </div>
  );
}

const tree = (children?: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <TerminalsProvider>
      <TerminalAdoption />
      <Probe />
      {children}
    </TerminalsProvider>
  </QueryClientProvider>
);

const refs = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-testid=tab]")].map((e) => e.getAttribute("data-ref"));

beforeEach(() => {
  vi.clearAllMocks();
  resetAdoption();
  world.status = status({ kind: "Starting" });
  world.answers = [];
  world.orphans = [];
  world.inventoryFails = false;
  world.repos = [{ name: "acme/web", path: "/Users/me/web", location: "Local" }];
});

describe("a tab for every adopted session", () => {
  test("opens one, identified exactly as its own view would, and closes nothing", async () => {
    world.answers = [[agent(5, "AK-1"), agent(6, "AK-2")]];
    const { container } = render(tree());

    await waitFor(() => expect(refs(container)).toEqual(["tree:AK-1", "tree:AK-2"]));
    const first = container.querySelector("[data-testid=tab]");
    expect(first).toHaveAttribute("data-kind", "Claude");
    expect(first).toHaveTextContent("acme/web");
    expect(tauriBackend.close).not.toHaveBeenCalled();
  });

  test("leaves out the backend's orphans, and sessions on no known surface", async () => {
    world.orphans = [6];
    world.answers = [
      [
        agent(5, "AK-1"),
        agent(6, "AK-2"),
        { id: 7, label: "settings:login", agentKind: null, cwd: null, command: "" },
      ],
    ];
    const { container, getByTestId } = render(tree());

    await waitFor(() => expect(refs(container)).toEqual(["tree:AK-1"]));
    // The orphan is still adopted (held by address) — just not given a tab.
    expect(getByTestId("held")).toHaveTextContent("3");
    expect(tauriBackend.close).not.toHaveBeenCalled();
  });

  test("when the backend can't say what is orphaned, every session still gets its tab", async () => {
    world.inventoryFails = true;
    world.answers = [[agent(5, "AK-1")]];
    const { container } = render(tree());
    await waitFor(() => expect(refs(container)).toEqual(["tree:AK-1"]));
  });
});

describe("an agent whose project list could not be read", () => {
  test("is not given up on: it gets its tab once the projects are known", async () => {
    // The read failed (settled, but with no data): every agent would read as
    // belonging to no project, and each would be skipped for good.
    world.repos = undefined;
    world.answers = [[agent(5, "AK-1")]];
    const { container, rerender, getByTestId } = render(tree());
    await waitFor(() => expect(getByTestId("held")).toHaveTextContent("1"));
    await act(async () => {});
    expect(refs(container)).toEqual([]);

    world.repos = [{ name: "acme/web", path: "/Users/me/web", location: "Local" }];
    rerender(tree());
    await waitFor(() => expect(refs(container)).toEqual(["tree:AK-1"]));
  });
});

describe("adopting again when the server comes up", () => {
  const settle = () => act(async () => {});

  test("only on the move INTO Running, never on a session-count change", async () => {
    world.answers = [[], [agent(5, "AK-1")]];
    const { container, rerender } = render(tree());
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));

    // Starting -> Running: the server came up after the page adopted.
    world.status = status(running(0));
    rerender(tree());
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refs(container)).toEqual(["tree:AK-1"]));

    // The same status re-pushed as sessions come and go: not a reason to ask.
    for (const n of [1, 2, 3]) {
      world.status = status(running(n));
      rerender(tree());
      await settle();
    }
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(tauriBackend.close).not.toHaveBeenCalled();
  });

  test("a server that was already Running when the page mounted adopts once, with the page", async () => {
    world.status = status(running(2));
    world.answers = [[agent(5, "AK-1")]];
    const { container, rerender } = render(tree());
    await waitFor(() => expect(refs(container)).toEqual(["tree:AK-1"]));

    world.status = status(running(3));
    rerender(tree());
    await settle();
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  test("a restarted server is adopted again, and a mode with no server never is", async () => {
    world.status = status(running(1));
    const { rerender } = render(tree());
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));

    for (const state of [
      { kind: "Down", reason: "stopped" },
      { kind: "Starting" },
    ] as ServerState[]) {
      world.status = status(state);
      rerender(tree());
    }
    await settle();
    expect(adopt).toHaveBeenCalledTimes(1);

    world.status = status(running(0));
    rerender(tree());
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(2));

    world.status = status({ kind: "Off" });
    rerender(tree());
    await settle();
    expect(adopt).toHaveBeenCalledTimes(2);
  });

  test("is idempotent: adopting a session already held adds no second tab", async () => {
    world.answers = [[agent(5, "AK-1")], [agent(5, "AK-1")]];
    const { container, rerender, getByTestId } = render(tree());
    await waitFor(() => expect(refs(container)).toEqual(["tree:AK-1"]));

    world.status = status(running(1));
    rerender(tree());
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(2));
    await settle();

    expect(refs(container)).toEqual(["tree:AK-1"]);
    expect(getByTestId("held")).toHaveTextContent("1");
  });

  test("a failed adoption is silent and leaves the page as it was", async () => {
    adopt.mockRejectedValueOnce(new Error("no server"));
    const { container, getByTestId } = render(tree());
    await waitFor(() => expect(getByTestId("probe")).toHaveAttribute("data-ready", "true"));
    expect(refs(container)).toEqual([]);
  });
});
