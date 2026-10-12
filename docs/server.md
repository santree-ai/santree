# The santree server

The source of truth for the local terminal server: a detached process that holds
this Mac's PTYs so a quit, a crash or an update of the app never ends an agent.
Read it before touching `crates/host/`, `crates/server/`, `src-tauri/src/sessions/`,
`src-tauri/src/server/`, `scripts/{bundle-binaries,sign-resources}.mjs` or
`scripts/verify-bundle-signatures.sh`. The terminal layer is docs/terminals.md;
the protocol and the other host that speaks it are docs/remote.md; the promise
this design keeps is COMPLIANCE.md, "The santree server is session persistence".

Everything here is built and tested in the tree. What has never run on a signed,
notarized build is under [Unverified](#unverified); what is not built is under
[Known limits](#known-limits).

---

## What it is

santree launches a **detached `santree-server`** that owns the local PTYs. The
app can quit, crash, reload or update while agents keep working; a relaunch
reattaches every pane with its scrollback. An update never ends a session: an
older server keeps its sessions and drains beside the new one.

The local server is **Daedalus, on this Mac, over a local socket**: the same
protocol v1 (`crates/remote-proto`), client (`crates/remote`) and pane code
(`RemoteTerminals`), with a different transport and a different rule for who may
connect. Scope is **PTYs only**: git, files, `ps`, trackers and GitHub stay in
the app. The server opens a session when the app asks (a human opened a tab),
relays `pty.write` and nothing else, reads output only to replay terminal modes
into a viewer, and starts, resumes and retries nothing.

```
santree.app  (UI, git, trackers, sole DB migrator)
  ├─ ── run/server-r<N>.sock ──▶ santree-server r<N>   (current: new sessions)
  ├─ ── run/server-r<M>.sock ──▶ santree-server r<M>   (older: draining while it holds sessions)
  └─ ── unix socket ──▶ Daedalus agent ──TLS──▶ session host

agent hooks ──▶ <app_data>/bin/santree-hook ──▶ santree.db (+ signal-socket nudge)
```

The app is the only client of each socket and the only migrator of the database.
`santree-server` (`crates/server`) is `santree-host` on a unix socket plus a
lifecycle: no database, no `santree-core`, no Tauri, one per **revision**. Hooks
do not go through it: `santree-hook` writes SQLite directly, app open or not. A
new PTY whose cwd is in a Daedalus project goes to Daedalus, every other one to
the current local server; an existing pane dispatches by id ([Sessions](#sessions)).

---

## Modes: who gets the server

`sessions::server_mode()` (`src-tauri/src/sessions/mod.rs`) is decided once at
startup, because a pane's route depends on the answer staying put:

| `Mode` | When | Admission |
|---|---|---|
| `Signed { team }` | macOS, `SANTREE_TEAM_ID` baked in **and** the running app's own signature names that team | the peer's code signature, both ways |
| `OptIn` | no team baked in, and `SANTREE_SERVER=1` | the uid only |
| `Off` | everything else | no server: in-app `PtyManager`, nothing outlives the app |

`choose_mode` is pure and tested: a baked build that cannot confirm its own
signature is `Off`, never `OptIn`, and the env flag never overrides a signed
build. There is no Settings switch. Linux has no signature check, so it is `Off`
(or `OptIn`, launched by a plain detached spawn), and its packages do not carry
the server.

**Why only signed builds.** Every agent in a santree PTY runs as the user's uid. A
socket that admitted by uid would let one agent attach to another's pane, type
into it or open a shell beside it. The code signature is the only thing that
separates santree.app from such an agent. An opted-in unsigned build admits by
uid alone and logs that it does: any agent of that user can then drive another's
terminal. It is a development tool; do not opt in where you run untrusted agents.

---

## Lifecycle

### Spawn

The app launches the server; nothing else does (no login item, no launchd).

1. **ensure**: connect `run/server-r<REV>.sock` (3 s hello timeout). A server that
   answers `hello` is the only proof of a server; pid files are never evidence.
2. Nothing answers: copy `r<REV>/santree-server` from the bundle (temp file and
   rename, only when absent or different, never while a server answers), then
   spawn. A server that answers by then is connected to instead.
3. The spawn is **detached**: `setsid`, cwd `/`, the environment cleared to `HOME`,
   `USER`, `LOGNAME`, `TMPDIR`, `LANG` and a fixed system `PATH`, every
   descriptor above the ready fd closed, stderr appended to a private plain file
   beside the log (a planted FIFO or symlink is refused), a 30 s ready timeout.
4. **The ready socketpair.** The server gets one end of a `UnixStream::pair()` as
   `--ready-fd N`, writes `ready <pid>` (or `occupied`) and closes it. A socket,
   so a signed server can ask who launched it; and an **anonymous** end
   (`endpoint::peer_is_unnamed`), because on macOS a client of a named listener
   reports the listener's identity, which would let an agent pass a socket
   santree.app listens on. The server adopts the fd before opening any file.

There is no signature check before the exec: macOS has no `fexecve`, so it could
only narrow a race. The guards are `validate_binary` (a plain file this user owns,
writable by nobody else, in a 0700 dir), the server's launcher and self checks,
the connect-time peer check, and the hardened runtime. A swapped binary may run as
the user, as any agent can; it is never sent a byte, a session or a secret.

### The lock owns the socket

A server of revision N owns `run/server-rN.sock` while it holds an exclusive,
non-blocking `flock` on `run/server-rN.lock` (`crates/server/src/endpoint.rs`).
Two launches at once: the loser exits 20 and its launcher connects to the winner.
A crashed server's stale socket: the next lock holder unlinks it and binds (0600,
in a `run/` that is 0700, this user's, not a symlink). **Nobody unlinks on exit**,
so an exiting server never removes a newcomer's name, and there is no sweeper.
The kernel drops the lock however the holder dies; the fd is close-on-exec.

**The server repairs its endpoint.** Both files sit where any process of this uid
can write. Every 3 s (`Endpoint::check`) the server compares them with the
`(dev, ino)` it made. A removed or replaced lock is retaken, unless somebody else
now holds it (then it logs once and binds nothing). A socket that is gone or
replaced is bound again exactly as at startup, under the held lock, for as long as
the server runs; the new socket gets its own accept loop and accepted connections
carry on. Both files are touched hourly, because the run dir can fall back to
`$TMPDIR`, which cleaners sweep by access time.

**The app probes the lock before it calls a server dead.** Before it marks a
server dead, tells its panes `Lost` or gives up on one that never answered, the
app takes and drops a shared `flock` on `server-rN.lock` (`server/lock.rs`,
read-only, `O_NOFOLLOW`). Held: a server is alive behind a socket nobody can
dial, liveness stays incomplete, a current server is `Down` with a reason naming
the lock file (no relaunch, which would exit 20, and not a crash), an older one
stays draining. Free, or no file: dead. Restart and End now wait for the lock to
free. A launch that exits 20 with the lock free and no socket met the app's own
probe and is retried once. A same-uid process holding the lock can keep the app
from starting a server; the app names the file and never kills the holder.

### Exit codes

| code | meaning |
|---|---|
| `0` | retired (idle), stopped (`server.stop`), or SIGTERM/SIGINT |
| `1` | failed to start for any other reason |
| `2` | usage error |
| `20` | `EXIT_OCCUPIED`: another server of this revision holds the endpoint |
| `21` | `EXIT_UNTRUSTED_LAUNCHER`: signed, and the launcher is not santree.app, or no ready fd, or not an unnamed socketpair end |
| `22` | `EXIT_UNVERIFIED_SELF`: a release build cannot confirm it is signed by its baked team |

21 and 22 become `Down` with a reason. The launch-trust check runs before the
endpoint is touched, so a server an agent launched never holds the lock.

### Serving, flood, retirement, quit

`serve` raises `RLIMIT_NOFILE` to `min(hard, 10240)`, is non-dumpable on Linux
(the hardened runtime covers macOS) and logs panics. It catches signals rather
than ignoring them, since an ignored disposition passes to every PTY child:
SIGTERM and SIGINT close every session and exit 0; SIGHUP is logged and ignored.

**Flood.** Peer signature checks run at most 4 at a time (`MAX_CHECKS`) and at
most 32 accepted connections wait for one (`MAX_WAITING`); past that a connection
is closed at once, logged once per burst. A same-user process connecting in a
loop can delay the app's connect, which costs availability only: that process
could `kill` the server anyway. Every connection is verified.

**Idle retirement** (`Idle`): no clients and no held sessions for 10 s (120 s if
nobody ever connected) and the server exits; a connection being verified counts
as open. An exited session is held until reaped (60 min) so the app can read how
it ended. Quitting with no sessions leaves nothing running.

**Quit is a disconnect.** `Terminals::release()` closes in-app sessions and only
disconnects from a server. Stopping is explicit: Restart, Stop and End now in
Settings send `server.stop`. There is no `status` or `stop` CLI verb, because
anything in a santree terminal could run it.

**Closing a session hangs up its descendants.** The PTY layer SIGHUPs every
process whose controlling terminal is that PTY (`crates/pty` `hang_up`), so a
background job in its own process group does not outlive the tab. A process that
left the session (`setsid`, a daemon) is not the tab's to end.

### Logs and files

`--log-file` is appended at 0600, `O_NOFOLLOW`, rotated at 5 MiB keeping three
(`logging.rs`; no logging crate, since every dependency is part of the revision).
It records methods, ids, commands and working directories, never env values,
input or output. The app passes `~/Library/Logs/com.santree.desktop/santree-server.log`
(`santree-server-dev.log` for an opt-in server).

```
~/Library/Application Support/com.santree.desktop/server/        (Signed)
~/Library/Application Support/com.santree.desktop/server-optin/  (OptIn)
  r<N>/santree-server   revision N's binary, copied from the bundle
  run/server-r<N>.sock  its socket (0600)
  run/server-r<N>.lock  its endpoint lock
```

The tree is keyed by trust mode, not debug/release: `pnpm dev` shares the
production identifier, and a uid-only server must never be found by a signed app.
Every `ensure` prunes older `r<N>` dirs that are not draining, with a free lock
and a silent socket (`prune_old_revisions`). A socket path holds at most 103 bytes
on macOS; when Application Support is too deep the run dir is
`$TMPDIR/santree-<uid>/run` (0700), discovery reads both, and a path that would
not fit is refused rather than truncated.

---

## Trust

The server admits santree.app alone, at accept; the app admits only the server.

- **Server → peer.** The peer's **audit token** (`LOCAL_PEERTOKEN`, never its
  pid) becomes a code object checked against
  `anchor apple generic and certificate leaf[subject.OU] = "<team>" and identifier "com.santree.desktop"`,
  where the team is the server's own. About a quarter second, once per accept.
- **App → server.** `ServerConnector` (`server/connector.rs`) connects, checks the
  socket file is this user's plain socket (advisory), then runs
  `peer::verify(fd, team, "com.santree.server")` on the connected fd **before a
  byte is written**; the identifier keeps the same-team `santree-hook` out. A "no"
  is `ConnectError::Untrusted`; a check that could not judge (2.5 s timeout,
  panic, unreadable peer) is `ConnectError::Unverified`. Both fail closed and are
  re-checked on every reconnect. A slow first check keeps running and warms the
  cache, and the supervisor waits it out rather than reporting `Down`. Nothing
  listening is `ConnectError::NotRunning`, a state, not a failure.
- **The server serves only when santree.app launched it**: the ready socketpair's
  peer is checked the same way, else exit 21.
- **The socket path is never exported into a PTY's environment.**

**Trust is encoded** (`crates/remote/src/transport.rs`). A `Connector` sets
`Link.peer` (`PeerTrust`: `Unverified | Agent | UidOnly | Signed { team }`) after
verifying and before returning the link; `HostOptions.require` (`Required`:
`Any | Agent | UidOnly | Signed`) is checked before the client exists, and a link
that falls short is dropped unread. `Signed` and `Agent` never satisfy each
other. The local server requires `Signed` (`UidOnly` when opted in); Daedalus
requires `Agent`.

**The hardened runtime is load-bearing.** Peer checks mean nothing if a same-user
agent can inject into either process, so neither carries `get-task-allow`,
`disable-library-validation` or `allow-dyld-environment-variables`
(`scripts/verify-bundle-signatures.sh` asserts it on every slice). Do not add an
entitlements file without reading that script's header. A signed process whose
executable was replaced on disk fails the check until it relaunches: the updater
restarts the app, and a running server's copy is never replaced.

**The team-id bake.** `SANTREE_TEAM_ID` is baked into the server and the app
(`option_env!`). A baked build requires exactly that team and fails closed (the
server exits 22, the app runs `Off`). Unset, as in every developer build, each
goes by whatever signature it has, or by uid alone.

---

## Versions and draining

- **`REVISION`** (`crates/server/src/lib.rs`) is the server's compatibility
  revision; the first release carries revision 1. An app runs the revision it
  bundles: a running server of that revision is adopted as is, one of another is
  left to drain. A release that does not touch the server keeps both.
- **The drift test** (`crates/server/tests/revision.rs`, run by ci.yml) hashes,
  against `crates/server/revision.lock`: the non-test `.rs` and the `Cargo.toml`
  of every workspace crate the server links (`CRATES`), the root manifest's
  `[profile.release]`/`[profile.server]` keys and the workspace keys they
  inherit, and every registry package reachable from `santree-server` in
  `Cargo.lock`. Comments count. Without it, an app that shipped changed server
  code under an old revision would adopt the old server and never run the new code.
- **When it fails**: if a release carries `REVISION`, bump it; then
  `UPDATE_REVISION_LOCK=1 cargo test -p santree-server revision`. An unshipped
  revision can take more changes without a bump: set `revision` in the lock one
  below `REVISION` and run the same command. Once released, revision N is final.
- **Protocol stays `1`.** Changes are additive features named in `hello.features`
  and checked per host, so the app can always drive an older draining server. A
  breaking change would be protocol 2, with the v1 client kept for draining.
- App and server ship as one signed artifact. `santree-server version --json`
  prints `{version, revision, protocol, features}`.

**Discovery of older servers** reads every run dir (it must be this user's and
0700) for at most the 8 newest `server-r<N>.sock` with N below the current
revision:

| What the app finds | Result |
|---|---|
| refused, lock free | gone, forgotten |
| no answer or no socket, lock held | draining, count unknown |
| connected, no sessions | let go; it retires once the app disconnects |
| connected, sessions | **draining**: its panes work, it gets no new ones |
| silence (hello timeout, no verdict, failed listing) | draining, count unknown (never shown as 0); asked again for up to 5 minutes, then given up |
| a definitive signature refusal, another uid, not our socket | not santree's server; not held open, so a squatter cannot pin liveness |

Refused and given-up sockets appear only in the Diagnostics export. A draining
server that dies is marked dead and its panes told `Lost`; End now
(`server_end_draining`) stops it, waits for the lock to free, then does the same.

| Situation | What happens |
|---|---|
| Update, same revision | same server, sessions untouched |
| Update, new revision, old server has sessions | the new server starts beside it and takes new sessions; the old one exits after its last |
| Downgraded app meets a newer server | it starts its own revision's server; the newer drains |
| Current server crashed | panes read `Lost` with Resume; the app respawns it |
| Crash loop / can't start | `Failing` / `Down{reason}`: banner, dot, Start, Open logs |
| Reboot / logout | everything ends; the next launch starts fresh; tabs offer Resume |

**Crash budget**: at most 5 respawns in 60 s, then `Failing` until a manual Start.
Restart and Stop are not crashes; Start resets the budget.

---

## Sessions

One facade, **`sessions::Terminals`** (`backend.rs`, the managed state):
`Local::{InApp(PtyManager), Server(Arc<dyn LocalHosts>)}` plus the Daedalus
`RemoteTerminals`. An existing pane is found by id (`Terminals::target`); a new
one names its `Route` (`Local | Daedalus`). Code outside the session layer must
not branch on the backend. This is a review rule; nothing checks it.

**Ids.** `IdRegistry` (`ids.rs`) is one counter for every remote pane, from 2³¹;
in-app ids count from 1 inside `PtyManager`. The facade asks each host whether it
`holds(id)`, so several local servers and Daedalus coexist. Ids are never reused.

**Boot ids.** A host numbers its sessions from 1 on every boot, so a pane records
`hello.bootId` at bind; a different boot means `PaneLink::Lost` and no attach.

**Adopt everything.** The local server's profile sets `adopt_all`. On the first
connect per boot, panes that asked for a session by address bind first; every
other alive session becomes a pane no view shows yet, so agents in worktrees
nobody opened are back and count toward attention; sessions found exited go to
`Profile::on_exited` (their hook rows are retired) and are closed. A failed
listing is retried once, then left for the next connect. `Terminals::adopt` waits
up to 10 s for adoption. **The claim rule:** `open()` on such a profile claims an
unclaimed adopted pane of the same address (label and provider), with no new
session and no seed, so a tab opening after adoption cannot start a conversation
twice or type into a running agent. `terminal_adopt` skips `run:` labels.

**Orphans are listed, never closed.** `terminal_inventory` returns
`TerminalInventory { sessions, complete, orphans }`: an orphan is a live session
shown by no pane whose label is a tab key (`tree:<worktree>:tab:<id>`,
`triage:<ticket>:tab:<id>`) with no `worktree_tabs` row. Investigations, AI
reviews and logins have no row and are never listed. Settings → Terminal shows
them for a human to close.

### Liveness is `{ live, complete }`

For the local server (`Gone::Lost`) liveness reads `pty.sessions`, because a
detached pane cannot see an exit; `complete` is true only when the host is
connected, adopted for this boot and the listing answered. For Daedalus
(`Gone::End`) the panes' state is the answer and `complete` is always true.
`Liveness::merge` unions the live sets and ANDs `complete`.

Consumers honour it. `hooks::session_states` keeps agents as they were when the
answer is incomplete. `resume_worktree_session` and `check_tab_resume` ask
`session::occupancy` / `tab_occupancy`: `Running` and `Unknown` (incomplete
answer, bound or not) both refuse, the latter with "Terminals are still
reconnecting", so a running conversation is never resumed twice. A complete answer
is also `Running` when a live pane of the provider is held by no binding and the
session was heard from within the heartbeat window (a tab closed while the server
could not be told leaves the agent running unbound).

**Reads are bounded.** A host's `pty.sessions` listing is cached 10 s, asked one
caller at a time, abandoned after 3 s, a failure cached 5 s
(`sessions::remote::Timing`); every change to the table drops the cache, so only an
exit nobody watched can read as live, for up to 10 s. The facade bounds each local
host separately (4 s), so a wedged server makes only its part incomplete.

**Accounting.** A server's sessions are its children: `resources` and
`agent_procs` walk the process table from each session's pid, and the server is
its own row, found as the sessions' parent, never by name.

### `PaneLink::Lost` and Resume

`PaneLink` is `Live | Reconnecting | Lost`, sent on a pane's own channel. `Lost`
is not an exit: the pane stays, says its session is gone, and offers Close and,
for agents, **Resume**, always a human click. Resume is disabled with a reason
while the local server is Down, Failing, Starting or Stopping. It closes the dead
pane and reopens the agent through its surface:

- a surface with its own Resume on the embed (`TerminalEmbed.onResume`: an
  investigation, an AI review) is handed the click once the pane is gone, so the
  conversation resumes once and never without the click;
- an agent tab that is a `worktree_tabs` row (a worktree's, a review checkout's,
  a triage ticket's "+" tab) resumes in place through `useLostTabResume`: the
  layer holds its row (`holdRow`) through the gap so the conversation's binding
  survives, `check_tab_resume` refuses unless `tab_occupancy` is `Free` (a
  complete answer, no live pane on the key, no bound session running), and the
  tab relaunches on its stored session. A refusal releases the row, which closes
  like any closed pane's; the tab mounts no terminal meanwhile. Shell tabs offer
  no Resume;
- anything else (a pane no tab is showing) is opened the way the sidebar opens an
  agent with no live terminal (`useOpenAgent`).

**A pane does not wait forever.** A pane with no session after
`Timing::unbound_ttl` (45 s) is `Lost` and its queued launch line dropped. When
the supervisor gives up (`Down`, `Failing`), panes that never reached a session
are `Lost` at once, and `refuse_unbound` makes panes opened meanwhile `Lost` from
birth, so a later Start never types a line asked for long before. A line queued
across a link outage is typed only if the outage was under 45 s. Daedalus panes
keep waiting (docs/remote.md).

**"Terminals aren't responding".** After 10 s waiting on its host (reconnecting,
or an open or attach unanswered) a pane shows a hint pointing at Settings →
Terminal (local) or Settings → Daedalus. It reads only `PaneLink` state.

**Seeds.** `Terminals::seed_policy(id)` is `Spill` for local panes (a long launch
line goes to a private script, docs/terminals.md) and `Cap(2048)` for Daedalus. A
remote pane types a seed only into a session it opened. `write_pty` is the single
PTY-write path (COMPLIANCE.md).

### Setup runs

A worktree's `.santree/init.sh` run is a pane on the facade (`stream::RunHost`,
implemented by `terminal::TerminalRuns`, `Route::Local`): on a server build the
script runs in the server and survives a quit, a crash or an update; with
`Mode::Off` it ends with the app and QuitGuard counts it. `stream.rs` never
branches on the backend and writes nothing into the PTY.

- The host has no exit status (`pty.exitStatus` is not built), so a wrapper leaves
  the exit code in a status file in the worktree's git dir; no file is a failure.
- A run is labelled `run:<key>#<run-id>`, unique per run.
- The app that started a run streams it, can Stop and resize it, and stops it
  after 60 minutes.
- **Nothing tracks a run across a relaunch.** A script still going at quit keeps
  running on the server, unfollowed: its output and result go nowhere, and
  Settings → Terminal lists it and can stop it. While a live `run:<key>#*` pane
  exists a new run for that key is refused (`RunHost::any_live`), and so is one
  the server cannot answer about yet.

---

## Hooks: the stable `santree-hook` path

Agents outlive the bundle path, which the updater moves. After migrations on each
launch, `hook_bin::prepare` copies the bundled binary to
`<app_data>/bin/santree-hook` (`bundled_bin::install_copy`: temp file, 0755,
rename, only when the bytes differ, in a 0700 dir; a symlink at the target is
replaced, not followed). Every hook command, the status line and the review MCP
config name that path; if the copy failed they name the bundle path. A debug build
skips the copy.

**Freshness, not integrity.** A process of this uid can write `<app_data>/bin` as
it can write the bundle, so each time a path is about to be written into a hook
command, status line or MCP config, the copy is compared with the bundle and
healed. Nothing checks the bundle itself (the release asserts the shipped hook's
team and hardened runtime); a swap between two emissions stands until the next,
no worse than a swapped bundle.

**The tables `santree-hook` writes are a compatibility surface.** A running agent
may call an older hook against a newer schema, so migrations on `session_state`,
`session_usage_live`, `terminal_sessions`, `claude_rate_limits` or anything else
it writes are additive only.

---

## Environment

A server's sessions are children of a process with a minimal environment, so the
app forwards what they inherit:

- **`baseEnv`** (feature `pty.baseEnv`) is a property of the host's profile
  (`Profile::base_env`), read when the host opens a session: the app's environment
  after `hydrate_path`, minus the nested-session markers
  (`santree_pty::INHERITED_SESSION_MARKERS`) and the prefixes `SANTREE_`,
  `TAURI_`, `WEBKIT_`, `DYLD_`, `LD_`, sorted, non-UTF-8 dropped. Name-blind: what
  an in-app terminal inherits. Sent only to a host that names the feature; the
  server requires it (`require_base_env`) and refuses an open without it.
- **Secrets travel only in `env`**, built per open by `session_env(route, db,
  opts)`: the project env (`resolve_env`) for `Route::Local`; `TERM` plus
  `SANTREE_REPO`/`SANTREE_TERM_KEY` for a Daedalus agent. The host strips the
  markers from `baseEnv` and applies `env` over it, so a user's own value wins.
- **Daedalus's profile has no `baseEnv`**: this Mac's environment never reaches
  the box.
- `Debug` of `Spec`, `PtyOpenParams`, `OpenOpts` and host options prints names only.

---

## Server API

`hello.features` of a local server is `["pty.baseEnv", "pty.modes", "server.info",
"server.keepAwake", "server.stop"]`. Wire shapes are in docs/remote.md.

| | |
|---|---|
| `server.info` | `{version, revision, pid, startedAtMs, exe, liveSessions, clients}` |
| `server.keepAwake {on}` → `{active, supported}` | holds `caffeinate -d -i -w <server pid>` on macOS: the Mac stays awake while the server runs, not the app. Sent on each connect and when the setting changes |
| `server.stop {}` | answers first (`Extension::answered`), then closes every session and exits 0 |
| `pty.attach`, `pty.modes` | a `tail` replay may begin with a mode preamble (docs/remote.md) |
| `pty.sessions` | the whole table with `alive`: what adoption and liveness read |

The server serves no hooks (`Methods::PTY_ONLY`), so its `RemoteHost` runs with
`hooks: false`.

---

## The shared host crate

`crates/host` (`santree-host`) is protocol v1's host side: PTY sessions that
outlive their client, `exec.run`, `fs.*`, a hook queue. Embedders bring the
transport and admission: the local server (unix socket, PTYs only), the test
daemon (`santree-remote-client`'s `fake`, in memory, everything on, so client and
app tests run against production code), and later Daedalus's session host.

It decides once what the protocol leaves open: the attach response precedes that
attach's `pty.data`; attaching to an ended session answers, then sends `pty.exit`;
`pty.close` ends with `pty.exit` after the last output; a dropped connection or
`pty.detach` detaches only that connection's sessions; `hooks.subscribe` has one
subscriber, the newest.

- **Pacing.** A session whose receiver reads slower than it prints waits for the
  connection to drain (`Caps::pace_high`); only a receiver silent for
  `Caps::stall` (30 s) loses its link, and its sessions park.
- **Caps**: sessions, requests in flight, connections and blocking work per node,
  bytes queued, a session's input queue. The server allows 128 sessions and 16
  connections per node.
- **`Extension`** (`observe`, `handle`, `answered`): the embedder's own methods
  (the server's `ServerExt`).
- **Panics** answer `io` and leave other sessions alone, which is why the server
  is built with `panic = "unwind"`.
- **Contract** (AGENTS.md): `rust-version = "1.95"`; no `santree-core`, Tauri,
  specta, transport or crypto. `Host::pty()` exists only under `test-support`,
  which the server never enables, and `clippy.toml` forbids a write or spawn
  through the PTY table outside the `pty.write` and `pty.open` handlers.

---

## Build, bundle, sign, release

- **Build**: `cargo build --profile server -p santree-server` (`target/server/`).
  `[profile.server]` is `release` with `panic = "unwind"`: under the workspace's
  `abort`, one handler panic would end the process and every shell in it.
- **Stage**: `pnpm bundle:binaries` (run by `beforeDevCommand` and
  `beforeBuildCommand`) builds `santree-hook` and `santree-server` into
  `target/bundle-resources/`, lipo'd for `universal-apple-darwin`.
- **Declare**: the server is a macOS-only resource in
  `src-tauri/tauri.macos.conf.json`. tauri-build fails on a declared resource that
  is missing, so stage it before any macOS cargo build of `src-tauri` (ci.yml's
  cargo-only job stages both by hand).
- **Sign**: `scripts/sign-resources.mjs` (`beforeBundleCommand`) signs both
  hardened with a timestamp, the server as `com.santree.server` with no
  entitlements; a no-op without `APPLE_SIGNING_IDENTITY`. A new resource binary
  goes on its list.
- **Team**: release.yml derives `SANTREE_TEAM_ID` from the signing identity
  (asserted 10 chars of `[A-Z0-9]`). A wrong team ships a server that serves nobody.
- **Verify**: `scripts/verify-bundle-signatures.sh <santree.app> <TeamID>` checks
  both identifiers, the team's signature and the baked team, the hardened runtime
  on every slice, and none of the three injectable entitlements.
- **Smoke**: release.yml checks the bundled server's `version --json` against
  `REVISION` and the release version, launches the signed app under
  `SANTREE_SMOKE` (which starts no server, `server::smoke_enabled`, and checks the
  bundled binary, `server::smoke_assert`), then requires `pgrep -x santree-server`
  to find nothing.
- **Linux**: ci.yml asserts the deb carries `santree-hook` and not the server.

**The database is a compatibility surface.** sqlx refuses a database that recorded
a migration the binary lacks, so a beta that applies a migration cannot be rolled
back by reinstalling. Never edit or renumber a migration a beta has shipped.

---

## Dev workflow

```sh
pnpm dev                     # Mode::Off: in-app PTYs
SANTREE_SERVER=1 pnpm dev    # Mode::OptIn: a uid-only server in server-optin/
target/debug/santree-server version --json
target/debug/santree-server serve --run-dir /tmp/santree-dev/run --idle-initial-ms 1500
```

With the opt-in, quitting leaves agents running; stop them from Settings →
Terminal. Tests: `cargo test -p santree-host`, `cargo test -p santree-server` (the
real binary on a real socket, launched as the app does), and
`cargo test -p santree-server revision`. Hidden flags `--idle-grace-ms`,
`--idle-initial-ms`, `--reap-after-ms` and `--endpoint-check-ms` shorten timings.

---

## UX

- **State** (`crates/core/src/domain.rs`): `ServerState { Off | Starting |
  Stopping | Running{revision, version, pid, startedAtMs, liveSessions} |
  Down{reason} | Failing{reason} }` and `DrainingServer { revision, sessions:
  Known{count} | Unknown, pid, version }`, plain values, never toasts. Commands
  `server_status`, `server_start`, `server_restart`, `server_stop` (stays stopped
  until Start), `server_end_draining(revision)` (only a revision found draining),
  `quit_summary`, `terminal_inventory`; event `ServerStateChanged`.
- **One state view.** `serverStateView` (`src/lib/serverStatus.ts`) words the
  Settings card, the banner, the status-bar dot and the lost pane alike. The
  banner and dot speak at once for Down and Failing, and for Starting and
  Stopping only after 2 s (`useServerAttention`).
- **Settings → Terminal**: status, revision, version, uptime to the minute, pid,
  sessions by server; Restart, Stop, Open logs, Export logs; a row per draining
  server with End now; the orphans. Restart, Stop and End now confirm with what
  will end and are never optimistic.
- **Re-adoption**: `TerminalAdoption` adopts again when the state moves into
  `Running` and gives each adopted session whose surface can be named a tab
  (`adoptedTabs.ts`); an adopted id is spent by the one pane that attaches it.
- **QuitGuard** counts what quitting ends, `QuitSummary { terminalsEnd }`: live
  in-app sessions. With a server it is 0 and quitting never asks.
- **Diagnostics export** adds the server state, each `server.info`, refused and
  unreachable sockets, and the server log.

---

## Status

| Part | Where | Status |
|---|---|---|
| Protocol-v1 host: pacing, caps, `Extension`, `baseEnv`, `pty.modes` | `crates/host`, `crates/pty` | built |
| Server: lock, endpoint repair, ready socketpair, exit codes, flood limit, retirement, signals, logs, `server.*` | `crates/server` | built |
| `REVISION`, `revision.lock`, drift test | `crates/server` | built; revision 1 |
| Trust: `PeerTrust`/`Required`, peer signature both ways, launch and self checks | `crates/remote`, `crates/server/src/peer.rs`, `server/connector.rs` | built |
| `LocalServers`: layout, install, spawn, supervisor, discovery, draining, crash budget, pruning, keep-awake, diagnostics | `src-tauri/src/server/` | built |
| Facade, id counter, `RemoteTerminals` + `Profile`, adopt-all, `Liveness`, `PaneLink::Lost`, `session_env` | `src-tauri/src/sessions/` | built |
| Liveness consumers, `occupancy`, `tab_occupancy`, `check_tab_resume` (in-place Resume of worktree, review-checkout and triage "+" agent tabs) | `hooks.rs`, `session.rs`, `commands.rs`, `src/features/trees/useLostTabResume.tsx` | built |
| Stable hook path | `hook_bin.rs`, `bundled_bin.rs` | built |
| Setup runs as server panes (no tracking across a relaunch) | `stream.rs`, `worktree.rs`, `terminal.rs` | built |
| Frontend: lost pane and Resume, re-adoption, banner, dot, Settings card, not-responding hint, QuitGuard | `src/features/terminal/`, `src/components/shell/`, `src/features/settings/`, `src/lib/serverStatus.ts` | built |
| Bundling, signing, team bake, signature verification, smoke | `scripts/`, `.github/workflows/`, `tauri.macos.conf.json` | built; never run by a release |
| Daedalus session host on `santree-host` | daedalus engine | not built |
| `pty.exitStatus`, fd handoff, Mach probe, server on Linux | | not built |

## Known limits

- A second santree.app instance is admitted and can `pty.adopt` everything:
  session theft, not input. An app-instance lock is not built.
- A transient signature-check failure is a refusal: safe, not smooth.
- A `flock` lasts until its last fd copy closes, and a child the app spawns
  holds a copy of every open fd from its fork until its exec (close-on-exec acts
  at exec; `posix_spawn` too). So the app's shared probe can outlive itself by
  the length of an exec it overlapped, and a server launched in that moment
  finds its lock briefly held. Harmless: `take_lock` waits 200 ms, an exit 20
  with the lock free is retried once, and the app's children cannot make its
  probe read `Held`, since the app never holds the lock exclusively.
- A new revision drains beside the old one; there is no fd handoff.
- A setup run is not followed across a relaunch.
- After the crash budget, liveness stays incomplete until Start succeeds, so
  stored agent state is stale meanwhile.
- The same `term_key` in two projects collapses to one adopted tab.
- The sidebar reopen of an exited agent whose row is gone (`useReopenClosedTab`)
  depends on the worktree's sessions list, because `tabs::remove` deletes the
  binding. That is an exit, not a lost pane.
- Hook wrappers written before the stable path (an older global status-line
  capture, existing AI-review MCP configs) keep the bundle path until rewritten.
- Not built: `pty.exitStatus`, fd-handoff upgrades, a Mach-bootstrap health probe,
  a hardened-runtime flag check in `peer.rs`, the server on Linux.

## Unverified

Built and tested, but never run on a signed, notarized build. The first release
with the server is a **beta tag**; a stable tag follows only after this list is
walked on it, installed over an older build:

1. **Peer verification with the real team**: Settings → Terminal shows the server
   running at the expected revision; an agent-launched server exits 21; the
   server log has no refusals and the app log no `Untrusted`.
2. **Quit paths**: open an agent and a shell; ⌘Q, Dock quit and force-quit each
   leave them running, a relaunch re-adopts them with scrollback, and QuitGuard
   does not ask.
3. **An update leaves the server alone**: update with an agent running; it is
   still running, not resumed, and the server's uptime spans the update.
4. **TCC**: what a prompt says when an agent under the server touches
   `~/Documents`, whether grants survive an update, whether the spawn needs
   `responsibility_spawnattrs_setdisclaim` (the server runs from a copy outside
   the bundle because the updater deletes the old bundle).
5. **Keychain**: `claude` and `gh` reading their credentials in a server session.
6. **Logout** ends the sessions; the next login starts fresh and tabs offer Resume.
7. **Notarizing** the team-baked universal server.
8. **`SANTREE_SMOKE` on the signed app** with the server bundled, and the
   workflow's identity and smoke steps green.
9. **Quarantine xattrs** on the binary copied into app data.
10. **Setup runs**: a script survives a quit, is listed in Settings → Terminal,
    can be stopped there, and blocks a second run of its key until it ends.
11. **The `pty.modes` preamble** on a signed build.
12. **Linux**: an opted-in server has never run on a Linux host.

---

## Daedalus adopts `santree-host`

Daedalus's session host still runs its own protocol-v1 host. Moving onto the
shared crate needs, in the daedalus engine:

- **One rev bump** of `santree-pty`, `santree-remote-proto`, `santree-agent-kind`
  and `santree-remote-tls` with `santree-host` (`OpenOpts` gained `base_env`; its
  sinks are `Send + Sync`). It brings the `pty.modes` preamble to Daedalus panes.
  The `#[allow(clippy::disallowed_methods)]` attributes in those crates are inert
  there: the engine has no such `clippy.toml`.
- **Its embedder pieces**: the pinned TLS 1.3 transport, admission of its
  allow-listed machines at accept, confinement to the projects root,
  `workspaces.*` through an `Extension`, and `hooks.*`.
- **Upgrades that keep sessions**: a session host restart ends its panes today; it
  needs drain-beside-new by revision or an fd handoff.
- **Second-instance protection** and a **Mach-bootstrap health probe**.
