import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared mock state, matching the `logMock` pattern in lib/logging.test.ts —
// `vi.hoisted` because the factories below run before this file's own
// top-level `const`s would otherwise be initialized.
const windowMock = vi.hoisted(() => ({
  onCloseRequested: vi.fn(() => Promise.resolve(vi.fn())),
  listen: vi.fn(() => Promise.resolve(vi.fn())),
  destroy: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMock,
}));

const bindingsMock = vi.hoisted(() => ({
  quitApp: vi.fn(async () => ({ status: "ok" as const, data: null })),
}));
vi.mock("../bindings", () => ({ commands: bindingsMock }));

// `data` mirrors the persisted CONFIRM_ON_QUIT_KEY setting (undefined ⇒ unset,
// which QuitGuard treats as "confirm" — only an explicit "false" opts out).
const queriesMock = vi.hoisted(() => ({
  data: undefined as string | undefined,
  mutateAsync: vi.fn(async () => {}),
}));
vi.mock("../lib/queries", () => ({
  CONFIRM_ON_QUIT_KEY: "confirm_on_quit",
  useSetting: () => ({ data: queriesMock.data, isLoading: false }),
  useSetSetting: () => ({ mutateAsync: queriesMock.mutateAsync }),
}));

import { QuitGuard } from "./QuitGuard";

/** The close-requested / quit-requested handlers QuitGuard registered on the
 *  (mocked) window in its mount effect. */
function handlers() {
  const close = windowMock.onCloseRequested.mock.calls.at(-1)?.[0] as (e: {
    preventDefault: () => void;
  }) => void;
  const quit = windowMock.listen.mock.calls.find(([event]) => event === "quit-requested")?.[1] as
    | (() => void)
    | undefined;
  return { close, quit: quit as () => void };
}

beforeEach(() => {
  vi.clearAllMocks();
  queriesMock.data = undefined;
});

describe("QuitGuard", () => {
  it("close (⌘W / red traffic light): prevents the default close, shows the confirm dialog, and destroys the window on confirm", async () => {
    render(<QuitGuard />);
    const { close } = handlers();
    const preventDefault = vi.fn();

    act(() => close({ preventDefault }));

    expect(preventDefault).toHaveBeenCalled();
    await screen.findByRole("dialog", { name: "Quit santree?" });

    fireEvent.click(screen.getByRole("button", { name: "Quit" }));

    await waitFor(() => expect(windowMock.destroy).toHaveBeenCalled());
    expect(bindingsMock.quitApp).not.toHaveBeenCalled();
  });

  it("⌘Q (quit-requested): shows the confirm dialog and calls quitApp on confirm, not destroy", async () => {
    render(<QuitGuard />);
    const { quit } = handlers();

    act(() => quit());

    await screen.findByRole("dialog", { name: "Quit santree?" });
    fireEvent.click(screen.getByRole("button", { name: "Quit" }));

    await waitFor(() => expect(bindingsMock.quitApp).toHaveBeenCalled());
    expect(windowMock.destroy).not.toHaveBeenCalled();
  });

  it("does not prevent the close or open the dialog when confirm-on-quit is disabled — it quits immediately", () => {
    queriesMock.data = "false";
    render(<QuitGuard />);
    const { close } = handlers();
    const preventDefault = vi.fn();

    act(() => close({ preventDefault }));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("persists don't-ask-again before quitting, in that order", async () => {
    render(<QuitGuard />);
    const { close } = handlers();
    act(() => close({ preventDefault: vi.fn() }));
    await screen.findByRole("dialog", { name: "Quit santree?" });

    fireEvent.click(screen.getByLabelText(/don't ask again/i));

    const order: string[] = [];
    queriesMock.mutateAsync.mockImplementationOnce(async () => {
      order.push("save");
    });
    windowMock.destroy.mockImplementationOnce(async () => {
      order.push("destroy");
    });

    fireEvent.click(screen.getByRole("button", { name: "Quit" }));

    await waitFor(() => expect(windowMock.destroy).toHaveBeenCalled());
    expect(queriesMock.mutateAsync).toHaveBeenCalledWith({
      scope: "app",
      key: "confirm_on_quit",
      value: "false",
    });
    expect(order).toEqual(["save", "destroy"]);
  });

  it("still quits even when persisting don't-ask-again fails", async () => {
    render(<QuitGuard />);
    const { close } = handlers();
    act(() => close({ preventDefault: vi.fn() }));
    await screen.findByRole("dialog", { name: "Quit santree?" });

    fireEvent.click(screen.getByLabelText(/don't ask again/i));
    queriesMock.mutateAsync.mockRejectedValueOnce(new Error("disk full"));

    fireEvent.click(screen.getByRole("button", { name: "Quit" }));

    await waitFor(() => expect(windowMock.destroy).toHaveBeenCalled());
  });

  it("does not persist a setting when don't-ask-again isn't checked", async () => {
    render(<QuitGuard />);
    const { close } = handlers();
    act(() => close({ preventDefault: vi.fn() }));
    await screen.findByRole("dialog", { name: "Quit santree?" });

    fireEvent.click(screen.getByRole("button", { name: "Quit" }));

    await waitFor(() => expect(windowMock.destroy).toHaveBeenCalled());
    expect(queriesMock.mutateAsync).not.toHaveBeenCalled();
  });
});
