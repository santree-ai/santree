/**
 * Design S5: bytes from Daedalus are untrusted. Against the real xterm parser
 * (the other renderer tests fake xterm): a remote pane swallows OSC 52 — the
 * clipboard write — ahead of any handler registered before it, and opens an
 * OSC 8 link only when it is a web page.
 */
import { Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, test, vi } from "vitest";

const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    opened.urls.push(url);
  },
}));

import { distrust, openWebLink } from "./XtermRenderer";

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

/** `hello`, base64 — what a program on the box would put on the clipboard. */
const OSC_52 = "\x1b]52;c;aGVsbG8=\x07";

describe("OSC 52 in an untrusted pane", () => {
  test("a clipboard handler registered before it never sees the write", async () => {
    const term = new Terminal({ allowProposedApi: true });
    // Stands in for a clipboard addon: it would write the Mac's clipboard.
    const clipboard = vi.fn(() => true);
    term.parser.registerOscHandler(52, clipboard);
    distrust(term);
    await write(term, `before${OSC_52}after`);
    expect(clipboard).not.toHaveBeenCalled();
    term.dispose();
  });

  test("a trusted pane leaves OSC 52 to whatever handles it", async () => {
    const term = new Terminal({ allowProposedApi: true });
    const clipboard = vi.fn(() => true);
    term.parser.registerOscHandler(52, clipboard);
    await write(term, OSC_52);
    expect(clipboard).toHaveBeenCalledWith("c;aGVsbG8=");
    term.dispose();
  });
});

describe("OSC 8 links in an untrusted pane", () => {
  beforeEach(() => {
    opened.urls.length = 0;
  });

  test("only web pages open", () => {
    for (const uri of [
      "file:///Applications/Calculator.app",
      "x-apple.systempreferences:com.apple.preference.security",
      "javascript:alert(1)",
      "vscode://file/etc/passwd",
      "not a url",
    ]) {
      openWebLink(uri);
    }
    openWebLink("https://github.com/acme/web/pull/7");
    openWebLink("http://localhost:5173/");
    expect(opened.urls).toEqual(["https://github.com/acme/web/pull/7", "http://localhost:5173/"]);
  });
});
