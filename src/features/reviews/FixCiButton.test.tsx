import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CheckStatus, PrCheck, ReviewPr } from "../../bindings";
import { FixCiButton } from "./FixCiButton";

const spies = vi.hoisted(() => ({
  createWorktreeForPr: vi.fn(),
  prCheckLog: vi.fn(),
  fixCiPrompt: vi.fn(),
  navigate: vi.fn(),
  addPendingLaunches: vi.fn(),
  removePendingLaunch: vi.fn(),
  requestFixCiLaunch: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("../../bindings", () => ({ commands: spies }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => spies.navigate }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: spies.invalidateQueries }),
}));
vi.mock("../../state/AppContext", () => ({ useAppUi: () => spies }));

function check(over: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "build",
    status: "Failure" as CheckStatus,
    description: null,
    url: null,
    steps: [],
    annotations: [],
    jobId: 77,
    ...over,
  };
}

const pr = {
  number: 483,
  title: "[AK-201] Booking webhook retries",
  repo: "acme/booking-agent",
  headRef: "santree/ak-201-booking-webhook",
} as ReviewPr;

function renderButton(failed: PrCheck[] = [check()]) {
  return render(<FixCiButton pr={pr} santreeRepo="/repo" failed={failed} />);
}

describe("FixCiButton", () => {
  it("runs the launch chain once for a double-click", async () => {
    // Hold the chain at its first await so both clicks land while it's in flight.
    let releaseWorktree: (() => void) | undefined;
    spies.createWorktreeForPr.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWorktree = () => resolve({ status: "ok", data: { id: "w1" } });
        }),
    );
    spies.prCheckLog.mockResolvedValue({
      status: "ok",
      data: { blocks: [{ kind: "line", text: "boom", level: "Error" }], truncated: false },
    });
    spies.fixCiPrompt.mockResolvedValue({ status: "ok", data: "/repo/.santree/fix-ci.md" });

    renderButton();
    const button = screen.getByRole("button", { name: /Fix CI with AI/ });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(spies.createWorktreeForPr).toHaveBeenCalledTimes(1);
    // A second run would also duplicate the sidebar placeholder and the navigation.
    expect(spies.addPendingLaunches).toHaveBeenCalledTimes(1);
    expect(spies.navigate).toHaveBeenCalledTimes(1);

    releaseWorktree?.();
    await vi.waitFor(() => expect(spies.requestFixCiLaunch).toHaveBeenCalledTimes(1));
    expect(spies.fixCiPrompt).toHaveBeenCalledTimes(1);

    // Still guarded once the chain has completed — one Fix-CI tab per worktree.
    fireEvent.click(button);
    expect(spies.createWorktreeForPr).toHaveBeenCalledTimes(1);
  });

  it("re-arms after a failed run and drops the pending launch", async () => {
    vi.clearAllMocks();
    spies.createWorktreeForPr.mockResolvedValue({ status: "error", error: "no such branch" });

    renderButton();
    const button = screen.getByRole("button", { name: /Fix CI with AI/ });
    fireEvent.click(button);

    await vi.waitFor(() => expect(spies.removePendingLaunch).toHaveBeenCalledWith("AK-201"));

    fireEvent.click(button);
    expect(spies.createWorktreeForPr).toHaveBeenCalledTimes(2);
  });

  it("renders nothing when no failed check has a fetchable job log", () => {
    const { container } = renderButton([check({ jobId: null })]);
    expect(container).toBeEmptyDOMElement();
  });
});
