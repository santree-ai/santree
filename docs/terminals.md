# Terminals in santree

The source of truth for how terminal emulation works here. If you are about to
change anything in `crates/pty`, `src-tauri/src/terminal.rs`, or
`src/features/terminal/`, read this first — the individual pieces are small, but
the ordering between them is load-bearing and most of the constraints were paid
for by a bug.

---

## The shape, in one page

A santree terminal is a **kernel PTY hosting a real, unmodified vendor CLI**.
Bytes go in as keystrokes and come out as bytes; nothing in between interprets
them. `vim`, `htop` and an interactive `claude` behave exactly as they would in
iTerm.

```
xterm.js (webview)          one instance per tab, mounted in a persistent overlay
   │  keystrokes ↓   ↑ bytes
   │  Tauri Channel<ArrayBuffer>   (raw, not JSON; empty chunk = process exited)
   ▼
terminal.rs                 thin adapter: open/attach/detach/adopt/write/resize/close/sessions
   ▼
crates/pty PtyManager       one kernel PTY + one reader thread per session
   │                        each session keeps a 2 MiB ring of its recent output
   ▼
the real CLI                claude / codex / zsh, spawned on the pty slave
```

Five facts that explain most of the rest:

1. **A session is owned by the Rust process, not by the page or the pane.** A
   pane unmounting detaches; only closing a tab kills a process.
2. **One string identifies a terminal everywhere.** The frontend calls it
   `refId`, the PTY calls it `label`, SQLite calls it `term_key`. Same value.
3. **Every session records its recent output**, so a client that lost its view
   can be caught up instead of losing the session.
4. **There is no daemon.** Sessions survive a webview reload; they die when
   santree quits. This is a deliberate trade — see [No daemon](#no-daemon).
5. **santree never reads what the agent prints in order to decide what to
   send.** That rule is what keeps this a terminal emulator rather than a
   harness, and it is enforced by tests (`COMPLIANCE.md`).

---

## Process model

`crates/pty` is the whole interactive backend and is Tauri-agnostic — it hands
bytes to a `Fn(Vec<u8>)` sink, so it unit-tests directly against a real shell.

`PtyManager::open` allocates a PTY pair via `portable-pty`, spawns the command on
the slave, drops the slave in the parent so the master sees EOF when the child
exits, and starts a **dedicated std thread per session** (`pty-reader-<id>`)
because the master read blocks. Id minting and registration happen in a single
critical section, and `open` is refused once `close_all` has latched — otherwise
a racing open would register a child nothing would ever reap.

An empty `command` means the user's login shell (`$SHELL`, else `/bin/zsh` on
macOS, `/bin/bash` elsewhere) with `-l`. A missing cwd falls back to `$HOME`
rather than failing the spawn, and says so in the log.

**One PTY per logical surface**, keyed by `term_key`:

| surface | `term_key` |
|---|---|
| a worktree's main terminal | `tree:<worktree_id>` |
| an extra agent/terminal tab | `tree:<worktree_id>:tab:<tab_id>` |
| a triage investigation | `triage:<ticket>` |
| an AI review | `ai-review:<owner>/<name>#<n>` |
| the Settings agent-login box | `login:<agent>` |

`useTerminalTabs.ensure()` dedupes on it, so re-entering a surface attaches to
its live session instead of spawning a second.

---

## Identity: one string, three homes

This is worth stating plainly because it is what makes reattach possible at all.

- **Minted** at the launch site — e.g. ``refId: `tree:${worktree.id}:tab:${tab.id}` ``
  (`TreesView.tsx`).
- **Sent to the PTY** as `OpenOpts.label` (`TerminalView.tsx` → `terminal.rs` →
  `crates/pty`). Opaque there: stored and compared for equality, never a path.
- **Stored** as `terminal_sessions.term_key`, which maps a surface to a durable
  agent conversation id.

```sql
CREATE TABLE terminal_sessions (
    repo TEXT NOT NULL, term_key TEXT NOT NULL, cwd TEXT NOT NULL,
    session_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (…),
    agent_kind TEXT NOT NULL DEFAULT 'Claude'
        CHECK (agent_kind IN ('Claude','Codex','Cursor','Opencode')),
    PRIMARY KEY (repo, term_key, agent_kind)
);
```

