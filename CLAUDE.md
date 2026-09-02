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
backed by real data. **No view ever renders sample data**; when a backend isn't
connected (no Linear org, no `gh` auth, no repo path) commands return real-but-empty
results and the view shows its empty state. The one sample lives outside the views:
`prompts::preview` renders a template against a built-in sample ticket so the prompt
editor can re-render on every keystroke without a fetch.

**Trees is the workspace; Reviews is the inbox.** A PR *you* opened is worked on in
Trees, beside its worktree and its agents (the right panel's PR and AI-work panes).
Reviews carries the PRs waiting on *your* review — other people's. That split is
load-bearing for where new PR work goes; see "Key patterns".

The hidden **Dev** tab (dogfooding: build/install santree from inside santree, cut
a release, bug TODO list) was **removed** before the public release, along with the
cross-repo Agents landing view it sat beside. `/` now redirects to `/trees`, whose
empty state is the welcome surface. Its migration (`0017_dev_todos`) is still in
the directory on purpose — sqlx fails to start against a DB that recorded an
applied version the resolved set no longer has — and `0028` drops the table.

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
  no `tailwind.config`), xterm.js, react-markdown, refractor (Prism) for syntax
  highlighting, mermaid (dynamic-imported — never in the startup bundle). Biome
  for lint+format. Vitest.
- **Cargo workspace:** `src-tauri` (the backend: the Tauri adapter plus the
  integrations and services it drives) + `crates/core` (pure domain
  + static config, no Tauri dep) + `crates/pty` (PTY manager, Tauri-agnostic) +
  `crates/hook` (the bundled `santree-hook`: Claude hooks, status line, MCP server).

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
  The one sanctioned exception is the **screenshot fixture mode**
  (`src/dev/fixtures/`, `VITE_SANTREE_FIXTURES=1 pnpm dev:alt`): a fake company
  answered at the `invoke` boundary through a Vite alias of `@tauri-apps/api/core`,
  for README and website captures. Dev-only by build-time constants, no view or
  hook knows it exists, and it never ships — see its README before touching it.
- **Domain types** live in `crates/core/src/domain.rs` and derive `specta::Type` —
  that's how their shapes reach `bindings.ts`. **Never hand-edit `bindings.ts`** (it's
  generated; run `pnpm gen:bindings` after changing a command or `Type`).
- **Presentation is the frontend's job.** Rust ships plain enums; `src/theme/colors.ts`
  maps them to colors/labels. The accent is a runtime CSS var so it re-themes live.

## Repo structure

