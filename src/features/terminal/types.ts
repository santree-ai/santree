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
  /** Force the grid to a specific size. */
  resize(cols: number, rows: number): void;
  /** Fit the grid to the mounted element; returns the new size. */
  fit(): { cols: number; rows: number };
  /** Give the terminal keyboard focus. */
  focus(): void;
  /** Tear down and release all resources. */
  dispose(): void;
}

/** The transport to the local Rust PTY layer (one implementation over Tauri). */
export interface TerminalBackend {
  open(opts: OpenOpts): Promise<SessionId>;
  write(id: SessionId, data: string): void;
  resize(id: SessionId, cols: number, rows: number): void;
  onOutput(id: SessionId, cb: (bytes: Uint8Array) => void): Unsubscribe;
  /** Fires once when the hosted process exits (so the pane can be torn down). */
  onExit(id: SessionId, cb: () => void): Unsubscribe;
  close(id: SessionId): void;
}
