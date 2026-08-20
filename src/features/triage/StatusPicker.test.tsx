import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StatusPicker } from "./StatusPicker";

// The picker only pulls the shared copy out of the queries module; mocking it
// keeps the test off the Tauri bridge that module imports.
vi.mock("../../lib/queries", () => ({
  LINEAR_READ_ONLY_HINT: "Linear is connected read-only.",
}));

const detail = {
  id: "SAN-1",
  state: "Triage",
  stateId: "s1",
  states: [
    { id: "s1", name: "Triage", color: "#f00", type: "triage" },
    { id: "s2", name: "Backlog", color: "#0f0", type: "backlog" },
  ],
} as unknown as Parameters<typeof StatusPicker>[0]["detail"];

describe("Triage → StatusPicker", () => {
  it("changes state when Linear can be written to", () => {
    const onSetState = vi.fn();
    render(<StatusPicker detail={detail} onSetState={onSetState} />);
    fireEvent.click(screen.getByRole("button", { name: /Triage/ }));
    fireEvent.click(screen.getByRole("button", { name: "Backlog" }));
    expect(onSetState).toHaveBeenCalledWith("s2");
  });

  // The backend refuses the write regardless; this is about not offering it.
  it("is inert on a read-only grant, and says why", () => {
    const onSetState = vi.fn();
    render(<StatusPicker detail={detail} onSetState={onSetState} readOnly />);
    const trigger = screen.getByRole("button", { name: /Triage/ });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    // The menu never opens, so no state is reachable to click.
    expect(screen.queryByRole("button", { name: "Backlog" })).not.toBeInTheDocument();
    expect(onSetState).not.toHaveBeenCalled();
    // A disabled button swallows `title`, so the hint lives on the wrapper.
    expect(trigger.parentElement).toHaveAttribute("title", "Linear is connected read-only.");
  });
});
