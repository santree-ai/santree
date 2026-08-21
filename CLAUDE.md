# CLAUDE.md

Guidance for working in this repo. Keep it accurate as the code changes.

## What this is

**santree** — a cross-platform (macOS + Linux) desktop app for **managing AI coding
agents** across a repo's tickets. Tauri 2 + React 19, with a **fully-typed
Rust ↔ TypeScript bridge** (tauri-specta). Shipped via GitHub Releases with a
built-in updater, but with ~zero external users — prefer deleting dead/old code
over keeping shims. The exceptions, now that installs update themselves: the
updater contract (the pubkey and endpoints in `tauri.conf.json`, the
`update_channel` setting) and the SQLite migrations are real compat surfaces —
an installed app will meet their future versions.

**Views:** all of them — Triage, Issues, Trees, Reviews, Settings, Terminal — are
backed by real data. **There is no mock/sample data anywhere**; when a backend isn't
connected (no Linear org, no `gh` auth, no repo path) commands return real-but-empty
results and the view shows its empty state.

There is also a hidden **Dev** tab (dogfooding: build/install santree from inside
santree, bug TODO list, its own Claude session), gated to the developer's GitHub
login. Deliberately self-contained — `src/features/dev/`, `src-tauri/src/dev.rs`,
migration `0017`, and a delimited block in `lib/queries.ts` — so it can be deleted
cleanly before a public release.

## Goal & priorities (in order)

1. **Snappy, native-feeling UX.** Optimistic updates + async execution everywhere a
   user acts — patch the cache/UI immediately, reconcile in the background, roll back
   on error. Never block the UI on a round-trip.
2. **Correctness over cleverness.** No hacky things that break later. When something
   non-obvious is necessary, leave a short comment explaining *why* (not what).
3. **Clean, legible code.** Reuse shared primitives/hooks; don't duplicate logic.
   Match the surrounding style. Avoid comments that just restate the code.
4. **The typed bridge is sacred.** The frontend never calls `invoke` or hardcodes
   data — it goes through query hooks → generated `bindings.ts` → `#[tauri::command]`.

## Tech stack

- **Rust:** Tauri 2.11, tauri-specta `=2.0.0-rc.25` (pinned with `specta`/
  `specta-typescript` — bump all three together), sqlx + SQLite, portable-pty, tokio,
  reqwest, serde, anyhow, `log` + tauri-plugin-log (file logging — Rust + JS console
  to `~/Library/Logs/com.santree.desktop/santree.log`).
- **Frontend:** React 19, Vite 8, TanStack Router + Query v5, Tailwind v4 (CSS-first,
  no `tailwind.config`), xterm.js, react-markdown. Biome for lint+format. Vitest.
- **Cargo workspace:** `src-tauri` (thin Tauri adapter) + `crates/core` (pure domain
  + static config, no Tauri dep) + `crates/pty` (PTY manager, Tauri-agnostic).

## Architecture & data flow

```
React view → query hook (src/lib/queries.ts) → bindings.ts (generated)
          → #[tauri::command] (src-tauri/src/commands.rs)
          → live backend (linear.rs / db.rs / repo.rs / settings.rs / terminal.rs /
                           github.rs / reviews.rs)
            └─ when not connected: return real-but-empty (no sample data)
```

- **No mock data.** When a backend isn't connected the command returns an empty
  result (e.g. `live.unwrap_or_default()`, `Ok(vec![])`) and the view renders its
  empty state. `crates/core/src/config.rs` holds the only *static* data — real
  canonical config, not samples: the agent catalog, stage metadata, default settings.
  This also bans **hardcoded placeholder field values**: if a struct field isn't
  wired to a real source, derive it or don't render it — never ship a constant
  (e.g. a fixed `InProgress`/`Idle`) that the UI shows as live data.
- **Domain types** live in `crates/core/src/domain.rs` and derive `specta::Type` —
  that's how their shapes reach `bindings.ts`. **Never hand-edit `bindings.ts`** (it's
  generated; run `pnpm gen:bindings` after changing a command or `Type`).
- **Presentation is the frontend's job.** Rust ships plain enums; `src/theme/colors.ts`
  maps them to colors/labels. The accent is a runtime CSS var so it re-themes live.

## Repo structure

