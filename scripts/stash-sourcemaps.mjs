/**
 * Move the production source maps out of `dist/` before Tauri embeds it.
 *
 * Vite emits `.map` files carrying `sourcesContent` — the original TypeScript,
 * comments and all. Tauri compiles everything under `dist/` into the binary, so
 * leaving them there ships our full source to every user (compressed, but
 * trivially recoverable). Instead we archive them under `sourcemaps/<version>/`,
 * which stays out of the app bundle and out of git: keep that directory with the
 * release artifact and `pnpm symbolicate` can still turn a user's minified stack
 * trace back into real file/line frames.
 *
 * Vite is configured with `sourcemap: "hidden"`, so the emitted JS carries no
 * `//# sourceMappingURL=` comment — nothing dangles once the maps move away.
 *
 * Runs from `beforeBuildCommand` (see src-tauri/tauri.conf.json), i.e. after
 * `vite build` and before Tauri reads `dist/`.
 */
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Every `.map` under `dir`, recursively, as paths relative to `dist/`. */
async function findMaps(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findMaps(full)));
    else if (entry.name.endsWith(".map")) found.push(relative(dist, full));
  }
  return found;
}

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const outDir = join(root, "sourcemaps", version);

let maps;
try {
  maps = await findMaps(dist);
} catch {
  console.error(`stash-sourcemaps: no dist/ at ${dist} — run \`pnpm build\` first.`);
  process.exit(1);
}

if (maps.length === 0) {
  console.log("stash-sourcemaps: no .map files in dist/ (nothing to stash).");
  process.exit(0);
}

// A stale archive from a previous build of the same version would leave maps
// that no longer match the shipped bundle — worse than none, since symbolicate
// would resolve frames against the wrong code.
await rm(outDir, { recursive: true, force: true });

let bytes = 0;
for (const rel of maps) {
  const from = join(dist, rel);
  const to = join(outDir, rel);
  bytes += (await stat(from)).size;
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

const mb = (bytes / 1e6).toFixed(1);
console.log(
  `stash-sourcemaps: moved ${maps.length} map(s) (${mb} MB) out of dist/ → ${relative(root, outDir)}`,
);
