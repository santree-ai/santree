import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useNativeContextMenu } from "./useNativeContextMenu";

/** Right-click `el`; true when the webview's menu would have opened. */
function nativeMenuOpens(el: Element, init: MouseEventInit = {}): boolean {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return !e.defaultPrevented;
}

function mount<T extends HTMLElement>(el: T): T {
  document.body.append(el);
  return el;
}

describe("useNativeContextMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("keeps the webview's menu off the app's chrome", () => {
    renderHook(() => useNativeContextMenu());
    expect(nativeMenuOpens(mount(document.createElement("button")))).toBe(false);
    expect(nativeMenuOpens(mount(document.createElement("div")))).toBe(false);
  });

  it("leaves it to a text field, which needs cut and paste", () => {
    renderHook(() => useNativeContextMenu());
    expect(nativeMenuOpens(mount(document.createElement("input")))).toBe(true);
    expect(nativeMenuOpens(mount(document.createElement("textarea")))).toBe(true);
  });

  it("leaves it to a terminal, which needs paste", () => {
    renderHook(() => useNativeContextMenu());
    const term = mount(document.createElement("div"));
    term.className = "xterm";
    const row = term.appendChild(document.createElement("span"));
    expect(nativeMenuOpens(row)).toBe(true);
  });

  it("leaves it to selected text, which needs copy", () => {
    renderHook(() => useNativeContextMenu());
    const p = mount(document.createElement("p"));
    p.textContent = "a title worth copying";
    window.getSelection()?.selectAllChildren(p);
    expect(nativeMenuOpens(p)).toBe(true);
    // …but only on the selection: a right-click elsewhere while text is
    // selected is a right-click on chrome.
    expect(nativeMenuOpens(mount(document.createElement("button")))).toBe(false);
  });

  // Vitest runs as a dev build, so the escape hatch is live here.
  it("keeps ⌥-right-click for Inspect Element in a dev build", () => {
    renderHook(() => useNativeContextMenu());
    expect(nativeMenuOpens(mount(document.createElement("button")), { altKey: true })).toBe(true);
  });

  it("stops listening once unmounted", () => {
    const { unmount } = renderHook(() => useNativeContextMenu());
    unmount();
    expect(nativeMenuOpens(mount(document.createElement("button")))).toBe(true);
  });
});
