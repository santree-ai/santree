/**
 * When a snooze wakes.
 *
 * Linear's own quick picks land on a morning, not on the same minute N days
 * out: "tomorrow" means tomorrow when you sit down, so each option is 9:00
 * local on the day it names. Pure, so the two rows the triage menu offers can
 * be pinned without a clock.
 */
export const WAKE_HOUR = 9;

export function snoozeUntil(nowMs: number, days: number): number {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + days);
  d.setHours(WAKE_HOUR, 0, 0, 0);
  return d.getTime();
}