The primary key is a **triple**, not a pair: one surface can hold one durable
conversation *per provider*, so switching a worktree from Claude to Codex and
back finds both threads still there. `cwd` is stored because it is what locates
Claude's transcript on disk.

Because the identity is one string, a reloaded page can take a live session it
knows nothing about and put it back on the pane that owns it. That is the entire
adoption mechanism.

---

## Transport

Output crosses IPC on a Tauri `Channel<RawBytes>`, not `emit`. `RawBytes`
implements `IpcResponse` by hand so the body is `InvokeResponseBody::Raw` — the
frontend receives a real `ArrayBuffer` instead of a JSON array of up to 8192
decimal integers, which is real CPU on both ends for a verbose build or a fast
agent scroll. `Type` is hand-implemented as `ArrayBuffer` so the generated
bindings describe the true runtime shape rather than a `number[]` that lies.

**An empty chunk is the exit sentinel.** Real output chunks are never empty, so
empty is unambiguous; the frontend latches `exited` so a pane cannot be torn down
twice. `terminal.rs` also wraps every sink (`retiring_sink`, at both `open` and
`attach` — attaching *replaces* the sink, so it has to be re-wrapped or a pane
remount loses it) so the same sentinel retires the terminal's agent rows in
`session_state`. santree gets that signal for free where other apps inject shell
integration to recover it: the seed is `exec <cli>`, so the PTY **is** the agent
process and its EOF is the agent exiting, however it died.

`terminal_open` and `terminal_write` run on the blocking pool: a spawn is a
fork/exec with a full env copy, and a write can block on a wedged child's full
PTY buffer. Neither may pin a tokio worker. `resize`/`close`/`detach` are cheap
and stay inline. Each session has its own writer mutex, so a stuck child
serializes only itself.

