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
- Every backend path that touches a repo resolves its `RepoLocation` once and
  dispatches: local → `std::fs`/`Command`/`PtyManager` as today; Daedalus →
  `exec.run`/`fs.*`/`pty.*`. `git.rs`'s one spawn site (`git_capture`) is where git
  dispatches.
- Hooks: agents on the server are launched with a settings file santree writes there
  via `fs.write`, whose hook commands are `<hookBin> hook <args>` (`hookBin` from `hello`). The relayed
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
  connection to a `FakeDaemon` — what the connector and the app's health and
  workspace tests connect through.

`src-tauri/src/daedalus/`:

- `host.rs` — `DaedalusHost` (Tauri-managed): the one `RemoteHost` over the
  `AgentConnector`, started once with the saved hook cursor (`resume`);
  `state()` / `settled()` → `DaedalusLink`; `retry_now()`; `client(app)` /
  `connected_client(app)` (waits ≤5s while `Connecting`) →
  `Result<Arc<RemoteClient>, NotConnected>`; `reconnected(app)`; the
  `DaedalusLinkChanged` event; the hook `Relay`.
- `mod.rs` — the health check, `workspaces.list` over the link, and registering a
  checkout.

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