```
crates/core/src/   domain.rs (types) · config.rs (static config/defaults) · linear.rs
                   (mapping) · layout.rs (dagre-free graph helpers) · lib.rs
crates/pty/src/    lib.rs — PtyManager: spawn real process behind a PTY, stream bytes
src-tauri/src/     lib.rs (builder + command registration) · commands.rs (thin wrappers)
                   · linear.rs (GraphQL + OAuth + token store) · db.rs (sqlx pool +
                   migrations) · repo.rs · settings.rs · terminal.rs · stream.rs
                   (background command runs behind a PTY → read-only log panes)
                   · hooks.rs (the `--settings` file EVERY santree `claude` launch
                   layers on: session-state hooks, statusLine, English tutor)
                   · english_tutor.rs (opt-in writing coach: hook + practice log
                   + on-demand analysis)
src-tauri/migrations/  0001_init … (SQLite schema; applied on startup)
src/
  main.tsx         QueryClient (+ global mutation→toast) · providers · router
  routes/          one file per tab → renders a feature view
  features/<view>/ each owns a model.tsx (context) + presentational components
  lib/queries.ts   ALL data hooks (useUnwrappedQuery, useOptimisticMutation, …)
  state/           AppContext (repo, theme, settings) · toast.tsx (notifications)
  components/       shared chrome + primitives.tsx (Badge, EmptyState, ChevronSelect…)
  theme/colors.ts  enum → color/label maps
```

## Key patterns (reuse these)

- **Data:** every read is a hook in `lib/queries.ts`. Result-typed commands go through
  `useUnwrappedQuery`; raw-value commands use plain `useQuery`. Writes use
  `useOptimisticMutation` (cancel → patch → rollback-on-error → invalidate-on-settle).
- **Errors & background events:** failed mutations auto-surface as red toasts (wired in
  `main.tsx`); raise green ones with `toast.success(...)` from `state/toast.tsx`.
- **Feature state:** ephemeral view state lives in `features/<view>/model.tsx` (a
  context); shared cross-view state in `AppContext`; server data only via query hooks.
- **Shared UI:** `primitives.tsx` (Badge, Dot, Toggle, Tabs, Segmented, EmptyState,
  ChevronSelect), `useEdgeResize` (panel resizers), `deriveIssueState` (the single
  source for a ticket's running/ready/blocked/chainable flags).
- **Colors:** never hardcode hex in components — use `theme/colors.ts` (`successColor`,
  `LINEAR_BRAND`, `alpha()`, `statusColor`) or a CSS token. Tinted-text/on-accent have
  dedicated tokens (`--accent-text`, `--on-accent`) so they flip in light mode.

## Security & validation invariants (load-bearing)

- **Every IPC value that becomes a path, id, or git arg is untrusted.** Validate
  before it touches the filesystem or a `git` argv: paths/ids through `git.rs`
  `safe_path`/`safe_real_path` (single normal component; reject `..`, absolute,
  symlink-escape); branch/ref names must not start with `-` (flag injection).
  `issue_id`, `base`, session ids all cross this line — never `Path::join` or
  shell them raw.
- **Match hosts/URLs by parse at the sink, never by string prefix** —
  `url.host_str() == Some("uploads.linear.app")`, not
  `starts_with("https://uploads.linear.app")` (a prefix also matches
  `…app.evil.com`). Same for any allowlist.
- **App-owned secrets** (Linear tokens) belong in the OS keychain, not plaintext
  SQLite. Don't add new plaintext-secret columns. (Distinct from `COMPLIANCE.md`,
  which bars *agent-CLI* creds — this is our own OAuth.)

## Commands

| | |
|---|---|
| `pnpm dev` | Run the app with HMR (regenerates `bindings.ts` on startup) |
| `pnpm build` | `tsc --noEmit` + production Vite build |
| `pnpm gen:bindings` | Regenerate `bindings.ts` from Rust |
| `pnpm lint` / `pnpm format` | Biome check / autoformat |
| `pnpm test` / `cargo test` | Vitest / Rust tests |
| `cargo clippy` | Rust linter |

**Before finishing a change:** run the `/verify` skill (or at minimum its static
gates: `cargo check`/`clippy`, `pnpm gen:bindings` if commands changed,
`npx tsc --noEmit`, `pnpm lint`, both test suites — all green). For any new
command taking a path/id/branch, confirm it's validated (`safe_path` /
no-leading-dash) before it reaches fs or git.

## Releasing & the self-updater

The app ships from CI only: a `v*` tag drives `.github/workflows/release.yml`
(universal macOS build → codesign → notarize → staple → `spctl` verify →
smoke-launch the signed .app → publish). No local machine signs anything — the
credentials live in the repo's `release` GitHub environment, restricted to `v*`
tags. README "Releasing" is the operator story; this is what an implementer
must not break.

**Cutting a release** is a version bump and a tag, nothing else: set the same
version in `package.json`, `src-tauri/tauri.conf.json` and `Cargo.toml`
(`[workspace.package]`, which `Cargo.lock` mirrors for the workspace crates),
then `git tag vX.Y.Z && git push origin vX.Y.Z`. The guard job fails the tag
unless all three match it.

