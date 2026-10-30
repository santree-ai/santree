/**
 * COMPLIANCE.md's terminal rule, made executable on the TypeScript side.
 *
 * `COMPLIANCE.md`: "The only bytes santree writes to a terminal are the user's
 * keystrokes and the single human-initiated seed prompt. Orchestration stops at:
 * choose a cwd, place the pane, send one seed." And: "No auto-responders, no
 * output-parsing that feeds new prompts back in… The backend streams bytes; it
 * never inspects them to decide what to type next."
 *
 * `src/features/terminal/` is where that holds or fails on this side: it does
 * placement plus that one seed (`terminal_seed`, with keystrokes going through
 * `terminal_write`), and it never reads output or drives the session.
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
import ts from "typescript";
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
 *  test files — fixtures legitimately contain the shapes being hunted for. A
 *  glob key is relative to this file (`./x`, `../conversation/x`, `../../lib/x`),
 *  so it is resolved from here to its path in the repo. */
function load(modules: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, source] of Object.entries(modules)) {
    if (/\.test\.tsx?$/.test(path)) continue;
    out[new URL(path, "file:///src/features/terminal/").pathname.slice(1)] = stripComments(
      source as string,
    );
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

/** Every call that puts bytes into a PTY: keystrokes (`write`) and the one
 *  human-initiated launch line (`seed`), and the renderer's own input — a paste
 *  or a key press, which xterm emits through `onData` to that same `write`. The
 *  renderer's `write()` is the opposite direction — bytes onto the screen — and
 *  is deliberately not here. */
const PTY_WRITES = [
  "backend.write(",
  "backend.seed(",
  "commands.terminalWrite(",
  "commands.terminalSeed(",
  ".paste(",
  ".press(",
  "term.paste(",
  "term.input(",
];

/** Names anything carrying PTY output would be called. A write whose argument
 *  mentions one of these is a write derived from what the agent printed. */
const OUTPUT_WORDS = /output|bytes|chunk|stdout|stderr|scrollback|screen|transcript|title/i;

/** What starts typing in the Conversation view: steps queued on a pane
 *  (`paneWriter.enqueue`). A function that calls it is an *action*. */
const QUEUE = "enqueue";
/** The JSX handlers through which a user, and only a user, starts an action. */
const USER_HANDLERS = new Set(["onKeyDown", "onClick"]);
const EFFECTS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const TIMERS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
  "queueMicrotask",
]);
/** Calls whose callbacks run when something else happens: a store or a channel
 *  that changed, an event, a promise that settled (a poll's result). */
const SUBSCRIPTIONS = new Set([
  "subscribe",
  "listen",
  "addEventListener",
  "observe",
  "useSyncExternalStore",
  "then",
]);
/** Calls with which code passes for the user: a click, a key or a submit. */
const SYNTHETIC = new Set(["click", "dispatchEvent", "requestSubmit", "submit"]);

/** A syntax tree with the walking and asking the scans below share. */
function syntax(source: string) {
  const file = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true);
  const walk = (node: ts.Node, visit: (n: ts.Node) => void) => {
    visit(node);
    node.forEachChild((child) => walk(child, visit));
  };
  return {
    file,
    walk: (visit: (n: ts.Node) => void) => walk(file, visit),
    within: (node: ts.Node, root: ts.Node | undefined) => {
      for (let at: ts.Node | undefined = node; at; at = at.parent) if (at === root) return true;
      return false;
    },
    line: (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    /** The innermost function around `node`. */
    fnOf: (node: ts.Node) => {
      for (let at = node.parent; at; at = at.parent) if (ts.isFunctionLike(at)) return at;
      return undefined;
    },
    /** The JSX attribute `node` sits in, by name. */
    handlerOf: (node: ts.Node) => {
      for (let at = node.parent; at; at = at.parent) {
        if (ts.isJsxAttribute(at)) return at.name.getText(file);
      }
      return null;
    },
    called: (call: ts.CallExpression) =>
      ts.isIdentifier(call.expression)
        ? call.expression.text
        : ts.isPropertyAccessExpression(call.expression)
          ? call.expression.name.text
          : null,
  };
}

