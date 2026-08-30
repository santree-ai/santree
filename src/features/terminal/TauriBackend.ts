/**
 * `TerminalBackend` over Tauri IPC. Output streams from Rust on a Tauri
 * `Channel` (raw byte chunks, delivered as `ArrayBuffer` — see `terminal::RawBytes`
 * in `terminal.rs`), not `emit` — the right primitive for high-frequency terminal
 * output. This is local in-process plumbing carrying the PTY byte stream, exactly
 * like VS Code's renderer↔pty-host split.
 *
 * A session is not owned by the channel it is currently streaming to. `attach`
 * swaps in a new one and the backend catches this client up from what it kept,
 * which is what lets a pane unmount — or the whole page reload — without ending
 * the process. See `docs/terminals.md`.
 */
import { Channel } from "@tauri-apps/api/core";

import { commands, type TerminalAnchor } from "../../bindings";
import { PAGE_OWNER } from "./pageOwner";
import { paneAddress } from "./paneAddress";
import type {
  Anchor,
  Attached,
  OpenOpts,
  OutputHandlers,
  SessionId,
  TerminalBackend,
} from "./types";

/** Bridge one output channel to a pane's handlers.
 *
 *  An empty chunk is the PTY exit sentinel; real output chunks are never empty,
 *  so empty is unambiguous. `exited` latches because the sentinel is the last
 *  thing a session ever sends and a pane must not be torn down twice. */
function channelFor(handlers: OutputHandlers): Channel<ArrayBuffer> {
  const channel = new Channel<ArrayBuffer>();
  let exited = false;
  channel.onmessage = (chunk) => {
    if (chunk.byteLength === 0) {
      if (exited) return;
      exited = true;
      handlers.onExit();
      return;
    }
    handlers.onOutput(new Uint8Array(chunk));
  };
  return channel;
}

const toBinding = (anchor: Anchor): TerminalAnchor =>
  anchor.kind === "at"
    ? { kind: "at", epoch: anchor.epoch, seq: anchor.seq }
    : { kind: anchor.kind };

export class TauriBackend implements TerminalBackend {
  async open(opts: OpenOpts, handlers: OutputHandlers): Promise<SessionId> {
    // The backend sends raw bytes (`InvokeResponseBody::Raw`, not JSON), so Tauri
    // delivers each chunk here as an `ArrayBuffer` rather than a JSON array of
    // decimal integers — avoids JSON-parsing megabytes of terminal output on
    // high-throughput streams (verbose builds, `cat` of a large file).
    const result = await commands.terminalOpen(
      {
        cwd: opts.cwd ?? null,
        command: opts.command,
        args: opts.args,
        cols: opts.cols,
        rows: opts.rows,
        // Tags the session with this page load, so the next one can adopt it
        // rather than start over (see PAGE_OWNER).
        owner: PAGE_OWNER,
        label: opts.label,
        // The provider as its own field, never appended to the label: the label
        // is joined byte-for-byte against `terminal_sessions.term_key`, which
        // keys the same surface by a separate provider column.
        agentKind: opts.agentKind ?? null,
      },
      channelFor(handlers),
    );
    if (result.status === "error") throw new Error(result.error);
    return result.data;
  }

  async attach(id: SessionId, anchor: Anchor, handlers: OutputHandlers): Promise<Attached> {
    const result = await commands.terminalAttach(id, toBinding(anchor), channelFor(handlers));
    if (result.status === "error") throw new Error(result.error);
    return result.data;
  }

  detach(id: SessionId) {
    void commands.terminalDetach(id);
  }

  async adopt(owner: string): Promise<Map<string, SessionId>> {
    const result = await commands.terminalAdopt(owner);
    if (result.status === "error") throw new Error(result.error);
    // Keyed by the pane's address — the surface's `term_key` AND the provider
    // in it — because that is what a pane coming up knows about itself, and
    // because one surface can have a pane per provider (a Claude and a Codex
    // review of the same PR): keyed by label alone, both would adopt the same
    // session and the other would be stranded. A session nothing claims stays
    // alive and unattached; it costs a ring and a shell until the app exits,
    // which is strictly better than killing work the user can still get back to.
    return new Map(result.data.map((s) => [paneAddress(s.label, s.agentKind), s.id]));
  }

  write(id: SessionId, data: string) {
    void commands.terminalWrite(id, data);
  }

  seed(id: SessionId, seed: string) {
    void commands.terminalSeed(id, seed);
  }

  resize(id: SessionId, cols: number, rows: number) {
    void commands.terminalResize(id, cols, rows);
  }

  close(id: SessionId) {
    void commands.terminalClose(id);
  }
}

/** Shared singleton — all terminals in the app talk to the one PTY manager. */
export const tauriBackend = new TauriBackend();
