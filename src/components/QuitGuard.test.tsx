import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared mock state, matching the `logMock` pattern in lib/logging.test.ts —
// `vi.hoisted` because the factories below run before this file's own
// top-level `const`s would otherwise be initialized.
// The mock signatures are declared (rather than bare `vi.fn()`) so `.mock.calls`
// is typed — otherwise the recorded args are an empty tuple and every read of them
// needs a cast, which is how this file's handler lookups silently stopped being
// type-checked at all.
type CloseHandler = (e: { preventDefault: () => void }) => void;
const windowMock = vi.hoisted(() => ({
  onCloseRequested: vi.fn((_h: (e: { preventDefault: () => void }) => void) =>
    Promise.resolve(vi.fn()),
  ),
  listen: vi.fn((_event: string, _h: () => void) => Promise.resolve(vi.fn())),
  destroy: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMock,
}));

// What quitting would end, as the backend reports it. The default is the common
// case the older tests below are about: something that dies with the app.
const bindingsMock = vi.hoisted(() => ({
  quitApp: vi.fn(async () => ({ status: "ok" as const, data: null })),
  quitSummary: vi.fn(
    async (): Promise<{ terminalsEnd: number }> => ({
      terminalsEnd: 2,
    }),
  ),
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
  const close = windowMock.onCloseRequested.mock.calls.at(-1)?.[0] as CloseHandler;
  const quit = windowMock.listen.mock.calls.find(([event]) => event === "quit-requested")?.[1];
  return { close, quit: quit as () => void };
}

beforeEach(() => {
  vi.clearAllMocks();
  queriesMock.data = undefined;
  bindingsMock.quitSummary.mockResolvedValue({ terminalsEnd: 2 });
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

describe("QuitGuard: it asks only about what quitting ends", () => {
  const closeWindow = () => {
    render(<QuitGuard />);
    const preventDefault = vi.fn();
    act(() => handlers().close({ preventDefault }));
    return preventDefault;
  };

  it("counts the terminals that will end", async () => {
    bindingsMock.quitSummary.mockResolvedValue({ terminalsEnd: 3 });
    closeWindow();
    const dialog = await screen.findByRole("dialog", { name: "Quit santree?" });
    expect(dialog).toHaveTextContent("3 running terminals in this window will be stopped.");
  });

  it("says 'terminal' for one", async () => {
    bindingsMock.quitSummary.mockResolvedValue({ terminalsEnd: 1 });
    closeWindow();
    expect(await screen.findByRole("dialog")).toHaveTextContent("1 running terminal in this");
  });

  it("quits without a prompt when nothing ends (a server holds them): window close", async () => {
    bindingsMock.quitSummary.mockResolvedValue({ terminalsEnd: 0 });
    const preventDefault = closeWindow();

    await waitFor(() => expect(windowMock.destroy).toHaveBeenCalled());
    // Held while the summary was read, then finished through destroy().
    expect(preventDefault).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bindingsMock.quitApp).not.toHaveBeenCalled();
  });

  it("quits without a prompt when nothing ends: ⌘Q exits the process", async () => {
    bindingsMock.quitSummary.mockResolvedValue({ terminalsEnd: 0 });
    render(<QuitGuard />);
    act(() => handlers().quit());

    await waitFor(() => expect(bindingsMock.quitApp).toHaveBeenCalled());
    expect(windowMock.destroy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks with the general warning when the summary can't be read", async () => {
    bindingsMock.quitSummary.mockRejectedValue(new Error("no backend"));
    closeWindow();
    const dialog = await screen.findByRole("dialog", { name: "Quit santree?" });
    expect(dialog).toHaveTextContent("Any running agent terminals in this window will be stopped.");
    expect(windowMock.destroy).not.toHaveBeenCalled();
  });

  it("never reads the summary when confirm-on-quit is off", () => {
    queriesMock.data = "false";
    closeWindow();
    expect(bindingsMock.quitSummary).not.toHaveBeenCalled();
  });
});