/**
 * Every place a module of the Conversation view could type without the user:
 * the rule is about *when* as well as *what*, and a text scan can't tell an
 * Enter handler from an effect, so this reads the syntax tree. A view module
 * types only by queuing steps on a pane, and only from an action — a `const`
 * function that queues them in its own body — and an action is reached only
 * from an `onKeyDown` or `onClick`. No effect, timer or subscription (a store,
 * an event, a settled promise: a poll's result) reaches an action or the
 * queue, and nothing passes for the user. The renderer's paste and key press
 * belong to the queue alone. Answers each violation as `line: why`.
 */
function viewActions(source: string): { actions: string[]; violations: string[] } {
  const { walk, within, line, fnOf, handlerOf, called } = syntax(source);
  const out: string[] = [];
  const say = (node: ts.Node, why: string) => out.push(`${line(node)}: ${why}`);

  // The actions: each `const` function whose own body queues steps.
  const actions = new Map<string, ts.Node>();
  walk((n) => {
    if (!ts.isCallExpression(n) || called(n) !== QUEUE) return;
    const fn = fnOf(n);
    const decl = fn?.parent;
    if (fn && decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      actions.set(decl.name.text, fn);
    } else {
      say(n, "steps queued outside an action of its own (a `const` function that queues them)");
    }
  });

  walk((n) => {
    if (ts.isIdentifier(n) && actions.has(n.text)) {
      const { parent } = n;
      // Its own declaration, or another thing's member of the same name.
      const named =
        ((ts.isVariableDeclaration(parent) ||
          ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent)) &&
          parent.name === n) ||
        (ts.isBindingElement(parent) && parent.propertyName === n);
      if (!named && !USER_HANDLERS.has(handlerOf(n) ?? "")) {
        say(n, `\`${n.text}\` is reached from somewhere other than the user's Enter or click`);
      }
    }
    if (ts.isNewExpression(n)) {
      const made = n.expression.getText();
      if (/Event$/.test(made)) say(n, `a made-up ${made} would pass for the user`);
      if (/Observer$/.test(made)) {
        for (const arg of n.arguments ?? []) reaches(arg, made);
      }
    }
    if (!ts.isCallExpression(n)) return;
    const name = called(n);
    if (name === "paste" || name === "press") {
      say(n, `\`.${name}()\` outside the pane's queue`);
    }
    if (name === QUEUE) {
      // Queued from the action's own body, not from a callback inside it.
      const action = [...actions.values()].find((fn) => within(n, fn));
      if (action && fnOf(n) !== action)
        say(n, "steps queued from a callback, not the action itself");
    }
    if (name && SYNTHETIC.has(name)) say(n, `\`.${name}()\` would pass for the user`);
    if (name && (EFFECTS.has(name) || TIMERS.has(name) || SUBSCRIPTIONS.has(name))) {
      for (const arg of n.arguments) reaches(arg, name);
    }
  });

  /** An effect, timer or subscription callback must not reach an action or the queue. */
  function reaches(arg: ts.Node, by: string) {
    const visit = (inner: ts.Node) => {
      if (ts.isIdentifier(inner) && actions.has(inner.text)) {
        say(inner, `${by} reaches \`${inner.text}\``);
      }
      if (ts.isCallExpression(inner)) {
        const typed = called(inner);
        if (typed === QUEUE || typed === "paste" || typed === "press") {
          say(inner, `${by} types (\`${typed}()\`)`);
        }
      }
      inner.forEachChild(visit);
    };
    visit(arg);
  }
  return { actions: [...actions.keys()], violations: out };
}

const typingWithoutTheUser = (source: string) => viewActions(source).violations;

/**
 * The pane's queue (`paneWriter.ts`) is the one place the view's keys reach a
 * renderer. It must type only the steps it was handed — the renderer's paste
 * and key press called from its step runner alone, with the step's own text and
 * key — run steps only for a queued action, and keep its timers to the waits
 * between one action's steps. Answers each violation as `line: why`.
 */
