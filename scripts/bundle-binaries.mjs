/**
 * Build and stage the binaries that ship inside the app as bundle resources:
 * `santree-hook` (Claude/Codex hooks, status line, MCP server) and
 * `santree-server` (the detached local session host). Output goes to
 * `target/bundle-resources/<name>`, which `tauri.conf.json` (and
 * `tauri.macos.conf.json`, for the server) list under `bundle.resources`.
 *
 * Runs from `beforeDevCommand` / `beforeBuildCommand`, so it reads Tauri's own
 * env: `TAURI_ENV_DEBUG=true` picks the dev profile, `TAURI_ENV_TARGET_TRIPLE`
 * the target (`universal-apple-darwin` builds both Apple arches and lipo-merges
 * them, since a resource is not something Tauri merges for us).
 *
 * The server is built with `--profile server` (the release profile, but a panic
 * unwinds — see the root Cargo.toml) unless debugging, where the dev profile
 * already unwinds. `SANTREE_TEAM_ID` is passed through the environment:
 * `santree-server` bakes it with `option_env!`, and cargo rebuilds when it
 * changes (rustc records the var in the dep-info). Unset, the server is a dev
 * build that does not know its team. release.yml sets it and asserts it landed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "target/bundle-resources";
const BASE = process.env.CARGO_TARGET_DIR || "target";
const DEBUG = process.env.TAURI_ENV_DEBUG === "true";

const team = process.env.SANTREE_TEAM_ID;
if (team !== undefined && team !== "" && !/^[A-Z0-9]{10}$/.test(team)) {
  throw new Error(
    `bundle-binaries: SANTREE_TEAM_ID=${JSON.stringify(team)} is not a 10-character Team ID`,
  );
}

const run = (cmd, args) => {
  console.log(`bundle-binaries: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0)
    throw new Error(
      `bundle-binaries: \`${cmd} ${args.join(" ")}\` failed (${r.status ?? r.signal})`,
    );
};

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)$/m)[1];
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || host;
const universal = triple === "universal-apple-darwin";

// What cargo is asked for, per binary: the cargo flags, and the directory its
// output lands in (a custom profile gets a directory named for it).
const bins = [
  { name: "santree-hook", flags: DEBUG ? [] : ["--release"], dir: DEBUG ? "debug" : "release" },
  {
    name: "santree-server",
    flags: DEBUG ? [] : ["--profile", "server"],
    dir: DEBUG ? "debug" : "server",
  },
];

mkdirSync(OUT, { recursive: true });

for (const { name, flags, dir } of bins) {
  const out = join(OUT, name);
  if (universal) {
    const arches = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    run("cargo", ["build", "-p", name, ...flags, ...arches.flatMap((t) => ["--target", t])]);
    run("lipo", ["-create", "-output", out, ...arches.map((t) => join(BASE, t, dir, name))]);
  } else if (triple === host) {
    run("cargo", ["build", "-p", name, ...flags]);
    copyFileSync(join(BASE, dir, name), out);
  } else {
    run("cargo", ["build", "-p", name, ...flags, "--target", triple]);
    copyFileSync(join(BASE, triple, dir, name), out);
  }
  console.log(`bundle-binaries: staged ${out}`);
}
