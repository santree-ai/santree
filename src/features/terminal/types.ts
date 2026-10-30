/**
 * The two seams that keep the terminal engine swappable.
 *
 * `TerminalRenderer` is the VT engine in the webview (xterm.js today; a
 * libghostty-backed, xterm-API-compatible renderer later). `TerminalBackend`
 * talks to the Rust PTY layer. `TerminalView` wires one to the other by session
 * id. Nothing outside the single `XtermRenderer` implementation imports xterm.
 */

import type { AgentKind, PaneLink } from "../../bindings";

export type { PaneLink };

export type SessionId = number;
export type Unsubscribe = () => void;

/** How to spawn a session. Empty `command` ⇒ the user's login shell. */
export interface OpenOpts {
  cwd?: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  /** What this session is called — the surface's `term_key`, exactly, with
   *  nothing appended. Handed back by `adopt` after a reload so the pane that
   *  owns it can find it again. */
  label: string;
  /** Which agent is being launched here; absent for a plain shell. The other
   *  half of the session's identity: a surface hosts one session per provider,
   *  and the backend joins `(label, agentKind)` against `terminal_sessions`'
   *  own primary key to decide whether an agent is still running. */
  agentKind?: AgentKind | null;
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

/** A digit key, as a dialog's numbered rows take them. */
export type DigitKey = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/** A key the user can press from outside the terminal (the Conversation view):
 *  Enter after their paste, Esc for Stop, and `clear`, the keys that empty
 *  Claude Code's input ahead of a send (Ctrl+K then Ctrl+U, sixteen of each,
 *  as one write) — and, to answer a dialog the way its own keys do, Tab, Up
 *  and the digits 1 to 9. */
export type TerminalKey = "enter" | "escape" | "clear" | "tab" | "up" | DigitKey;

/** The VT engine: renders the PTY byte stream and emits keystrokes. */
export interface TerminalRenderer {
  /** Attach to the DOM and start rendering. */
  mount(el: HTMLElement): void;
  /** Bytes from the PTY → screen. */
  write(data: Uint8Array | string): void;
  /** Clear the screen and scrollback — for a view that replays a transcript from
   *  the start rather than appending to what's already there. */
  reset(): void;
  /** Keystrokes → bytes for the PTY. `cb` answers whether the session took them
   *  (the write's own answer), which is how {@link paste} and {@link press}
   *  know their keystrokes arrived. */
  onInput(cb: (data: string) => Promise<boolean>): void;
  /** Paste text the user wrote, as their own paste into the terminal would send
   *  it: the engine encodes it as the program asked (bracketed while the program
   *  has bracketed paste on) and emits it through {@link onInput}, the one way
   *  keystrokes leave a renderer. Control characters other than tab and newline
   *  are dropped first, so nothing in the text can act as a key. Nothing else
   *  may call it with anything but what a user typed. Resolves to whether the
   *  session took all of it — false when nothing was emitted (a disposed pane)
   *  or a write was refused. */
  paste(text: string): Promise<boolean>;
  /** Press one key, emitted through {@link onInput} as the engine encodes it
   *  when typed. Resolves as {@link paste} does. */
  press(key: TerminalKey): Promise<boolean>;
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
  /** Let go of the keyboard, if the terminal has it. */
  blur(): void;
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
  /** Whether the pane reaches its session right now. Only a session on
   *  Daedalus ever reports one: `reconnecting` while the link is down — the
   *  process is still running there, never exited — and `live` once it is
   *  caught up again. */
  onLink?(link: PaneLink): void;
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
  /** Keystrokes, verbatim. A paste is keystrokes too, so nothing may reshape
   *  what goes through here — see `seed` for the one line santree composes.
   *  Resolves to whether the session took them: false when it is gone, or its
   *  link is down and the bytes were dropped. */
  write(id: SessionId, data: string): Promise<boolean>;
  /** Type the one human-initiated launch line, followed by Enter.
   *
   *  Separate from `write` precisely so the backend can tell them apart: a tty
   *  in canonical mode silently truncates a long line (macOS `MAX_CANON` is
   *  1024 bytes), which is how a Codex launch came to sit half-typed at the
   *  prompt. `terminal_seed` spills anything near that limit to a private script
   *  and types a reference to it instead — a rewrite that would be wrong for a
   *  keystroke and is invisible for a seed. The reference follows the seed's own
   *  shape (`exec <path>` for an `exec …` launch line, sourcing otherwise), so a
   *  seed keeps the session lifecycle it would have had if it were typed. */
  seed(id: SessionId, seed: string): void;
  resize(id: SessionId, cols: number, rows: number): void;
  /** End the session and kill its process. */
  close(id: SessionId): void;
}
