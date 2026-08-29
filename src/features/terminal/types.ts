/**
 * The two seams that keep the terminal engine swappable.
 *
 * `TerminalRenderer` is the VT engine in the webview (xterm.js today; a
 * libghostty-backed, xterm-API-compatible renderer later). `TerminalBackend`
 * talks to the Rust PTY layer. `TerminalView` wires one to the other by session
 * id. Nothing outside the single `XtermRenderer` implementation imports xterm.
 */

export type SessionId = number;
export type Unsubscribe = () => void;

/** How to spawn a session. Empty `command` ⇒ the user's login shell. */
export interface OpenOpts {
  cwd?: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  /** What this session is called — the surface's `term_key`. Handed back by
   *  `adopt` after a reload so the pane that owns it can find it again. */
  label: string;
}

/** Where a client is in a session's output stream.
 *
 *  `Fresh` and `Unknown` are not the same thing and the difference is the whole
 *  point: a terminal with nothing on it wants every byte the backend still has,
 *  while a terminal that has content it can't place wants none of them. Sending
 *  the ring to the second one paints a duplicate of what is already on screen. */
export type Anchor =
  | { kind: "at"; epoch: string; seq: number }
  | { kind: "fresh" }
  | { kind: "unknown" };

/** What the backend could do about the gap. `reanchor` means it sent nothing —
 *  the pane keeps what it has, and the program is asked to repaint. */
export type ReplayMode = "exact" | "tail" | "reanchor";

/** Where the client is once it has written everything `attach` delivered.
 *
 *  `seq` is nullable because the bridge carries it as a double and specta types
 *  those as `number | null` (JSON has no NaN). A null is not a position, so it
 *  must be treated as "no anchor" rather than coerced to zero — no anchor
 *  degrades to a full replay, while a wrong one silently skips bytes forever. */
export interface Attached {
  epoch: string;
  seq: number | null;
  mode: ReplayMode;
}

/** The VT engine: renders the PTY byte stream and emits keystrokes. */
export interface TerminalRenderer {
  /** Attach to the DOM and start rendering. */
  mount(el: HTMLElement): void;
  /** Bytes from the PTY → screen. */
  write(data: Uint8Array | string): void;
  /** Clear the screen and scrollback — for a view that replays a transcript from
   *  the start rather than appending to what's already there. */
  reset(): void;
  /** Keystrokes → bytes for the PTY. */
  onInput(cb: (data: string) => void): void;
  /** The hosted program set the window title (OSC 0/2).
   *
   *  Read-only, and required to stay that way: santree renders it as a status
   *  dot and nothing else (see `agentTitle.ts` for the compliance boundary). */
  onTitle(cb: (title: string) => void): void;
  /** Force the grid to a specific size. */
  resize(cols: number, rows: number): void;
  /** Fit the grid to the mounted element; returns the new size. */
  fit(): { cols: number; rows: number };
  /** Give the terminal keyboard focus. */
  focus(): void;
  /** Tear down and release all resources. */
  dispose(): void;
}

/** How a pane receives one session's stream. Passed at open/attach time rather
 *  than subscribed afterwards, so there is never a window where bytes arrive
 *  with nobody to give them to — which is what the old pre-subscribe buffer
 *  existed to paper over, unboundedly. */
export interface OutputHandlers {
  onOutput(bytes: Uint8Array): void;
  /** The hosted process exited. Fires at most once. */
  onExit(): void;
}

/** The transport to the local Rust PTY layer (one implementation over Tauri). */
export interface TerminalBackend {
  /** Spawn a new session. */
  open(opts: OpenOpts, handlers: OutputHandlers): Promise<SessionId>;
  /** Point an existing session's output here and catch this client up.
   *
   *  This is what survives a pane unmounting or the whole page reloading: the
   *  session never stopped, and `anchor` says how much of it this client has
   *  already seen. */
  attach(id: SessionId, anchor: Anchor, handlers: OutputHandlers): Promise<Attached>;
  /** Stop receiving a session's output without ending it. */
  detach(id: SessionId): void;
  /** Claim the sessions a previous page load left running, by `label`. */
  adopt(owner: string): Promise<Map<string, SessionId>>;
  write(id: SessionId, data: string): void;
  resize(id: SessionId, cols: number, rows: number): void;
  /** End the session and kill its process. */
  close(id: SessionId): void;
}
