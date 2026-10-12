import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerState } from "../../../bindings";

const world = vi.hoisted(() => ({
  state: undefined as ServerState | undefined,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => world.navigate }));
vi.mock("../../../lib/queries", () => ({
  useServerStatus: () => ({
    data: world.state && { state: world.state, draining: [] },
  }),
}));

import { TRANSITION_GRACE_MS } from "../../../lib/serverStatus";
import { ServerSegment } from "./ServerSegment";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  world.state = undefined;
});
afterEach(() => vi.useRealTimers());

describe("ServerSegment", () => {
  it("is absent when the status is unknown, off or running", () => {
    for (const state of [
      undefined,
      { kind: "Off" },
      {
        kind: "Running",
        revision: 1,
        version: "v",
        pid: 1,
        startedAtMs: 0,
        liveSessions: 0,
      },
    ] as const) {
      world.state = state;
      const { container, unmount } = render(<ServerSegment />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("shows a dot for Down and Failing with the reason, and opens Terminal settings", () => {
    world.state = { kind: "Down", reason: "It was stopped." };
    const { unmount } = render(<ServerSegment />);
    const button = screen.getByRole("button", { name: /server stopped/ });
    expect(button).toHaveAttribute("title", expect.stringContaining("It was stopped."));
    fireEvent.click(button);
    expect(world.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "terminal" },
    });
    unmount();

    world.state = { kind: "Failing", reason: "Crashed 3 times." };
    render(<ServerSegment />);
    expect(screen.getByRole("button", { name: /server failing/ })).toBeInTheDocument();
  });

  it.each([
    ["Starting", /server starting/],
    ["Stopping", /server stopping/],
  ] as const)("shows %s only after it has lasted past the grace period", (kind, name) => {
    world.state = { kind };
    const { container } = render(<ServerSegment />);
    expect(container).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(TRANSITION_GRACE_MS - 1);
    });
    expect(container).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });
});
