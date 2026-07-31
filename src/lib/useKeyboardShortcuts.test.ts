/**
 * The global shortcut map (⌘1…⌘N / ⌘; / ⌘B / ⌘/ / Esc) and the shared 1..N
 * digit listener the dropdown menus mount. Both are window-level keydown
 * handlers, so the risks are the same: firing on a shifted/alt'd combo, stealing
 * a key from a text field, and outliving the component that bound them.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ pathname: "/", navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: router.pathname } }),
}));

const app = vi.hoisted(() => ({
  triageEnabled: false,
  devEnabled: false,
  toggleSidebar: vi.fn(),
  toggleShortcuts: vi.fn(),
}));
vi.mock("../state/AppContext", () => ({
  useAppOptional: () => ({ triageEnabled: app.triageEnabled, devEnabled: app.devEnabled }),
  useAppUiOptional: () => ({
    toggleSidebar: app.toggleSidebar,
    toggleShortcuts: app.toggleShortcuts,
  }),
}));

import {
  inEditable,
  targetOwnsKey,
  useDigitShortcuts,
  useKeyboardShortcuts,
} from "./useKeyboardShortcuts";

/** Dispatch a keydown the way the browser would — from the focused element, so
 *  the handler's `e.target` is the field the user is typing in. */
function press(key: string, opts: KeyboardEventInit & { on?: Element } = {}) {
  const { on, ...init } = opts;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    (on ?? window).dispatchEvent(event);
  });
  return event;
}

function typeInto(tag: "input" | "textarea") {
  const el = document.createElement(tag);
  document.body.append(el);
  return el;
}

/** xterm's DOM: a hidden textarea (so `inEditable` says yes) inside `.xterm`. */
function typeIntoTerminal() {
  const term = document.createElement("div");
  term.className = "xterm";
  const helper = document.createElement("textarea");
  helper.className = "xterm-helper-textarea";
  term.append(helper);
  document.body.append(term);
  return helper;
}

/** `targetOwnsKey` takes the event; build one without dispatching it. */
function keyOn(el: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, ...init });
  Object.defineProperty(event, "target", { value: el });
  return event;
}

beforeEach(() => {
  router.pathname = "/";
  router.navigate.mockClear();
  app.triageEnabled = false;
  app.devEnabled = false;
  app.toggleSidebar.mockClear();
  app.toggleShortcuts.mockClear();
  document.body.innerHTML = "";
});

describe("inEditable", () => {
  it("is true for the fields keystrokes belong to", () => {
    expect(inEditable(typeInto("input"))).toBe(true);
    expect(inEditable(typeInto("textarea"))).toBe(true);
    const div = document.createElement("div");
    div.contentEditable = "true";
    // jsdom doesn't derive `isContentEditable` from the attribute.
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(inEditable(div)).toBe(true);
  });

  it("is false for anything else", () => {
    expect(inEditable(document.createElement("div"))).toBe(false);
    expect(inEditable(document.createElement("button"))).toBe(false);
    expect(inEditable(null)).toBe(false);
  });
});