function writerOutsideItsSteps(source: string): string[] {
  const { walk, within, line, called } = syntax(source);
  const out: string[] = [];
  const say = (node: ts.Node, why: string) => out.push(`${line(node)}: ${why}`);
  const fns = new Map<string, ts.Node>();
  walk((n) => {
    if (ts.isFunctionDeclaration(n) && n.name) fns.set(n.name.text, n);
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) fns.set(n.name.text, n);
  });
  for (const name of ["enqueue", "run", "sleep"]) {
    if (!fns.has(name)) out.push(`0: no \`${name}\` to check`);
  }
  walk((n) => {
    if (!ts.isCallExpression(n)) return;
    const name = called(n);
    if (name === "paste" || name === "press") {
      if (!within(n, fns.get("run"))) say(n, `\`.${name}()\` outside the step runner`);
      const args = n.arguments.map((a) => a.getText());
      const own = name === "paste" ? "step.text" : "step.key";
      if (args.join(", ") !== own)
        say(n, `\`.${name}(${args.join(", ")})\` types other than its step`);
    }
    if (name === "run" && !within(n, fns.get("enqueue"))) say(n, "steps run without being queued");
    if (name && TIMERS.has(name) && !within(n, fns.get("sleep"))) {
      say(n, `\`${name}\` outside the wait between one action's steps`);
    }
  });
  return out;
}

