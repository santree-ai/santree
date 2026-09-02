import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TriageDetail, TriageTicket } from "../../bindings";
import { useTriageKeyboard } from "./hooks";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const { openUrl } = await import("@tauri-apps/plugin-opener");

const ticket = (id: string) => ({ id }) as TriageTicket;
const queue = (...ids: string[]) => ids.map(ticket);

describe("useTriageKeyboard", () => {
  const detail = { id: "AK-1", url: "https://linear.app/x/AK-1" } as TriageDetail;

  function mount(over: Partial<Parameters<typeof useTriageKeyboard>[0]> = {}) {
    const onSelect = vi.fn();
    const onInvestigate = vi.fn();
    const onTogglePanel = vi.fn();
    renderHook(() =>
      useTriageKeyboard({
        ordered: queue("AK-1", "AK-2", "AK-3"),
        activeId: "AK-2",
        detail,
        onSelect,
        onInvestigate,
        onTogglePanel,
        ...over,
      }),
    );
    return { onSelect, onInvestigate, onTogglePanel };
  }

  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    });

  beforeEach(() => vi.mocked(openUrl).mockClear());

  it("j steps down the queue and k steps back up", () => {
    const a = mount();
    press("j");
    expect(a.onSelect).toHaveBeenCalledWith("AK-3");

    const b = mount();
    press("k");
    expect(b.onSelect).toHaveBeenCalledWith("AK-1");
  });

  it("clamps at both ends instead of wrapping", () => {
    const top = mount({ activeId: "AK-1" });
    press("k");
    expect(top.onSelect).not.toHaveBeenCalled();

    const bottom = mount({ activeId: "AK-3" });
    press("j");
    expect(bottom.onSelect).not.toHaveBeenCalled();
  });

  it("with no selection, j picks the first ticket and k the last", () => {
    const down = mount({ activeId: null });
    press("j");
    expect(down.onSelect).toHaveBeenCalledWith("AK-1");

    const up = mount({ activeId: null });
    press("k");
    expect(up.onSelect).toHaveBeenCalledWith("AK-3");
  });

  it("does nothing when the queue is empty", () => {
    const { onSelect } = mount({ ordered: [], activeId: null });
    press("j");
    expect(onSelect).not.toHaveBeenCalled();
  });

  // The embedded terminal's xterm input is a textarea — j/k must reach the agent,
  // not the queue.
  it("ignores keys typed into a field", () => {
    const { onSelect } = mount();
    const input = document.createElement("textarea");
    document.body.append(input);

    press("j", {}, input);

    expect(onSelect).not.toHaveBeenCalled();
    input.remove();
  });

  it("⌘I investigates the active ticket, and is a no-op with no selection", () => {
    const withSel = mount();
    press("i", { metaKey: true });
    expect(withSel.onInvestigate).toHaveBeenCalledTimes(1);

    const noSel = mount({ activeId: null });
    press("i", { metaKey: true });
    expect(noSel.onInvestigate).not.toHaveBeenCalled();
  });

  /** Without a workspace there is no rail; flipping a persisted flag nobody can
   *  see would be a surprise saved for the next ticket. */
  it("⌘L toggles the panel with a ticket open, and does nothing without one", () => {
    const withSel = mount();
    press("l", { metaKey: true, code: "KeyL" });
    expect(withSel.onTogglePanel).toHaveBeenCalledTimes(1);

    const noSel = mount({ activeId: null });
    press("l", { metaKey: true, code: "KeyL" });
    expect(noSel.onTogglePanel).not.toHaveBeenCalled();
  });

  it("⌘O opens the ticket in Linear only once its detail has loaded", () => {
    mount({ detail: undefined });
    press("o", { metaKey: true });
    expect(openUrl).not.toHaveBeenCalled();

    mount();
    press("o", { metaKey: true });
    expect(openUrl).toHaveBeenCalledWith(detail.url);
  });

  it("leaves ⌥-modified keys alone", () => {
    const { onSelect, onInvestigate } = mount();
    press("j", { altKey: true });
    press("i", { metaKey: true, altKey: true });

    expect(onSelect).not.toHaveBeenCalled();
    expect(onInvestigate).not.toHaveBeenCalled();
  });
});