```
docs/terminals.md  how terminal emulation works, end to end — the source of
                   truth for crates/pty, terminal.rs and features/terminal
crates/core/src/   domain.rs (types) · config.rs (static config/defaults) · linear.rs
                   (mapping) · layout.rs (dagre-free graph helpers) · diff_index.rs
                   (a PR's commentable hunk spans; written by the app, read by the
                   AI review's MCP server) · lib.rs
crates/pty/src/    lib.rs — PtyManager: spawn real process behind a PTY, stream bytes
                   · ring.rs (a session's recent output + the attach protocol, so
                   a reload costs the view and not the work)
crates/hook/src/   main.rs — the bundled `santree-hook`: Claude's session-state
                   hooks + statusLine, and `mcp` mode (mcp.rs · review_tools.rs),
                   the AI review's draft-comment tools
src-tauri/src/     lib.rs (builder + command registration) · commands.rs (thin wrappers)
                   · linear.rs (GraphQL + OAuth + token store) · db.rs (sqlx pool +
                   migrations) · repo.rs · settings.rs · terminal.rs · stream.rs
                   (background command runs behind a PTY → read-only log panes)
                   · proc_table.rs (the one `ps` listing, cached 500ms) +
                   agent_procs.rs (which agent owns each pane's foreground —
                   identity, never status; see COMPLIANCE.md)
                   · hooks.rs (the `--settings` file EVERY santree `claude` launch
                   layers on: session-state hooks, statusLine, English tutor; plus
                   the AI review's deny/allow variant and its `--mcp-config`)
                   · review_ai.rs (both review prompts + the AI-review launch)
                   · review_drafts.rs (the AI's drafts, and the ONE path that puts
                   them on GitHub — on a click, into the user's pending review)
                   · english_tutor.rs (opt-in writing coach: hook + practice log
                   + on-demand analysis)
src-tauri/migrations/  0001_init … (SQLite schema; applied on startup)
src/
  main.tsx         QueryClient (+ global mutation→toast) · providers · router ·
                   the fixture-mode boot hook (dev + `VITE_SANTREE_FIXTURES=1` only)
  dev/fixtures/    the screenshot fixture world (see "No mock data") — its own
                   README says what is fake and what stays real
  routes/          one file per destination → renders a feature view's CONTENT
                   (window chrome belongs to the shell, never to a view)
  components/shell/  the one permanent frame: sidebar (search · destinations ·
                   triage → tickets → investigations · projects → worktrees →
                   agents) · status bar · AppShell
  features/<view>/ each owns a model.tsx (context) + presentational components
  features/trees/  the worktree workspace. Right panel = 6 panes (Issue · Files ·
                   Changes · History · PR · AI work queue; the last two only when
                   the branch has one). The AI-work pane is the queue AND the AI's
                   brief, in that order — one destination, not two tabs. Main area
                   = the worktree's tabs (every agent and shell it has open, the
                   one a started task runs in included — each a `worktree_tabs`
                   row, so a restart reopens exactly what was open, and closing
                   the last leaves the welcome surface) · a picked file's diff ·
                   setup logs · a check's raw job log · the PR page and the
                   Linear ticket page, each opened from its rail pane's expand
                   control (closable, and not a row)
  features/reviews/  OTHER PEOPLE's PRs (the inbox). Main area = the same tab
                   strip Trees has (`ReviewTabBar`): a non-closable **Pull
                   Request** tab (its header, then Conversation — description
                   block, then the comments — · Commits · Checks · Files changed,
                   which carries the diffstat) · the PR checkout's own
                   `worktree_tabs` rows · the AI review sessions · the Linear
                   ticket page when expanded from the rail. Beside it a
                   `ReviewSidePanel` rail of Issue + AI work queue. Also the PR
                   components both hosts share — `PrPage` (the whole PR view,
                   host-agnostic: Trees opens it too), checks, brief, queue list,
                   AI work pane, file body, cards
  features/triage/ the ticket workspace at `/triage?ticket=` — a third tab-strip
                   host (`TriageTabBar`): a non-closable **Linear** tab
                   (`components/IssuePage`), one closable tab per investigation
                   agent, and a shell. Beside it a `TriageSidePanel` rail of
                   Files · Session history, both reading the attached project's
                   MAIN checkout and naming it (with its Change control) on
                   their header line; with nothing attached each pane is the
                   ask instead. `TriageRepoGate` is the modal that asks for
                   that project. The queue itself lives in the
                   sidebar's `TriageSection`.
  lib/queries.ts   ALL data hooks (useUnwrappedQuery, useOptimisticMutation, …)
  lib/attention.ts what needs a human: level ladder, seen-gating, tree ordering
  state/           AppContext (repo, theme, settings) · toast.tsx (notifications)
  components/       shared chrome + primitives.tsx (Badge, EmptyState, ChevronSelect…)
                   · SidePanel (the one right-panel shell every view is built on)
                   · TabStrip (the one main-area tab strip every view draws)
                   · IssuePane (the Linear-ticket RAIL pane) + IssuePage (the
                   same ticket at reading width, for a tab) · IssueProperties
                   (the one Linear-style property strip — priority, points,
                   cycle, due, project, milestone, assignee, labels — every
                   ticket surface draws, from a row or from the detail) ·
                   WorkSignals (the shared marks: PriorityBars, StatusGlyph,
                   EstimateTag, CycleTag, the due-date signals, the headings)
                   · ProjectPickerDialog (pick a registered project, with a
                   default — what the triage repo gate asks through)
  theme/colors.ts  enum → color/label maps
```

## Key patterns (reuse these)

