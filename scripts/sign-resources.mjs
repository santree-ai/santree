/**
 * Codesign the bundled `santree-hook` before Tauri packages it.
 *
 * Tauri signs the app bundle and its sidecars, but NOT binaries listed under
 * `bundle.resources` — and notarization rejects an app containing any unsigned
 * Mach-O, with an error that names the nested binary rather than the config
 * field that put it there. The hook is a resource (not an `externalBin`) because
 * the app resolves it through `resource_dir()`; moving it would change that
 * path, so it gets signed here instead.
 *
 * Runs from `beforeBundleCommand` — after the binary is built and staged by
 * `bundle:hook`, before the bundler copies it into the .app. Order matters:
 * signing is inside-out, so the hook must carry its own signature before the
 * outer bundle seals it into `CodeResources`.
 *
 * A no-op without `APPLE_SIGNING_IDENTITY` (local builds, ci.yml's bundle smoke)
 * — those bundles are never distributed, and failing them would make every
 * keyless build require a certificate.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const HOOK = "target/bundle-resources/santree-hook";

if (process.platform !== "darwin") process.exit(0);

const identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity) {
  console.log("sign-resources: APPLE_SIGNING_IDENTITY unset — leaving the hook unsigned");
  process.exit(0);
}

if (!existsSync(HOOK)) {
  throw new Error(`sign-resources: ${HOOK} is missing — did bundle:hook run?`);
}

// --options runtime: the hardened runtime is a notarization requirement, and it
// has to be on the nested binary too, not just the app.
execFileSync(
  "codesign",
  ["--force", "--sign", identity, "--options", "runtime", "--timestamp", HOOK],
  { stdio: "inherit" },
);
execFileSync("codesign", ["--verify", "--strict", "--verbose=2", HOOK], { stdio: "inherit" });
console.log(`sign-resources: signed ${HOOK}`);
