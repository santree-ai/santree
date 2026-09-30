# Daedalus projects (remote execution) in santree

The source of truth for how santree works on repos that live on the user's home
server, managed by **Daedalus**. Read this before touching `crates/remote/`,
`crates/remote-proto/`, `src-tauri/src/daedalus/`, or anything that dispatches on
`RepoLocation`.

---

## The shape, in one page

A **Daedalus project** is a registered repo whose checkout lives on the server
(`<projectsRoot>/<name>`, e.g. `/home/santiago/projects/web`). Everything that
touches it executes **on the server**: shells, agents, git, file reads, setup
scripts. santree on the Mac only draws.

santree never talks to the box itself. It talks to the **Daedalus agent**
installed on the same machine, which the box already knows (its node key,
approved in Daedalus › Settings › Machines):

```
santree app (Mac)
  └─ crates/remote ──unix socket──▶ Daedalus agent (same Mac; root)
                                      │ per connection: its own TLS 1.3 link,
                                      │ proving the node key, pinning the host's
                                      ▼
                        session host on the box (Daedalus runs it)
                          ├─ PtyManager from santree's own crates/pty (sessions outlive the link)
                          ├─ exec.run (argv, no shell) · fs.read/write/stat · workspaces.list
                          └─ hook queue  ◀── `<hookBin> hook <Event>` (Claude/Codex hooks there)
```

- santree has **nothing to configure**: no URL, no token, no ssh, no key. It finds
  the agent's socket at a fixed path. Whether this Mac may use santree at all is
  Daedalus's call — the per-machine `santree` switch in Settings › Machines.
- The session host is **not** shipped or launched by santree, and neither is the
  agent. A missing agent, santree switched off, or a host speaking another
  protocol version is a **state** santree shows, never a crash.
- The host is deliberately **thin**: primitives only. All santree logic (the git
  operations in `git.rs`/`worktree.rs`, hooks settings, prompts) stays in the app and
  runs *through* those primitives, so an app update almost never needs a host update.
- **Unreachable is normal** (the user is away from home without the VPN). Every read
  that asks "is Daedalus there" answers with a typed state as a plain `Ok` value —
  never an `Err`, which `lib/queryFailures.ts` would turn into a red toast. Daedalus
  surfaces disable with a hint instead of attempting and failing.
- **A Daedalus project never silently executes locally.** When the link is down, its
  actions are disabled; live remote panes read "reconnecting", never "exited".
- GitHub, Linear and Jira stay local to santree; only the checkout is remote.

## The transport: the Daedalus agent's socket

`crates/remote/src/agent.rs` (`AgentConnector`). One connect is:

1. **The socket**, at one fixed path per OS (overridable only in tests):
   `/Library/Application Support/daedalus-agent/run/santree.sock` on macOS,
   `/var/lib/daedalus-agent/run/santree.sock` on Linux. Not there → **no agent**;
   not there but the agent's own `agent.sock` beside it → **an agent too old** to
   serve santree. Refused (a stale file, nobody listening) → the agent isn't running.
2. **The other end is checked**: the kernel's peer credentials and the socket file's
   owner must both be root, who runs the agent — the same check every client of the
   agent's local socket makes. Anything else is refused as untrusted. macOS can't
   name a peer that has already closed, as the agent does right after a refusal;
   then the file's owner alone is checked, since nothing santree writes reaches a
   closed peer. The agent checks this side too: only root and the user who
   installed it may connect.
3. **One first line from the agent**, before santree writes anything (≤ 4 KiB,
   within 20 s — the agent answers within its own 15, its 10 s dial to the host
   included), read a byte at a time so nothing after it is taken:
   - `{"id":null,"ok":{"host":"<host:port>","node":"<node id>","agent":"<version>"}}`
     — from here on the socket is protocol v1 to the session host, raw, and the
     client speaks `hello` first;
   - `{"id":null,"err":{"code","msg"}}` and a closed socket — `santree_off`
     (Settings › Machines keeps it off), `host_key_changed` (the host proved
     another key than the box named), `unavailable` with the agent's reason (not
     paired, not approved, no session host, unreachable, TLS failed), and the
     agent door's own `forbidden` (this user may not use the socket) and `busy`
     (past four connections at once). An unknown code reads as `unavailable`.