- **Layout:** there is ONE window frame (`components/shell/AppShell`) — a permanent
  sidebar and status bar around a swapping content area. A view renders content only:
  no navigation, no repo switcher, no window chrome of its own. Anything that must
  outlive a navigation (terminal layer, background agent runs, palette) is mounted by
  `routes/__root.tsx` outside the content slot, or it dies on the next click.
- **Attention:** a status dot, an ordering, or a "needs you" count comes from
  `lib/attention.ts` (`levelOf` · `highest` · `compareAttention` · `useSeenAgents`) on
  top of the agent registry's buckets — never from a second classification.
- **Your own PR lives in Trees, not Reviews.** The right panel's `pr` and `aiWork`
  panes (`features/trees/WorktreePrPane` · `reviews/AiWorkPane`) are the whole
  own-PR surface: state, checks, conversation, AI brief, and the work queue that a
  failing check, a review comment, an AI draft or a highlighted diff line all feed.
  One "Start work" agent drains it, in the same main panel as every other agent.
  Everything that *fills* the queue goes through `reviews/QueueAction` — one
  control, one spark glyph, one minted id — so the buttons and the tab read as one
  concept.
  The sidebar lists no own-PR rows: a worktree's PR is reached through the
  worktree. The full PR page (header + Conversation · Commits · Checks · Files
  changed) is `reviews/PrPage`, and the PR pane's expand control opens it as a
  closable Trees tab — so do the Linear and GitHub marks on a sidebar worktree
  row (`TreeFocus.expand`: the ticket page or the PR page, never the rail pane).
  The prompt "Start work" hands the agent is the `pr-fix` template
  (`review_ai::fix_prompt` renders it over the open queue items), editable in
  Settings → Prompts under Reviews; its preview renders over a sample queue the
  editor builds and the backend turns into the agent's JSON through the same
  builder a real queue uses (`sample_fix_tasks`).
  **Reviews is only other people's PRs** — the inbox of what's waiting on you.
  The components are shared, not duplicated: `PrPage`, `ChecksPane`,
  `ReviewBriefSection`, `ReviewWorklist`, `AiWorkPane`, `PrFileBody` and the
  draft/thread cards take their host's callbacks as props (see `useStartWork.ts`
  for the one thing the two hosts really differ on — whether the PR's worktree
  has to be created first).
- **Triage is a sidebar section, not a destination.** `shell/TriageSection`
  lists the rotation (one row — who has it and until when; a click opens the
  whole schedule in `shell/RotationDialog`), the active tickets with their SLA,
  each ticket's investigation agents under it, and a folded Snoozed group — scoped
  to the active repo and filtered by the header's scope menu — Mine/All, the
  `triage_good_citizen` setting; that menu is its only control. A ticket opens
  `/triage?ticket=<id>`; selection lives in the route so the row lights from it,
  exactly as Reviews' `?pr=` does. There is no manual ordering: the order is the
  backend's (active first, soonest SLA). `useTriageQueue` is the one source for
  what the section shows. A row's right-click menu (`shell/TriageTicketMenu`)
  snoozes it — the one Linear write offered from the rail, gated like the
  status picker (disabled with `LINEAR_READ_ONLY_HINT`, refused by
  `repo_write_session` regardless).
- **A triage ticket runs on an attached project, never a worktree.** Two repos,
  deliberately: the queue and the ticket come from one Linear org
  (`useTriageOrgRepo` — the triage default, else the active repo — read by both
  the section and the workspace so a row and the ticket it opens can't disagree),
  while anything that *runs* uses the ticket's attached project (`useTriageRepo`:
  its own `triage_repo:<id>`, else `triage_default_repo`), on that project's MAIN
  checkout. An investigation, a terminal and the rail's file/history panes all
  need one, so the first such action asks for it once through
  `triage/TriageRepoGate` (the promise-resolving pattern `reviews/WorktreeGate`
  established) and every action goes through one `withRepo`. Nothing here creates
  a worktree, and the backend agrees: `validate_agent_cwd` refuses a `triage:`
  session anywhere but the registered repo root.
