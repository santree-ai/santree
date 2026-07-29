/**
 * Detach any of our own DMG volumes left mounted from an earlier build.
 *
 * `bundle_dmg.sh` mounts its scratch image at `/Volumes/<productName>` and then
 * drives Finder over AppleScript to lay the window out, waiting for Finder to
 * write a `.DS_Store` there. When a previous build (or a user double-clicking the
 * DMG) left that name taken, macOS mounts the new image at `/Volumes/santree 1`,
 * `santree 2`, … while the AppleScript still addresses the volume named
 * `santree` — the *stale* one. The `.DS_Store` never appears where the script
 * looks, it times out, and Tauri reports only:
 *
 *     failed to bundle project: error running bundle_dmg.sh
 *
 * with no hint that a leftover mount is the cause. These accumulate silently
 * (eight of them, once), so each failed build makes the next one likelier to
 * fail. Clearing them here — from `beforeBundleCommand`, after the binary is
 * built and before the bundler runs — keeps the name free for the real mount.
 *
 * Deliberately narrow: only volumes mounted at exactly `/Volumes/<productName>`
 * or `/Volumes/<productName> <n>` are touched, so an unrelated disk that happens
 * to be attached is never ejected. Best-effort — a failure here must not fail a
 * build that would otherwise have succeeded.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// DMGs are macOS-only; the Linux target has nothing to clean up.
if (process.platform !== "darwin") process.exit(0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { productName } = JSON.parse(
  await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);

/** `/Volumes/santree`, plus the `santree 1`, `santree 2`, … macOS mints on collision. */
const mountPattern = new RegExp(
  `^/Volumes/${productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\d+)?$`,
);

/** Run `cmd`, feeding it `input` on stdin, and resolve its stdout. `execFile` has
 *  no stdin option (only the *Sync* variants do), and passing one silently leaves
 *  the child waiting on a stream that never closes — so spawn and close it here. */
function run(cmd, args, input) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}: ${err.trim()}`)),
    );
    child.stdin.end(input ?? "");
  });
}

/** Mounted disk-image entities, via `hdiutil`'s plist output turned into JSON. */
async function mountedImages() {
  const plist = await run("hdiutil", ["info", "-plist"]);
  const json = await run("plutil", ["-convert", "json", "-o", "-", "-"], plist);
  return JSON.parse(json).images ?? [];
}

let images;
try {
  images = await mountedImages();
} catch (e) {
  console.warn(`eject-stale-dmg: couldn't list mounted images (${e.message}) — continuing.`);
  process.exit(0);
}

// Detach the whole device (`/dev/disk4`), not the partition (`/dev/disk4s1`):
// ejecting the slice alone can leave the image attached but unmounted, which
// still holds the volume name.
const stale = [];
for (const image of images) {
  for (const entity of image["system-entities"] ?? []) {
    if (mountPattern.test(entity["mount-point"] ?? "")) {
      const dev = (entity["dev-entry"] ?? "").replace(/s\d+$/, "");
      if (dev) stale.push({ dev, mount: entity["mount-point"] });
    }
  }
}

if (stale.length === 0) process.exit(0);

for (const { dev, mount } of new Map(stale.map((s) => [s.dev, s])).values()) {
  try {
    await run("hdiutil", ["detach", dev, "-force"]);
    console.log(`eject-stale-dmg: ejected ${mount} (${dev})`);
  } catch (e) {
    // Left mounted, the bundle will probably fail — but say why rather than
    // aborting a build that hasn't actually gone wrong yet.
    console.warn(`eject-stale-dmg: couldn't eject ${mount} (${e.message}).`);
  }
}
