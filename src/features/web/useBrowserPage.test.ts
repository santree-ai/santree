import { describe, expect, it } from "vitest";

import { holesIn } from "./useBrowserPage";

const page = { x: 100, y: 50, width: 400, height: 300 };
const overlay = (left: number, top: number, right: number, bottom: number, radius = 8) => ({
  left,
  top,
  right,
  bottom,
  radius,
});

// A page is a native view above the app: an overlay that crosses it is cut out
// of it, and one that covers it (a modal) makes it stand aside for a still. Get
// either wrong and the overlay is drawn under the page, out of sight.
describe("holesIn", () => {
  it("cuts a crossing overlay out, page-relative, and covers for a modal", () => {
    expect(holesIn(page, [])).toEqual([]);
    // A menu dropping from the tab strip into the page.
    expect(holesIn(page, [overlay(380, 30, 560, 200)])).toEqual([
      { rect: { x: 280, y: -20, width: 180, height: 170 }, radius: 8 },
    ]);
    // A toast beside the page, not over it.
    expect(holesIn(page, [overlay(600, 400, 900, 460)])).toEqual([]);
    // A modal's scrim: the whole window.
    expect(holesIn(page, [overlay(80, 300, 200, 360), overlay(0, 0, 1200, 800, 0)])).toBe(
      "covered",
    );
  });
});
