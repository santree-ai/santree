# Terminals in santree

The source of truth for how terminal emulation works here. If you are about to
change anything in `crates/pty`, `src-tauri/src/terminal.rs`, or
`src/features/terminal/`, read this first — the individual pieces are small, but
the ordering between them is load-bearing and most of the constraints were paid
for by a bug. Where a session's process lives (in the app, on the santree
server, or on Daedalus) is [docs/server.md](server.md) and
[docs/remote.md](remote.md).

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
terminal.rs                 thin adapter: open/attach/detach/adopt/write/seed/resize/close/sessions
   ▼
crates/pty PtyManager       one kernel PTY + one reader thread per session
   │                        each session keeps a 2 MiB ring of its recent output
   ▼
the real CLI                claude / codex / zsh, spawned on the pty slave
```

In the diagram `PtyManager` is in the app's own process. On a signed build the
same `PtyManager` runs inside the detached santree server and the adapter reaches
it over protocol v1 through `sessions::Terminals`
([The santree server](#the-santree-server)). `Mode::Off` (unsigned and dev
builds) keeps `PtyManager` in the app as `Local::InApp`.

Five facts that explain most of the rest:

1. **A session is owned by the Rust process, not by the page or the pane.** A
   pane unmounting detaches; only closing a tab kills a process.
2. **One identity names a terminal everywhere**, and it is a *pair*: the surface
   plus the provider in it. The surface is one string — the frontend calls it
   `refId`, the PTY calls it `label`, SQLite calls it `term_key`, same value —
   and the provider rides beside it in all three (`agent.kind`, `agent_kind`,
   the `agent_kind` column).
3. **Every session records its recent output**, so a client that lost its view
   can be caught up instead of losing the session.
4. **A session can outlive the app, by a process of its own.** Sessions survive
   a webview reload; on a signed build they also survive a quit, a crash and an
   update, because the PTYs live in the detached **santree server** — see
   [The santree server](#the-santree-server) and [docs/server.md](server.md).
   Where there is no server (an unsigned or dev build without
   `SANTREE_SERVER=1`) they die when santree quits. A Daedalus project's
   terminals run on the box and outlive santree too — see
   [Remote sessions](#remote-sessions).
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
| a worktree's agent or terminal tab | `tree:<worktree_id>:tab:<tab_id>` |
| a triage investigation | `triage:<ticket>` |
| an AI review | `ai-review:<owner>/<name>#<n>` |
| the Settings agent-login box | `login:<agent>` |

`useTerminalTabs.ensure()` dedupes on it, so re-entering a surface attaches to
its live session instead of spawning a second.

A worktree has **no privileged terminal**. Every agent and shell it runs is a
`worktree_tabs` row, the one a started task launches into included, so what a
worktree has open is exactly what that table says and a restart reopens it. The
bare `tree:<worktree_id>` key belongs to sessions minted before that was true;
nothing writes it any more, and the reads that span a worktree (`hasLivePane`,
`session::worktree_key_patterns`) still match it so those conversations stay
attributed.

---

## Identity: one pair, three homes

This is worth stating plainly because it is what makes reattach possible at all.

- **Minted** at the launch site — e.g. ``refId: `tree:${worktree.id}:tab:${tab.id}` ``
  (`TreesView.tsx`), beside the tab's `agent.kind`.
- **Sent to the PTY** as `OpenOpts.label` + `OpenOpts.agent_kind`
  (`TerminalView.tsx` → `terminal.rs` → `crates/pty`). Opaque there: stored and
  compared for equality, never a path.
- **Stored** as `terminal_sessions.(term_key, agent_kind)`, which maps a surface
  and a provider to a durable agent conversation id.

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

**The PTY carries the same two columns, as two fields.** It has to: the label is
compared byte-for-byte against `term_key`, so a launch site that folded the
provider into it (`triage:AK-1` opened as `AK-1::codex`) matched no row on the way
back, and `hooks::session_states` reported a working agent as exited. A pane, a
title, an adopted session and a process-table result are therefore all keyed by
the *pair* — `paneAddress` on the frontend, `terminal::LiveTerminal` in Rust.