describe("COMPLIANCE.md: the terminal orchestrator places panes and seeds once", () => {
  it("keeps every PTY write behind the one backend module", () => {
    // COMPLIANCE.md names two commands as the way bytes go into a session:
    // `terminal_write` for keystrokes and `terminal_seed` for the single
    // human-initiated launch line. A second caller of either is a second place
    // that could answer the agent.
    for (const [command, parameters] of [
      ["commands.terminalWrite(", "id, data"],
      ["commands.terminalSeed(", "id, seed"],
    ] as const) {
      const callers = Object.entries(APP)
        .filter(([, source]) => source.includes(command))
        .map(([path]) => path);
      expect(callers).toEqual(["src/features/terminal/TauriBackend.ts"]);

      // …and that one caller forwards its own parameters, nothing derived.
      expect(callArgs(APP["src/features/terminal/TauriBackend.ts"], command)).toEqual([parameters]);
    }
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

/** Every non-test module of the Conversation view, as written (comments and
 *  all: the syntax tree reads them as such). */
const VIEW = Object.fromEntries(
  Object.entries(
    import.meta.glob("../conversation/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  )
    .filter(([path]) => !/\.test\.tsx?$/.test(path))
    .map(([path, source]) => [path.replace("../conversation/", ""), source as string]),
);

/** The expressions given to `name:` in an object literal: the text after it, to
 *  the comma or brace that ends it at its own depth. */
function propValues(src: string, name: string): string[] {
  const out: string[] = [];
  for (const match of src.matchAll(new RegExp(`\\b${name}: `, "g"))) {
    let depth = 0;
    let i = (match.index ?? 0) + match[0].length;
    const from = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if ((c === "," || c === ";" || c === "\n") && depth === 0) break;
    }
    out.push(src.slice(from, i).trim());
  }
  return out;
}

/** Where a module calls `callee` outside the function named `fn`, as
 *  `line: why`: for a builder whose pieces must only be put together by it. */
function callsOutside(source: string, callee: string, fn: string): string[] {
  const { walk, within, line, called } = syntax(source);
  let home: ts.Node | undefined;
  walk((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fn) home = n;
  });
  if (!home) return [`0: no \`${fn}\` to check`];
  const out: string[] = [];
  walk((n) => {
    if (ts.isCallExpression(n) && called(n) === callee && !within(n, home)) {
      out.push(`${line(n)}: \`${callee}()\` outside \`${fn}\``);
    }
  });
  return out;
}

/** The steps argument of every `enqueue(pane, steps, …)` call in a module. */
function queuedSteps(source: string): string[] {
  return queuedArgs(source, 1).map((arg) => arg ?? "");
}

/** Argument `index` of every `enqueue(…)` call in a module, null where the call
 *  has none. */
function queuedArgs(source: string, index: number): (string | null)[] {
  const { walk, called } = syntax(source);
  const out: (string | null)[] = [];
  walk((n) => {
    if (ts.isCallExpression(n) && called(n) === QUEUE) {
      out.push(n.arguments[index]?.getText() ?? null);
    }
  });
  return out;
}

/**
 * COMPLIANCE.md, the Conversation view's paragraph: it types into the same
 * pane, through the pane's own renderer, on the user's action and at no other
 * time. A send is the draft the user wrote, as their own clear, paste and
 * Enter; Stop is one Esc; an answer is the keys the user's choice has in the
 * dialog Claude is showing. That is the whole of what may reach a pane from
 * outside this feature, and all of it goes through one queue per pane.
 */
describe("COMPLIANCE.md: the Conversation view types only what the user wrote or picked, on their action", () => {
  const COMPOSER = "src/features/conversation/Composer.tsx";
  const CARD = "src/features/conversation/AnswerCard.tsx";
  const WRITER = "src/features/conversation/paneWriter.ts";
  const KEYS = "src/features/conversation/keys.ts";
  const outside = Object.entries(APP).filter(
    ([path]) => !path.startsWith("src/features/terminal/"),
  );
  const callersOutside = (needle: string) =>
    outside
      .filter(([, source]) => source.includes(needle))
      .map(([path]) => path)
      .sort();

  it("types into a pane only through the pane's queue, and the queue only the steps it is handed", () => {
    expect(callersOutside("inputFor(")).toEqual(["src/features/conversation/ConversationView.tsx"]);
    expect(callersOutside(".paste(")).toEqual([WRITER]);
    expect(callersOutside(".press(")).toEqual([WRITER]);
    // The queue's own definition, and the two modules that start actions: the
    // composer (Send, Stop) and the answer card.
    expect(callersOutside("enqueue(")).toEqual([CARD, COMPOSER, WRITER]);
    expect(writerOutsideItsSteps(VIEW["paneWriter.ts"])).toEqual([]);
    // What each queues is a builder's: Send's, Stop's, and an answer's.
    expect(queuedSteps(VIEW["Composer.tsx"])).toEqual(["sendSteps(text)", "stopSteps()"]);
    expect(queuedSteps(VIEW["AnswerCard.tsx"])).toEqual(["steps"]);
    expect(callArgs(APP[CARD], "answerSteps(")).toEqual(["dialog, choice, card.trust"]);
    expect(APP[CARD]).toContain("const steps = answerSteps(dialog, choice, card.trust);");
  });

  it("types only the draft the user wrote, and Stop's one Esc", () => {
    // The one step that carries a send's text is its paste of its draft…
    const keys = APP[KEYS];
    expect([...keys.matchAll(/kind: "paste", text: (\w+)/g)].map((m) => m[1])).toEqual(["draft"]);
    expect(keys).not.toContain("enqueue(");
    // …which is what is in the box when the user sends it.
    const composer = APP[COMPOSER];
    expect(callArgs(composer, "sendSteps(")).toEqual(["text"]);
    expect(composer).toContain("const text = draft;");
    expect(callArgs(composer, "stopSteps(")).toEqual([""]);
    // And the box holds only what the user typed there, or a message they sent
    // from it, put back: nothing the view drew from the transcript or the hooks.
    expect(callArgs(composer, "typeDraft(")).toEqual(["draftKey, e.target.value"]);
    expect(callArgs(composer, "sendSettled(")).toEqual([
      "key, text, outcome, { afterSeq: seqNow.current, queued }",
    ]);
    const store = APP["src/features/conversation/composerStore.ts"];
    expect(propValues(store, "draft")).toEqual([
      "string",
      '""',
      "value",
      "withSent(prev.draft, echo.text)",
      'prev.draft === text ? "" : prev.draft',
      "withSent(prev.draft, stop.restore)",
    ]);
    // What is put back: an echo, or the message an early Stop gave back — both
    // only ever the text a send settled with.
    expect(store).toContain("const echo: Echo = { id: ++echoSeq, text, afterSeq: at.afterSeq");
    expect(store).toContain("lastSent: { text, echo: echo.id, shownAs: null },");
    expect(propValues(store, "restore")).toEqual(["string | null", "current ? last.text : null"]);
  });

  it("answers with the dialog's own keys, built in one place, and only the text the user wrote in the card", () => {
    const keys = APP[KEYS];
    // An answer's keys are put together by `answerSteps` alone: a digit, Tab,
    // Up, Enter, Esc alone, and a paste of the answer's own text.
    for (const piece of ["digit", "pasteOf", "typed"]) {
      expect(callsOutside(keys, piece, "answerSteps"), piece).toEqual([]);
    }
    expect(callArgs(keys, "pasteOf(")).toEqual([
      "text: string",
      "answer.text",
      "answer.text",
      "answer.text",
      "answer.text",
    ]);
    // The one place the payload chooses a byte: a digit, bounded to 1-9.
    expect(keys).toContain("if (!Number.isInteger(n) || n < 1 || n > MAX_DIGIT) return null;");
    // And the card's text answers carry only its own field's text, which only
    // the user's typing sets.
    const card = APP[CARD];
    expect(callArgs(card, "setText(")).toEqual(["e.target.value"]);
    expect(callArgs(card, "answer(")).toEqual([
      "row.choice",
      "row.choice",
      '{ kind: "picks", options: picks.map((p) => p ?? -1) }',
      '{ kind: "toggles", options: toggles }',
      '{ kind: "cancel" }',
      "{ kind: mode, text }",
      "{ kind: mode, text }",
    ]);
  });

  // The scans above pin what is typed. This pins when: an effect that sent the
  // waiting draft the moment the hooks said idle typed exactly the user's draft,
  // and passed all of them.
  it("types only on the user's own Enter or click, never from an effect, a timer or a subscription", () => {
    const found: Record<string, string[]> = {};
    for (const [path, source] of Object.entries(VIEW)) {
      if (path === "paneWriter.ts") continue;
      const { actions, violations } = viewActions(source);
      expect(violations, path).toEqual([]);
      if (actions.length > 0) found[path] = actions;
    }
    // Every module that types, and its actions: the scan sees them all.
    expect(found).toEqual({ "AnswerCard.tsx": ["answer"], "Composer.tsx": ["send", "stop"] });
  });

  it("reaches the session through the renderer's own input, and the one writer", () => {
    // xterm's paste and key input encode the bytes as the program asked and emit
    // them through `onData`, the path a typed key takes. Only the renderer calls
    // them: with the text it was handed, and one of the keys it maps.
    for (const needle of ["term.paste(", "term.input("]) {
      const callers = Object.entries(APP)
        .filter(([, source]) => source.includes(needle))
        .map(([path]) => path);
      expect(callers, needle).toEqual(["src/features/terminal/XtermRenderer.ts"]);
    }
    const renderer = APP["src/features/terminal/XtermRenderer.ts"];
    // …with its control characters gone, so no byte of it can act as a key
    // (`XtermRenderer.input.test.ts`).
    expect(callArgs(renderer, "term.paste(")).toEqual(["pasteable(text)"]);
    expect(callArgs(renderer, "term.input(")).toEqual(["KEY_INPUT[key], true"]);
    expect(renderer).toContain(
      [
        "const KEY_INPUT: Record<TerminalKey, string> = {",
        '  enter: "\\r",',
        '  escape: "\\x1b",',
        '  clear: "\\x0b".repeat(16) + "\\x15".repeat(16),',
        '  tab: "\\t",',
        '  up: "\\x1b[A",',
        '  "1": "1",',
        '  "2": "2",',
        '  "3": "3",',
        '  "4": "4",',
        '  "5": "5",',
        '  "6": "6",',
        '  "7": "7",',
        '  "8": "8",',
        '  "9": "9",',
        "};",
      ].join("\n"),
    );

    // `onData` reaches the session by the pane's one writer, as it always has;
    // the input watch only notes when (`inputWatch`).
    const view = APP["src/features/terminal/TerminalView.tsx"];
    expect(callArgs(view, "renderer.onInput(")).toEqual(["write"]);
    expect(callArgs(view, "backend.write(")).toEqual(["id, data"]);
    expect(callArgs(view, "inputReached(")).toEqual(["id, data", "id, seed"]);
    expect(view).toContain(
      [
        "        const write = (data: string) => {",
        "          inputReached(id, data);",
        "          return backend.write(id, data);",
        "        };",
        "        renderer.onInput(write);",
      ].join("\n"),
    );

    // It notes every write but an answer card's keys. The one way past it is
    // `untracked`, around one of the queue's own paste or press calls, for an
    // action queued untracked; and only the answer card queues one. A Send's
    // and a Stop's keys count.
    expect(APP["src/features/terminal/inputWatch.ts"]).toContain(
      "if (!watch || untracking || FOCUS_REPORTS.has(data)) return;",
    );
    const flagged = Object.entries(APP)
      .filter(([, source]) => source.includes("untracked("))
      .map(([path]) => path);
    expect(flagged).toEqual([WRITER]);
    const writer = APP[WRITER];
    expect(callArgs(writer, "untracked(")).toEqual(["type"]);
    expect(writer).toContain(
      'const type = () => (step.kind === "paste" ? pane.paste(step.text) : pane.press(step.key));',
    );
    expect(writer).toContain("taken = await (untrack ? untracked(type) : type());");
    expect(writer).toContain("const untrack = options.untracked === true;");
    expect(queuedArgs(VIEW["Composer.tsx"], 3)).toEqual([null, null]);
    expect(queuedArgs(VIEW["AnswerCard.tsx"], 3)).toEqual(["{ untracked: true }"]);
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

    // The same answer typed through the renderer is the same loop.
    const pasting = "onOutput: (bytes) => { if (ask(bytes)) renderer.paste('yes'); },";
    const [body] = handlerBodies(pasting, "onOutput");
    expect(PTY_WRITES.filter((write) => body.includes(write))).toEqual([".paste("]);

    const replaying = "backend.write(id, decodeLast(chunk))";
    expect(OUTPUT_WORDS.test(callArgs(replaying, "backend.write(")[0])).toBe(true);

    expect(callArgs("f.write(a, g(b))", ".write(")).toEqual(["a, g(b)"]);
  });

  it("catches a view typing on its own schedule", () => {
    const view = (extra: string) => `
      function Composer() {
        const send = () => {
          enqueue(pane, sendSteps(draft), check);
        };
        const stop = () => enqueue(pane, stopSteps());
        ${extra}
        return <><textarea onKeyDown={() => send()} /><button onClick={stop} /></>;
      }`;
    expect(viewActions(view(""))).toEqual({ actions: ["send", "stop"], violations: [] });
    for (const shape of [
      'useEffect(() => { if (phase === "ready" && draft.trim()) send(); }, [phase]);',
      "useLayoutEffect(() => { enqueue(pane, sendSteps(draft)); });",
      "useEffect(() => { input()?.paste(draft); });",
      "useEffect(() => { const t = window.setTimeout(stop, 5000); return () => clearTimeout(t); });",
      'if (phase === "ready" && queued) send();',
      'useEffect(() => box.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));',
      "useEffect(() => { if (idle) sendButton.current?.click(); }, [idle]);",
      // A store, an event or a poll's result deciding to type.
      "useEffect(() => store.subscribe(() => send()), []);",
      'useEffect(() => { window.addEventListener("focus", stop); });',
      "const onRead = () => readSessionNow().then(() => enqueue(pane, sendSteps(draft)));",
      "const later = () => window.setTimeout(() => enqueue(pane, stopSteps()), 100);",
      "const watch = new MutationObserver(() => send());",
      // An action reached through another function, which anything could call.
      "const pick = () => answer(1); const answer = (n) => enqueue(pane, keysFor(n));",
    ]) {
      expect(typingWithoutTheUser(view(shape)), shape).not.toEqual([]);
    }

    // The queue: the renderer's keys from its step runner alone, with the
    // step's own text; steps run only once queued; timers only between steps.
    const writer = (extra: string) => `
      export function enqueue(pane, steps) { return run(pane, steps); }
      async function run(pane, steps) {
        for (const step of steps) {
          if (step.kind === "paste") await pane.paste(step.text);
          else await pane.press(step.key);
        }
      }
      class Control { sleep(ms) { return new Promise((done) => setTimeout(done, ms)); } }
      ${extra}`;
    expect(writerOutsideItsSteps(writer(""))).toEqual([]);
    for (const shape of [
      'export function hello(pane) { return pane.paste("hello"); }',
      "export function again(pane, steps) { return run(pane, steps); }",
      "async function run2(pane, step) { await pane.press(step.key === 'enter' ? 'escape' : step.key); }",
      "setInterval(() => flush(), 1000);",
    ]) {
      expect(writerOutsideItsSteps(writer(shape)), shape).not.toEqual([]);
    }
  });
});
