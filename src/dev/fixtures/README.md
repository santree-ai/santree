# Screenshot fixtures

A fake world for README and website captures, served at the one boundary every
view reads through: the Tauri `invoke` call the generated bindings make. The
views render it exactly as they render a live backend, because as far as they
can tell it is one.

This is the **one sanctioned exception** to AGENTS.md's no-mock-data rule, and
it is built so it cannot leak: the whole directory is reached only from
`main.tsx` behind `import.meta.env.DEV && import.meta.env.VITE_SANTREE_FIXTURES === …`,
both build-time constants, and from `vite.config.ts` aliases and a plugin that
exist only in a dev build with the flag set, so a production bundle contains
none of it. CI proves that on every build: `pnpm check:no-demo`
(`scripts/check-no-demo-in-dist.mjs`) fails if `dist/` carries a string only
the fixtures contain. No view, hook or command knows this directory exists.

## Run it

```sh
echo 'VITE_SANTREE_FIXTURES=1' > .env.development.local   # gitignored (*.local)
pnpm dev:alt
```

Edit `scene.ts` to pick the route, theme, selected worktree, right-panel pane
and main tab; saving reloads the page onto it.

## What is fake and what is real

Fake (`handlers.ts`): repos, worktrees and their git state, Linear tickets and
triage, GitHub PRs and reviews, agent sessions and their usage, and the
terminals — every pane the fixture world owns is painted from a script in
`transcript.ts` instead of a process (`terminal.ts`).

Real: settings, prompts, the agent catalog and its availability, hook files,
the keychain-backed statuses. The chrome around the invented work is the app's
own. The one seam in app code is `features/terminal/fixtureSeam.ts`, which lets
the installer open a pane per fake agent so the sidebar counts them as live.

## The live demo world (`demo/`)

A second, stateful world for recording the product demo: Parcelwise, a
delivery-logistics company with three repos, five Linear projects with
milestones, a blocker graph, chained worktrees and PRs, and a busy merge
queue. Unlike the screenshot world it *moves*: launches create worktrees, the
setup script streams, agents work through scripted screens, commits and PRs
land, the AI review writes its drafts, and the work queue gets worked.

```sh
VITE_SANTREE_FIXTURES=demo pnpm dev:alt
```

- **Photos:** run `src/dev/fixtures/demo/fetch-avatars.sh [your-photo.jpg]`
  once. It fills the gitignored `demo/avatars/` with coworker portraits
  (randomuser.me) and your own photo (default `~/Documents/image.jpg`);
  without them everyone gets an initials disc.
- **Shortcuts** (no app UI knows the demo exists; each confirms in a small
  bottom-left label): ⌃⌥⌘R resets the demo, ⌃⌥⌘S saves the current state as
  the starting point a reset returns to (the first boot is the default), and
  ⌃⌥⌘1–4 set the speed to 1×, 1.5×, 2× or 3× (default 2×), which scales the
  agents, the AI review, the queue run, the hero PR's CI and its comments. The
  timings below are at 1×; halve them at the default. All demo state is in
  memory.
- **Daedalus is real.** Commands for a demo repo, PR or checkout are answered
  here; everything else (Daedalus projects and terminals, settings, the agent
  catalog) reaches the real backend. Local repos are hidden; Daedalus ones show.
- **Pace:** setup ≈3s, hero agent ≈23s, AI commit message ≈0.6s, AI PR
  description ≈0.85s (neither follows the speed), PR comments and CI ≈38s, AI review ≈13s, queue run
  ≈21s, green CI after the push ≈31s.
- `demo/demo.test.ts` runs the whole script against the demo backend.

**How it hooks in.** Not through `invoke`: a dev-only Vite plugin resolves
every app import of `src/bindings.ts` to `demo/bindings.ts`, which spreads
`buildDemoCommands(real.commands)` over the generated `commands`. Each override
has the real command's exact signature, so a Rust change that moves one fails
`tsc` in the demo rather than at runtime (modules inside `demo/` import the
real bindings, so there is no cycle). Local state changes reach the views the
way the backend's do, through the typed events; GitHub data the app only polls
for is refreshed through the one hook the app gives the demo, the query client
`main.tsx` hands to `installDemo`. `@tauri-apps/plugin-opener` is aliased to
`demo/opener.ts` so links into the invented org (`github.com/parcelwise/…`,
`linear.app/parcelwise/…`) open nothing.

| File | What it holds |
|---|---|
| `company.ts` | people, repos, the Linear plan and ticket bodies |
| `hero.ts` | PLAT-421's code (three versions), its PR's timeline, its AI review |
| `code.ts` / `diff.ts` | the repo's file tree, and the differ that makes patches |
| `prs.ts` | PR seeds and builders, the inbox, the merge queue |
| `screens.ts` | scripted agent screens, the setup script's output |
| `state.ts` | everything the demo changes, and the clock that moves agents along |
| `world.ts` | the bindings' shapes, built from the two above |
| `handlers.ts` / `terminal.ts` | the typed command overrides and the fake PTYs |
| `bindings.ts` / `opener.ts` | what the Vite plugin and alias put in place of the real modules |
| `install.ts` / `reset.ts` | boot, the shortcuts, and the starting point a reset returns to |

### Run of show

Everything after the launch happens on one ticket, **PLAT-421** (webhook
retries deliver duplicates), so the sidebar barely moves.

1. **Graph.** Opens on Tickets in graph mode. Four tickets are ready
   (PLAT-418, -421, -424, -427); click **Select ready**. The sidebar already
   shows PLAT-401 → 402 → 404 chained, with PRs #1279 and #1284.
2. **Launch.** In the queue pane set two cards to Codex, then Launch. All four
   worktrees appear together in **infra**, the first project in the sidebar and
   otherwise empty, setup runs (≈3s), the agents start.
3. **The hero finishes.** Open PLAT-421: its agent is done in ≈23s, and its edits
   show up in Changes as it prints them.
4. **Commit + PR.** Stage all → the AI button in the commit box → Commit. It
   pushes and the PR dialog opens: **AI fill** → Create (#1293).
5. **The PR comes alive.** CI runs an eleven-job matrix for ≈38s: preview
   deploy skipped at once, jobs queue then run ("In progress · 12s"),
   `typecheck` red at 17s, `unit (2/3)` red at 24s, codecov neutral at 25s,
   e2e passes at 38s. Aisha comments inline at 9s, Maya at 20s, and Daniel
   requests changes at 25s, right after the shard he points at goes red.
6. **Review + queue.** AI work queue → **Start Claude Code review**: brief and
   three drafts in ≈13s. Walk the reading order; queue the drafts, the threads
   and the failing checks; **Start work**. Items tick off in ≈21s and the fixes
   land uncommitted (the run can't push, as in the real product). Commit (AI
   message) and push: the matrix runs again, all green by ≈31s, Daniel approves
   at ≈33s.
7. **Merge queue.** infra → Reviews → *Merge queue*: #1293 joins at position 6
   once approved. platform's queue has eight PRs with #1279 at position 3. Maya's three stacked PRs show in the
   Reviews section.
8. **Remote sessions.** Settings → Agents → Claude Code → *Enable Remote
   Control* is the real setting.

Between runs: **⌃⌥⌘R**.
