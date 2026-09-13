/**
 * The rail's prompt to connect a tracker: drawn only once both trackers have said
 * nothing is connected, and it goes to the place each one is connected.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ connected: null as boolean | null, navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("../../lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queries")>()),
  useTrackerConnected: () => state.connected,
}));

import { TrackerConnectPrompt } from "./TrackerConnectPrompt";

beforeEach(() => {
  state.navigate.mockClear();
});

describe("TrackerConnectPrompt", () => {
  /** An unknown is not a no: a cold start must not flash a warning at an install
   *  that is connected. */
  it("draws nothing while the connection reads are in flight", () => {
    state.connected = null;
    const { container } = render(<TrackerConnectPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing once a tracker is connected", () => {
    state.connected = true;
    const { container } = render(<TrackerConnectPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing is connected, and takes you to either tracker's settings", () => {
    state.connected = false;
    render(<TrackerConnectPrompt />);

    expect(screen.getByText("No ticket tracker connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/settings",
      search: { section: "linear" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Jira" }));
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/settings",
      search: { section: "jira" },
    });
  });
});
