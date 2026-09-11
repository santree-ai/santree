/**
 * The rail's prompt to connect Linear: drawn only once Linear has said nothing is
 * connected, and it goes to the one place a workspace is connected.
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
  useLinearConnected: () => state.connected,
}));

import { LinearConnectPrompt } from "./LinearConnectPrompt";

beforeEach(() => {
  state.navigate.mockClear();
});

describe("LinearConnectPrompt", () => {
  /** An unknown is not a no: a cold start must not flash a warning at an install
   *  that is connected. */
  it("draws nothing while the org read is in flight", () => {
    state.connected = null;
    const { container } = render(<LinearConnectPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing once a workspace is connected", () => {
    state.connected = true;
    const { container } = render(<LinearConnectPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says Linear isn't connected, and takes you to its settings", () => {
    state.connected = false;
    render(<LinearConnectPrompt />);

    expect(screen.getByText("Linear isn't connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "linear" },
    });
  });
});
