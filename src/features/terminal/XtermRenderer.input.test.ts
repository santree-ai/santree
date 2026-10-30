/**
 * What the Conversation view's composer types, against the real xterm (the
 * other renderer tests fake it): a paste or a key press leaves through the one
 * input callback the pane wires to the session's writer, and answers with that
 * writer's answer. The composer clears a draft only on a yes — a write the
 * session refused used to be dropped while the draft was cleared all the same.
 */
import { afterEach, expect, test, vi } from "vitest";

// No WebGL in jsdom, and nothing here is drawn.
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    activate() {}
    dispose() {}
  },
}));

import { inputReached, quietSince, untracked, watchInput } from "./inputWatch";
import { XtermRenderer } from "./XtermRenderer";

afterEach(() => vi.unstubAllGlobals());

/** A real xterm, mounted, with everything it emits recorded. */
function mounted(answer: (data: string) => boolean = () => true) {
  // xterm reads the pixel ratio as it opens; jsdom has no matchMedia.
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  const renderer = new XtermRenderer();
  renderer.mount(document.body.appendChild(document.createElement("div")));
  const written: string[] = [];
  renderer.onInput(async (data) => {
    written.push(data);
    return answer(data);
  });
  return { renderer, written };
}

// The clear is one write of its own: sent in the paste's write, Ctrl+U arrived
// in Claude's input as a literal character (Orca #11253).
test("a paste or a key press is one write, and answers with its write's answer, so a refused one keeps the draft", async () => {
  const { renderer, written } = mounted((data) => data !== "refused");

  expect(await renderer.press("clear")).toBe(true);
  expect(await renderer.paste("hello")).toBe(true);
  expect(await renderer.press("enter")).toBe(true);
  expect(await renderer.press("escape")).toBe(true);
  expect(await renderer.paste("refused")).toBe(false);
  expect(written).toEqual([
    "\x0b".repeat(16) + "\x15".repeat(16),
    "hello",
    "\r",
    "\x1b",
    "refused",
  ]);

  // A pane that is gone types nothing, and says so.
  renderer.dispose();
  expect(await renderer.paste("late")).toBe(false);
  expect(written).toHaveLength(5);
});

// The input watch leaves an answer's keys out by flagging the call that types
// them (`inputWatch.untracked`). That holds only because xterm emits a paste's
// or a key's bytes before `paste` or `input` returns: a write made later would
// be counted, and a flag left up would hide the next one's.
test("a paste or a key press reaches the writer before it returns, so only its own writes go untracked", async () => {
  const { renderer, written } = mounted();
  renderer.write("\x1b[?2004h"); // bracketed paste on, as Claude sets it
  await new Promise((settle) => setTimeout(settle, 0));
  // The pane's writer, as `TerminalView` wires it.
  renderer.onInput(async (data) => {
    inputReached(7, data);
    return true;
  });
  const unwatch = watchInput(7);
  const from = Date.now();

  const pressed = untracked(() => renderer.press("1"));
  const pasted = untracked(() => renderer.paste("Also log it"));
  // Both written before their calls returned, and neither counted.
  expect(written).toEqual(["1", "\x1b[200~Also log it\x1b[201~"]);
  expect(quietSince(7, from)).toBe(true);
  expect(await pressed).toBe(true);
  expect(await pasted).toBe(true);
  // The next write, not flagged, is counted.
  await renderer.press("enter");
  expect(quietSince(7, from)).toBe(false);
  unwatch();
  renderer.dispose();
});

// xterm brackets a paste verbatim. A draft carrying the bracket's own end
// marker closed it early, and what followed — a Ctrl-C, Claude's `!` bash mode,
// an Enter — arrived as keys the user never pressed.
test("a paste cannot close its own bracket: its control characters are dropped", async () => {
  const { renderer, written } = mounted();
  renderer.write("\x1b[?2004h"); // the program turns bracketed paste on
  await new Promise((settle) => setTimeout(settle, 0));

  await renderer.paste("fix it\x1b[201~\x03!rm -rf ~\r\nand\tthen\u009b2J this");
  expect(written).toEqual(["\x1b[200~fix it[201~!rm -rf ~\rand\tthen2J this\x1b[201~"]);
  renderer.dispose();
});
