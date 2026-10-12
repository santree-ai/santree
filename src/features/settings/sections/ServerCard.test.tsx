/**
 * Settings → Terminal → the santree server card.
 *
 * Real hooks over a stubbed bridge, like the Daedalus pane's test: the claims are
 * about what the card shows for each state of the server, what a confirm says
 * will end (an unknown count is never "0"), that nothing paints an ending before
 * the status event says so.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerState, ServerStatus } from "../../../bindings";
import { useServerStatusWatcher } from "../../../lib/queries";
import { ServerCard } from "./ServerCard";

const world = vi.hoisted(() => ({
  status: { state: { kind: "Off" }, draining: [] } as unknown as ServerStatus,
  onEvent: null as null | ((e: { payload: ServerStatus }) => void),
  restart: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  endDraining: vi.fn(),
  revealLogs: vi.fn(),
}));

vi.mock("../../../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../bindings")>();
  const ok = (data: null = null) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...actual,
    commands: {
      ...actual.commands,
      serverStatus: () => Promise.resolve(world.status),
      serverRestart: () => {
        world.restart();
        return ok();
      },
      serverStop: () => {
        world.stop();
        return ok();
      },
      serverStart: () => {
        world.start();
        return ok();
      },
      serverEndDraining: (rev: number) => {
        world.endDraining(rev);
        return ok();
      },
      revealLogs: () => {
        world.revealLogs();
        return ok();
      },
      exportLogs: () =>
        Promise.resolve({
          status: "ok" as const,
          data: { path: "/tmp/x.log", bytes: 1, files: [] },
        }),
    },
    events: {
      ...actual.events,
      serverStateChanged: {
        listen: (cb: (e: { payload: ServerStatus }) => void) => {
          world.onEvent = cb;
          return Promise.resolve(() => {});
        },
      },
    },
  };
});

vi.mock("../../../state/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const running = (liveSessions = 3): ServerState => ({
  kind: "Running",
  revision: 3,
  version: "0.1.19",
  pid: 4242,
  startedAtMs: Date.now() - 125_000,
  liveSessions,
});

function Harness() {
  useServerStatusWatcher();
  return <ServerCard />;
}

const renderCard = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Harness />
    </QueryClientProvider>,
  );

/** The server moves, and says so. */
const push = (status: ServerStatus) =>
  act(async () => {
    world.status = status;
    world.onEvent?.({ payload: status });
  });

beforeEach(() => {
  vi.clearAllMocks();
  world.onEvent = null;
  world.status = { state: running(), draining: [] };
});

describe("server card", () => {
  it("shows a running server's facts and its controls", async () => {
    renderCard();
    const card = await screen.findByRole("region", { name: "santree server" });
    expect(within(card).getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(within(card).getByText("r3")).toBeInTheDocument();
    expect(within(card).getByText("0.1.19")).toBeInTheDocument();
    expect(within(card).getByText("4242")).toBeInTheDocument();
    expect(within(card).getByText("2m")).toBeInTheDocument();
    for (const name of ["Restart", "Stop", "Open logs", "Export logs"]) {
      expect(within(card).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(card).queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("opens the logs folder through revealLogs, separately from Export logs", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Open logs" }));
    await waitFor(() => expect(world.revealLogs).toHaveBeenCalledTimes(1));
  });

  it.each([
    [{ kind: "Down", reason: "It was stopped from outside santree." }, "Not running"],
    [{ kind: "Failing", reason: "It exited 3 times in a row." }, "Keeps stopping"],
  ] as [ServerState, string][])("explains %j and offers Start", async (state, title) => {
    world.status = { state, draining: [] };
    renderCard();
    const card = await screen.findByRole("region", { name: "santree server" });
    expect(within(card).getByText(title)).toBeInTheDocument();
    expect(within(card).getByText((state as { reason: string }).reason)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Restart" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(world.start).toHaveBeenCalledTimes(1));
  });

  it("is a single line, with no controls, when the server is off", async () => {
    world.status = { state: { kind: "Off" }, draining: [] };
    renderCard();
    expect(await screen.findByText(/Terminals aren't persistent in this build/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "santree server" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("confirms a restart with the count and does not call until confirmed", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    const dialog = screen.getByRole("dialog", { name: "Restart the santree server?" });
    expect(dialog).toHaveTextContent("This ends 3 sessions");
    expect(dialog).toHaveTextContent("resumed from their tabs");
    expect(world.restart).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(world.restart).toHaveBeenCalledTimes(1));
  });

  it("holds a pending state after a stop until the status event arrives", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Stop the santree server?" })).getByRole("button", {
        name: "Stop",
      }),
    );
    await waitFor(() => expect(world.stop).toHaveBeenCalled());
    // The command returned, but the card does not claim "stopped": it still reads
    // pending, with its controls disabled, because the event hasn't said so.
    const card = screen.getByRole("region", { name: "santree server" });
    await waitFor(() => expect(within(card).getByText("Stopping…")).toBeInTheDocument());
    expect(within(card).getByRole("button", { name: "Restart" })).toBeDisabled();
    expect(within(card).getByRole("img", { name: "Working" })).toBeInTheDocument();

    await push({ state: { kind: "Down", reason: "Stopped from Settings." }, draining: [] });
    expect(await within(card).findByText("Not running")).toBeInTheDocument();
    expect(within(card).queryByText("Stopping…")).toBeNull();
  });

  it("keeps a stop pending when only the session count moves under it", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Stop the santree server?" })).getByRole("button", {
        name: "Stop",
      }),
    );
    await waitFor(() => expect(world.stop).toHaveBeenCalled());
    const card = screen.getByRole("region", { name: "santree server" });
    await waitFor(() => expect(within(card).getByText("Stopping…")).toBeInTheDocument());

    // A session ending re-pushes the status: the stop has not happened yet.
    await push({ state: running(2), draining: [] });
    expect(await within(card).findByText("2")).toBeInTheDocument();
    expect(within(card).getByText("Stopping…")).toBeInTheDocument();
    expect(within(card).queryByText("Running")).toBeNull();
  });

  it("names an unknown draining count as unknown, never 0, in the row and the confirm", async () => {
    world.status = {
      state: running(),
      draining: [
        { revision: 2, sessions: { kind: "Unknown" }, pid: null, version: null },
        { revision: 1, sessions: { kind: "Known", count: 1 }, pid: 7, version: "0.1.18" },
      ],
    };
    renderCard();
    const older = await screen.findByRole("region", { name: "Older servers" });
    expect(older).toHaveTextContent("r2 · an unknown number of sessions · exits when it ends");
    expect(older).toHaveTextContent("r1 · 1 session · exits when it ends");
    expect(older).not.toHaveTextContent("0 sessions");

    fireEvent.click(within(older).getByRole("button", { name: "End r2 now" }));
    const dialog = screen.getByRole("dialog", { name: "End r2 now?" });
    expect(dialog).toHaveTextContent("an unknown number of sessions");
    expect(dialog).toHaveTextContent("resumed from their tabs");
    fireEvent.click(within(dialog).getByRole("button", { name: "End now" }));
    await waitFor(() => expect(world.endDraining).toHaveBeenCalledWith(2));
  });

  it("gives every control an accessible name and starts the confirm on Cancel", async () => {
    renderCard();
    for (const b of await screen.findAllByRole("button")) {
      expect(b).toHaveAccessibleName();
    }
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
