/**
 * Codesign the bundled `santree-hook` and `santree-server` before Tauri packages
 * them.
 *
 * Tauri signs the app bundle and its sidecars, but NOT binaries listed under
 * `bundle.resources` — and notarization rejects an app containing any unsigned
 * Mach-O, with an error that names the nested binary rather than the config
 * field that put it there. Both are resources (not `externalBin`s) because the
 * app resolves them through `resource_dir()`; moving them would change that
 * path, so they get signed here instead.
 *
 * Runs from `beforeBundleCommand` — after the binaries are built and staged by
 * `bundle:binaries`, before the bundler copies them into the .app. Order
 * matters: signing is inside-out, so each must carry its own signature before
 * the outer bundle seals it into `CodeResources`.
 *
 * The server's identifier is pinned to `com.santree.server`: the app admits a
 * server by identifier AND Team ID, and a default identifier
 * would be derived from the file name. Neither binary gets entitlements — the
 * hardened runtime without `get-task-allow` / `disable-library-validation` is
 * what keeps an agent from injecting into them, and release.yml asserts it.
 *
 * A no-op without `APPLE_SIGNING_IDENTITY` (local builds, ci.yml's bundle smoke)
 * — those bundles are never distributed, and failing them would make every
 * keyless build require a certificate. With one, a missing binary is an error.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** What gets signed, and with which `codesign` flags beyond the common ones. */
const ENTRIES = [
  { path: "target/bundle-resources/santree-hook", extra: [] },
  {
    path: "target/bundle-resources/santree-server",
    extra: ["--identifier", "com.santree.server"],
  },
];

if (process.platform !== "darwin") process.exit(0);

const identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity) {
  console.log("sign-resources: APPLE_SIGNING_IDENTITY unset — leaving the resources unsigned");
  process.exit(0);
}

for (const { path } of ENTRIES) {
  if (!existsSync(path)) {
    throw new Error(`sign-resources: ${path} is missing — did bundle:binaries run?`);
  }
}

for (const { path, extra } of ENTRIES) {
  // --options runtime: the hardened runtime is a notarization requirement, and it
  // has to be on the nested binary too, not just the app.
  execFileSync(
    "codesign",
    ["--force", "--sign", identity, "--options", "runtime", "--timestamp", ...extra, path],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", path], { stdio: "inherit" });
  console.log(`sign-resources: signed ${path}`);
}
