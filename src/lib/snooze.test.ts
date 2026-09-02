import { describe, expect, it } from "vitest";

import { snoozeUntil, WAKE_HOUR } from "./snooze";

describe("snoozeUntil", () => {
  it("wakes at nine in the morning on the day it names, not N×24h out", () => {
    const now = new Date(2026, 8, 2, 17, 45).getTime();
    const tomorrow = new Date(snoozeUntil(now, 1));
    expect([tomorrow.getMonth(), tomorrow.getDate()]).toEqual([8, 3]);
    expect([tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([WAKE_HOUR, 0]);

    const week = new Date(snoozeUntil(now, 7));
    expect([week.getMonth(), week.getDate(), week.getHours()]).toEqual([8, 9, WAKE_HOUR]);
  });

  it("rolls over a month boundary", () => {
    const now = new Date(2026, 8, 30, 8, 0).getTime();
    const d = new Date(snoozeUntil(now, 1));
    expect([d.getMonth(), d.getDate()]).toEqual([9, 1]);
  });
});
