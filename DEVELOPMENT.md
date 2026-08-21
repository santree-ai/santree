# Developing santree

The contributor's guide: how the app is put together, how to build and test
it, and how releases ship. For what santree *is*, read the
[README](README.md); for how it's allowed to interact with agent CLIs, read
[COMPLIANCE.md](COMPLIANCE.md).

santree is **Tauri 2 + React 19 + TanStack** with a **fully-typed
Rust ↔ TypeScript bridge** (tauri-specta). Every view is backed by live data:
Linear (GraphQL + OAuth), a SQLite store, real `git`/GitHub, and real kernel
PTYs. **There is no mock/sample data anywhere.** When a backend isn't
connected (no Linear org, no `gh` auth, no repo path) commands return
real-but-empty results and the view shows its empty state — the frontend
never fabricates data.

```
React view → query hook (src/lib/queries.ts) → bindings.ts (generated)
          → #[tauri::command] → live backend (Linear / SQLite / git / GitHub / PTY)
            └─ when not connected: real-but-empty result → view renders its empty state
```

---

## Prerequisites

- **Rust** — install via [rustup](https://rustup.rs). The exact toolchain version is pinned in [`rust-toolchain.toml`](./rust-toolchain.toml) (with `rustfmt` + `clippy`), so rustup will fetch and use the right one automatically, both locally and in CI.
- **Node 22+** and **pnpm** (`npm i -g pnpm`).

### Linux system dependencies

Tauri renders through the OS webview — **WebKitGTK** on Linux — so you need its dev libraries before the Rust side will build.

**Debian / Ubuntu:**

```sh
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

**Fedora:**

```sh
sudo dnf install -y \
  webkit2gtk4.1-devel \
  openssl-devel \
  curl wget file \
  libappindicator-gtk3-devel \
  librsvg2-devel
sudo dnf group install -y "c-development"
```

**Arch:**

```sh
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  base-devel \
  curl wget file \
  openssl \
  gtk3 \
  libayatana-appindicator \
  librsvg
```

macOS needs only the Xcode Command Line Tools (`xcode-select --install`); no extra webview packages.

---

## Install & run

```sh
pnpm install      # frontend deps (Cargo deps are fetched on first build)
pnpm dev          # launches the full desktop app with hot reload
```

The first `pnpm dev` compiles the Rust side and can take a few minutes; subsequent runs are fast.

---

## How data flows

The frontend never calls `invoke` directly and never hard-codes data. Follow the layers:

1. **A view** (e.g. `src/features/issues/IssuesView.tsx`) consumes a typed query hook.
2. **`src/lib/queries.ts`** — TanStack Query hooks (`useTasks`, `useTriageTickets`, …) wrapping the generated client. Caching, loading states, and **optimistic mutations** live here (`useOptimisticMutation`: patch the cache, roll back on error, invalidate on settle).
3. **`src/bindings.ts`** — **generated** by `tauri-specta`. The typed `commands.*` and every domain type, mirroring Rust exactly. _Never hand-edit this file._
4. **`src-tauri/src/commands.rs`** — thin `#[tauri::command]` wrappers that forward to a live backend, e.g. `linear::…(db, repo).await?.unwrap_or_default()`. When a backend isn't connected the command returns a real-but-empty result (`Ok(vec![])`, `None`, …) — never sample data.
5. **Live backends** — `src-tauri/src/{linear,db,repo,settings,terminal,github,worktree,git,reviews}.rs` (Linear GraphQL + OAuth + token store, the sqlx pool, repo registry, settings, PTY, GitHub API, git worktree management, PR reviews). Domain types live in `crates/core/src/domain.rs` and derive `specta::Type`, which is how their shapes reach `bindings.ts`. `crates/core/src/config.rs` holds the only static data in the app — real canonical config (agent catalog, stage metadata, default settings), not samples.

Presentation (colors, labels) is the frontend's job: `src/theme/colors.ts` maps the plain Rust enums (`TaskStatus`, `Tone`, …) to concrete colors. The accent color is a runtime CSS variable so the Appearance setting re-themes everything.

Failed mutations surface as red **toasts** automatically (wired once in `main.tsx`); background successes raise green ones via `toast.success(...)`.

---

## Hot reload

| You edit…                     | What happens                                                           |
| ----------------------------- | ---------------------------------------------------------------------- |
| `.tsx` / `.css` in `src/`     | **Vite HMR** — updates instantly, no restart, state preserved.         |
| `src-tauri/**` or `crates/**` | **`tauri dev` rebuilds** the Rust binary and relaunches (~tens of secs).|

---

## Regenerating bindings

`src/bindings.ts` is regenerated automatically on every `pnpm dev` (debug builds export it on startup). To regenerate it on demand without launching the app:

```sh
pnpm gen:bindings
```

This drives a Rust test (`export_bindings_succeeds`) that re-emits the file from the current command set. Run it whenever you add/change a `#[tauri::command]` or a `specta::Type`. **`bindings.ts` is generated — never hand-edit it** (it is committed so release builds, which skip the export, can rely on it).

---

## Testing

```sh
cargo test        # Rust: core logic + bindings export
pnpm test         # Frontend: Vitest
```

- **`crates/core`** — unit tests for Linear→domain mapping (`linear.rs`) and the dagre-free graph layout helpers (`layout.rs`).
- **`src-tauri`** — `export_bindings_succeeds` guards that the command set always produces valid bindings.
- **Frontend (Vitest)** — presentation helpers (`theme/colors`, `lib/format`), component behavior (`Markdown`, `ErrorBoundary`, `TerminalView`, `TaskNotes`, `ReviewsSidebarView`), and pure logic (`buildChangeTree`, Trees `model`, terminal agent seeding).

---

## Releasing

Releases are cut by pushing a tag; `.github/workflows/release.yml` does the rest
(universal macOS build → codesign → notarize → staple → smoke-launch → publish).
macOS only: the Linux jobs in CI exist to keep the code portable, not to produce
downloads.

```sh
# bump the version in all three places CI checks: package.json,
# src-tauri/tauri.conf.json, Cargo.toml ([workspace.package])
git tag v0.2.0 && git push origin v0.2.0
```

**The tag picks the channel.** `v0.2.0` publishes a normal release (the stable
channel, which reads GitHub's `releases/latest` pointer). `v0.2.0-beta.1`
publishes a pre-release, which that pointer skips — so only beta users see it.
The semver ordering is what makes a beta roll onto stable later:
`0.2.0-beta.1 < 0.2.0`. Updates only ever move forward, so switching from beta
back to stable means waiting for a stable release that passes the installed
beta; the Settings → Updates panel says so.

Beta's endpoint is a fixed pre-release tag, `updater-beta`, whose `latest.json`
**every** release overwrites — stable ones included. That's what stops a beta
user from being stranded on an old beta once a newer stable ships.

**Credentials** live in the repo's `release` GitHub environment, which is
restricted to `v*` tags so no other workflow can reach them: the Developer ID
certificate (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`), the App Store Connect API key used for notarization
(`APPLE_API_ISSUER`, `APPLE_API_KEY_ID`, `APPLE_API_KEY`), and the updater
signing key (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

> **The updater private key has no recovery path.** Installed copies only accept
> an update signed by the key whose public half was compiled into them
> (`plugins.updater.pubkey` in `tauri.conf.json`). Lose it and every install
> silently stops updating forever — the only fix is asking users to re-download.
> The Apple certificate, by contrast, is replaceable: shipped apps keep
> validating, because their signatures are timestamped.

Two subtleties worth knowing before touching this:

- **Bundle resources aren't signed by Tauri.** `santree-hook` ships via
  `bundle.resources`, and notarization rejects any unsigned Mach-O in the
  bundle, so `scripts/sign-resources.mjs` signs it from `beforeBundleCommand` —
  after it's staged, before the bundler seals it in. The script is a no-op
  without `APPLE_SIGNING_IDENTITY`, which is why keyless local builds still work.
- **Updater artifacts are release-only.** Generating them *requires* the signing
  key, so `createUpdaterArtifacts` is passed by the release workflow
  (`--config '{"bundle":{"createUpdaterArtifacts":true}}'`) rather than committed
  to `tauri.conf.json` — otherwise every keyless build, including CI's bundle
  smoke and any local `pnpm tauri build`, would fail.

---

## Terminals (real PTY emulation)

The **Terminal** tab is a real terminal emulator — architecturally like iTerm or
VS Code's integrated terminal, **not** a command runner. A kernel PTY hosts a real
process and we stream raw bytes both ways: `xterm.js` in the webview ↔
`portable-pty` in Rust, over a local Tauri **Channel** (the high-throughput
primitive; output never uses `emit`). Full-screen TUIs (`vim`, `htop`, an
interactive `claude`) run identically to a standalone terminal — alt-screen,
colors, mouse, `Ctrl-C`, live resize.

**Try it:** open the Terminal tab → a login shell opens in the active repo's
directory. Click **+** for another shell (sessions are isolated and run
concurrently). Type a command into "Run a command…" (e.g. `htop` or `vim`) to open
a new terminal seeded with it. Closing a tab kills its child; quitting the app
cleans up every session.

**Swappable engine.** xterm.js sits behind two interfaces in
`src/features/terminal/types.ts` — `TerminalRenderer` (the VT engine) and
`TerminalBackend` (the Tauri transport). xterm is imported in exactly one file,
`XtermRenderer.ts`, so swapping the engine later (e.g. a libghostty-backed
renderer) is mechanical.

**Layers:**

```
crates/pty/                  # PtyManager: spawn real process behind a real PTY,
                             #   stream raw bytes to a callback (Tauri-agnostic, unit-tested)
src-tauri/src/terminal.rs    # thin commands: terminal_open/write/resize/close; output → Channel
src/features/terminal/
  types.ts                   # TerminalRenderer + TerminalBackend interfaces (the seams)
  XtermRenderer.ts           # the ONLY xterm import
  TauriBackend.ts            # transport over the generated commands + Channel
  TerminalView.tsx           # wires a renderer to a backend by session id
  orchestrator.ts            # the app's terminal API: placement + one optional seed
  TerminalSurface.tsx        # the Terminal tab (tab list + active terminal)
```

**Testing:** `cargo test -p santree-pty` covers the PTY lifecycle (spawn → write →
read echo → close, concurrent isolation); `pnpm test` covers `TerminalView` wiring
with a fake backend/renderer.

> **Compliance:** santree runs the real, unmodified CLI in a real terminal. It does
> **not** handle credentials, parse output to drive input, or run any unattended
> control loop. See [COMPLIANCE.md](./COMPLIANCE.md) — these constraints are
> load-bearing and must survive future changes.

---

## Project layout

```
.
├── crates/core/               # pure domain + static config — NO Tauri dep, unit-testable
│   └── src/{domain,config,linear,layout}.rs  # types · canonical config/defaults · Linear→domain mapping · dagre-free graph helpers
├── crates/pty/                # PtyManager: real process behind a real PTY (Tauri-agnostic)
├── src-tauri/                 # THIN Tauri adapter (wiring + commands + live backends)
│   ├── src/{lib,commands}.rs  #   builder + registration + #[tauri::command] wrappers
│   ├── src/{linear,db,repo,settings,terminal,github,worktree,git,reviews}.rs  # live backends (GraphQL/OAuth, sqlx, PTY, GitHub API, worktrees, PR reviews)
│   └── migrations/            #   SQLite schema, applied on startup
├── website/                   # the landing page + docs (TanStack Start, prerendered to GitHub Pages)
└── src/                       # React frontend (SPA)
    ├── main.tsx               #   QueryClient (+ global mutation→toast) · providers · Router
    ├── bindings.ts            #   GENERATED typed client (do not edit)
    ├── routeTree.gen.ts       #   GENERATED route tree (do not edit)
    ├── routes/                #   one file per top-level tab → renders a feature view
    ├── components/            #   shared chrome + primitives.tsx (Badge, EmptyState, …)
    ├── state/                 #   AppContext (repo, theme, settings) · toast.tsx
    ├── lib/                   #   query hooks · format helpers · useEdgeResize · shortcuts
    ├── theme/colors.ts        #   enum → color/label presentation maps
    └── features/              #   one folder per view (issues, triage, trees, …)
        └── <view>/            #   its own model.tsx + presentational components
```

**The pattern, top to bottom:** `src-tauri` is a thin adapter over `crates/core`; the frontend reads only through typed query hooks; each feature owns its ephemeral state in a `model.tsx` context while shared data comes from queries and shared client state from `AppContext`. Presentational components stay dumb (they receive view-models).

### Available scripts

| Command             | Does                                                 |
| ------------------- | ---------------------------------------------------- |
| `pnpm dev`          | Launch the full app with HMR (alias for `tauri dev`).|
| `pnpm build`        | Type-check + production frontend build.              |
| `pnpm gen:bindings` | Regenerate `src/bindings.ts` from Rust.              |
| `pnpm lint`         | Biome lint + format check.                           |
| `pnpm format`       | Biome auto-format.                                   |
| `pnpm test`         | Vitest (frontend).                                   |
| `cargo test`        | Rust tests (core logic + bindings).                  |
| `cargo clippy`      | Rust linter.                                         |
| `cargo fmt`         | Rust formatter.                                      |

---

## Known caveats

- **`tauri-specta` is on a release-candidate tag.** It's pinned to `=2.0.0-rc.25` (with `specta =2.0.0-rc.25` and `specta-typescript 0.0.12`) — these are the Tauri 2-compatible line and must move together. Exact-version pins (`=`) are intentional: RC releases can break across patch bumps. If you bump one, bump all three and run `pnpm gen:bindings` + `cargo test` to confirm the bridge still compiles. This is the current state of the art for typed Tauri bindings; we are **not** falling back to untyped `invoke`.
- **The Linux webview is WebKitGTK**, not Chromium. It's generally fine, but it lags Chromium on bleeding-edge CSS/Canvas/WebGL — worth remembering once we add heavy graphics (node graphs, terminals) later.
