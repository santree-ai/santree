# Screenshot fixtures

A fake world for README and website captures, served at the one boundary every
view reads through: the Tauri `invoke` call the generated bindings make. The
views render it exactly as they render a live backend, because as far as they
can tell it is one.

This is the **one sanctioned exception** to CLAUDE.md's no-mock-data rule, and
it is built so it cannot leak: the whole directory is reached only from
`main.tsx` behind `import.meta.env.DEV && import.meta.env.VITE_SANTREE_FIXTURES === "1"`,
both build-time constants, so a production bundle contains none of it. No view,
hook or command knows this directory exists.

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