Because that identity is a value both ends can re-derive, a reloaded page can take
a live session it knows nothing about and put it back on the pane that owns it.
That is the entire adoption mechanism.

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

`terminal_open`, `terminal_write` and `terminal_seed` run on the blocking pool:
a spawn is a fork/exec with a full env copy, a write can block on a wedged
child's full PTY buffer, and a seed may write a file before either. None of them
may pin a tokio worker. `resize`/`close`/`detach` are cheap
and stay inline. Each session has its own writer mutex, so a stuck child
serializes only itself.

**There is no backpressure toward the renderer.** The app forwards every chunk to
the webview, and absorption is left to xterm's internal write queue. The ring
bounds Rust-side memory; the renderer side is unbounded. (Between a server or a
Daedalus host and the app, the host paces a session whose link drains slowly,
docs/server.md "The shared host crate".)

---

## Lifecycle: what survives what

| event | PTY process | scrollback |
|---|---|---|
| route navigation, tab switch | ✅ | ✅ |
| **webview reload** (⌘R, HMR, crash recovery) | ✅ **adopted** | ring replay (2 MiB) |
| app quit, in-app PTYs (`Mode::Off`) | ❌ `close_all()` | ❌ |
| app quit / crash / update, on the santree server | ✅ the server keeps it | ✅ the server's ring |