**There is no backpressure today.** The reader thread forwards unconditionally,
and absorption is left to xterm's internal write queue. The ring bounds Rust-side
memory; the renderer side is still unbounded. See
[What is built, and what is not](#what-is-built-and-what-is-not).

---

## Lifecycle: what survives what

| event | PTY process | scrollback |
|---|---|---|
| route navigation, tab switch | ✅ | ✅ |
| **webview reload** (⌘R, HMR, crash recovery) | ✅ **adopted** | ring replay (2 MiB) |
| app quit | ❌ `close_all()` | ❌ |

### The one rule

> **A pane unmounting detaches. Only closing a tab closes.**

`TerminalView`'s cleanup calls `backend.detach(id)`. Every property in this
document depends on that line: when it called `close(id)`, a reload killed every
running agent, nothing could be evicted to save memory (disposing an xterm meant
losing the session), and the orphan reaper existed purely to clean up after it.

Killing is explicit and lives in `useTerminalTabs.close(key)`, which invokes the
pane's registered handle **before** dropping the tab — the other order would
unmount the pane first and leave nothing to call.

### The ring

Each session keeps `RING_CAP_BYTES = 2 MiB` of recent output as a `VecDeque` of
**whole pump-read chunks**, never a byte offset into a circular buffer. A PTY
read routinely ends mid-escape-sequence, so a reader-chosen boundary is the only
safe place to cut. (Every shipping implementation we looked at cuts at a byte
offset; VS Code's does an unconditional `substr` that can split a UTF-16
surrogate.) Eviction drops whole chunks from the head and advances `start_seq` by
exactly what left, never dropping the last chunk — an empty ring would turn every
attach into a reanchor.

The pump writes the **ring first, then the sink**, and a `None` sink is not an
error. That is what lets a detached pane, or a reloaded page, lose nothing.

### Attach

One call, three outcomes:

```
Exact     epoch matches AND start_seq <= seq <= head
          → send exactly the missed suffix (nothing when already current)
Tail      the client is a virgin xterm
          → send the whole ring, best effort
Reanchor  epoch mismatch, a gap older than the ring, or a malformed anchor
          → send NOTHING, report the live head
```

`Reanchor` sending zero bytes is deliberate: **the client's stale-but-real screen
beats anything we could synthesize.** `epoch` is minted per session object from
the process start time plus the id, so an anchor from a previous run fails to
match rather than matching the wrong session.

### Adoption

`terminal_adopt(owner)` replaced the old `terminal_reap_orphans`. The page-owner
tag — a per-document UUID in `pageOwner.ts` — went from a kill list to a
hand-over: sessions belonging to a different page are re-tagged to the current
one and reported with their labels, and the panes claim them by label as they
mount.

Two things about it are easy to get wrong and were both found only by running the
app:

- **It is not idempotent.** Adoption re-tags what it returns, so a second call
  finds everything already claimed and answers with nothing. It therefore runs
  **once per document at module scope**, beside `PAGE_OWNER` — not from an
  effect, whose double-invoke would hand the empty second answer to the panes and
  make each spawn a duplicate of the session still running behind it.
- **Late adoption is the same as no adoption.** A pane reads the map once as it
  mounts and its mount effect never re-runs, so `TerminalLayer` renders nothing
  until adoption settles. One IPC round-trip of an invisible overlay buys
  correctness.

**One label, one session.** Two live sessions under the same label means an
earlier page leaked one; only one is reachable, so adoption keeps the newest and
ends the rest.

---

## No daemon

Both reference implementations run the PTY in a **detached daemon that outlives
the app**, and this is the single biggest architectural difference.

- **Orca** forks plain Node with `ELECTRON_RUN_AS_NODE=1`, `detached: true`,
  `unref`'d. Its shutdown path calls `disconnectDaemon()` and *never*
  `shutdownDaemon()`, with the note that doing otherwise *"would make orcad's own
  restart destructive, which is the exact property this whole item exists to
  buy."* Their ops doc warns that systemd's `KillMode=control-group` would reap
  the daemon with the app and turn every restart back into data loss.
- **Superset** spawns a per-organization `pty-daemon`, `detached` and `unref`'d
  in production (`detached: !isDev` — in development it dies with the parent,
  exactly like ours). It goes further: a daemon *binary upgrade* passes PTY
  master fds to its successor through inherited stdio, and their test asserts
  sessions survive the swap with the same shell PIDs.

So yes — quitting those apps leaves your agents running, and relaunching
reattaches. We are strictly weaker on that axis.

**What it would buy us:** quit santree, reopen it, and an agent is still
mid-task. That is genuinely the one thing this design cannot do.

**What it costs:** a second binary with its own version and upgrade path (hence
superset's "Update daemon" / "Force restart" buttons — controls that exist to fix
a problem the daemon creates), plus an endpoint-ownership protocol. Orca's has a
design note recording *"seven review rounds … produced twenty-three defects"* and
a section titled **"Do not add a sweeper"** explaining that the last one deleted
a live listener's only pathname. Neither daemon has an idle timeout, so both hold
shells indefinitely for windows nobody has open.

**What we skip by not having one:** the daemon's own machinery — a second binary
with its own version, the fd handoff that carries PTYs across its upgrade,
endpoint-ownership fencing, crash budgets, and the "terminals aren't responding"
UI that exists because a daemon can stop answering.

**What we do NOT skip, and an earlier draft of this document got wrong:** the
ability to restore *after a quit*. That claim — "the PTY dies with the app, so
there is nothing to restore into" — conflates the shell with the conversation.
superset's entire post-reboot experience runs with its daemon dead: it persists
the scrollback, spawns a **fresh** shell under the same terminal id, marks the
agent's binding `terminal-exited`, and auto-resumes the conversation into it.
Nothing in that sequence needs the PTY to have survived, and none of it needs a
daemon. What a quit costs us is the running *process*; the conversation is
already durable in `terminal_sessions.session_id`, and `session::resolve`
already turns it back into a `--resume`.

This is an open decision, not a closed one. If it is ever taken, the ring,
`attach`/`detach`/`adopt` and the anchor protocol all transfer unchanged; they
were designed against exactly this architecture.

---

## Rendering

`XtermRenderer` is the **only** module that imports xterm; everything else
depends on the `TerminalRenderer` interface, so swapping the engine means
replacing one file.

`TerminalLayer` is mounted once at the app shell and renders *every* live tab as
a `fixed` overlay positioned over whatever host element a view registered.
Sessions belong to the document, not to the route.

- **Hidden panes use `invisible`, never `display:none`**, so xterm never reflows
  from a zero-size state on a tab switch.
- **Geometry freezes at the last embed rect** when nothing is embedded. Snapping
  to the full content area would resize the grid and make zsh reprint its prompt,
  leaving a blank prompt line every time you came back.
- **WebGL contexts are rationed to 8** in an MRU pool. WebKit silently drops the
  oldest past ~16 per page, and an xterm that loses its context never gets it
  back; overflow panes render through the DOM fallback and reclaim a context on
  activation. Two losses and it stops trying.
- **The overlay clips, and its geometry is written from the resize callback, not
  through React state.** xterm sizes `.xterm-screen` and its canvases from the
  *grid*, not from the element it was mounted in, and nothing in xterm's own
  stylesheet keeps an over-sized canvas inside that box — so a grid lagging a
  shrinking pane paints over whatever is beside it, at z-index 30.
  `overflow-hidden` on the layer makes that structurally impossible; putting the
  host rect straight onto the element from the ResizeObserver — which the browser
  dispatches after layout and before paint — is what stops the overlay itself
  trailing a fast sidebar drag by a frame, the way a scheduled re-render did.
- **Only the PTY resize is debounced, and it is deduped**: the renderer refits on
  every observer tick (cheap, local, and it never touches the PTY), while the
  SIGWINCH waits 100 ms for the size to settle and is then dropped unless
  cols/rows actually changed. Every SIGWINCH makes p10k reprint, so one per frame
  of a drag would stack a prompt line per frame; a refit per frame only costs
  repaints. Only the *active* pane acts on a resize, because all panes are laid
  out at full size and a layer change would otherwise SIGWINCH every backgrounded
  shell at once.
- Scrollback is 10 000 lines per instance, and **nothing evicts instances yet**.

---

## Agent state

santree never infers agent state from terminal output. For Claude it comes from
**hooks**; Codex has none.

### Claude

Every santree `claude` launch layers a `--settings` file (written by `hooks.rs`)
registering six state events, each running the bundled `santree-hook` binary:

| event | recorded state |
|---|---|
| `UserPromptSubmit` | `Active` |
| `SessionStart` · `Stop` | `Idle` |
| `SessionEnd` | `Exited` |
| `PermissionRequest` | `Permission` |
| `Notification` | refined by type: `permission_prompt`→`Permission`, `agent_completed`→`Idle`, `agent_needs_input`/`idle_prompt`/`elicitation_dialog`→`Waiting`, otherwise unchanged |

Five are `async: true` (10 s) so they **structurally cannot** approve or deny.
`SessionEnd` is the one synchronous state hook (5 s), because it fires at
teardown where there is no decision left to gate.

`PostToolUse`/`PostToolUseFailure` are injected as **heartbeats** — the only
events that fire mid-turn, and so the only evidence that a long build or a long
think is still a running turn rather than a finished one. They fire with no
ordering guarantee, which is why they are heartbeats and not transitions: in
`crates/hook`'s `record`, a heartbeat may advance the clock but can never move a
session out of a blocked-on-user state, so a straggler cannot clear a permission
prompt still on screen. `PreToolUse` and `PermissionDenied` stay out —
`PreToolUse` is the only hook that can *authorize or rewrite* a tool call
(`permissionDecision`, `updatedInput`), which is the one thing santree must never
be able to do.

The status line carries `refreshInterval: 15` (seconds; the CLI's schema requires
≥ 1), so every live session stamps `session_usage_live` even while sitting
silently at the prompt. That is a proof of **life**, never of *work* — the
status line renders just as happily when idle.

The hook binary **prints nothing on the hook path and always exits 0**, including
on panic. After writing it nudges a Unix socket (`session_signal.rs`) — a socket,
not a file watch, because the hook is a separate process that cannot emit Tauri
events and FSEvents single-file watching proved unreliable.

**Reconciliation.** Hooks reliably *set* a needs-you state but nothing fires when
the user *resolves* one (a manual accept, or a turn that ends without `Stop`), so
rows go stale. `hooks.rs::reconcile_live_state` corrects them on read against the
transcript's recency: a 128 KB tail read, `RESOLVED_MARGIN_MS = 1 s`,
`IDLE_QUIET_MS = 30 s`, capped at `MAX_SESSION_ROWS = 200`, batched into one
`spawn_blocking`. It also splits `Active` into `Delegating` when the freshest
write is a subagent file, because the main transcript is silent for a whole Task
run. Activity is the newest of *three* clocks — the transcript, the subagent
files, and the row's own `updated_at_ms` (the tool heartbeats). Without the third,
a turn whose transcript went quiet past `IDLE_QUIET_MS` read as **Idle while the
agent was plainly working**, which is the bug the heartbeats exist to fix.

`transcript_activity_ms` picks the reader by provider, because the two formats
share nothing but the extension: a Claude transcript's records are
`type: "assistant" | "user"`, a Codex *rollout*'s are `session_meta` /
`event_msg` / `response_item` / `turn_context`. Running the Claude parser over a
rollout matched nothing and returned "no evidence", so Codex sessions got no
reconciliation at all. The registry's `agent_kind` decides; when that join is
gone, the `rollout-` file-name prefix does.

**Liveness is a join, not a record.** `session_states` takes the set of
`term_key`s with a live PTY (`terminal::live_terminals`, straight out of the
in-memory manager) and no row whose terminal is absent can come back
live-looking. Because santree has no daemon, a PTY cannot outlive the app —
so an empty set after a restart is the *correct* answer, not a missing one. This
is why there is no sweeper, no decay timer and no straggler window: the answer is
recomputed from live state on every read, so a hook that lands after the process
died has nothing to win against. Matching is on `term_key` alone, never `cwd`
(path normalization — `/var` vs `/private/var` — would retire every
session at once); the *write* half, `retire_terminal`, scopes by `cwd` too,
because there the failure modes are reversed. A row with no terminal to join
falls back to the status-line heartbeat, and a row with neither is left alone:
a false "exited" hides a working agent, which is the failure this exists to
prevent.

**The final fold** (`registry.ts`) — note that liveness beats the recorded state:

```ts
if (state === "exited") return "done";
if (!live) return "detached";        // no live PTY ⇒ the process is gone
if (state === "permission" || state === "waiting") return "attention";
if (state === "active" || state === "delegating") return "working";
return "idle";
```

That is what stops a session that died mid-question from shouting "waiting"
forever.

### Codex

**Codex reports live state through the same hooks.** Six events are injected per
launch via `-c 'hooks.<Event>=[...]'` (`SessionStart`, `UserPromptSubmit`,
`PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd` — Codex has no
`PostToolUseFailure`), and `SessionState.agent_kind` is read off the owning
terminal's registry row rather than assumed, so a Codex session is no longer
painted with the Claude mark. Its rows reconcile like Claude's, against the
rollout rather than a transcript (`codex_rollouts::last_activity_ms`).

Codex also has *history*, reconstructed from rollout files under
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl` — prompts, replies,
model, subagent counts — read display-only and bounded by a first-line peek plus
a byte-length-keyed cache.

There is no thread control. santree once owned a `codex app-server` on a private
Unix socket and started, named and resumed threads over it; that is gone — it
orphaned processes and held Codex's per-thread writer lock, which surfaced as
"thread `<id>` already has an active writer" on resume. A Codex session is now
`codex` (or `codex resume <thread>`) in a PTY, and the surfaces that used the
protocol ask the CLI: `codex login status`, `codex debug models`, `codex logout`.
Subscription usage comes from the `token_count` record in the rollout itself.

---

## Launch composition

The agent is started by writing one line into a fresh login shell:

```
exec <env> <bin> <remote><settings><mcp><chrome><permission>--resume <id>
exec <env> <bin> <remote><settings><mcp><chrome><permission><model><effort>--session-id <id> <prompt>
```

- `exec` replaces the shell, so quitting the agent ends the PTY rather than
  dropping you at a prompt.
- `env SANTREE_REPO=… SANTREE_TERM_KEY=…` is how the hook binary knows which row
  to repoint after a `/clear` or a fork. Repointing is gated on
  `SessionStart.source` being `clear` or `fork`, which is what stops an
  env-inheriting subprocess from hijacking the row.
- `--settings` is always a **file path, never inline JSON** — inlining overflowed
  the seed line and left the shell stuck at a `quote>` continuation. It is a
  key-level override: the user's other settings keys are untouched.
- `--mcp-config` appears only for review sessions, naming
  `review-<sha256(owner/name#number)>.mcp.json`.
- `--permission-mode`, `--remote-control` and `--chrome` are pass-throughs of the
  user's own settings. **santree never selects a permissive permission mode.**
- `--model`/`--effort` only on a fresh launch; a resume carries the session's own.

Every value is single-quoted through `shellQuote`, which strips newlines and all
C0/C1 control characters first — the seed is written to a PTY, where control
bytes would be interpreted.

**The launch is gated on `isFetched`, never on a value.** A boolean setting reads
`false` both when it is off and when it has not loaded, and launching in that
window silently dropped `--chrome` — or worse, ran a restricted tab with no deny
list.

---

## The other execution paths

Not every process santree runs is an interactive terminal.

**`stream.rs` — background command runs.** Repo setup scripts and builds, shown
in a **read-only** pane. It still uses a PTY, because nearly every build tool
block-buffers its output and turns colour off when stdout is not a TTY. Spawned
as `/bin/bash -lc <command>`, owned by a process-wide registry keyed by an opaque
caller string rather than by a tab, with a 60-minute watchdog and a 120×40
starting grid. Output arrives as a `Channel<StreamEvent>` of
`Chunk { text } | Done { ok }`, with partial UTF-8 carried across reads.

**`agent.rs` — headless one-shots.** `claude -p` / `codex exec` to draft a commit
message, a PR body, or an English-tutor analysis. Prompts go over **stdin, never
argv** (argv is world-readable on Linux). Tool use is denied by default because
these prompts embed diff, PR and ticket content that an attacker can influence.
Every call site names its own timeout; there is no shared default.

**`codex_cli.rs` — Codex's non-session surfaces.** One short-lived, non-interactive
`codex` invocation each (stdin closed, timeout, output cap) for version, login
status, the model catalog and logout. No login command: `codex login` owns a
browser round trip, so Settings points the user at their own terminal.

---

## Compliance

`COMPLIANCE.md` is the governing document and most of it is now executable
(`src-tauri/src/compliance.rs`, `src/features/terminal/compliance.test.ts`). The
parts that bear on this layer:

- **The only bytes santree writes to a terminal are the user's keystrokes and the
  single human-initiated seed prompt.** A test asserts only `terminal.rs` writes
  into a PTY, and four frontend tests assert nothing decodes PTY output and feeds
  it back.
- No credential handling; `resolve_env` is the single env-injection chokepoint,
  with values in the OS keychain and only names in SQLite.
- The deny lists in restricted flows are **best-effort defence-in-depth, not a
  security boundary** — they are text-matched and bypassable. Never build on them
  as a gate.

---

## Where things live

```
crates/pty/src/lib.rs        PtyManager: spawn, read loop, attach/detach/adopt, close_all
crates/pty/src/ring.rs       the output ring + the anchor protocol
crates/hook/src/main.rs      the hook binary: state hooks, status line, MCP mode
src-tauri/src/terminal.rs    Tauri adapter + the RawBytes channel
src-tauri/src/hooks.rs       the --settings file every claude launch layers
src-tauri/src/session.rs     term_key → durable conversation id (resolve/mint/forget)
src-tauri/src/stream.rs      background runs behind a PTY → read-only panes
src-tauri/src/session_signal.rs   the socket the hook nudges to push state changes
src/features/terminal/
  types.ts                   the two seams: TerminalRenderer, TerminalBackend
  TauriBackend.ts            IPC implementation; channel wiring; adoption by label
  TerminalView.tsx           one pane: open-or-attach, detach on unmount, resize
  TerminalLayer.tsx          the persistent overlay that outlives routes
  TerminalsContext.tsx       once-per-document adoption
  orchestrator.ts            tabs, embed claims, the pane handle registry
  XtermRenderer.ts           the only xterm import; WebGL rationing; theming
  agentProvider.ts           the seed line
src/features/agents/registry.ts   term_key parsing + the state → bucket fold
```

---

## What is built, and what is not

| | |
|---|---|
| ✅ ring + anchor protocol + attach/detach | `crates/pty/src/ring.rs` |
| ✅ adoption across a webview reload | `terminal_adopt` |
| ✅ session inspector | Settings → Terminal |
| ⬜ **flood safety** | no backpressure; a renderer that falls behind has an unbounded queue |
| ⬜ **memory eviction** | every xterm stays mounted at 10k scrollback; only WebGL is rationed |
| ⬜ **mode restoration** | a reattached TUI loses bracketed paste, mouse tracking and kitty keyboard |

The three are ordered by dependency, not by value: flood safety stands alone,
eviction wants the ring underneath it, and mode restoration is what makes
eviction and reload *correct* rather than merely A program sets those modes once at startup and the bytes scroll out
of a 2 MiB ring within minutes, so a restored pane gets paste-as-keystrokes and
dead mouse reporting on a live TUI. The intended shape is `vte` plus a mode-only
`Perform` — the same thing zellij ships — chosen by *running* the alternatives:
`vt100` panics on real input, `avt` emits colon-form truecolor our xterm renders
as literal text, `termwiz::Surface` takes `Change` not bytes, and `wezterm-term`
keeps its mode fields private and is unpublished.

Two gaps a snapshot cannot close, so the mirror must carry them: no version of
`@xterm/addon-serialize` emits the **scroll region** (DECSTBM — the four-year-old
cause of broken `vi`/`top` restore) or the **mouse encoding modes**
(`?1006`/`?1005`/`?1015`, which xterm.js does not expose on its public API at
all). It also never emits `?1049l`, so a preamble must assert it — in the
targeted form, never `ESC c`, which clears scrollback outright.

If a mode mirror is built it must be **write-only toward the PTY**: it may never
emit a reply or answer a query sequence, because the webview's xterm is the
single query-reply authority. See `COMPLIANCE.md`.

---

## Traps

The first group are bugs Orca or superset shipped, found, and left a comment
about. We inherit the lesson without having paid for it.

- **A mid-escape chunk tail lives in the parser, not the buffer.** `serialize()`
  drops it and the continuation renders as literal text after a restore. It must
  be written back **last**, after every reset — a reset's `ESC` would abort it.
- **Abort a truncated control string with `CAN` (0x18), not `ESC`.** xterm
  dispatches OSC/DCS on any terminator except CAN/SUB, so a bare `ESC` grounds
  the parser but *commits* what the gap truncated: a half-read `OSC 0` retitles
  the pane, `OSC 52` writes the clipboard.
- **A dead TUI's modes outlive it.** Killed with `SIGKILL` it never writes its
  restore sequences, so mouse reporting and kitty keyboard leak into the shell
  that reclaims the PTY. Worse, they latch into any snapshot and re-arm on every
  future restore — Orca found the re-arm arriving through two independent
  channels, so disarming one was not enough.
- **`?1049h` does not clear the alt buffer.** The pre-hide frame bleeds through a
  restored snapshot's blank cells.
- **Never reconstruct a screen on reanchor.** The client's stale-but-real screen
  beats anything the host can synthesize.
- **A resize must be recorded where it happened**, or replay reflows at the wrong
  width.
- **Queries hiding in dropped bytes must be salvaged.** A program blocked on a
  `DSR`/`DA1` reply that was inside a discarded batch waits forever.
- **Don't trust the size you last sent.** Read back what the PTY actually
  applied.

And these are ours, all three found only by running the app:

- **Guarding a double-invoked effect on a resolved id does not work.** `open` is
  async, so both runs are past the check before either returns. The in-flight
  *promise* is what must be shared.
- **A seed keyed to "the run that created the session" is never sent.** That run
  is torn down before its `open` resolves, and the second run did not create
  anything, so both skip it and the agent silently never launches. Key it to the
  session.
- **Adoption resolving after first paint is the same as no adoption**, per the
  section above.

One more, from the test suite rather than the app: these tests fork real shells
on parallel threads, and under `--workspace` that exhausted the pty table
(`openpty: Os { code: -6 }`), failing a different test each run. They now take a
serialisation guard. If you add a PTY-allocating test, take it too.
