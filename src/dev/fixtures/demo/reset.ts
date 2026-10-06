/**
 * Put the demo back where a run starts. The demo world itself lives in memory,
 * so a reload resets it; what a reload doesn't undo is everything the presenter
 * changed for real along the way — settings (the Remote Control toggle), tab
 * and split layouts, panel widths, selections — so those are snapshotted once
 * and restored before the reload.
 */
import { commands, type Settings } from "../../../bindings";

const KEY = "santree.demo.snapshot";
const KEEP = [KEY, "santree.demo.agentSpeed"];

interface Snapshot {
  local: Record<string, string>;
  settings: Settings | null;
  takenAtMs: number;
}

function read(): Snapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

/** Save the current state as the one every reset returns to. */
export async function saveStartingPoint(): Promise<void> {
  const local: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k !== KEY) local[k] = localStorage.getItem(k) ?? "";
  }
  const res = await commands.getSettings();
  const snapshot: Snapshot = {
    local,
    settings: res.status === "ok" ? res.data : null,
    takenAtMs: Date.now(),
  };
  localStorage.setItem(KEY, JSON.stringify(snapshot));
}

/** The first demo boot becomes the starting point unless one is saved. */
export async function snapshotOnce(): Promise<void> {
  if (!read()) await saveStartingPoint();
}

export const startingPointAt = () => read()?.takenAtMs ?? null;

/** Restore the starting point and reload onto the opening scene. */
export async function resetDemo(): Promise<void> {
  const snapshot = read();
  if (snapshot) {
    if (snapshot.settings) await commands.setSettings(snapshot.settings);
    // The snapshot itself and the demo speed (a presenter's preference, not
    // demo state) survive the reset.
    const keep = KEEP.map((k) => [k, localStorage.getItem(k)] as const);
    localStorage.clear();
    for (const [k, v] of Object.entries(snapshot.local)) localStorage.setItem(k, v);
    for (const [k, v] of keep) if (v !== null) localStorage.setItem(k, v);
  }
  location.replace("/issues");
}