- **Where a ticket starts is the Work gate's answer.** Several registered
  projects can share a ticket's Linear org, so the Tickets list resolves the
  project once, through `tickets/WorkRepoGate` — the one project that carries
  the ticket (no question), else the Work default (`work_default_repo`, Settings
  → Work; distinct from triage's on purpose), else `ProjectPickerDialog` over just
  those projects, with a save-as-default switch. Run and the launch queue both
  take that answer (`enqueueIn` switches the active repo and parks the add when
  the answer isn't it), and the menu's "Run in another project…" is the one way
  past it for a single run.
- **One right panel, four hosts.** `components/SidePanel` is the chrome — icon
  strip, underline, dots, drag region, edge resize, collapse-to-nothing — and each
  view supplies its own panes, dots and model (`trees/FilePickerPanel`,
  `reviews/ReviewSidePanel`, `triage/TriageSidePanel`, and Tickets'
  `issues/RightPanel`; distinct `cssVar`s, or they resize each other). What goes
  in a rail is *reference beside the work*, which is why Reviews has no PR pane
  and Triage no Issue pane: in each, the main area already **is** that thing.
  Tickets' rail has two: the whole ticket (`issues/IssuePanel` — run control,
  blockers, body, notes) and the launch queue (`issues/QueuePane` — one card per
  queued ticket with its agent pick and notes, and the one Launch button; its
  tab wears the accent dot while anything is queued and a `+N` for a beat after
  each add). The queue is in-memory and the active repo's; the per-ticket pick
  is the *agent* only — model and effort come from Settings for that agent, by
  the rule in `issues/model.tsx`. Collapsed, a rail draws
  nothing and its host's top strip takes the `PanelToggle` over at the same
  right edge (Trees' tab bar, the Tickets header).
- **One main tab strip, three hosts.** `components/TabStrip` is the chrome — fitting
  and overflow, rename-in-place, the close ×, the "+" and its ⌘T, the drag region —
  and each host supplies its tabs, its menu rows and its trailing controls
  (`trees/MainTabBar`, `reviews/ReviewTabBar`, `triage/TriageTabBar`). A tab is a
  `worktree_tabs` row, or one of two other things: the tab that *is* the view
  (Reviews' "Pull Request", Triage's "Linear" — always there, never closes), or a
  transient view that appears with what it shows (a picked file, setup logs, a
  check log, the PR page, the ticket page — ephemeral `MainTab` literals, never
  rows, closable). Closing a row tears its PTY down and a dead process closes its
  row — both from `trees/useTabSessions`, once, for every strip.
- **One place renders a diff.** `features/trees/DiffPane` picks the source with
  `prDiffModeFor`: GitHub's own patch when the file is in the PR (its line numbers
  are what the comments anchor to), the local branch-vs-base diff otherwise, and
  the local diff *with a notice* when the branch has unpushed commits. Never
  overlay PR comments on a locally recomputed diff — that is how a comment lands
  on the wrong line.
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
- **Right-click menus:** `primitives` `ContextMenu` wraps a region (a row, a
  card) and opens `PositionedMenu` at the pointer or from Shift-F10; the graph
  opens `PositionedMenu` itself from React Flow's `onNodeContextMenu`. Four
  objects have one: a worktree (`shell/WorktreeMenu`), a ticket (the Tickets
  list row and the graph node — `tickets/TicketRow`, `issues/ticketMenu` — and
  the triage row, `shell/TriageTicketMenu`), and a pull request in the sidebar
  (`shell/ReviewPrMenu`). A ticket's Linear rows (open, copy id, copy link)
  come from `components/menuRows` so every host offers the same three; the
  Linear url is built from the org's slug (`useLinearIssueUrl`), never fetched.
  Rows are declarative `ContextMenuItem`s — a menu is a fixed list of actions
  on one object, and a render prop is how two of them drift.
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
- **Nothing an agent writes reaches GitHub without a click.** The AI review's MCP
  tools write santree's own rows; `review_drafts::publish` is the only path out,
  and it runs on a user action into their pending review. A new command that lets
  an agent-authored value reach a `github.rs` write is the line this feature exists
  to hold.

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
gates: `cargo fmt --all --check`, `cargo check`/`clippy`, `pnpm gen:bindings` if
commands changed, `npx tsc --noEmit`, `pnpm lint`, both test suites — all green).
`cargo fmt` is first because it is the gate that keeps getting skipped: clippy
and the tests pass happily on unformatted code, and CI's backend job runs `fmt`
*before* them, so the drift fails the build and masks everything after it. For any new
command taking a path/id/branch, confirm it's validated (`safe_path` /
no-leading-dash) before it reaches fs or git.

