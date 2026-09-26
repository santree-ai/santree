# Daedalus projects (remote execution) in santree

The source of truth for how santree works on repos that live on the user's home
server, managed by **Daedalus**. Read this before touching `src-tauri/src/remote/`,
`crates/remote/`, `src-tauri/src/daedalus/`, or anything that dispatches on
`RepoLocation`.

---

## The shape, in one page

A **Daedalus project** is a registered repo whose checkout lives on the server
(`<projectsRoot>/<name>`, e.g. `/home/santiago/projects/web`). Everything that
touches it executes **on the server**: shells, agents, git, file reads, setup
scripts. santree on the Mac only draws.

```
santree app (Mac)
  ├─ daedalus/   REST: GET <url>/api/santree/{connection,workspaces}  (bearer token)
  └─ crates/remote  ssh <user>@<host> santree-remote connect   (one long-lived process)
                    │  stdio = newline-delimited JSON, protocol v1 (below)
                    ▼
server: `santree-remote serve`  (always-on service, owned by the daedalus repo)
          ├─ PtyManager from santree's own crates/pty (sessions outlive the link)
          ├─ exec.run (argv, no shell) · fs.read/write/stat
          └─ hook queue  ◀── `santree-remote hook <Event>` (Claude/Codex hooks there)
```

- The daemon is **not** shipped or launched by santree. Daedalus builds and runs it.
  santree only connects. A daemon that isn't there, or speaks another protocol
  version, is a **state** santree shows, never a crash.
- The daemon is deliberately **thin**: primitives only. All santree logic (the git
  operations in `git.rs`/`worktree.rs`, hooks settings, prompts) stays in the app and
  runs *through* those primitives, so an app update almost never needs a daemon update.
- **Unreachable is normal** (the user is away from home without the VPN). Every read
  that asks "is Daedalus there" answers with a typed state as a plain `Ok` value —
  never an `Err`, which `lib/queryFailures.ts` would turn into a red toast. Daedalus
  surfaces disable with a hint instead of attempting and failing.
- **A Daedalus project never silently executes locally.** When the link is down, its
  actions are disabled; live remote panes read "reconnecting", never "exited".

## Configuration and reachability

- `daedalus_connection` (one row): the Daedalus URL, plus the connection info last
  fetched from `GET /api/santree/connection` (`{sshUser, sshHost, sshPort,
  projectsRoot}`), plus an optional user-set identity file. The API token lives in
  the OS keychain (service `com.santree.desktop`, account `daedalus`), never in
  SQLite.
- The token rides every request, so the URL must be `https` — except to a host on
  the user's own network, judged on the parsed host (`api.rs`
  `plain_http_allowed`): loopback, a private or link-local IP literal (10/8,
  172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10), `localhost`, a `.local`
  name, or a single-label name. A blank token on Connect reuses the saved one only
  when the new URL has the saved one's scheme, host and port; a new server gets
  its token typed again.
- **Daedalus owns the connection details.** The user sets exactly three things:
  the URL, the token and the identity file (a private key path on the Mac).
  `sshUser`/`sshHost`/`sshPort`/`projectsRoot` are shown read-only, and no command
  writes them except the refresh from the API. A missing `sshPort` is 22.
- **One address.** `sshHost` is a split-horizon name: the home Pi-hole answers it
  with the server's LAN IP (at home, and over the VPN, whose DNS is that Pi-hole),
  and public DNS with the public IP. Over the VPN, packets for the LAN IP land in
  wg-easy's rootless network namespace rather than on the host, so the server
  DNATs port 22 on the tunnel to sshd; that rule is what lets the one name reach
  sshd from both places. santree therefore tries one target, never a list.
- `repos.location` is `'local'` (default) or `'daedalus'`; it ships as
  `Repo.location: RepoLocation`. A Daedalus repo's `path` is the absolute path **on
  the server**. Never `canonicalize`, `is_dir` or read it locally.
- `DaedalusReach` (what `daedalus_status` returns — the REST side only):
  `NotConfigured | ApiUnreachable { reason } | Unauthorized | ApiReachable`.
- `DaemonReach` (what `daedalus_daemon_status` returns — the ssh/daemon side):
  `NotConfigured | Connecting | Connected { version } |
  Unreachable { reason } | VersionMismatch { theirs }`. The two are separate because
  "Daedalus answers but the daemon doesn't" and "nothing answers" need different hints.