describe("targetOwnsKey", () => {
  it("hands a text field every key, modified or not", () => {
    const field = typeInto("input");
    expect(targetOwnsKey(keyOn(field, "l"))).toBe(true);
    expect(targetOwnsKey(keyOn(field, "l", { metaKey: true }))).toBe(true);
    expect(targetOwnsKey(keyOn(field, "t", { ctrlKey: true }))).toBe(true);
  });

  it("leaves ⌘-chords to the app while a terminal has focus", () => {
    // The whole point: ⌘T/⌘L/⌘1 are app chrome — a shell has no use for them,
    // so an agent session must not swallow them the way a text field does.
    const term = typeIntoTerminal();
    expect(targetOwnsKey(keyOn(term, "t", { metaKey: true }))).toBe(false);
    expect(targetOwnsKey(keyOn(term, "l", { metaKey: true }))).toBe(false);
    expect(targetOwnsKey(keyOn(term, "1", { metaKey: true }))).toBe(false);
  });

  it("still gives the terminal its unmodified keys and Ctrl-chords", () => {
    // ^C / ^D / ^R belong to the shell on every platform — releasing those would
    // break the terminal to fix the chrome.
    const term = typeIntoTerminal();
    expect(targetOwnsKey(keyOn(term, "l"))).toBe(true);
    expect(targetOwnsKey(keyOn(term, "Escape"))).toBe(true);
    expect(targetOwnsKey(keyOn(term, "c", { ctrlKey: true }))).toBe(true);
    expect(targetOwnsKey(keyOn(term, "l", { ctrlKey: true }))).toBe(true);
  });

  it("is false with focus nowhere in particular", () => {
    expect(targetOwnsKey(keyOn(document.createElement("div"), "l", { metaKey: true }))).toBe(false);
  });
});