**The tag picks the channel.** `v0.2.0` = stable — GitHub's `releases/latest`
pointer, which is also what the website's download button resolves through.
`v0.2.0-beta.N` = beta, published as a pre-release so that pointer skips it.
Semver ordering is load-bearing: `0.2.0-beta.1 < 0.2.0` is what rolls a beta
user onto the next stable, and the updater never downgrades.

**The beta manifest is rolling.** Every release — stable included — re-uploads
`latest.json` to the fixed `updater-beta` pre-release. A release published
outside the workflow skips that and strands every beta user on their last
beta, silently.

**The updater is `tauri-plugin-updater`; channels are ours.** One binary
serves both: `src-tauri/src/update.rs` picks the endpoint per check from the
`update_channel` setting, because the endpoint list in `tauri.conf.json` is
baked in at build time. The `pubkey` there pairs with
`TAURI_SIGNING_PRIVATE_KEY` in CI — **that key has no recovery path**;
installed apps accept only updates it signed, so losing it strands every
install until users re-download by hand. `useUpdateWatcher` (mounted by the
app shell) checks 15s after launch and every 6h, announcing via one toast per
version.

**Traps, each paid for once already:**

- Tauri does **not** sign `bundle.resources`, and notarization rejects any
  unsigned Mach-O in the bundle. `scripts/sign-resources.mjs` signs
  `santree-hook` from `beforeBundleCommand` — after staging, before the
  bundler seals it — and no-ops without `APPLE_SIGNING_IDENTITY` so keyless
  builds keep working. A new resource binary must be added there.
- The signing certificate is imported into a keychain in its own workflow step
  *before* the build. Tauri's own import happens at its signing phase, which is
  after `beforeBundleCommand` — too late for the hook. That ordering was the
  first release's failure.
- `createUpdaterArtifacts` is passed via `--config` in the release workflow,
  not committed: generating updater artifacts *requires* the signing key, so
  committing it would break every keyless build, including CI's bundle smoke.
- `TAURI_BUNDLER_DMG_IGNORE_CI=true` in the release env re-enables the Finder
  AppleScript that paints the DMG background and places the icons — with
  `CI=true` the bundler otherwise passes `--skip-jenkins` and ships a
  default-looking DMG (background.png present but no `.DS_Store` to use it).
- The version-free `santree-macos.dmg` asset exists for the website's
  `releases/latest/download/…` link. Stop uploading it and the download button
  404s on the next release.
- `SANTREE_SMOKE=1` (lib.rs) is CI's launch probe — exit 0 once the window
  loads, watchdog exit 3 if it never does. It runs in ci.yml's macOS bundle
  smoke and against the signed .app in the release job; it is the only thing
  that ever *runs* what ships.

## Claude project config (committed in `.claude/`)

- **Skills:** `/verify` (green checklist + real-app screenshot harness),
  `/new-command` (end-to-end Tauri command checklist incl. security gate),
  `/production-review` (multi-agent review + wave-pattern fix mode).
- **Agent:** `ipc-security-auditor` — run it on any diff touching `commands.rs`,
  `git.rs`, `terminal.rs`, or `crates/pty`.
- **Hook:** editing `commands.rs`/`lib.rs`/`domain.rs` triggers a bindings-drift
  reminder (`.claude/hooks/bindings-reminder.py`).
- Session/worktree state under `.claude/` stays gitignored; only settings,
  hooks, skills, agents, and commands are versioned.

## Gotchas

- `bindings.ts` and `routeTree.gen.ts` are **generated but committed** — don't edit by
  hand; Biome ignores them.
- Tailwind v4 is CSS-first (`@theme` in `src/styles.css`, which Biome is configured to
  skip). IDE "unknown at-rule" warnings are handled by `.vscode/settings.json`.
- **Terminal compliance:** the PTY runs the real, unmodified CLI — no credential
  handling, no output-parsing-drives-input, no unattended loops. See `COMPLIANCE.md`;
  these constraints are load-bearing.
- **External CLI contracts:** verify vendor flags against `--help`, don't guess.
  Claude `--model` takes dash-form ids or aliases (`sonnet`/`opus`/`haiku`) —
  dotted (`claude-sonnet-4.5`) is invalid and fails launch.
- **Non-idempotent effects** (setup scripts, PTY spawn, worktree create) must stay
  mounted with `display:none`, never `cond && <C/>` — remount re-fires them.
- **A11y baseline:** new interactive elements need keyboard focus + an accessible
  name; never `outline:none` without a `:focus-visible` ring.