- `DaedalusHealth` (what `daedalus_health` returns — the card's one status surface):
  each stage in order, `api` → `ssh` → `daemon`, with a stage an earlier failure
  makes moot reading `Skipped { reason }`. ssh is `Ok { target }` or
  `Failed { reason, target }`, `target` being the `user@host` it tried; it needs
  only the cached connection info, never a live API. The ssh stage is `ssh_probe` (`crates/remote/src/probe.rs`):
  the link's own argv running
  `command -v santree-remote >/dev/null 2>&1 && santree-remote --version || echo __santree_remote_missing__`,
  8s — the marker is `NotInstalled`. An installed daemon is then
  judged by the live link (`NotRunning { reason }` when `connect` can't complete).
  Settings runs it on open, on "Run check" and after a connect; the santree-remote
  row follows `DaemonReach` from then on, and never toasts.
- The VPN setting in the card is a disabled toggle with a WIP badge: santree does not
  run its own WireGuard tunnel yet. Until it does, the Mac must be on the home network
  or on the system VPN.

## SSH transport

System `ssh` (the user's keys, agent and config keep working), spawned once per
connection:

```
ssh -T -o BatchMode=yes -o ConnectTimeout=4
    -o ControlMaster=auto -o ControlPath=<app_data>/ssh/cm-%C -o ControlPersist=300
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    -o HostKeyAlias=santree-daedalus -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="<app_data>/ssh/known_hosts ~/.ssh/known_hosts"
    -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes
    -o PermitLocalCommand=no
    [-i <identity_file> -o IdentitiesOnly=yes] -p <port> <user>@<host>
    santree-remote connect
```

- `<user>` and `<host>` come from Daedalus's API, so they are allow-listed before
  they reach the argv: a user is letters, digits, `.`, `_`, `-`; a host is
  letters, digits, `.`, `-`, `:` (an IPv6 literal, unbracketed); neither may be
  empty or start with `-`. Anything else fails the attempt with a reason.
- No forwarding: the link needs only its stdio, so whatever the user's ssh config
  forwards elsewhere (agent, X11, ports) or runs locally on connect is switched
  off. Command-line `-o` beats the config files — ssh keeps the first value.

- `BatchMode=yes`: a GUI app must never block on a password or passphrase prompt.
  Auth failure is a state (`Unreachable { reason: "ssh: permission denied" }`).
- `HostKeyAlias` pins the server's key under one name, whichever IP `sshHost`
  resolved to; `accept-new` pins it on first connect, and a changed key fails the
  connection.
- `ControlPath` is really `<app_data>/ssh/cm-<8 hex>` (a hash of user, host, port and
  key): `%C` is 40 characters, and under macOS's `Application Support` that overflows
  a unix socket path (104 bytes), which ssh treats as fatal. When even the short name
  won't fit, the three `Control*` options are left out — multiplexing only speeds up
  reconnects. Paths are passed double-quoted (the app dir has a space in it).
- Reconnect with backoff (1s → 30s) while the app runs. On every reconnect the client
  re-sends `hello`, re-subscribes to hooks after the last acked seq, and emits a
  reconnected event so terminals re-attach through their ring anchors.

## Protocol v1 (the contract with the daemon)

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
`{"protocol":1,"version","hostname","user","home","bootId"}`. `bootId` is random per
`serve` start: hook `seq` restarts at 1 with each boot, so a client whose stored
`bootId` differs resets its hook cursor to 0. Unsupported protocol → error `version`,
connection kept open. `owner` is minted once per app process (the link outlives page
reloads); a PTY session's own `owner` is the webview's page owner, as locally.

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

## How santree dispatches (app side)

- `crates/remote` (package `santree-remote-client`, Tauri-agnostic like
  `crates/pty`) is transport + client only (`proto`, `transport`, `client`, `host`):
  it knows nothing about repos. Its `fake` module (behind the `fake` feature, for
  tests) is an in-process daemon
  speaking the same protocol, backed by a real `PtyManager`, so the client and every
  dispatch path are tested without ssh.
- Every backend path that touches a repo resolves its `RepoLocation` once and
  dispatches: local → `std::fs`/`Command`/`PtyManager` as today; Daedalus →
  `exec.run`/`fs.*`/`pty.*`. `git.rs`'s one spawn site (`git_capture`) is where git
  dispatches.
- Hooks: agents on the server are launched with a settings file santree writes there
  via `fs.write`, whose hook commands are `santree-remote hook <args>`. The relayed
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
  `exec.run`, parsed by the existing `proc_table` parser.
- Worktree changes: polled (`git status` while the worktree is on screen), not
  watched.
- Stays local: GitHub (`gh`, by repo slug), Linear/Jira. **AI review is disabled for
  Daedalus projects** (its MCP draft tools would need a relay).

## Code map

`crates/remote` (package `santree-remote-client`):

- `proto.rs` — protocol v1 as types: one marker per method in `proto::m` (`Method`
  ties the wire name to params and result), the frames, events, error codes, base64
  helpers. Its tests pin the exact wire text; changing one is a protocol change.
- `transport.rs` — `SshTarget`, the validated `ssh` argv (`ssh_args` /
  `ssh_command`), `SshConnector`, stderr → short reason (`classify_ssh_failure`),
  the `Connector` seam and `memory_link()`.
- `client.rs` — `RemoteClient`: framing (32 MiB line cap), concurrent calls, event
  routing (per-session receivers from `pty_attach`, one hooks receiver), link death
  after 45s of silence, `call_blocking` for sync callers.
- `host.rs` — `RemoteHost`: its one `SshTarget`, `hello`, the `HostStatus` watch, backoff,
  the hooks subscription carried across links (boot-tagged `HookDelivery`s, the
  cursor reset on a new `bootId`), the `Reconnected` broadcast.
- `probe.rs` — `ssh_probe`: the health check's one ssh round trip.
- `fake.rs` (feature `fake`) — the in-process daemon (a random `bootId` per
  instance); `FakeDaemon::connector()` plugs it into a `RemoteHost`.

`src-tauri/src/daedalus/`:

- `host.rs` — `DaedalusHost` (Tauri-managed): the one `RemoteHost`, configured from
  the `daedalus_connection` row (`ssh_user@ssh_host`, port 22 by default) and
  re-synced after every command that can change it (reconfigured only when the
  target changes); `client(app)` / `connected_client(app)` (waits ≤5s while `Connecting`)
  → `Result<Arc<RemoteClient>, NotConnected>`; `reconnected(app)`; the
  `DaedalusDaemonChanged` event; the hook `Relay`.
- `health.rs` — `daedalus_health`'s staging.

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
