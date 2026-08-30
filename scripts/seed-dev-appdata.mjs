#!/usr/bin/env node
// Seeds the `dev:alt` app-data dir from the production one.
//
// `dev:alt` runs under its own bundle identifier (com.santree.desktop.dev) so it
// gets its own app-data dir, its own SQLite DB and its own single-instance lock —
// a dev build can then run beside an installed santree without fighting it for
// either. The cost is an empty DB, which makes it useless for reproducing a bug
// that needs the real repos/settings. This copies the production DB across so the
// dev instance starts from the same state.
//
// One-way on purpose: prod -> dev only, and it refuses to clobber an existing dev
// DB unless --force is passed, so a dev run can never write back into the app the
// user actually depends on.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = join(homedir(), "Library", "Application Support");
const PROD = join(base, "com.santree.desktop");
const DEV = join(base, "com.santree.desktop.dev");
const force = process.argv.includes("--force");

if (!existsSync(PROD)) {
  console.error(`No production app data at ${PROD} — nothing to seed from.`);
  process.exit(1);
}

mkdirSync(DEV, { recursive: true });

// The DB plus its WAL sidecars; a partial copy would look corrupt to sqlx.
const files = ["santree.db", "santree.db-wal", "santree.db-shm"];
const target = join(DEV, files[0]);
if (existsSync(target) && !force) {
  console.error(`${target} already exists. Re-run with --force to overwrite it.`);
  process.exit(1);
}

for (const name of files) {
  const from = join(PROD, name);
  const to = join(DEV, name);
  if (existsSync(from)) copyFileSync(from, to);
  else rmSync(to, { force: true });
}

console.log(`Seeded ${DEV} from ${PROD}.`);