A terminal in a Daedalus project runs on the box instead, and outlives more —
see [Remote sessions](#remote-sessions):

| event | PTY process on the box | scrollback |
|---|---|---|
| webview reload | ✅ adopted (the pane lives in the app) | the box's ring |
| link drop | ✅ pane reads "Reconnecting…" | exact replay of what was missed |
| app quit + relaunch | ✅ found again by its address | the box's ring |
| the box's session host restarts | ❌ the pane exits | ❌ |

### The one rule

> **A pane unmounting detaches. Only closing a tab closes.**

`TerminalView`'s cleanup calls `backend.detach(id)`. Every property in this
document depends on that line: a `close(id)` there would kill every running agent
on a reload and make an xterm impossible to dispose without losing its session.

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

`terminal_adopt(owner)` is a hand-over keyed by the page-owner tag, a
per-document UUID in `pageOwner.ts`: sessions belonging to a different page are
re-tagged to the current one and reported with their labels, and the panes claim
them by label as they mount.

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

**One pane, one session.** Two live sessions under the same label *and the same
provider* means an earlier page leaked one; only one is reachable, so adoption
keeps the newest and ends the rest. Two under the same label and *different*
providers are two panes the user can legitimately have open at once (a Claude and
a Codex review of one PR), and both survive.

---

## The santree server

On a signed build a detached **`santree-server`** owns this Mac's PTYs
(docs/server.md is its source of truth), so a quit, a crash or an update of the
app never ends an agent. The reference implementations do the same: Orca and
Superset both run the PTY in a detached daemon that outlives the app. What a
daemon costs, and how santree answers each cost:

| Cost | Our answer |
|---|---|
| A second binary with its own version and upgrade path | One signed artifact through the one updater. The server has a compile-time **revision** pinned by a drift test; a new revision starts beside the old one, which keeps its sessions and drains until idle. Protocol stays v1 with additive features |
| Endpoint ownership (Orca's design notes record twenty-three defects, and "do not add a sweeper") | A per-revision `flock` held for the server's life is the ownership: only the holder binds, nobody unlinks on exit, the kernel releases the lock on death, and the server rebinds a socket someone removed |
| A daemon that stops answering | A typed `ServerState`, a banner with Start, a crash budget (5 in 60 s, then `Failing`), panes that read `Reconnecting` or `Lost` rather than exited, and a "terminals aren't responding" hint after 10 s |
| Shells held for windows nobody has open | Idle retirement: no clients and no sessions for 10 s (120 s if nobody ever connected) and the server exits |
| fd handoff across a daemon upgrade | Not built; drain-beside-new needs none |
| A process any local agent could reach | Admits only santree.app, by code signature, and the app admits only the server; unsigned builds don't use it unless opted in |

**What the server does not change.** The ring, `attach`/`detach`/`adopt` and the
anchor protocol are the same code: the server runs `crates/pty`'s `PtyManager`. A
pane is still keyed by its `(term_key, provider)` pair and a reload still adopts.
A **reboot or logout** still ends the process; the conversation is durable in
`terminal_sessions.session_id`, which `session::resolve` turns back into a
`--resume` when a human clicks Resume on the tab, never on santree's own
decision. A session santree can no longer reach reads **Lost**, not exited
([Remote sessions](#remote-sessions)).

### Two backends, one facade

`sessions::Terminals` (`src-tauri/src/sessions/backend.rs`) is the one handle the
commands hold. Local panes are either **in-app** (`Mode::Off`, the `PtyManager`
above) or on the **local server** (`Mode::Signed` for a signed release,
`Mode::OptIn` for an unsigned build with `SANTREE_SERVER=1`); Daedalus panes are
the third home. The mode is chosen once by `sessions::server_mode()`. Code outside
`sessions/` must not branch on which backend a pane has; that is a review rule,
not a checked one.

---

## Remote sessions

A terminal whose cwd is inside a Daedalus project is a PTY on the box, reached
over the link (docs/remote.md, "Terminals and setup scripts on the box"); on a
signed build every other terminal is a PTY in the local santree server, reached
over a unix socket. **One piece of code serves both**: `RemoteTerminals`
(`src-tauri/src/sessions/remote.rs`), one instance per host, parameterised by a
`Profile` that says what differs: which environment a session inherits, what
happens to a pane whose session the host no longer has (`Gone::End` for Daedalus,
`Gone::Lost` for the local server), and whether to adopt every session the host
holds. The trust a link must carry is the host's (`HostOptions.require`).
The frontend knows only what it has to:

- **The same backend calls.** `sessions::Terminals` dispatches on the route at
  open (a cwd inside a Daedalus project is `Route::Daedalus`) and on the id
  afterwards: remote ids come from one counter (`IdRegistry`, from 2³¹) and each
  host answers whether it `holds(id)`, so several local servers and Daedalus
  coexist.
  `TerminalView`, the layer and the orchestrator don't branch on where a
  session runs.
- **One more signal, never an exit.** `terminal_open`/`terminal_attach` take a
  second channel, `on_link`, which only a remote session sends on: `live`,
  `reconnecting` or `lost` (`PaneLink`). `TerminalView` shows "Reconnecting…" over
  the pane while the link is down; the exit sentinel is still the only thing that
  closes a tab, and a dropped link never sends it. `lost` is the local server's
  one other signal: the host the session lived on was stopped, killed or restarted
  (the pane remembers the host's `bootId`, and a host numbers its sessions from 1
  on every boot), so the session is gone but the tab stays, saying why, with a
  **Resume** for agents, a human click (docs/server.md, "`PaneLink::Lost` and
  Resume"). On reconnect the backend
  re-attaches from the anchor it kept — every byte it forwarded — and the box
  replays exactly the gap, into the same xterm.
- **Adoption.** A reload adopts remote panes through the same `terminal_adopt`
  (they live in the app process). After santree itself restarts, a pane that
  opens finds its session on the host by its address — the pair from
  [Identity](#identity-one-pair-three-homes) — and attaches `fresh`, so the tab
  comes back running; its seed is not typed again. A host that outlives the app
  by design (the local server) goes further, **adopting everything**: on the first
  connect per boot every alive session becomes a pane no view is showing yet, so
  agents in worktrees nobody has opened are back and their prompts count; and a
  tab that then opens for the same address *claims* that pane instead of
  starting a second session. Sessions whose surface is gone are never closed
  automatically (they are listed in Settings → Terminal). Daedalus does
  not adopt everything.
- **Untrusted bytes**: `TerminalLayer` builds a Daedalus pane's renderer with
  `untrusted` (decided from the tab's cwd, before any byte,
  which is why the layer also waits for the repo registry): OSC 52 is claimed
  and dropped ahead of any clipboard handler, and an OSC 8 link opens only as
  an `http(s)` page through the system browser. Remote text reaches the screen
  only through xterm's renderer, never as HTML.
- Keystrokes typed while the pane is reconnecting are dropped, not queued.

Setup scripts in a Daedalus project run the same way, streamed to the usual
read-only pane (`daedalus/setup.rs`). So do its agents: an agent tab's pane is
a remote one carrying `SANTREE_REPO`/`SANTREE_TERM_KEY`, its seed the usual
one (up to the box's longer line, `REMOTE_SEED_CAP`, 2048 bytes), its hooks written
and fired on the box and relayed back, and which agent is in its foreground
read from the box's process table (docs/remote.md, "Agents on the box").

---

## Rendering

`XtermRenderer` is the **only** module that imports xterm; everything else
depends on the `TerminalRenderer` interface, so swapping the engine means
replacing one file.

`TerminalLayer` is mounted once at the app shell and renders *every* live tab as
a `fixed` overlay positioned over whatever host element a view registered.
Sessions belong to the document, not to the route.

- **Each session has its own slot, so several can be on screen.** A split main
  area (`components/split`) shows a terminal per group: every session's newest
  claim (`TerminalTabs.embeds`) places that session's pane over its own host,
  and the newest claim overall (`embed`) is the one that takes the keyboard
  (`TerminalView`'s `focused`, distinct from `active`, which is "on screen").
  A press inside a pane calls its claim's `onActivate`, which is how a split
  group learns it was clicked — the terminal is drawn by the layer, not inside
  the group. A host that *moves* without resizing (a tab dragged into a group
  of the same width) is re-placed through `relayoutTerminals()`, since a
  `ResizeObserver` only reports size.

- **Hidden panes use `invisible`, never `display:none`**, so xterm never reflows
  from a zero-size state on a tab switch.
- **A pane's geometry freezes at its last embed rect** when it is not embedded.
  Snapping to the full content area would resize the grid and make zsh reprint
  its prompt, leaving a blank prompt line every time you came back. A session
  never shown parks at the last rect any pane had.
- **WebGL contexts are rationed to 8** in an MRU pool. WebKit silently drops the
  oldest past ~16 per page, and an xterm that loses its context never gets it
  back; overflow panes render through the DOM fallback and reclaim a context on
  activation. Two losses and it stops trying.
- **The overlay clips, and its geometry is written from the resize callback, not
  through React state.** xterm sizes `.xterm-screen` and its canvases from the
  *grid*, not from the element it was mounted in, and nothing in xterm's own
  stylesheet keeps an over-sized canvas inside that box — so a grid lagging a
  shrinking pane paints over whatever is beside it, at z-index 30.
  `overflow-hidden` on each pane makes that structurally impossible; putting the
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

Which agent is running is a *separate question* from what it is doing, and it has
its own source — see "Agent identity: the process table" below. The state ladder
described here is unchanged by it.

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
`(term_key, agent_kind)` pairs with a live PTY (`sessions::Terminals::liveness`,
which asks the in-memory manager, the local server or Daedalus, whichever holds
the pane) and no row whose terminal is absent from a complete answer can come
back live-looking. With in-app PTYs a PTY cannot outlive the app, so an empty set after
a restart is the *correct* answer, not a missing one. With a santree server it is
**not always correct**: a server santree cannot reach right now may be holding
agents that are running fine. So the answer carries whether it is complete,
`sessions::Liveness { live, complete }`, and `complete` is true only when every host that may hold sessions answered
for its current boot. An incomplete answer means `terminal_liveness` returns `None`,
the fold below keeps agents as they were, and resuming a conversation is refused
(it could otherwise be resumed twice): `hooks::session_states`, and
`session::occupancy` behind `resume_worktree_session` and `check_tab_resume`.
This is why there is no
sweeper, no decay timer and no straggler window: the answer is recomputed from
live state on every read, so a hook that lands after the process died has nothing
to win against. Matching is on the row's own identity — `(term_key, agent_kind)` — and never on
`cwd` (path normalization — `/var` vs `/private/var` — would retire every
session at once); the *write* half, `retire_terminal`, scopes by `cwd` and the
provider too, because there the failure modes are reversed. A row with no terminal to join
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
terminal's registry row rather than assumed, so a Codex session is never
painted with the Claude mark. Its rows reconcile like Claude's, against the
rollout rather than a transcript (`codex_rollouts::last_activity_ms`).

**`SessionStart` is not a launch event here.** Claude fires it while the TUI comes
up; Codex fires it when the *first turn is submitted*, because that is when it
creates the thread the session id belongs to. Measured on codex-cli 0.151.0 in a
real pty with santree's exact flags: idle for 95s after boot and only `SessionEnd`
ever fires, at quit; type one prompt and `SessionStart` lands the instant it is
submitted, followed by `UserPromptSubmit`, `Stop`, `SessionEnd`.

That matters because `SessionStart` is what writes the `terminal_sessions` row
binding the session to its surface — so between opening a Codex tab and speaking
to it, *nothing hook-fed knows the session exists*. This is why the agent registry
does not wait for it: a tab carries santree's own record of the launch (provider,
repo, term key — `AgentTabIdentity`), and `buildAgentEntries` renders an entry from
that until the provider's row supersedes it. Anything new that must show a Codex
agent promptly reads the launch or the process table, not the hook.

Codex also has *history*, reconstructed from rollout files under
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl` — prompts, replies,
model, subagent counts — read display-only and bounded by a first-line peek plus
a byte-length-keyed cache.

There is no thread control. A Codex session is `codex` (or `codex resume
<thread>`) in a PTY; a santree-owned `codex app-server` would hold Codex's
per-thread writer lock ("thread `<id>` already has an active writer" on resume).
The other surfaces ask the CLI: `codex login status`, `codex debug models`, `codex logout`.
Subscription usage comes from the `token_count` record in the rollout itself.

---

## Agent identity: the process table

The two sources above are *records*. A hook row is what a provider said; an
`AgentTabIdentity` is what santree launched. Neither can see an agent the user
started themselves by typing `codex` in a santree shell, and neither notices when
the CLI in a pane is replaced by a different one.

So santree also *observes*. `agent_procs::detect` takes each live PTY's
address — `term_key` and the provider in it — and its root pid
(`terminal::pane_roots`), walks that pid's descendants in
one shared `ps` listing (`proc_table`), and reports which catalog binary owns the
pane's **foreground process group** — `ps`'s `+` flag in `stat`. Measured against
the real CLIs:

| pane | `stat` | detected |
|---|---|---|
| `codex`, opened and never prompted | `Ss+` | Codex |
| `claude`, opened and never prompted | `Ss+` | Claude |
| `/bin/zsh -l` at its prompt | `Ss+` | *(nothing — zsh is not in the catalog)* |
| a shell in which the user typed `codex` | shell `Ss`, codex `S+` | Codex |
| …then suspended it with `^Z` | shell `Ss+`, codex `T` | *(nothing — the pane is the user's again)* |

Rules that make this safe to trust:

- **Identity, never status.** It answers "which agent is here", never "what is it
  doing". `lib/attention.ts` remains the one state vocabulary; the hook rows and
  then the terminal title still decide the dot.
- **Precedence is one ordered lookup**, so the three sources cannot disagree: a
  provider's own session row, then the process table, then santree's launch
  record. The scan outranks the record because it observes reality; it does not
  *replace* it, because a failed `ps` or a CLI behind an interpreter (an
  npm-installed agent under `#!/usr/bin/env node`) names nothing, and the record
  is what stands then.
- **Absence is unknown, not "no agent".** Nothing substitutes a default provider
  for a pane the walk could not attribute.
- **`argv[0]`'s basename, matched against the agent catalog** — not `ucomm`,
  which lies (a running `claude` reports `claude.exe`, and so did a `ugrep` it
  spawned), and not the whole command line, which would claim `vim codex`.
- One `ps` for the whole app: the listing is cached 500ms and the Resource
  Manager reads the same snapshot. A 3s timeout bounds it, and a failure degrades
  to an empty result rather than an error.

The trigger is the pane set, not a clock. `useAgentEntries` invalidates the read
whenever a tab opens or closes, so a new Codex tab is scanned immediately; the
query's own 10s interval (the cadence `useSessionStates` already uses, and only
while a pane is open) exists to catch an agent started *inside* an existing pane.
Orca binds the same scan to pane bind and OSC 133 command start/finish; santree
has no shell integration to hook, so the tab set is the bind signal it has.

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
- A tab whose stored Claude session is running as one of Claude's own background
  sessions (`claude --bg`, hosted by Claude's daemon, so it outlives any pane)
  launches `exec <bin> attach <id>` instead of `--resume`, which the CLI refuses:
  `session::resolve` asks `claude agents --json` (process identity, never terminal
  output; any failure reads "none") and returns `AgentSession::Attach`, with none
  of the flags above. Daedalus panes never attach.

Every value is single-quoted through `shellQuote`, which strips newlines and all
C0/C1 control characters first — the seed is written to a PTY, where control
bytes would be interpreted.

### A seed longer than a line

**A tty silently truncates a long line, so no seed is ever typed as one.** The
seed goes to the PTY through its own command, `terminal_seed` — not
`terminal_write` — and that command types it verbatim only while it fits in
`MAX_SEED_LINE` (512 bytes, half of macOS's `MAX_CANON`; Linux's
`N_TTY_BUF_SIZE` is 4096). Past that the line is written to
`<app_data_dir>/seeds/seed-<uuid>.sh` — `0700`, in a `0700` directory — and what
is typed is a reference to it, measured at 123 bytes in this repo whatever the
command was.

**The reference's form follows the seed.** A seed starting with `exec ` — every
agent launch — is referenced with `exec '<path>'`: the shell is replaced by the
script and the script's own `exec` replaces that with the agent, so the PTY is
still the agent and its EOF is still the agent exiting. Anything else is sourced
(`. '<path>'`), which leaves the login shell alive exactly as typing the command
would; `exec`ing it would instead end the session the moment the command
finished. Nothing produces a long non-`exec` seed today — the Settings login box
is the only non-`exec` caller and its command is a few bytes — so that branch
exists to stop a future one being silently redefined.

Three things about it are load-bearing:

- **The split is per input kind, not per length.** A keystroke — a long paste
  included — must arrive byte-for-byte, so `terminal_write` may never take this
  path. Only the one line santree composes itself may be reshaped, which is why
  it has a command of its own.
- **The limit is the line discipline, not the write.** Splitting the write into
  chunks does not help; the tty's canonical-mode buffer drops the overflow with
  no error and no signal, which is why this failed as "the command is sitting
  half-typed at the prompt" rather than as an error.
- **The directory is never followed through a symlink.** `create_new` protects
  the script's own name, but `create_dir_all` decides "already there" with
  `is_dir()` and `set_permissions` is `chmod`, not `lchmod` — so a symlink in
  place of `seeds/` would hand the mode change, and the sweep's delete loop, to
  whatever it points at. Planting it needs santree's own UID, which can do worse
  directly, but on macOS it would let a process that can write to Application
  Support (not TCC-protected) borrow a signed app's reach into Documents. Both
  paths bail on `symlink_metadata` first.
- **Scripts are swept by age, not deleted after use.** Nothing here may watch a
  session to learn when the shell got to its script (that is output-parsing), and
  a login shell resolving `direnv`/nix can take seconds — so each launch first
  deletes any seed script older than ten minutes. A crash between the write and
  the exec cleans up on the next launch instead of never.

The same trap had already been paid for twice, each time with a local
workaround: `hooks.rs` spills Claude's settings JSON to a `--settings` file, and
every launch site that would otherwise inline a rendered prompt seeds `Read
<path> and follow the instructions inside` instead (`useWorkLaunch`,
`AiReviewSessionPane`, the triage panes). The Codex `-c 'hooks.<Event>=[…]'`
flags — six of them, each repeating an absolute hook-binary path and an absolute
db path — then reintroduced it by a third route, at 1.4–2 KB depending on how
deep those two paths are (a real launch from a `.santree/worktrees/<branch>`
checkout measured just over 2 KB). Those workarounds are still worth keeping —
a file is a better home for a page of prose than a command line either way —
but they are no longer what stands between a launch and a mangled line. The
guard sits below every provider, so the next one inherits it without knowing.

**The launch is gated on `isFetched`, never on a value.** A boolean setting reads
`false` both when it is off and when it has not loaded, and launching in that
window silently dropped `--chrome` — or worse, ran a restricted tab with no deny
list.

---

## The other execution paths

Not every process santree runs is an interactive terminal.

**`stream.rs` — background command runs.** Repo setup scripts, shown in a
**read-only** pane. A run is a **pane on the terminal facade** (`stream::RunHost`,
implemented by `terminal::TerminalRuns`): its PTY is the in-app manager's or the
local server's like any terminal's, so on a build with the server the script
outlives the app; it is not followed again after a relaunch, but Settings →
Terminal lists it and a second run of its key is refused while it lives
(docs/server.md, "Setup runs"). It still
uses a PTY, because nearly every build tool block-buffers its output and turns
colour off when stdout is not a TTY. Spawned as `/bin/bash -lc` around the script
with a wrapper that leaves the exit code in a status file (there is no
`pty.exitStatus`), owned by a process-wide registry keyed by an opaque caller
string rather than by a tab, with a 60-minute deadline while this app follows
it and a 120×40 starting grid. Output arrives as a
`Channel<StreamEvent>` of `Chunk { text } | Done { ok }`, with partial UTF-8
carried across reads. A Daedalus project's setup script streams the same events
from a PTY on the box (`daedalus/setup.rs`, docs/remote.md).

**`agent.rs` — headless one-shots.** `claude -p` / `codex exec` to draft a commit
message, a PR body, or an English-tutor analysis. Prompts go over **stdin, never
argv** (any local process can read argv through `ps`). Tool use is denied by default because
these prompts embed diff, PR and ticket content that an attacker can influence.
Every call site names its own timeout; there is no shared default.

**`codex_cli.rs` — Codex's non-session surfaces.** One short-lived, non-interactive
`codex` invocation each (stdin closed, timeout, output cap) for version, login
status, the model catalog and logout. No login command: `codex login` owns a
browser round trip, so Settings points the user at their own terminal.

---

## Compliance

`COMPLIANCE.md` is the governing document. Most of it is enforced by the compiler
(the input types in `terminal.rs`, the workspace `clippy.toml`) and by tests
(`src-tauri/src/compliance.rs`, `src/features/terminal/compliance.test.ts`). The
parts that bear on this layer:

- **The only bytes santree writes to a terminal are the user's keystrokes and the
  single human-initiated seed prompt.** The compiler holds it: a terminal takes
  input only as `terminal::input`'s `Keystrokes` or `LaunchLine`, which exist
  only as `terminal_write`'s and `terminal_seed`'s IPC arguments, and
  `clippy.toml` forbids the raw PTY writes beneath them outside their sanctioned
  sites. Four frontend tests assert nothing decodes PTY output and feeds it back.
- No credential handling; `resolve_env` is the single env-injection chokepoint,
  with values in the OS keychain and only names in SQLite.
- **Reading the process table is observation, not a control loop.** It is the
  same passive class as reading a pane's title: nothing derived from `ps` is ever
  written back into a PTY, gates a launch, chooses a prompt, or becomes an
  argument to a command. Nor could it: outside `write_pty` nothing can make the
  input a terminal accepts, so it has no path to a terminal even in principle.
- **The santree server is session persistence, not a driver.** It relays
  `pty.write` and nothing else, reads output only to replay terminal modes into a viewer (`crates/pty/src/modes.rs`), and starts, resumes and retries
  nothing; it admits only santree.app by code signature, and the unsigned-build
  opt-in is the one named exception (COMPLIANCE.md, docs/server.md "Trust").
- The deny lists in restricted flows are **best-effort defence-in-depth, not a
  security boundary** — they are text-matched and bypassable. Never build on them
  as a gate.

---

## Where things live

```
crates/pty/src/lib.rs        PtyManager: spawn, read loop, attach/detach/adopt, close_all
crates/pty/src/ring.rs       the output ring + the anchor protocol
crates/hook/src/lib.rs       the hook binary: state hooks, status line, MCP mode
src-tauri/src/terminal.rs    Tauri adapter + the RawBytes channel; pane_roots, the
                             inventory and quit-summary commands (dispatch is
                             sessions/'s)
src-tauri/src/sessions/      mod.rs (Mode, PaneLink, Liveness, Spec) · backend.rs
                             (`Terminals`, the facade) · ids.rs (the id registry) ·
                             remote.rs (`RemoteTerminals`: remote panes, ids,
                             anchors, re-attach, find-again — local server and
                             Daedalus) · env.rs (a session's env and baseEnv)
src-tauri/src/server/        the local server's launcher, connector and supervisor
crates/host/src/lib.rs       protocol v1 served: what the server and the test daemon run
crates/server/src/lib.rs     the santree-server binary: serve, lifecycle, peer trust
src-tauri/src/daedalus/setup.rs      setup scripts in a PTY on the box
src-tauri/src/proc_table.rs  the one `ps` listing, cached 500ms and shared
src-tauri/src/agent_procs.rs which agent owns each pane's foreground
src-tauri/src/hooks.rs       the --settings file every claude launch layers
src-tauri/src/session.rs     term_key → durable conversation id (resolve/mint/forget)
src-tauri/src/stream.rs      setup runs as facade panes (RunHost) → read-only panes
src-tauri/src/session_signal.rs   the socket the hook nudges to push state changes
src/features/terminal/
  types.ts                   the two seams: TerminalRenderer, TerminalBackend
  TauriBackend.ts            IPC implementation; channel wiring; adoption by address
  paneAddress.ts             (term_key, provider) — the pane's key in every map
  TerminalView.tsx           one pane: open-or-attach, detach on unmount, resize
  TerminalLayer.tsx          the persistent overlay that outlives routes
  TerminalsContext.tsx       once-per-document adoption
  orchestrator.ts            tabs, embed claims, the pane handle registry
  relayout.ts                "hosts moved": re-place every embedded pane
  XtermRenderer.ts           the only xterm import; WebGL rationing; theming;
                             the untrusted mode (OSC 52 off, web-only OSC 8)
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
| ✅ **mode restoration** | host-side (`crates/pty/src/modes.rs`, feature `pty.modes`); Daedalus panes get it once the engine adopts this santree-pty |
| ⬜ **renderer backpressure** | a renderer that falls behind has an unbounded queue |
| ⬜ **memory eviction** | every xterm stays mounted at 10k scrollback; only WebGL is rationed |

**Why the replay alone is not enough.** A program sets bracketed paste, mouse
reporting and the like once at startup, and those bytes leave a 2 MiB ring within
minutes. A reattach is always a fresh xterm, so `TerminalView` attaches with
`Anchor::Fresh` and the ring answers `Tail`: xterm re-derives a mode only if its
DECSET is still in the replay. Without restoration a restored pane would get
paste-as-keystrokes and a dead mouse on a live TUI.

**The host restores; the pane does nothing.** The ring feeds every chunk it evicts
to a tracker that keeps the last explicit set or reset of application cursor keys
and keypad (1, 66), focus reporting (1004), bracketed paste (2004), the mouse
protocol (9, 1000, 1002, 1003, one state), the mouse encoding (1006, 1016, one
state) and the alt screen (47/1047/1049, one key); DECSTR and RIS reset. Modes
xterm.js does not implement (1005/1015, the kitty keyboard protocol) are not
tracked. A `Tail` replay is prefixed with the DECSETs for the modes in effect
where the retained tail begins, alt screen first; the tail then moves the viewer
on exactly as it moved the original terminal. An exited session's preamble is the
alt screen only, and `Exact`/`Reanchor` replays carry none. The in-app
`PtyManager` and the santree server both send it, so a remount, a webview reload
and a relaunch against the server come back with the program's modes. The
frontend keeps no tracker of its own.

**Daedalus.** The preamble lives in santree-pty's `Ring`, so a Daedalus box sends
it once its engine moves to this santree-pty. Until then a Daedalus pane loses
bracketed paste and mouse reporting after a remount or reload, until the program
sets them again.

**Compliance.** The preamble is display-side bytes written into the viewer's
xterm ahead of the replay. It never reaches the PTY write path, answers no query,
and no mode decides what is typed (`COMPLIANCE.md`). Focus reporting is the one
mode with an outbound effect, the same bytes xterm would have sent had the
program's own `?1004h` been in the replay.

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