describe("useKeyboardShortcuts", () => {
  it("maps ⌘1…⌘N to the tabs in NavTabs order, Triage leading the repo-scoped ones", () => {
    app.triageEnabled = true;
    renderHook(() => useKeyboardShortcuts());

    for (const [key, to] of [
      ["1", "/"],
      ["2", "/triage"],
      ["3", "/issues"],
      ["4", "/trees"],
      ["5", "/reviews"],
    ]) {
      router.navigate.mockClear();
      press(key, { metaKey: true });
      expect(router.navigate).toHaveBeenCalledWith({ to });
    }
  });

  it("puts Dev second, beside Agents, since neither is repo-scoped", () => {
    app.triageEnabled = true;
    app.devEnabled = true;
    renderHook(() => useKeyboardShortcuts());

    for (const [key, to] of [
      ["1", "/"],
      ["2", "/dev"],
      ["3", "/triage"],
      ["4", "/issues"],
      ["5", "/trees"],
      ["6", "/reviews"],
    ]) {
      router.navigate.mockClear();
      press(key, { metaKey: true });
      expect(router.navigate).toHaveBeenCalledWith({ to });
    }
  });

  it("shifts the numbers up when Triage is disabled (no gap, no dead ⌘5)", () => {
    renderHook(() => useKeyboardShortcuts());

    press("1", { metaKey: true });
    expect(router.navigate).toHaveBeenCalledWith({ to: "/" });
    press("4", { metaKey: true });
    expect(router.navigate).toHaveBeenCalledWith({ to: "/reviews" });

    router.navigate.mockClear();
    press("5", { metaKey: true });
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("takes Dev's slot away — and shifts the rest back — once it's disabled", () => {
    app.devEnabled = true;
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    press("2", { metaKey: true });
    expect(router.navigate).toHaveBeenCalledWith({ to: "/dev" });
    unmount();

    app.devEnabled = false;
    router.navigate.mockClear();
    renderHook(() => useKeyboardShortcuts());
    press("2", { metaKey: true });
    expect(router.navigate).toHaveBeenCalledWith({ to: "/issues" });

    router.navigate.mockClear();
    press("5", { metaKey: true });
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("ignores ⌘0 now that there is no terminal page", () => {
    renderHook(() => useKeyboardShortcuts());

    press("0", { metaKey: true });
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("opens Settings with ⌘; and ⌘,", () => {
    renderHook(() => useKeyboardShortcuts());

    press(";", { metaKey: true });
    press(",", { ctrlKey: true });

    expect(router.navigate).toHaveBeenCalledTimes(2);
    expect(router.navigate).toHaveBeenCalledWith({ to: "/settings" });
  });

  it("toggles the sidebar (⌘B) and the shortcuts overlay (⌘/)", () => {
    renderHook(() => useKeyboardShortcuts());

    press("b", { metaKey: true });
    press("/", { metaKey: true });

    expect(app.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(app.toggleShortcuts).toHaveBeenCalledTimes(1);
  });

  // Shift is never part of a global binding: ⌘⇧; (and any other shifted combo
  // whose base key matches) must not fire the unshifted shortcut.
  it("ignores a shifted or alt'd combo, and a bare digit", () => {
    renderHook(() => useKeyboardShortcuts());

    press(";", { metaKey: true, shiftKey: true });
    press("1", { metaKey: true, altKey: true });
    press("b", { metaKey: true, shiftKey: true });
    press("1");

    expect(router.navigate).not.toHaveBeenCalled();
    expect(app.toggleSidebar).not.toHaveBeenCalled();
  });

  it("Esc leaves Settings for the view it was opened from", () => {
    router.pathname = "/trees";
    const { rerender } = renderHook(() => useKeyboardShortcuts());

    router.pathname = "/settings";
    rerender();
    press("Escape");

    expect(router.navigate).toHaveBeenCalledWith({ to: "/trees" });
  });

  it("Esc does nothing outside Settings, and is never stolen from an open field", () => {
    router.pathname = "/trees";
    const { rerender } = renderHook(() => useKeyboardShortcuts());
    press("Escape");
    expect(router.navigate).not.toHaveBeenCalled();

    router.pathname = "/settings";
    rerender();
    // Esc in a settings text field belongs to the field (cancel the edit), not
    // to the router.
    press("Escape", { on: typeInto("input") });

    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("unbinds on unmount", () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    unmount();

    press("1", { metaKey: true });

    expect(router.navigate).not.toHaveBeenCalled();
  });
});

describe("useDigitShortcuts", () => {
  it("runs the row the digit names", () => {
    const rows = [vi.fn(), vi.fn(), vi.fn()];
    renderHook(() => useDigitShortcuts(rows));

    const event = press("2");

    expect(rows[1]).toHaveBeenCalledTimes(1);
    expect(rows[0]).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  // A disabled/WIP row (the new-tab menu's "Web") still owns its number: the key
  // must be swallowed, not fall through to whatever else listens for it.
  it("swallows the digit of an inert row without running anything", () => {
    const rows = [vi.fn(), null];
    renderHook(() => useDigitShortcuts(rows));

    const event = press("2");

    expect(rows[0]).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves digits outside the menu's range alone", () => {
    const rows = [vi.fn()];
    renderHook(() => useDigitShortcuts(rows));

    const zero = press("0");
    const past = press("2");

    expect(rows[0]).not.toHaveBeenCalled();
    expect(zero.defaultPrevented).toBe(false);
    expect(past.defaultPrevented).toBe(false);
  });

  it("ignores a modified digit (⌘1 is a tab shortcut) and one typed into a field", () => {
    const rows = [vi.fn()];
    renderHook(() => useDigitShortcuts(rows));

    press("1", { metaKey: true });
    press("1", { ctrlKey: true });
    press("1", { altKey: true });
    press("1", { on: typeInto("input") });
    press("1", { on: typeInto("textarea") });
    // A bare digit typed at a shell is the shell's, even though ⌘-chords aren't.
    press("1", { on: typeIntoTerminal() });

    expect(rows[0]).not.toHaveBeenCalled();
  });

  // The menu rebuilds its row callbacks on every render (fresh closures over the
  // opener list), so the listener has to read them live — otherwise it either
  // re-subscribes on every keystroke or fires a stale row's action.
  it("runs the current rows after a re-render, not the ones bound at mount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ rows }) => useDigitShortcuts(rows), {
      initialProps: { rows: [first] as ((() => void) | null)[] },
    });

    rerender({ rows: [second] });
    press("1");

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("unbinds on unmount (the menu closed — its digits are the app's again)", () => {
    const rows = [vi.fn()];
    const { unmount } = renderHook(() => useDigitShortcuts(rows));
    unmount();

    press("1");

    expect(rows[0]).not.toHaveBeenCalled();
  });
});
