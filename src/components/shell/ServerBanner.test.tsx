import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerState, ServerStatus } from "../../bindings";

const world = vi.hoisted(() => ({
  status: undefined as ServerStatus | undefined,
  pending: false,
  mutate: vi.fn(),
}));

vi.mock("../../lib/queries", () => ({
  useServerStatus: () => ({ data: world.status }),
  useStartServer: () => ({ mutate: world.mutate, isPending: world.pending }),
}));

import { TRANSITION_GRACE_MS } from "../../lib/serverStatus";
import { ServerBanner } from "./ServerBanner";

const status = (state: ServerState): ServerStatus => ({ state, draining: [] });
const running: ServerState = {
  kind: "Running",
  revision: 1,
  version: "0.1.0",
  pid: 1,
  startedAtMs: 0,
  liveSessions: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  world.status = undefined;
  world.pending = false;
});
afterEach(() => vi.useRealTimers());

describe("ServerBanner", () => {
  it("says nothing before the status is known, when off, starting or running", () => {
    for (const state of [undefined, { kind: "Off" }, { kind: "Starting" }, running] as const) {
      world.status = state && status(state);
      const { container, unmount } = render(<ServerBanner />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("explains a down or failing server with its reason, and leaves the start to a click", () => {
    for (const [state, headline] of [
      [
        { kind: "Down", reason: "It was stopped from outside santree." },
        "The santree server isn't running.",
      ],
      [
        { kind: "Failing", reason: "Exited 5 times in a minute." },
        "The santree server keeps stopping.",
      ],
    ] as const) {
      world.mutate.mockClear();
      world.status = status(state);
      const { getByRole, unmount } = render(<ServerBanner />);
      expect(getByRole("alert")).toHaveTextContent(headline);
      expect(getByRole("alert")).toHaveTextContent(state.reason);
      // Nothing starts by itself: the call is made on the click.
      expect(world.mutate).not.toHaveBeenCalled();
      fireEvent.click(getByRole("button", { name: "Start server" }));
      expect(world.mutate).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("disables the button while the start is in flight", () => {
    world.status = status({ kind: "Down", reason: "Stopped." });
    world.pending = true;
    const { getByRole } = render(<ServerBanner />);
    expect(getByRole("button", { name: "Start server" })).toBeDisabled();
  });

  it("says 'Starting…' once a start has lasted the grace period, and leaves when it runs", () => {
    vi.useFakeTimers();
    world.status = status({ kind: "Down", reason: "Stopped." });
    const { getByRole, queryByRole, rerender, container } = render(<ServerBanner />);

    world.status = status({ kind: "Starting" });
    rerender(<ServerBanner />);
    act(() => void vi.advanceTimersByTime(TRANSITION_GRACE_MS - 1));
    expect(container).toBeEmptyDOMElement();
    act(() => void vi.advanceTimersByTime(1));
    expect(getByRole("status")).toHaveTextContent("Starting the santree server…");
    expect(queryByRole("button")).toBeNull();

    world.status = status(running);
    rerender(<ServerBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is quiet for a start that is over inside the grace period", () => {
    vi.useFakeTimers();
    world.status = status({ kind: "Starting" });
    const { container, rerender } = render(<ServerBanner />);
    act(() => void vi.advanceTimersByTime(TRANSITION_GRACE_MS - 1));
    world.status = status(running);
    rerender(<ServerBanner />);
    act(() => void vi.advanceTimersByTime(TRANSITION_GRACE_MS));
    expect(container).toBeEmptyDOMElement();
  });

  it("says 'Stopping…', not 'Starting…', while a stop that lasts runs", () => {
    vi.useFakeTimers();
    world.status = status({ kind: "Stopping" });
    const { getByRole } = render(<ServerBanner />);
    act(() => void vi.advanceTimersByTime(TRANSITION_GRACE_MS));
    expect(getByRole("status")).toHaveTextContent("Stopping the santree server…");
    expect(getByRole("status")).not.toHaveTextContent("Starting");
  });
});
