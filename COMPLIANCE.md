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
The app never reads, stores, proxies, injects, or intercepts a CLI's auth/OAuth
tokens. The user runs `claude login` (or any vendor's equivalent) **themselves,
inside the terminal**; auth lives wherever the CLI puts it. santree is agnostic to
and untouched by it. The PTY layer only inherits the ambient process environment
so PATH/HOME resolve — it does not synthesize, capture, or forward secrets.

## No automated control loop
No auto-responders, no output-parsing that feeds new prompts back in, no
retry/"keep going" loops, no always-on or unattended drivers. Orchestration stops
at: **choose a cwd, place the pane, send one human-initiated seed prompt.** After
that it is the human and the real CLI. The backend streams bytes; it never
inspects them to decide what to type next.

## No harness behavior
Do not wrap, re-implement, or spoof any agent's control loop or SDK. We spawn the
real binary and render its real output — nothing more.

## Where this is enforced in code
- `crates/pty` — spawns a real process behind a real PTY and streams **raw
  bytes**. No command interpretation, no output parsing.
- `src-tauri/src/terminal.rs` — thin Tauri adapter (open/write/resize/close). The
  output channel forwards bytes verbatim.
- `src/features/terminal/orchestrator.ts` — the app's only terminal API. It does
  placement + a single optional **seed** (`terminal_write` of bytes, identical to
  human typing). It does not read output or drive the session.

If a change introduces output parsing that influences input, token handling, or an
unattended loop, it violates these constraints and must not be merged.
