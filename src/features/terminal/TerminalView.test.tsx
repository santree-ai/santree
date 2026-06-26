import { render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { TerminalView } from "./TerminalView";
import type { OpenOpts, SessionId, TerminalBackend, TerminalRenderer } from "./types";

class FakeRenderer implements TerminalRenderer {
  mounted = false;
  disposed = false;
  written: (Uint8Array | string)[] = [];
  inputCb?: (data: string) => void;
  mount() {
    this.mounted = true;
  }
  write(d: Uint8Array | string) {
    this.written.push(d);
  }
  onInput(cb: (data: string) => void) {
    this.inputCb = cb;
  }
  resize() {}
  fit() {
    return { cols: 100, rows: 30 };
  }
  focus() {}
  dispose() {
    this.disposed = true;
  }
}

class FakeBackend implements TerminalBackend {
  opened?: OpenOpts;
  outputCb?: (bytes: Uint8Array) => void;
  writes: Array<[SessionId, string]> = [];
  closed: SessionId[] = [];
  async open(opts: OpenOpts) {
    this.opened = opts;
    return 7 as SessionId;
  }
  onOutput(_id: SessionId, cb: (bytes: Uint8Array) => void) {
    this.outputCb = cb;
    return () => {
      this.outputCb = undefined;
    };
  }
  exitCb?: () => void;
  onExit(_id: SessionId, cb: () => void) {
    this.exitCb = cb;
    return () => {
      this.exitCb = undefined;
    };
  }
  write(id: SessionId, data: string) {
    this.writes.push([id, data]);
  }
  resize() {}
  close(id: SessionId) {
    this.closed.push(id);
  }
}

test("TerminalView wires the renderer to the backend and cleans up", async () => {
  const renderer = new FakeRenderer();
  const backend = new FakeBackend();

  const { unmount } = render(
    <TerminalView
      cwd="/tmp"
      command=""
      seed="echo hi"
      backend={backend}
      createRenderer={() => renderer}
    />,
  );

  // Opens a session sized to the fitted grid, in the given cwd.
  await waitFor(() => expect(backend.opened).toBeTruthy());
  expect(renderer.mounted).toBe(true);
  expect(backend.opened).toMatchObject({ cwd: "/tmp", command: "", cols: 100, rows: 30 });

  // Seed is sent as if typed (with a trailing Enter).
  await waitFor(() => expect(backend.writes).toContainEqual([7, "echo hi\r"]));

  // PTY output → renderer.
  backend.outputCb?.(new Uint8Array([104, 105]));
  expect(renderer.written.length).toBeGreaterThan(0);

  // Keystrokes → PTY.
  renderer.inputCb?.("x");
  expect(backend.writes).toContainEqual([7, "x"]);

  // Unmount tears the session and renderer down.
  unmount();
  expect(backend.closed).toContain(7);
  expect(renderer.disposed).toBe(true);
});
