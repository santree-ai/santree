---
name: verify
description: Verify a santree-app change end-to-end — run the full green checklist (cargo check/clippy/test, bindings drift, tsc, biome, vitest), then drive the real app via the screenshot harness to observe the change working. Use before committing any nontrivial change, or when asked to confirm something works in the real app.
---

# Verify a santree-app change

Two passes: static gates first (fast → slow, stop on first failure), then drive
the real app and *observe* the change. A change is verified only when both pass.

## Pass 1 — static gates

Run in this order (cheapest first). All must be green:

0. `cargo fmt --all --check` — first, and never skipped. Clippy and the tests
   pass on unformatted code, so nothing else catches this; CI's backend job runs
   it *before* them, so drift fails the build and hides every later gate. If it
   reports a diff, `cargo fmt --all` and re-check.
1. `cargo check --workspace`
2. If anything touched `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, or a
   `specta::Type` in `crates/core/src/domain.rs`:
   `pnpm gen:bindings && git diff --exit-code src/bindings.ts` — if the diff is
   non-empty, the regenerated `bindings.ts` must be part of the change (CI fails
   on drift). Never hand-edit it.
3. `npx tsc --noEmit` — and if test files changed, also `pnpm typecheck:test`
   (vitest strips types without checking them; this is the only place test files
   are type-checked).
4. `pnpm lint` (Biome: lint + format + import sorting). The *frontend* half
   of the same trap — `biome check` fails on formatting too, so run
   `pnpm format` and re-check rather than reading past it.
5. `cargo clippy --workspace --all-targets -- -D warnings`
6. `pnpm test` (vitest) and `cargo test --workspace`
7. For any new/changed command taking a path, id, or branch: confirm it's
   validated (`safe_path`/`safe_real_path`, no leading `-`) before it reaches
   fs or git — see CLAUDE.md "Security & validation invariants".

## Pass 2 — drive the real app

`pnpm dev` in the background, wait for the window, then observe the affected
flow. Synthetic mouse clicks do NOT work — see harness notes below.

### Screenshot harness (WKWebView)

- **Synthetic clicks are silently dropped.** `osascript` System Events *clicks*
  reach the OS but never the WebView — they appear to succeed and do nothing.
  Do not use them, and do not conclude "no UI change" from one.
- **Keystrokes DO work**: `osascript -e 'tell application "System Events" to
  keystroke "1" using command down'` — use ⌘1–⌘5 to switch views, arrows/tab/
  enter to move focus and activate.
- **Capture**: `screencapture -x -l <windowId> out.png`, then Read the PNG.
  Get the window id from `screencapture -l`-style listing or
  `osascript -e 'tell application "santree" to id of window 1'`.
- On non-Retina displays the capture is 1x (pixels == points); take a
  full-window shot first and compute crop regions from the known layout.

### GOTCHA — verify WHICH binary you're looking at

This machine can run TWO processes named `santree` at once: the dev build
(`target/debug/santree`, no bundle id) and an installed `/Applications/santree.app`
(bundle id `com.santree.desktop`). Targeting by process name can silently hit
the stale installed app and make a real fix look absent (this has caused a
near-misdiagnosis before). Before trusting any observation:

- dev build: `pgrep -f target/debug/santree`
- installed: `stat -f "%Sm %N" /Applications/santree.app/Contents/MacOS/santree`
- target by pid — `first application process whose unix id is <pid>` — never by
  bare process name.

## Reporting

State plainly what was run and what was observed (screenshot evidence for UI
changes). If a gate failed, report the failure output — don't soften it.
