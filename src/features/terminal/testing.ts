/**
 * Test-only: the fakes every test that mounts the real `TerminalLayer` needs —
 * a renderer (xterm wants a canvas and WebGL, neither in jsdom), the Tauri
 * backend, and the two reads the layer makes. One copy, so a new layer read or
 * renderer method is added here and not in each file.
 *
 * Used from `vi.mock` factories, which are hoisted above imports:
 *
 *   vi.mock("./XtermRenderer", async () => ({
 *     XtermRenderer: (await import("./testing")).FakeXtermRenderer,
 *   }));
 */
import { vi } from "vitest";

import type { AdoptedSession, ServerStatus } from "../../bindings";
import type { SessionId, TerminalRenderer } from "./types";

/** A renderer that draws nothing. Every one built is in {@link FakeXtermRenderer.built},
 *  in mount order; `input` is set once its pane's session is open, which is the
 *  signal that the open/attach round-trip finished. */
export class FakeXtermRenderer implements TerminalRenderer {
  static built: FakeXtermRenderer[] = [];
  input?: (data: string) => void;
  untrusted: boolean;
  constructor(opts: { untrusted?: boolean } = {}) {
    this.untrusted = !!opts.untrusted;
    FakeXtermRenderer.built.push(this);
  }
  mount() {}
  write() {}
  reset() {}
  onInput(cb: (data: string) => void) {
    this.input = cb;
  }
  onTitle() {}
  resize() {}
  fit() {
    return { cols: 80, rows: 24 };
  }
  focus() {}
  dispose() {}
}

/** The `tauriBackend` singleton, with `adoptSessions` answering `adopted()` (none
 *  by default) and every open answering `openedId`. */
export function fakeTauriBackend(
  adopted: () => AdoptedSession[] = () => [],
  openedId: SessionId = 7,
) {
  return {
    adoptSessions: vi.fn(async () => adopted()),
    open: vi.fn(async () => openedId),
    attach: vi.fn(async () => ({ epoch: "e", seq: 0, mode: "tail" as const })),
    detach: vi.fn(),
    write: vi.fn(),
    seed: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  };
}

/** What the layer's reads answer. Mutable: a test changes it and re-renders. */
export interface LayerWorld {
  repos: { name: string; location: string; path: string | null }[];
  server?: Pick<ServerStatus, "state">;
}

/** The `lib/queries` hooks `TerminalLayer` reads, over `world`. */
export function layerQueries(world: LayerWorld) {
  return {
    useRepos: () => ({ data: world.repos, isFetched: true }),
    useServerStatus: () => ({ data: world.server }),
  };
}
