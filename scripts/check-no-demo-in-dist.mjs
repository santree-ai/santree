/**
 * Fail if any fixture world reached the production bundle.
 *
 * The screenshot and demo worlds (`src/dev/fixtures/`) are kept out of a
 * production build only by build-time constants and a dev-only Vite plugin —
 * one careless static import from app code would ship a fake company inside
 * the app. This scans everything `vite build` wrote to `dist/` (source maps
 * included, since they carry each bundled module's source) for strings only
 * the fixture code contains, and exits non-zero naming every hit.
 *
 * Run after `pnpm build` (`pnpm check:no-demo`; CI's frontend job does).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const dist = join(root, "dist");

// Each is unique to the fixtures: the demo's company and installer marker
// (`demo/company.ts`, `demo/install.ts` `DEMO_MARKER`), the screenshot world's.
const MARKERS = [/parcelwise/i, /santree-demo-world/, /mallard labs/i, /mallard-labs/i];

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(js|mjs|css|html|map|json|txt|svg)$/.test(entry.name)) yield path;
  }
}

let entries;
try {
  entries = await readdir(dist);
} catch {
  console.error("check-no-demo: no dist/ to check — run `pnpm build` first");
  process.exit(1);
}
if (entries.length === 0) {
  console.error("check-no-demo: dist/ is empty — run `pnpm build` first");
  process.exit(1);
}

const hits = [];
for await (const path of files(dist)) {
  const text = await readFile(path, "utf8");
  for (const marker of MARKERS) {
    if (marker.test(text)) hits.push(`${relative(root, path)}: ${marker.source}`);
  }
}

if (hits.length > 0) {
  console.error("check-no-demo: fixture/demo code found in the production bundle:");
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log("check-no-demo: dist/ carries no fixture or demo code");
