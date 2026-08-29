/**
 * The ring has to disappear for pointer users and come back for keyboard ones —
 * a11y regression territory, and the symptom (a stuck accent ring after a click)
 * is invisible to every other gate.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { initFocusModality } from "./focusModality";

const marked = () => document.documentElement.dataset.pointerNav === "true";

describe("focus modality", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.pointerNav;
    initFocusModality();
  });

  it("marks the document while the user is driving with a pointer", () => {
    expect(marked()).toBe(false);
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(marked()).toBe(true);
  });

  it("clears the mark on a navigation key, so keyboard focus rings again", () => {
    window.dispatchEvent(new PointerEvent("pointerdown"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(marked()).toBe(false);
  });

  /** Typing is not navigating: a character key must not light up rings on
   *  whatever else happens to be focused. */
  it("keeps the pointer mark while the user only types characters", () => {
    window.dispatchEvent(new PointerEvent("pointerdown"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    expect(marked()).toBe(true);
  });

  it("re-marks when the pointer comes back after keyboard use", () => {
    window.dispatchEvent(new PointerEvent("pointerdown"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(marked()).toBe(false);
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(marked()).toBe(true);
  });
});

/**
 * The gate above suppresses an `outline`, and an `outline` is the only thing it
 * can suppress. A component that draws its focus indicator as a Tailwind
 * box-shadow utility instead is therefore *outside* the gate: it survives the
 * pointer mark and leaves an accent box on the control after a plain click —
 * which is exactly how the status bar and the review queue regressed. The needle
 * is assembled at runtime so this file can never match itself.
 */
describe("focus indicators stay reachable by the gate", () => {
  const SOURCES = Object.entries(
    import.meta.glob(["../**/*.{ts,tsx}", "!../bindings.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).filter(([path]) => !/\.test\.tsx?$/.test(path));

  it("draws no focus ring as a box-shadow", () => {
    const boxShadowRing = new RegExp(`focus(-visible)?:(${["ring", "shadow"].join("|")})-`);
    const offenders = SOURCES.filter(([, source]) => boxShadowRing.test(source as string)).map(
      ([path]) => path,
    );
    expect(offenders).toEqual([]);
  });
});
