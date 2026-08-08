/**
 * App-wide text size, as webview zoom.
 *
 * Deliberately *not* a font-size scale: this codebase sizes everything in
 * arbitrary pixel values (`text-[12.5px]`, `h-[21px]`, …), so changing the root
 * font-size would move the text and leave every box, icon and gutter behind.
 * Webview zoom scales the rendered page the way a browser's ⌘+/⌘- does, so
 * proportions hold — and xterm re-fits on its own, since the terminals already
 * watch their container with a `ResizeObserver`.
 *
 * The level is chrome, not behaviour, so it lives in `localStorage` rather than
 * the settings table — and it has to be re-applied on every launch, because the
 * webview always starts at 1.
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Persisted level. Namespaced like the rest of the app's localStorage keys. */
export const ZOOM_KEY = "santree.zoom";

/**
 * The ladder ⌘+/⌘- walks. A fixed ladder rather than a multiplier so the steps
 * are predictable and always land back on exactly 1 — a zoom you can't return to
 * "normal" from is the thing people actually complain about.
 */
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export const DEFAULT_ZOOM = 1;

/** The nearest rung to `level`, so a hand-edited or legacy value still steps. */
export function nearestStep(level: number): number {
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - level) < Math.abs(best - level) ? s : best));
}

/** One rung up (`+1`) or down (`-1`), clamped at the ends. */
export function step(level: number, direction: 1 | -1): number {
  const i = ZOOM_STEPS.indexOf(nearestStep(level) as (typeof ZOOM_STEPS)[number]);
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + direction));
  return ZOOM_STEPS[next];
}

/** The stored level, or {@link DEFAULT_ZOOM}. Never throws — a corrupt or absent
 *  value simply means "normal size". */
export function loadZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (!raw) return DEFAULT_ZOOM;
    // Only the shape we write counts. Coercing (`Number("1.2")`) would also accept
    // `null`, `[]` and `""` as numbers, so anything that isn't literally a number
    // is treated as absent rather than guessed at.
    const n: unknown = JSON.parse(raw);
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? nearestStep(n) : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}

/**
 * Apply `level` to the webview and remember it.
 *
 * Both halves are best-effort: outside Tauri (tests, a plain browser) there's no
 * webview to zoom, and localStorage can refuse writes. Neither is worth failing a
 * keystroke over.
 */
export async function applyZoom(level: number): Promise<void> {
  try {
    localStorage.setItem(ZOOM_KEY, JSON.stringify(level));
  } catch {
    // Quota or a privacy mode; the level still applies for this session.
  }
  try {
    await getCurrentWebview().setZoom(level);
  } catch {
    // Not running in a webview (or the permission is missing) — nothing to scale.
  }
}