## Releasing & the self-updater

The app ships from CI only: a `v*` tag drives `.github/workflows/release.yml`
(universal macOS build → codesign → notarize → staple → `spctl` verify →
smoke-launch the signed .app → publish). No local machine signs anything — the
credentials live in the repo's `release` GitHub environment, restricted to `v*`
tags. README "Releasing" is the operator story; this is what an implementer
must not break.

**Cutting a release** is a version bump, a changelog entry and a tag, nothing
else: set the same version in `package.json`, `src-tauri/tauri.conf.json` and
`Cargo.toml` (`[workspace.package]`, which `Cargo.lock` mirrors for the
workspace crates), add a `## X.Y.Z` section to `CHANGELOG.md`, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. The guard fails the tag unless the
three versions match it, and fails a *stable* tag without its changelog entry
— that section becomes the release body and the in-app "What's new", so write
it for users, in plain bullets (the app renders it as text). Betas without an
entry fall back to a commit-compare link.

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
- **`tauri.dev.conf.json` carries the whole window entry**, not just its title:
  a `--config` overlay merges by JSON merge-patch, so an `app.windows` array
  *replaces* the base one — a one-field entry silently dropped
  `titleBarStyle: Overlay` and gave the dev build a native title bar, shifting
  every capture. Keep it a mirror of `tauri.conf.json`'s entry plus the title,
  and remember `tauri dev` reads the overlay once at launch: editing it triggers
  a rebuild but not a re-merge, so restart the dev stack to pick it up.
- Tailwind v4 is CSS-first (`@theme` in `src/styles.css`, which Biome is configured to
  skip). IDE "unknown at-rule" warnings are handled by `.vscode/settings.json`.
- **Terminals survive a reload, so a pane unmounting must never `close` a
  session** — it detaches, and the session is caught up from its ring on the way
  back. Only `close(key)` on a tab ends a process. Read
  `docs/terminals.md` before touching `crates/pty`,
  `terminal.rs`, or `src/features/terminal/`.
- **Terminal compliance:** the PTY runs the real, unmodified CLI — no credential
  handling, no output-parsing-drives-input, no unattended loops. See `COMPLIANCE.md`;
  these constraints are load-bearing.
- **External CLI contracts:** verify vendor flags against `--help`, don't guess.
  Claude `--model` takes dash-form ids or aliases (`sonnet`/`opus`/`haiku`) —
  dotted (`claude-sonnet-4.5`) is invalid and fails launch.
- **Codex fires `SessionStart` on the first turn, not at launch** (0.151.0,
  measured). So a Codex tab that hasn't been prompted has no `session_state` row
  and no `terminal_sessions` binding — nothing hook-fed knows it exists. Anything
  that must show an agent promptly reads the process table (`agent_procs.rs`, the
  pane's foreground process group) or santree's own launch record (the terminal
  tab's `AgentTabIdentity`), not the hook. **Which agent** is running has one
  ordered arbiter — session row → process table → launch record — and **what it
  is doing** still has only `lib/attention.ts`; never let the first answer the
  second. See `docs/terminals.md` "Agent state" and "Agent identity".
- **A `santree-hook` write that fails leaves a line in
  `<app_data_dir>/santree-hook-errors.log`.** The binary is silent to the agent
  by contract, which used to mean silent full stop — check that file before
  concluding a hook never fired.
- **Non-idempotent effects** (setup scripts, PTY spawn, worktree create) must stay
  mounted with `display:none`, never `cond && <C/>` — remount re-fires them.
- **A11y baseline:** new interactive elements need keyboard focus + an accessible
  name; never `outline:none` without a `:focus-visible` ring.
