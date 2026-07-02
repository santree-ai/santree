# CLAUDE.md

Guidance for working in this repo. Keep it accurate as the code changes.

## What this is

**santree** — a cross-platform (macOS + Linux) desktop app for **managing AI coding
agents** across a repo's tickets. Tauri 2 + React 19, with a **fully-typed
Rust ↔ TypeScript bridge** (tauri-specta). Pre-release, **zero users** — so there's
no backwards-compatibility burden: prefer deleting dead/old code over keeping shims.

**Views:** all of them — Triage, Issues, Trees, Reviews, Settings, Terminal — are
backed by real data. **There is no mock/sample data anywhere**; when a backend isn't
connected (no Linear org, no `gh` auth, no repo path) commands return real-but-empty
results and the view shows its empty state.

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
                   migrations) · repo.rs · settings.rs · terminal.rs
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

**Before finishing a change:** `cargo check`/`clippy`, `pnpm gen:bindings` (if commands
changed), `npx tsc --noEmit`, `pnpm lint`, and the test suites — keep them all green.
And for any new command taking a path/id/branch, confirm it's validated
(`safe_path` / no-leading-dash) before it reaches fs or git.

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
