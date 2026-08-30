import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdatesSection } from "./Updates";

// Settings → Updates is a leaf view over the updater hooks: mock the data layer
// so the pane renders without a Tauri backend.
type Info = { version: string; currentVersion: string; notes: string | null };
let channelValue: string | null = null;
let checkData: Info | null | undefined;
let installing = false;
const checkMutate = vi.fn();
const checkReset = vi.fn();
const installMutate = vi.fn();
const setSetting = vi.fn();

// The hooks are stubbed, but the channel parser and its key are taken from the
// real module: a stub of `parseUpdateChannel` here would be a second copy of the
// rule under test, and "defaults to stable when nothing is stored" would then be
// asserting the copy rather than the parser the app runs.
vi.mock("../../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/queries")>();
  return {
    UPDATE_CHANNEL_KEY: actual.UPDATE_CHANNEL_KEY,
    parseUpdateChannel: actual.parseUpdateChannel,
    useAppVersion: () => ({ data: "0.1.0" }),
    useSetting: () => ({ data: channelValue }),
    useSetSetting: () => ({ mutate: setSetting }),
    useCheckForUpdate: () => ({
      mutate: checkMutate,
      reset: checkReset,
      data: checkData,
      isPending: false,
    }),
    useInstallUpdate: () => ({ mutate: installMutate, isPending: installing }),
    useUpdateProgress: () => null,
    useClaudeModels: () => ({ data: [] }),
  };
});

describe("Settings → Updates", () => {
  beforeEach(() => {
    channelValue = null;
    checkData = undefined;
    installing = false;
    for (const fn of [checkMutate, checkReset, installMutate, setSetting]) fn.mockClear();
  });

  it("defaults to the stable channel when nothing is stored", () => {
    render(<UpdatesSection />);
    expect(screen.getByRole("combobox")).toHaveValue("stable");
    expect(screen.getByText("0.1.0 (stable)")).toBeInTheDocument();
  });

  // The other two branches of the real parser, through the pane that reads it.
  // The fallback is not cosmetic: Rust's `update.rs` makes the same call on the
  // same row, so a value neither side recognises has to mean stable in both —
  // otherwise a hand-edited setting strands the install on a channel that
  // publishes no manifest at all.
  it("shows a stored channel, and falls back to stable for one it doesn't know", () => {
    channelValue = "beta";
    const { unmount } = render(<UpdatesSection />);
    expect(screen.getByRole("combobox")).toHaveValue("beta");
    expect(screen.getByText("0.1.0 (beta)")).toBeInTheDocument();
    unmount();

    channelValue = "nightly";
    render(<UpdatesSection />);
    expect(screen.getByRole("combobox")).toHaveValue("stable");
  });

  it("checks for updates on demand", () => {
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(checkMutate).toHaveBeenCalledTimes(1);
  });

  it("reports being current only after a check has run", () => {
    render(<UpdatesSection />);
    expect(screen.queryByText("santree is up to date.")).not.toBeInTheDocument();

    checkData = null; // checked, nothing newer
    render(<UpdatesSection />);
    expect(screen.getByText("santree is up to date.")).toBeInTheDocument();
  });

  it("offers the install once an update is found", () => {
    checkData = { version: "0.2.0", currentVersion: "0.1.0", notes: "Fixed things" };
    render(<UpdatesSection />);
    expect(screen.getByText("Version 0.2.0 is available.")).toBeInTheDocument();
    expect(screen.getByText("Fixed things")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(installMutate).toHaveBeenCalledTimes(1);
  });

  // A result from the old channel must not survive the switch: the offered
  // version comes from whichever manifest answered, so leaving it on screen would
  // advertise a build the newly-picked channel doesn't serve.
  it("drops a previous result when the channel changes", () => {
    checkData = { version: "0.2.0", currentVersion: "0.1.0", notes: null };
    render(<UpdatesSection />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } });
    expect(checkReset).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith({
      scope: "app",
      key: "update_channel",
      value: "beta",
    });
  });
});
