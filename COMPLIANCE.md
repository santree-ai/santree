# Compliance constraints — terminals

santree runs **real, unmodified CLI binaries in a real terminal**. The user is a
human driving their own session, exactly as in iTerm or VS Code's integrated
terminal. The terminal feature is a local terminal emulator: a kernel PTY hosts a
real process, and we stream raw bytes to and from it (xterm.js in the webview ↔
`portable-pty` in Rust, over local Tauri IPC). It is **not** a "terminal server",
an agent harness, or an automation driver.

## Why this matters

Each agent CLI (Claude Code, Codex, …) has its own terms of service. Staying a plain
terminal emulator — we spawn the vendor's binary and render its output, nothing more —
keeps santree clearly on the right side of those terms and avoids re-implementing or
spoofing any vendor's control loop. The moment the app handles tokens, parses output to
decide what to type, or runs unattended, it stops being a terminal and becomes a
harness — a different product with different (and riskier) obligations. These
constraints keep that line bright.

These constraints are **load-bearing** for the product and must survive future
changes. Do not add any of the following, even if they seem helpful:

## No credential handling
The app never reads, stores, proxies, injects, or intercepts **an agent CLI's own
auth/OAuth tokens**. The user runs `claude login` (or any vendor's equivalent)
**themselves, inside the terminal**; auth lives wherever the CLI puts it. santree
is agnostic to and untouched by it. santree never reads or captures a CLI's token
from disk/keychain/env to forward it anywhere.

### User-configured project environment — a scoped exception
The PTY inherits the ambient process environment (so PATH/HOME resolve) **plus the
variables the user configures under Settings → Environment** (`env.rs`,
`OpenOpts.env`). This is the user's *own* project environment — a `DATABASE_URL`,
a service key their code-under-test needs — exactly what an IDE's integrated
terminal provides, and identical to the user `export`-ing it in their shell rc.
It is entered by the user in santree's own UI and stored in santree's own settings;
santree does not synthesize it, read it from a CLI's config, or capture it from
anywhere. This is **not** a hole in "No credential handling" above: santree still
never touches an agent CLI's *own* auth token. The distinction is load-bearing —
forwarding the user's project env is fine; reading/storing/proxying Claude's (or
any vendor's) login credential remains strictly forbidden.

## No automated control loop
No auto-responders, no output-parsing that feeds new prompts back in, no
retry/"keep going" loops, no always-on or unattended drivers. Orchestration stops
at: **choose a cwd, place the pane, send one human-initiated seed prompt.** After
that it is the human and the real CLI. The backend streams bytes; it never
inspects them to decide what to type next.

## No harness behavior
Do not wrap, re-implement, or spoof any agent's control loop or SDK. We spawn the
real binary and render its real output — nothing more.

## Headless helpers — a scoped exception
Two call sites intentionally sit outside the terminal pane. They, and the
session-state channel named in the next section, are the *only* sanctioned
exceptions to the constraints above:
- `src-tauri/src/agent.rs` (`run_print` / headless helpers) — one-shot `claude -p`
  calls that draft a commit message or a PR title/description.
- `src-tauri/src/github.rs` (`token()`) — reads a token via `gh auth token`, GitHub's
  own documented token-lending interface for scripts/tools. This is distinct from
  santree reading, storing, or proxying an *agent CLI's* (Claude/Codex/…) auth —
  that remains strictly forbidden per "No credential handling" above.

Both stay inside the spirit of this doc only because they are: the vendor's own
documented print/non-interactive mode, invoked on the real unmodified binary;
single-shot, with no loop and no retry; human-initiated by a button click, never
automatic or background; bounded by a timeout (~120s); scoped with explicit
`--allowedTools`/`--disallowedTools`; and their output lands in a commit message or
PR body — it never feeds back into another agent invocation. This is a narrow,
named exception, not a license for headless/background Claude usage generally. Any
new headless call site must be justified against these same conditions before
merging.

## Session-state hooks + status line — a scoped exception
Every santree `claude` launch layers a generated settings file over the user's own
(`claude --settings <path>`; built in `src-tauri/src/hooks.rs`, written to
`<app_data_dir>/claude-hooks.json`). `--settings` is a key-level override, so the
keys below win for santree's launches and the user's other keys are untouched.
This is a **third named exception** to "nothing more" above; it exists so the app
can badge each worktree with what its agent is doing (running / needs-you / idle)
and render the same context-usage bar the terminal shows.

Exactly what it injects — the whole list, no more:
- **Six session-state `hooks`**, each running the bundled `santree-hook` binary
  (`crates/hook`) as `<bin> --db <db> <Event>`: `SessionStart`, `UserPromptSubmit`,
  `Notification`, `PermissionRequest`, `Stop`, `SessionEnd`. Five are registered
  `async: true` (timeout 10s); `SessionEnd` is the only synchronous one (timeout
  5s) so "exited" lands before teardown. The per-tool events (`PreToolUse`,
  `PostToolUse`, `PermissionDenied`) are deliberately **not** injected.
- **A `statusLine`** (`<bin> --db <db> statusline`) — santree's own context-fill
  bar. It prints the bar Claude renders and records Claude's authoritative usage
  numbers into `session_usage_live`.
- **A `permissions.deny` block**, in the *Fix CI* flow only
  (`claude_settings_no_git`, written to a separate `claude-hooks-fixci.json`):
  `Bash(git commit)`, `Bash(git commit:*)`, `Bash(git push)`, `Bash(git push:*)` —
  so that session can fix and validate but leaves committing/pushing to the user.

The hook binary reads the event's JSON payload on stdin, maps it to an
`AgentState`, and UPSERTs one row per session in `session_state`. It **prints
nothing on the hook path and always exits 0**, on every failure path.

This stays inside the line — in particular inside "No automated control loop" —
only because of the following, and any change to this channel must preserve all
of them:
- **It cannot gate the CLI's decisions.** Every hook Claude treats as a decision
  channel (`PermissionRequest`, `Notification`, `UserPromptSubmit`) is registered
  `async: true`: Claude does not wait for it and ignores whatever it emits, so the
  hook structurally **cannot approve or deny anything**. Claude still shows the
  user its own permission prompt; we only observe that one appeared. The single
  synchronous hook, `SessionEnd`, fires at teardown, has no decision output to
  give, and emits none.
- **`permissions.deny` can only restrict, never approve.** It is declarative
  config the CLI enforces itself — the same mechanism as a user's own
  `settings.json` — not santree reacting to the session.
- **The captured state is display-only.** It reaches the UI as a status badge and
  a usage bar (`session_states` / `session_usage_live` → `WorktreeSidebar`,
  `AllAgentsView`) and stops there.
- **No output-parsing influences input.** Nothing derived from the hook payloads,
  the transcript reconciliation, or the status line is ever written back to the
  PTY. The only bytes santree writes to a terminal are the user's keystrokes and
  the single human-initiated seed prompt.
- **No unattended loop.** The hooks fire only while a human is driving a real
  session; santree never starts, resumes, retries, or continues one on their
  behalf.

Reading the session transcript (`hooks.rs`'s reconciler, to tell a resolved prompt
from a live one) is bounded by these same conditions: it is read to *label* the
session, never to decide what to send it.

## Where this is enforced in code
- `crates/pty` — spawns a real process behind a real PTY and streams **raw
  bytes**. No command interpretation, no output parsing. The only env it sets on
  top of the inherited ambient env is `TERM` plus the user's own configured
  variables (`OpenOpts.env`, resolved by `src-tauri/src/env.rs` from Settings →
  Environment) — never an agent CLI's auth token.
- `src-tauri/src/terminal.rs` — thin Tauri adapter (open/write/resize/close). The
  output channel forwards bytes verbatim.
- `src/features/terminal/orchestrator.ts` — the app's only terminal API. It does
  placement + a single optional **seed** (`terminal_write` of bytes, identical to
  human typing). It does not read output or drive the session.
- `src-tauri/src/hooks.rs` — builds the `--settings` file described under
  "Session-state hooks + status line" and reads back what the hooks recorded. It
  registers every decision-capable hook `async: true` (so none can gate Claude),
  and its output path ends at the UI: nothing it reads is ever written back to a
  PTY. `crates/hook` is the binary those hooks run; it records state and exits 0,
  emitting no hook decision.

If a change introduces output parsing that influences input, token handling, or an
unattended loop, it violates these constraints and must not be merged.
