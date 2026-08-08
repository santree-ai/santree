import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ZOOM, loadZoom, nearestStep, step, ZOOM_KEY, ZOOM_STEPS } from "./zoom";

describe("zoom ladder", () => {
  beforeEach(() => localStorage.clear());

  it("always contains exactly 1, so ⌘0 lands on a real rung", () => {
    // A ladder you can't return to normal from is the complaint people actually
    // file about zoom controls.
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
    expect(step(step(DEFAULT_ZOOM, 1), -1)).toBe(DEFAULT_ZOOM);
  });

  it("steps up and down through neighbouring rungs", () => {
    expect(step(1, 1)).toBe(1.1);
    expect(step(1, -1)).toBe(0.9);
    expect(step(1.25, 1)).toBe(1.5);
  });

  it("clamps at both ends instead of running off the ladder", () => {
    const [min] = ZOOM_STEPS;
    const max = ZOOM_STEPS[ZOOM_STEPS.length - 1];
    expect(step(min, -1)).toBe(min);
    expect(step(max, 1)).toBe(max);
  });

  it("snaps an off-ladder value to the nearest rung before stepping", () => {
    // A value can arrive off-ladder from a hand-edited localStorage or an older
    // build's steps; stepping from it must still land somewhere real.
    expect(nearestStep(1.04)).toBe(1);
    expect(nearestStep(1.6)).toBe(1.5);
    expect(step(1.04, 1)).toBe(1.1);
  });

  it("falls back to normal size for anything unusable in storage", () => {
    for (const bad of ["", "null", "not json", '"1.2"', "-3", "0"]) {
      localStorage.setItem(ZOOM_KEY, bad);
      // A corrupt level must never render the app at 0× or a negative scale.
      expect(loadZoom()).toBe(DEFAULT_ZOOM);
    }
  });

  it("restores a previously stored level", () => {
    localStorage.setItem(ZOOM_KEY, JSON.stringify(1.25));
    expect(loadZoom()).toBe(1.25);
  });
});