4. **The host may still refuse the key after `ok`**: in TLS 1.3 the host judges the
   client's certificate after the client's flight, so a key its allow-list doesn't
   hold (yet — it re-reads it every second) shows as the stream ending before
   `hello` is answered: "can't reach", retried.

A failed connect is a `ConnectError` (`transport.rs`), a state, never an error. Those
only a person can change — no agent, an old agent, an untrusted socket,
`santree_off`, `host_key_changed`, `forbidden` — are `permanent()`. They, and a host
speaking another protocol, send the reconnect loop straight to its slowest pace
(30 s) instead of spinning, so turning santree on in Daedalus connects within 30 s,
or at once with "Run check". Everything else backs off 1 s → 30 s. On every
reconnect the client re-sends `hello`, re-subscribes to hooks after the last acked
seq, and emits a reconnected event so terminals re-attach through their ring
anchors.

## States and settings

- `DaedalusLink` (what `daedalus_status` returns, pushed by `DaedalusLinkChanged`):
  `AgentMissing | AgentOutdated | Connecting | SantreeOff |
  HostKeyChanged { reason } | Unavailable { reason } | VersionMismatch { theirs } |
  Connected { hostname, version, projectsRoot, agent }`. `forbidden`, `busy`, an
  untrusted socket, a host that ends the stream before `hello` and every local
  failure are `Unavailable` with the reason; `src/lib/daedalusLink.ts` holds the one
  wording of each state and what to do about it.
- `daedalus_health` is "Run check": skip the backoff, try now, and answer the state
  the attempt settled on (`DaedalusHealth { link, checkedAt }`).
- Settings › Daedalus is one status card — the state, what to do, and for a
  connected link the box, the session host's and agent's versions and the projects
  root — plus "Run check". There is nothing to fill in.
