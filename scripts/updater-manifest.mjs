/**
 * Emit the `latest.json` the updater plugin polls.
 *
 * The plugin doesn't read GitHub's release API — it fetches one static manifest
 * and compares its `version` against the running app's. That manifest is this
 * file's whole output, so everything the updater needs (where to download, and
 * the minisign signature to check it against) has to be baked in here.
 *
 * Both macOS platform keys point at the SAME universal archive: we ship one
 * `universal-apple-darwin` build, so `darwin-aarch64` and `darwin-x86_64` are
 * two names for one artifact. Omitting `darwin-x86_64` would silently strand
 * Intel Macs — the updater looks up its own arch key and reports "no update"
 * when it's missing, which is indistinguishable from being up to date.
 *
 * The signature is read from the `.sig` Tauri wrote next to the archive rather
 * than re-signed here: re-signing would need the private key a second time, and
 * a manifest whose signature doesn't match the bytes users download is a silent
 * "updates stopped working" that only shows up on the next release.
 *
 * Usage (from the release workflow):
 *   node scripts/updater-manifest.mjs \
 *     --version 0.2.0 --archive <app.tar.gz> --signature <app.tar.gz.sig> \
 *     --url <download url> --notes-file <path> --out latest.json
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";

/** Minimal `--flag value` parser — no dependency for six arguments. */
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`expected a --flag, got ${flag}`);
    out[flag.slice(2)] = argv[i + 1];
  }
  return out;
}

const argv = args(process.argv.slice(2));
const { version, archive, signature, url, "notes-file": notesFile, out } = argv;

for (const [name, value] of Object.entries({ version, archive, signature, url, out })) {
  if (!value) throw new Error(`missing required --${name}`);
}

// A zero-byte archive or signature means the bundler produced the file but the
// signing step didn't actually run — the manifest would look valid and every
// client would reject the download.
for (const path of [archive, signature]) {
  if (statSync(path).size === 0) throw new Error(`${path} is empty — signing did not run`);
}

const sig = readFileSync(signature, "utf8").trim();
if (!sig) throw new Error(`${signature} contains no signature`);

const notes = notesFile ? readFileSync(notesFile, "utf8").trim() : "";
const platform = { signature: sig, url };

writeFileSync(
  out,
  `${JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform },
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${out} for ${version} -> ${url}`);
