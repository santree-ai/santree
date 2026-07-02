/**
 * `TerminalBackend` over Tauri IPC. Output streams from Rust on a Tauri
 * `Channel` (raw byte chunks, delivered as `ArrayBuffer` — see `terminal::RawBytes`
 * in `terminal.rs`), not `emit` — the right primitive for high-frequency terminal
 * output. This is local in-process plumbing carrying the PTY byte stream, exactly
 * like VS Code's renderer↔pty-host split.
 */
import { Channel } from "@tauri-apps/api/core";

import { commands } from "../../bindings";
import type { OpenOpts, SessionId, TerminalBackend, Unsubscribe } from "./types";

interface Sink {
  cb?: (bytes: Uint8Array) => void;
  /** Bytes that arrived before a subscriber attached, replayed on subscribe. */
  buffer: Uint8Array[];
  /** Exit-sentinel handler + whether the process has already exited. */
  exitCb?: () => void;
  exited: boolean;
}

export class TauriBackend implements TerminalBackend {
  private sinks = new Map<SessionId, Sink>();

  async open(opts: OpenOpts): Promise<SessionId> {
    const sink: Sink = { buffer: [], exited: false };
    // The backend sends raw bytes (`InvokeResponseBody::Raw`, not JSON), so Tauri
    // delivers each chunk here as an `ArrayBuffer` rather than a JSON array of
    // decimal integers — avoids JSON-parsing megabytes of terminal output on
    // high-throughput streams (verbose builds, `cat` of a large file).
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (chunk) => {
      // An empty chunk is the PTY exit sentinel (the process ended). Real output
      // chunks are never empty.
      if (chunk.byteLength === 0) {
        sink.exited = true;
        sink.exitCb?.();
        return;
      }
      const bytes = new Uint8Array(chunk);
      if (sink.cb) sink.cb(bytes);
      else sink.buffer.push(bytes);
    };

    const result = await commands.terminalOpen(
      {
        cwd: opts.cwd ?? null,
        command: opts.command,
        args: opts.args,
        cols: opts.cols,
        rows: opts.rows,
      },
      channel,
    );
    if (result.status === "error") throw new Error(result.error);
    this.sinks.set(result.data, sink);
    return result.data;
  }

  onOutput(id: SessionId, cb: (bytes: Uint8Array) => void): Unsubscribe {
    const sink = this.sinks.get(id);
    if (!sink) return () => {};
    sink.cb = cb;
    for (const chunk of sink.buffer) cb(chunk);
    sink.buffer = [];
    return () => {
      if (sink.cb === cb) sink.cb = undefined;
    };
  }

  onExit(id: SessionId, cb: () => void): Unsubscribe {
    const sink = this.sinks.get(id);
    if (!sink) return () => {};
    if (sink.exited) {
      cb();
      return () => {};
    }
    sink.exitCb = cb;
    return () => {
      if (sink.exitCb === cb) sink.exitCb = undefined;
    };
  }

  write(id: SessionId, data: string) {
    void commands.terminalWrite(id, data);
  }

  resize(id: SessionId, cols: number, rows: number) {
    void commands.terminalResize(id, cols, rows);
  }

  close(id: SessionId) {
    this.sinks.delete(id);
    void commands.terminalClose(id);
  }
}

/** Shared singleton — all terminals in the app talk to the one PTY manager. */
export const tauriBackend = new TauriBackend();
