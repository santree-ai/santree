/**
 * COMPLIANCE.md's terminal rule, made executable on the TypeScript side.
 *
 * `COMPLIANCE.md` says of `src/features/terminal/`: "the app's only terminal API.
 * It does placement + a single optional **seed** (`terminal_write` of bytes,
 * identical to human typing). It does not read output or drive the session." And
 * of the whole product: "No auto-responders, no output-parsing that feeds new
 * prompts back in… The backend streams bytes; it never inspects them to decide
 * what to type next."
 *
 * That rule is about a path that must not exist — PTY output reaching PTY input —
 * so there is no function to call and assert on. These are source scans over the
 * feature's own modules instead, which is what the rule's shape allows. They
 * strip comments first, so a comment that names a forbidden pattern (including
 * the ones in this file) can never trip a test.
 *
 * The behaviour of the pieces is tested next door: `orchestrator.test.ts`,
 * `TerminalView.test.tsx`, `TauriBackend.test.ts`.
 */
import { describe, expect, it } from "vitest";

/** Every non-test module in `src/features/terminal/`, as source text. */
const FEATURE = load(
  import.meta.glob("./*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
);

/** Every non-test module in `src/`, as source text. `bindings.ts` is generated
 *  and is the declaration of `terminalWrite`, not a caller of it. */
const APP = load(
  import.meta.glob(["../../**/*.{ts,tsx}", "!../../bindings.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** Normalise a glob result to `{ path: comment-stripped source }`, dropping the
 *  test files — fixtures legitimately contain the shapes being hunted for. */
function load(modules: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, source] of Object.entries(modules)) {
    if (/\.test\.tsx?$/.test(path)) continue;
    out[path.replace(/^(\.\.\/)+/, "src/").replace(/^\.\//, "src/features/terminal/")] =
      stripComments(source as string);
  }
  return out;
}

/**
 * TypeScript source with comments removed and string/template literals kept.
 *
 * Both halves matter: dropping comments keeps a scan from firing on a doc block
 * that names the pattern it forbids, and keeping literals keeps `"https://…"`
 * from being read as a line comment that swallows the rest of its line.
 */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== "*/") {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i++;
      continue;
    }
    const quote = src[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      out += quote;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    out += src[i];
  }
  return out;
}

/** The balanced-parenthesis argument text of every `<needle>…)` call. */
function callArgs(src: string, needle: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return out;
    const open = at + needle.length;
    let depth = 1;
    let i = open;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    if (depth === 0) out.push(src.slice(open, i - 1));
    from = open;
  }
}

/** The body of each `<name>` handler *definition*: the text after its arrow, to
 *  the end of its balanced braces or of its one concise expression. Enough to see
 *  what the handler does with what it was handed. */
function handlerBodies(src: string, name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(name, from);
    if (at === -1) return out;
    from = at + name.length;
    const arrow = src.indexOf("=>", from);
    // Only a definition — `name: (args) =>` — has nothing but a parameter list
    // between the name and the arrow. A *call* to the handler has statements in
    // between, so it is skipped rather than mistaken for a body.
    if (arrow === -1 || !/^\s*:?\s*\([^()]*\)\s*$/.test(src.slice(from, arrow))) continue;
    const rest = src.slice(arrow + 2);
    if (/^\s*\{/.test(rest)) {
      let depth = 0;
      let i = rest.indexOf("{");
      for (; i < rest.length; i++) {
        if (rest[i] === "{") depth++;
        else if (rest[i] === "}" && --depth === 0) break;
      }
      out.push(rest.slice(0, i + 1));
    } else {
      // A concise arrow body: up to the end of the line.
      out.push(rest.split("\n")[0]);
    }
  }
}

/** Receivers whose `.write()` reaches the PTY. The renderer's `write()` is the
 *  opposite direction — bytes onto the screen — and is deliberately not here. */
const PTY_WRITES = ["backend.write(", "pane.write(", "commands.terminalWrite("];

/** Names anything carrying PTY output would be called. A write whose argument
 *  mentions one of these is a write derived from what the agent printed. */
const OUTPUT_WORDS = /output|bytes|chunk|stdout|stderr|scrollback|screen|transcript|title/i;

describe("COMPLIANCE.md: the terminal orchestrator places panes and seeds once", () => {
  it("keeps every PTY write behind the one backend module", () => {
    // COMPLIANCE.md names `terminal_write` as the single way bytes go into a
    // session. A second caller is a second place that could answer the agent.
    const callers = Object.entries(APP)
      .filter(([, source]) => source.includes("commands.terminalWrite"))
      .map(([path]) => path);
    expect(callers).toEqual(["src/features/terminal/TauriBackend.ts"]);

    // …and that one caller forwards its own parameter, nothing derived.
    const forwarded = callArgs(
      APP["src/features/terminal/TauriBackend.ts"],
      "commands.terminalWrite(",
    );
    expect(forwarded).toEqual(["id, data"]);
  });

  it("never turns a session's output back into text", () => {
    // Decoding the byte stream is the first move of every output-parser. The
    // renderer takes `Uint8Array` straight through; nothing else needs to look.
    const decoders = ["TextDecoder", "String.fromCharCode", "Buffer.from", "atob("];
    for (const [path, source] of Object.entries(FEATURE)) {
      for (const decoder of decoders) {
        expect(
          source.includes(decoder),
          `${path} decodes the PTY byte stream with ${decoder}. Output goes to the renderer, ` +
            `and nowhere a decision could be made from it.`,
        ).toBe(false);
      }
    }
  });

  it("hands a session's output to the renderer and to nothing else", () => {
    // The one place output is received. Its body may paint; it may not type.
    let handlers = 0;
    for (const [path, source] of Object.entries(FEATURE)) {
      for (const body of handlerBodies(source, "onOutput")) {
        handlers++;
        for (const write of PTY_WRITES) {
          expect(
            body.includes(write),
            `${path}: an onOutput handler writes back into the session — that is the ` +
              `output-parsing-drives-input loop COMPLIANCE.md forbids: ${body}`,
          ).toBe(false);
        }
      }
    }
    expect(handlers, "no onOutput handler found — this scan has stopped working").toBeGreaterThan(
      0,
    );
  });

  it("reads a session's title without ever letting it back in", () => {
    // The OSC title is PTY output like any other byte — it just arrives as an
    // escape sequence instead of on the screen. santree classifies it into a
    // status dot (`agentTitle.ts`) and stops there; a title reaching a PTY write
    // would be the same output-drives-input loop, only narrower.
    let handlers = 0;
    for (const [path, source] of Object.entries(FEATURE)) {
      for (const body of callArgs(source, ".onTitle(")) {
        handlers++;
        for (const write of PTY_WRITES) {
          expect(
            body.includes(write),
            `${path}: an onTitle handler writes back into the session — a terminal title ` +
              `may become a status dot and nothing else: ${body}`,
          ).toBe(false);
        }
      }
    }
    expect(handlers, "no onTitle handler found — this scan has stopped working").toBeGreaterThan(0);
  });

  it("types only what a human wrote or asked to seed", () => {
    // Every argument that becomes PTY input, checked for provenance: a keystroke
    // or the one seed, never anything named after the stream coming back.
    let writes = 0;
    for (const [path, source] of Object.entries(FEATURE)) {
      for (const write of PTY_WRITES) {
        for (const args of callArgs(source, write)) {
          writes++;
          expect(
            OUTPUT_WORDS.test(args),
            `${path}: ${write}${args}) sends something derived from the session's own ` +
              `output. Only the user's keystrokes and the single seed may be written.`,
          ).toBe(false);
        }
      }
    }
    expect(writes, "no PTY writes found — this scan has stopped working").toBeGreaterThan(0);
  });
});

describe("the scans themselves", () => {
  // A stripper that ate string literals would make every scan above silently
  // vacuous, and a vacuous compliance test reports green forever.
  it("drops comments and keeps string literals", () => {
    const src = [
      "// a line comment naming TextDecoder",
      "/* a block comment naming backend.write( */",
      'const url = "https://example.test/x"; // trailing',
      "const t = `a $" + "{x} template // not a comment`;",
      "const s = 'quoted \\' apostrophe';",
    ].join("\n");
    const out = stripComments(src);
    expect(out).not.toContain("a line comment");
    expect(out).not.toContain("a block comment");
    expect(out).not.toContain("trailing");
    expect(out).toContain('"https://example.test/x"');
    expect(out).toContain("template // not a comment");
    expect(out).toContain("quoted \\' apostrophe");
  });

  // …and scans that no longer match anything would do the same. Each one is fed
  // the violation it exists to catch.
  it("catches the shapes the rules forbid", () => {
    const looping = "onOutput: (bytes) => { if (ask(bytes)) backend.write(id, 'yes\\r'); },";
    expect(handlerBodies(looping, "onOutput")[0]).toContain("backend.write(");

    const replaying = "backend.write(id, decodeLast(chunk))";
    expect(OUTPUT_WORDS.test(callArgs(replaying, "backend.write(")[0])).toBe(true);

    expect(callArgs("f.write(a, g(b))", ".write(")).toEqual(["a, g(b)"]);
  });
});
