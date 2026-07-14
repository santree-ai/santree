/**
 * Turn a minified production stack trace back into real source frames.
 *
 * Release builds ship minified JS with no source maps (see stash-sourcemaps.mjs),
 * so a crash in `~/Library/Logs/com.santree.desktop/santree.log` looks like
 *
 *   at Ai (tauri://localhost/assets/index-Cq8vN1zP.js:48:12904)
 *
 * Feed that log (or just the pasted frames) through here with the `sourcemaps/`
 * archive from the matching release and each frame is rewritten in place:
 *
 *   at focusTask (src/features/issues/model.tsx:212:7)   [was index-Cq8vN1zP.js:48:12904]
 *
 * Usage:
 *   pnpm symbolicate <trace-file>              # maps for the current package version
 *   pnpm symbolicate <trace-file> --version 0.2.0
 *   pnpm symbolicate --maps ./sourcemaps/0.2.0 < trace.txt
 *
 * Lines with no resolvable frame pass through untouched, so piping a whole log
 * file is fine.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const mapsDir = resolve(root, flag("maps") ?? join("sourcemaps", flag("version") ?? version));

let mapFiles;
try {
  mapFiles = (await readdir(mapsDir, { recursive: true })).filter((f) => f.endsWith(".map"));
} catch {
  console.error(
    `symbolicate: no source maps at ${mapsDir}\n` +
      "Point --maps at the sourcemaps/ archive kept with the release you're debugging.",
  );
  process.exit(1);
}
if (mapFiles.length === 0) {
  console.error(`symbolicate: ${mapsDir} holds no .map files.`);
  process.exit(1);
}

// Index by the bundle filename a stack frame names (`index-Cq8vN1zP.js`), which
// is what the map is called minus the `.map`. Loaded lazily — a log usually
// touches two or three chunks out of a couple of dozen.
const mapPathByBundle = new Map(
  mapFiles.map((f) => [
    f
      .split("/")
      .pop()
      .replace(/\.map$/, ""),
    join(mapsDir, f),
  ]),
);
const traceCache = new Map();

async function traceMapFor(bundle) {
  if (traceCache.has(bundle)) return traceCache.get(bundle);
  const path = mapPathByBundle.get(bundle);
  const tm = path ? new TraceMap(JSON.parse(await readFile(path, "utf8"))) : null;
  traceCache.set(bundle, tm);
  return tm;
}

const input = positional[0]
  ? await readFile(resolve(positional[0]), "utf8")
  : await new Response(process.stdin).text();

// Any `<something>.js:<line>:<col>`, plus whatever URL wraps it — Tauri serves
// the bundle as `tauri://localhost/...` on macOS and `http://tauri.localhost/...`
// on Linux, and a pasted frame may carry no scheme at all. The prefix has to be
// part of the match, not just tolerated beside it: it names the *bundle's*
// location, so leaving it in front of a resolved source path yields a path that
// points nowhere.
const FRAME = /(?:[^\s()'"]*\/)?([\w.-]+\.js):(\d+):(\d+)/g;

let resolved = 0;
let unresolved = 0;
const out = [];

for (const line of input.split("\n")) {
  const matches = [...line.matchAll(FRAME)];
  if (matches.length === 0) {
    out.push(line);
    continue;
  }
  let rewritten = line;
  for (const [whole, bundle, ln, col] of matches) {
    const tm = await traceMapFor(bundle);
    const pos = tm && originalPositionFor(tm, { line: Number(ln), column: Number(col) });
    if (!pos?.source) {
      unresolved++;
      continue;
    }
    resolved++;
    // Vite writes sources as `../../src/...` relative to dist/assets; collapse
    // the leading hops so frames read as repo-relative paths.
    const src = pos.source.replace(/^(\.\.\/)+/, "");
    const name = pos.name ? `${pos.name} ` : "";
    rewritten = rewritten.replace(
      whole,
      `${name}${src}:${pos.line}:${pos.column}   [was ${bundle}:${ln}:${col}]`,
    );
  }
  out.push(rewritten);
}

process.stdout.write(`${out.join("\n")}\n`);
console.error(
  `symbolicate: ${resolved} frame(s) resolved, ${unresolved} unresolved (maps: ${mapsDir})`,
);