- `daedalus_workspaces` lists the checkouts over the link (`workspaces.list`), each
  marked with whether it is registered; empty, with the link state saying why,
  whenever the host can't list — `hostOutdated` when it is connected but predates
  `workspaces.list` (`hello`'s `features`). `add_daedalus_repo(name)` re-reads that
  list and registers the named checkout; the path and remote are the host's, never
  IPC's.
- `repos.location` is `'local'` (default) or `'daedalus'`; it ships as
  `Repo.location: RepoLocation`. A Daedalus repo's `path` is the absolute path **on
  the server**. Never `canonicalize`, `is_dir` or read it locally.
- `daedalus_connection` (one row, written with the first ack) holds only where the
  app is in the host's hook queue: `hook_cursor` and `boot_id` (see "How santree
  dispatches").

## Protocol v1 (the contract with the session host)

Newline-delimited JSON, one object per line, both directions. Binary data is base64
(standard alphabet, padded).

- Request `{"id":<u64>,"m":"<method>","p":{…}}`
- Response `{"id":<u64>,"ok":<result>}` or
  `{"id":<u64>,"err":{"code":"<string>","msg":"<string>"}}`
- Event (server → client) `{"e":"<name>","p":{…}}`
- Requests run concurrently; responses may arrive out of order. The server sends
  `{"e":"ping"}` every 15s. Error codes: `bad_request`, `not_found`, `outside`, `io`,
  `timeout`, `version`.

`hello` (first request):
`{"protocol":1,"client":"santree/<ver>","owner":"<client instance id>"}` →
`{"protocol":1,"version","hostname","user","home","bootId","projectsRoot","hookBin","features"}`.
`bootId` is random per
session host start: hook `seq` restarts at 1 with each boot, so a client whose stored
`bootId` differs resets its hook cursor to 0. Unsupported protocol → error `version`,
connection kept open. `owner` is minted once per app process (the link outlives page
reloads); a PTY session's own `owner` is the webview's page owner, as locally.
`projectsRoot` is the absolute root the checkouts live under; `hookBin` the absolute
path an agent's hook command runs (`<hookBin> hook <args>`), stable across host
updates; `features` the wire names of the optional methods the host serves
(`["workspaces.list"]`) — a client checks it (`HelloResult::supports`) and shows
"session host too old" rather than calling a missing one. All three are required.

PTY (session info = `{id,pid,cwd,command,owner,label,agentKind,cols,rows,attached,
alive,epoch}`, `agentKind` ∈ `"Claude"|"Codex"|"Cursor"|"Opencode"|null`):

| method | params | result |
|---|---|---|
| `pty.open` | `{cwd?,command,args,cols,rows,env:[[k,v]…],owner,label,agentKind?}` | info (empty `command` = login shell) |
| `pty.attach` | `{id, anchor: {"at":{"epoch","seq"}} \| "fresh" \| "unknown"}` | `{mode:"exact"\|"tail"\|"reanchor",epoch,seq,data}` |
| `pty.detach` | `{id}` | `{}` |
| `pty.write` | `{id,data}` | `{}` |
| `pty.resize` | `{id,cols,rows}` | `{}` |
| `pty.close` | `{id}` | `{}` (kills it) |
| `pty.sessions` | `{}` | `[info]` |
| `pty.adopt` | `{owner}` | `[info]` (`adopt_others`) |

Events `pty.data {id,data}` and `pty.exit {id}`. The attach response precedes that
session's first `pty.data`; replay and live never overlap or gap. One receiver per
session (a newer attach replaces the older). A dropped connection detaches, never
closes.

Exec / files / hooks:

| method | params | result |
|---|---|---|
| `exec.run` | `{cwd,argv,env?,stdin?,timeoutMs?}` | `{code,signal?,stdout,stderr,truncated}` (always `GIT_OPTIONAL_LOCKS=0`; 60s default, 10 min max) |
| `fs.read` | `{path,offset?,len?,within?}` | `{data,size,eof}` (len ≤ 8 MiB; negative offset = from end; `within` → real path must stay under it, else `outside`) |
| `fs.write` | `{path,data,mode?}` | `{}` (atomic, creates parents) |
| `fs.stat` | `{path}` | `{exists,kind:"file"\|"dir"\|"symlink"\|"other",size,mtimeMs}` (lstat) |
| `hooks.push` | `{event,env,stdin}` | `{seq}` (used by the hook subcommand) |
| `hooks.subscribe` | `{after?}` | `{}` then events `hook {seq,at,event,env,stdin}` |
| `hooks.ack` | `{upTo}` | `{}` |

`hooks.dropped {count}` is sent when the in-memory queue (10k) overflows.

Features (served only when `hello`'s `features` names them):

| method | params | result |
|---|---|---|
| `workspaces.list` | `{}` | `{root,generatedAt,workspaces:[{name,path,remote,branch,head,headAt,dirty,ahead,behind,sync}]}` |

`root` is `projectsRoot`; `path` is `<root>/<name>`, `name` one plain component. Every
optional is written as `null`, never omitted: `generatedAt` (RFC 3339; `null` = no
snapshot yet, with an empty list), `remote`/`branch`/`head`/`headAt`, `ahead`/`behind`
(`null` with no upstream) and `sync` (`{result,detail,at}`, `null` before the host's
first sync of that checkout).

### The agent ↔ session host link

santree never sees it. The agent opens it per santree connection: TLS 1.3, both
ends proving ed25519 keys (the agent the machine's node key, the host its own),
the agent pinning the host key the box named in the machine's policy and the host
admitting only the keys on its allow-list (approved machines with santree on). The
host builds its side from `crates/remote-tls` (`santree-remote-tls`, below); the
agent uses its own rustls client, and the engine's `session-host/interop` tests
prove the two meet. santree does not depend on `santree-remote-tls`.

## How santree dispatches (app side)

- `crates/remote` (package `santree-remote-client`, Tauri-agnostic like
  `crates/pty`) is transport + client only (`agent`, `transport`, `client`, `host`, over the
  protocol types in `crates/remote-proto`):
  it knows nothing about repos. Its `fake` module (behind the `fake` feature, for
  tests) is an in-process daemon
  speaking the same protocol, backed by a real `PtyManager`, so the client and every
  dispatch path are tested without a box.
- **One seam: `git::Checkout`** (`src-tauri/src/git/checkout.rs`) — a directory (a
  repo root or a worktree) and where it lives. Every `git.rs` function takes one,
  so each git operation is written once: `Checkout::git_with` (and `git`, the plain
  case) is the one place a git process starts — a child process here, or
  `exec.run {cwd, argv: ["git", …], env, stdin, timeoutMs: 10 min}` on the box,
  since a local git has no deadline and a push must not hit the host's one-minute
  default. `read` is `open_in_worktree` or `fs.read` with `within` = the checkout
  (the host's symlink check), `contained` is `safe_real_path` or a zero-length
  `fs.read` with `within`, `is_dir`/`stat` are a stat or `fs.stat`, `write` is
  `std::fs` or `fs.write`, and the two deletes the protocol has no method for —
  `remove` (a tree, symlinks unlinked, never followed) and `remove_empty_dir` —
  are `std::fs` or `exec.run` of `rm -rf --` / `rmdir --` in the checkout, on an
  absolute, non-climbing path. IPC paths pass the lexical `safe_path` here before
  anything is sent. Output cut at the host's cap is an error, never a parsed
  half-answer; a failing git's stderr is the error, as it is locally. The remote
  half is blocking (`RemoteClient::call_blocking`), like the processes it stands
  in for: git code runs on the blocking pool.
- **Resolved in one place**: `repo::checkout(db, daedalus, name)` answers a local
  checkout, or a Daedalus one over the live client (waiting ≤5 s for a link that
  is still connecting); with the link down it is the error saying so
  (`NotConnected`), never a fall back to this machine. `worktree::root` is that for
  a repo's root, and `worktree::locate` builds a worktree's checkout from it
  (`Checkout::at`). Everything done to a worktree goes through them, reads and
  writes alike: the reads (`list`, `base_worktree`, `status`, `file_diff`,
  `file_source`, `branch_changes`, `branch_file_diff`, `files`, `branches`), the
  commit box (`stage`, `unstage`, `discard`, `stage_all`, `unstage_all`, `commit`
  under `with_index_lock` as locally, and `commit_message`'s staged diff), the sync
  buttons (`push`, `pull`, `pull_remote`, `update_base`), `worktree::create` /
  `remove` (given the resolved root), the split (`split_stack`), PR creation
  (`pr::draft`/`create`: the push, the first commit's subject, the diff and the
  template read through the checkout; GitHub asked from here) and the merge queue
  (the slug read on the box).
- **Worktrees on the box** keep the local layout: `<root>/.santree/worktrees/<id>`.
  `santree_dir::ensure` writes `.santree/.gitignore` through the checkout
  (`fs.write`), `git worktree add` makes the directory and its parents itself, a
  tree is adopted when git says it is its own top level (`rev-parse --show-prefix`
  is empty — asked of git, so no path is canonicalized on the wrong machine), an
  empty leftover is reclaimed with `remove_empty_dir`, and removal is
  `git worktree remove --force` then `remove` for whatever is left.
- **A split on the box**: `git/split.rs` runs every step through the checkout. Its
  private index is a file in the checkout's own git dir
  (`rev-parse --path-format=absolute --git-path santree-split-<uuid>.index`, set as
  `GIT_INDEX_FILE`) — never in the working tree it is snapshotting, always beside
  the git that writes it — and is removed, with any `.lock`, when the step ends.
  Pathspec lists go on stdin. The recovery stash is as it was.
- **Helpers stay here**: a commit message or PR body is drafted by the configured
  helper on this Mac, fed the diff read through the checkout. For a Daedalus
  worktree it runs in an empty scratch directory (`agent::HelperDir`) with no
  `Read` grant, so nothing it does reaches the box.
- **Terminals on the box** — see "Terminals and setup scripts on the box" below.
- **Agents on the box** — see "Agents on the box" below.
- **Still local-only, and refusing a Daedalus repo**: session history (the
  Session history pane reads this Mac's transcripts through `local_worktree`;
  a Daedalus project's shows "coming soon") and the AI review (`agent_session`
  refuses the review surfaces). The UI says so per kind of action
  (`lib/daedalusLink`): `gitOff` and `runOff` turn git actions, terminals and
  setup scripts off while the link is down ("Unavailable until santree can reach
  Daedalus"); `agentOff(kind)` does the same for agents, and also turns off one
  whose CLI the box doesn't have ("Codex isn't installed on Daedalus") — the "+"
  menu's agent rows, the project pickers that start one, a ticket's worktree
  (made, but its agent not started).
- **Reads wait for the link**: a Daedalus project's worktree reads are `enabled`
  only while the link is `Connected` (`useRepoReach` / `useReadableRepos` in
  `lib/queries.ts`), so a down link never fails a read into a toast; the sidebar
  greys and says why, and the workspace shows the link's state when it has nothing
  read yet.
- Hooks: agents on the server are launched with a settings file santree writes there
  via `fs.write` (Codex: `-c` flags), whose hook commands are `<hookBin> hook <args>`
  (`hookBin` from `hello`; `hooks::box_prefix`). The relayed
  `event` is those args, space-joined — exactly what follows `--db <path>` in the
  local `santree-hook` command (`SessionStart`, `--agent-kind Codex SessionStart`,
  `statusline`), parsed by the binary's own `parse_args`. `statusline` records only
  (the bar renders on the server, so `--then` never needs relaying); `mcp` is
  refused. The env pairs carry `SANTREE_REPO`/`SANTREE_TERM_KEY` as the local hook
  reads them from its process env, and may only bind a Daedalus project's terminal.
  The server is not trusted like the local binary: an event whose terminal key
  fails `tabs::validate_term_key`, whose `session_id` isn't a hyphenated UUID
  (`session::is_session_id` — Claude's and Codex's ids both are), or whose session
  is bound in `terminal_sessions` to a project that isn't a Daedalus one, is
  refused — logged and acked, never applied. `session_state` is keyed by session id
  alone, so without that last check a relayed event could rewrite a local agent's
  row. The payload's `transcript_path` is dropped before applying: the app reads a
  stored transcript path from local disk, and a server path names nothing here.
  Relayed text reaches the app's log `Debug`-quoted and capped.
  The app (`daedalus/host.rs` `Relay`) applies each event with `santree_hook::apply`
  over its own pool — the same code path as the binary — emits the same events the
  signal socket would, then acks the batch (≤256) and saves `(hook_cursor, boot_id)`
  in `daedalus_connection`, so a restart resumes after it. A failing event is logged
  (and noted in `santree-hook-errors.log`) and acked anyway; `hooks.dropped` is a
  warning. Each delivery is tagged with its boot, and an ack for a boot the daemon
  has since left is refused, never applied to the new boot's seqs.
- Which agent is running: `ps -axo pid=,ppid=,pcpu=,rss=,stat=,command=` via
  `exec.run`, parsed by the existing `proc_table` parser (see "Agents on the box").
- Worktree changes: polled, not watched — `useWorktreeWatcher(repo, tree)` re-reads
  the worktree on screen every 4 s through the watcher's own single-flight
  invalidation, while the link is up and the window visible.
- Stays local: GitHub (`gh`, by repo slug — PR status reads the slug from the
  checkout on the box, then asks GitHub from here), Linear/Jira. **AI review is
  disabled for Daedalus projects** (its MCP draft tools would need a relay).

## Terminals and setup scripts on the box

A terminal in a Daedalus project is a PTY on the box (`pty.open` in the
checkout, which the host confines under `projectsRoot`), drawn by the same
terminal layer as a local one — docs/terminals.md, "Remote sessions", has the
pane's side. `terminal.rs` dispatches: a cwd inside a Daedalus project
(`repo::daedalus_repo_at`, absolute and never climbing) goes to
`daedalus/terminals.rs`, every other id and command stays on `PtyManager`.

- **Ids.** A remote pane gets an app-side id from `terminals::FIRST_ID` (2³¹) up
  — a range `PtyManager` never reaches — so `write`/`resize`/`close`/`attach`/
  `detach` dispatch on the id alone. The box's own session id is bound to the
  pane once it is opened or found.
- **Anchors.** Every byte forwarded advances the pane's anchor; `pty.attach`
  resumes from it and the box's ring answers `exact|tail|reanchor` exactly as
  the local ring does. The frontend's own `terminal_attach` (a remount, a
  reload) passes its anchor through.
- **A dropped link is not an exit.** The route closing without `pty.exit` leaves
  the pane `Reconnecting` (a `PaneLink` on its own channel beside the bytes); on
  every `Reconnected` each waiting pane re-attaches from its anchor, so the box
  replays exactly what it missed. Only `pty.exit`, or an attach the box answers
  `not_found` (it restarted and lost the session), ends a pane. Keystrokes are
  tagged with the attach they were typed at and dropped while the pane can't
  reach its session — never replayed later into whatever runs by then. They go
  through one writer per pane, in order; the grid follows on the next attach.
- **santree quitting.** The PTY stays on the box. A pane with no session bound
  — after a relaunch, or opened while the link was down — first looks for a
  live one with its own address (label and provider, `pty.sessions`, one no
  other pane holds) and attaches to it from `fresh`, replaying the box's ring;
  only when there is none does it `pty.open`. A seed is typed only into a
  session the pane opened itself. A webview reload hands panes over through
  `terminal_adopt` like local ones: they live in the app process beside the
  link. `pty.adopt` is not used — the app-side registry is the reload hand-over,
  and a relaunch finds sessions by address, which also works when the link is
  down at launch (adoption at page load can't wait for it).
- **Closing** is `pty.close`; with the link down the pane waits and closes on
  the next connect (finding its session by address if it never bound one). A
  tab closed while the link is down and never reconnected before santree quits
  leaves its session running on the box.
- **Environment.** A remote pane gets `TERM` and nothing else from this Mac
  (`terminal::remote_env`). `env::resolve_env` is this Mac's project
  environment — values from this Mac's keychain and `.env` files read from this
  Mac's disk — and none of it is the box's to have; the shell there is the
  box's login shell under the session host, which runs with the operator's
  profile `PATH`, and the box's own profile is where a Daedalus project's
  environment belongs. santree's `SANTREE_*` keys are per launch and added by
  what launches: a setup run's two, and an agent pane's `SANTREE_REPO` /
  `SANTREE_TERM_KEY` (the project owning the cwd, and the pane's validated
  term key).
- **Untrusted bytes** (design S5): the pane's renderer is built untrusted —
  OSC 52 (clipboard writes) swallowed, OSC 8 links opened only as `http(s)`,
  remote text never rendered as HTML. The frontend decides it from the pane's
  cwd before the first byte (`lib/daedalusLink` `onDaedalus`, the backend's
  `on_daedalus`), which is why the terminal layer waits for the repo registry.
- **Setup scripts** (`worktree::run_setup_streamed` → `daedalus/setup.rs`):
  `.santree/init.sh` in a PTY on the box, `bash -lc` around it in the worktree
  there, env `TERM` + `SANTREE_WORKTREE_PATH` + `SANTREE_REPO_ROOT`, streamed
  to the same read-only pane as `StreamEvent`s. The run re-attaches from its
  anchor across a dropped link. `pty.exit` carries no status, so the wrapper
  writes the script's exit code to a file in the worktree's git dir
  (`rev-parse --git-path santree-setup-<uuid>.status`, like the split's index),
  read back and removed once the process is gone; no file (stopped, killed) is
  a failure. Stop is `pty.close` (queued while the link is down), resize
  `pty.resize`, removing the worktree stops it, and a 60-minute backstop closes
  a run that never ends. Quitting santree leaves a running script to finish on
  the box; nothing records it.
- **Compliance**: remote bytes enter a PTY only through `terminal.rs`'s
  `write_pty` → the pane's one writer (`pty.write`), pinned by
  `only_the_terminal_adapter_writes_bytes_into_a_pty`.

## Agents on the box

A Claude or Codex tab in a Daedalus project is the local launch, run on the box:
the same `agent_session` resolution, the same seed (`agentSessionSeed`), the
same work and investigate prompts — typed into a remote pane
(`terminal_open` with an `agentKind`, "Terminals and setup scripts on the box").
What the launch names lives on the box too (`daedalus/agents.rs`):

- **santree's files there** go in `santree/` inside the checkout's common git
  dir (`rev-parse --path-format=absolute --git-common-dir`, `agents::santree_dir`):
  under `projectsRoot` (the host's `fs.write` confinement), never in a working
  tree's `git status`, beside the split's index and the setup's status file.
  - `claude-hooks.json` / `claude-hooks-fixci.json`: `hooks::hook_settings`
    (the session-state hooks + the status line; the Fix-CI deny list) with
    every command `'<hookBin>' hook <args>`; Codex's `-c 'hooks.<Event>=…'`
    flags the same way. Written by `daedalus_agent_hooks(repo)`, which
    `useHookInjection({ repo })` asks in place of this Mac's
    `claude_hook_settings` / `codex_hook_flags` — a launch holds until it has
    them, and never takes this Mac's paths meanwhile. No English tutor on the
    box: its instruction and practice log are this Mac's files. The status line
    runs on the box and records only.
  - `prompts/<repo-key>/<id>.md` (and `.investigate.md` + its extracted
    images): `work_prompt` / `investigate_prompt` render through
    `prompts::resolve_sources_at`, whose project layer is the box's
    `.santree/prompts/*.njk` (listed with `Checkout::list_files` — `find` on
    the box — and read with `within` = the checkout), and write through
    `Checkout::write`. The ticket itself is still fetched here.
- **Resolution** (`agents::resolve_session`, from `agent_session` for a
  Daedalus repo): the cwd and the stored paths are the box's, checked as
  stored (absolute, never climbing), never canonicalized here. The executable
  is the plain `claude` / `codex` the box's shell finds — this Mac's exec
  override names nothing there. A stored session resumes while its record is
  on the box: Claude's transcript `fs.stat`ed at
  `<home>/.claude/projects/<escaped cwd>/<id>.jsonl`, Codex's rollout found
  under `<home>/.codex/sessions` (`find -name 'rollout-*-<id>.jsonl'`; the
  box's `CODEX_HOME` is not read). Codex's `--add-dir` is the box's git dir,
  and its `-c` overrides are checked by the box's own `codex exec
  --strict-config`. The AI review surfaces are refused.
- **Which CLIs the box has**: `bash -lc 'command -v …' claude codex` in
  `projectsRoot` — the login shell's `PATH`, which is what a pane's seed meets —
  cached for a minute per session-host boot (`BoxAgents::clis`,
  `daedalus_agent_clis`). The menus disable a missing one with "… isn't
  installed on Daedalus", and a launch of one is refused with the same words.
  `None` (no link, a failed probe) gates nothing: the launch says so if it must.
- **Seeds**: the box's tty is Linux's (`N_TTY_BUF_SIZE` 4096), so a remote seed
  may be up to 2048 bytes (`MAX_REMOTE_SEED_LINE`) — a Codex launch's six hook
  flags fit — and one past it is refused, never truncated or spilled.
- **Detection** (`BoxAgents::detect`, merged into `agent_processes`): for each
  remote agent pane bound to a session, its root pid from `pty.sessions`, the
  box's process table from `exec.run ps -axo …` in `projectsRoot` (bounded to
  3 s, cached 500 ms, a failure cached too) parsed by `proc_table::parse_ps`,
  and `agent_procs::attribute` — the same foreground walk. The frontend polls
  it while panes are open. Identity only, as locally.
- **Liveness**: `session_states` counts a remote pane as live until it ends
  (`RemoteTerminals::live`), a dropped link included; a remote pane's exit
  sentinel retires its session rows like a local one's.
- **Session history** stays "coming soon" for Daedalus projects: its
  transcripts are on the box, and reading them there (`fs.read` with `within`)
  is the next step.

## Code map

`crates/remote-proto` (package `santree-remote-proto`) — protocol v1 as types: one
marker per method in `m` (`Method` ties the wire name to params and result), the
frames, events, error codes, base64 helpers. Its tests pin the exact wire text;
changing one is a protocol change. `AgentKind` comes from `crates/agent-kind`
(package `santree-agent-kind`).

`crates/remote-tls` (package `santree-remote-tls`) — the session host's TLS
profile: `Identity`, the self-signed certificate (a small DER writer),
`client_config` / `server_config` and their pinning verifiers, `connect` / `accept`
(tokio-rustls), `peer_key`, `fingerprint`, `Refusal`. TLS 1.3 and ED25519 only,
ring's provider passed explicitly, no resumption. Its tests run real handshakes over
an in-memory duplex. santree itself doesn't link it.

These, and `crates/pty`, are the crates the host side shares: the daedalus
engine depends on them by git rev, so none of them depends on `santree-core`, Tauri
or (by default) specta, and their public APIs are a contract with that repo.

`crates/remote` (package `santree-remote-client`), which re-exports
`santree-remote-proto` as `proto`:

- `agent.rs` — `AgentConnector`: the socket path per OS, the root peer check, the
  first line (`AgentOk` or a refusal).
- `transport.rs` — the `Connector` seam, `Link`, `ConnectError` / `Refusal` and
  `permanent()`, `memory_link()`.
- `client.rs` — `RemoteClient`: framing (32 MiB line cap), concurrent calls, event
  routing (per-session receivers from `pty_attach`, one hooks receiver), link death
  after 45s of silence, `call_blocking` for sync callers.
- `host.rs` — `RemoteHost`: its connector, `hello` (kept for `features`), the
  `HostStatus` watch, backoff (the slow end at once for a permanent refusal), the
  hooks subscription carried across links (boot-tagged `HookDelivery`s, the cursor
  reset on a new `bootId`), the `Reconnected` broadcast.
- `fake.rs` (feature `fake`) — the in-process daemon (a random `bootId` per
  instance; `FakeDaemon::connector()` plugs it into a `RemoteHost` over memory), and
  `FakeAgent`, a unix socket that writes the agent's first line and then hands the
  connection to a `FakeDaemon` — what the connector and the app's health,
  workspace and git tests connect through. `FakeDaemon::exec_log()` is the argv of
  every `exec.run` it served, so a test can say what ran on the "box".

`src-tauri/src/daedalus/` (also `agents.rs`: "Agents on the box"; its tests,
`agent_tests.rs`, run the launch, the relay, detection and the prompts over the
fake agent and daemon, whose `FakeOptions::env` gives the fake box a home and
`PATH` of its own):

- `host.rs` — `DaedalusHost` (Tauri-managed): the one `RemoteHost` over the
  `AgentConnector`, started once with the saved hook cursor (`resume`);
  `state()` / `settled()` → `DaedalusLink`; `retry_now()`; `client()` /
  `client_within(wait)` (≤5 s while `Connecting`, `CONNECT_WAIT`) →
  `Result<Arc<RemoteClient>, NotConnected>`; the `DaedalusLinkChanged` event; the
  hook `Relay`.
- `terminals.rs` — `RemoteTerminals`: the remote panes (ids, anchors, the
  re-attach on `Reconnected`, finding a session again by address, the per-pane
  writer). Owned by `DaedalusHost`, started by `resume`.
- `setup.rs` — `RemoteRuns`: setup scripts in a PTY on the box, keyed like
  `stream::RUNS`.
- `mod.rs` — the health check, `workspaces.list` over the link, and registering a
  checkout. `git_tests.rs` drives a Daedalus project's git end to end: the
  worktree commands through a `FakeAgent` and `FakeDaemon` to real git in a temp
  repo — reads, the commit box, push and pull against a local bare origin,
  worktree create/remove, a split — and the link-down case running nothing.
  `terminal_tests.rs` does the same for terminals and setup: open, type, read,
  resize, detach and an exact re-attach, a dropped link (reconnecting, then
  caught up once, the same process), santree restarting (the session found
  again, its seed not retyped), setup runs (success, failure, resize, a drop,
  Stop), and the link-down case opening nothing on either machine.

`src-tauri/src/git/checkout.rs` — `Checkout`, the seam (above); `repo::checkout`
resolves one.

`crates/hook` is a library plus a one-line binary: `santree_hook::apply` is the
binary's hook and status-line modes over a caller's connection.

Wire details the tables above leave open, as the client and fake implement them
(a daemon should match): `env` is `[[k,v]…]` everywhere; `hooks.push`'s `stdin` and
`hook`'s `stdin` are base64; `hook.at` is Unix ms; `exec.run` past its timeout is a
`timeout` error (process killed), and `code` is `null` when a signal ended it;
`fs.stat` of a missing path is `{exists:false,kind:null,size:0,mtimeMs:0}`; `fs.read`
clamps `len` to 8 MiB and requires absolute paths; a `version` error may carry
`"protocol":<n>`, the version the daemon speaks; attaching to a session whose process
already ended answers, then sends `pty.exit`; `pty.detach` and a dropped connection
only detach sessions that connection is the receiver of; the newest
`hooks.subscribe` is the only subscriber, and its backlog follows its response.
