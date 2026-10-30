# Compliance constraints — terminals

santree runs **real, unmodified CLI binaries in a real terminal**. A kernel PTY
hosts the vendor's own process and we stream raw bytes to and from it. The user
is a human driving their own session, as in iTerm or VS Code's integrated
terminal. santree is **not** an agent harness or an automation driver. Its one
server (below) is session persistence, as tmux is: it keeps the user's own
terminals alive and relays their keystrokes, and decides nothing.

Each agent CLI has its own terms of service. Staying a plain terminal emulator
keeps us clearly on the right side of them. The moment the app handles tokens,
parses output to decide what to type, or runs unattended, it stops being a
terminal and becomes a harness — a different product, with riskier obligations,
and the user's vendor account carries the consequence.

> **If a change introduces output parsing that influences input, token handling,
> or an unattended loop, it violates these constraints and must not be merged.**

Most of this file is enforced by the build. Where a rule is about who may call what —
bytes into a terminal, a terminal spawned, a pane opened — the compiler holds
it: the input types in `src-tauri/src/terminal.rs` (`terminal::input`) and the
`disallowed-methods` rules in the workspace's `clippy.toml`, which CI's
`cargo clippy --workspace --all-targets -- -D warnings` turns into build
failures. `src-tauri/src/compliance.rs` and
`src/features/terminal/compliance.test.ts` hold the tests named below; each was
verified to fail on a real violation, not merely to pass. What stays in prose is
what neither can judge.

---

## The rules

**No output-parsing influences input.** Nothing derived from hook payloads,
transcript reconciliation, or the status line is ever written back to a PTY on
its own. **The only bytes santree writes to a terminal are the user's
keystrokes, the single human-initiated seed prompt, and what the Conversation
view types on the user's click (below).** Orchestration stops at: choose a cwd,
place the pane, send one seed.
→ Compiler-enforced. A terminal takes input only as `Keystrokes` or a
`LaunchLine` (`terminal::input`). They have private fields and no constructor
function: `Keystrokes` and `LaunchRequest` exist only as the deserialized
arguments of `terminal_write` and `terminal_seed`, and a `LaunchLine` only by
consuming a `LaunchRequest`. The
facade, a remote pane's input queue (so its output pump cannot answer the
program) and the in-app write all take one of them or a `PtyInput` made from
one; none is `Clone`, so a launch line is typed at most once per request (the
frontend latches a pane's repeats). Beneath them,
`clippy.toml` forbids `PtyManager::write` and `RemoteClient::pty_write`
everywhere but the facade's in-app write and a pane's writer. The exceptions are
pinned by `the_lint_exceptions_are_exactly_the_sanctioned_sites`, the raw
`call::<m::PtyWrite>` by `only_the_client_and_the_host_name_the_pty_write_method`,
and four frontend tests pin that no PTY output is decoded and fed back.

The Conversation view types into the same pane, through the pane's own
renderer, on the user's action and at no other time: `compliance.test.ts` reads
its source as a syntax tree and pins that only its key and click handlers reach
the renderer's paste and key presses — never an effect, a timer or a hook
result. Each of its three actions is a keystroke the user could type in the
terminal; santree adds no channel to Claude.

- **Send** types the draft the user wrote. It first clears what is left in
  Claude's input (Ctrl+K and Ctrl+U — keys the user did not type, sent only as
  part of their own Send), then hands the draft to the renderer as a paste
  (bracketed when the program asked for it, and stripped of control characters
  other than tab and newline, so a draft cannot close the paste early and run
  the rest as keys), then presses Enter as a keypress of its own. It sends while
  Claude is at its prompt or working (Claude queues a message typed while it
  works), and never while the hooks record a dialog, unless an interrupt
  marker came after it or the dialog's own call finished 2 s ago (a
  status-line render alone never reopens it, and a dialog that follows is on
  screen before its own hook lands), before the process in the
  pane has reported its prompt (no hook runs under Claude's startup dialogs, so
  a key sent earlier could answer one), or over a link that is not live. Right
  before the Enter it reads the session's state again and drops the Enter if a
  dialog has appeared since.
- **An answer** to a dialog Claude is showing: a permission prompt, a question,
  a plan to approve. The view draws the dialog from Claude's own
  `PermissionRequest` payload, and the user's click types the keys that choice
  has in Claude's dialog — a digit, a tab or arrow move, the text the user
  wrote, Enter, or an Esc sent on its own — and only sequences probed on
  Claude Code's own dialogs (docs/conversation.md, "Answer cards"). This is
  the one place a hook payload chooses bytes (the position of the option the
  user picked), and it is bounded: one answer per dialog, on the user's click,
  only while that dialog is the one recorded as pending (read again before the
  first key and the last), and never a default, a rule or a timer choosing
  for the user. The card offers nothing for a dialog that may not be the one
  on screen (recorded while an earlier one was still open: parallel calls
  fire every `PermissionRequest` at once and Claude shows one at a time), one
  Claude's own signs say has closed, or one that other input to the pane (any
  but a card's own answer keys) may already have answered, or that this page
  wasn't watching the pane for. A
  sequence that depends on where the dialog's highlight is (anything but a
  lone digit or Esc) also needs the pane untouched since before the dialog
  appeared.
- **Stop** sends one Esc on a click.

santree cannot see Claude's screen and does not read it, so the view accepts
one risk by design: a menu or dialog Claude shows without a hook (a
slash-command picker the user opened in the terminal, history search) can
receive what the view types. Nothing the view renders from the transcript
reaches the draft or an answer.

**No unattended loop.** No auto-responders, no retry or "keep going" loops, no
always-on drivers. santree never starts, resumes, retries, or continues a
session on the user's behalf. A `--resume` seed (or the `attach` one for a session
Claude's daemon is already running) is built only when a human opens the tab. Closing a tab hangs up every process on its terminal (a tty `SIGHUP`,
`crates/pty` `hang_up`): that is the user's close, not control of the vendor
CLI's loop.

**No harness behavior.** Do not wrap, re-implement, or spoof any agent's control
loop or SDK. No outbound request may claim to be a vendor CLI.
→ `no_outbound_request_claims_to_be_a_vendor_cli`

**No credential handling.** santree never stores, proxies, injects, or
intercepts an agent CLI's auth tokens, and never reads one **to forward it
anywhere**. The user runs `claude login` themselves, inside the terminal. The
one bounded read is below. App-owned secrets never land in plaintext SQLite.
→ `a_vendor_credential_is_read_in_one_module_and_reachable_through_one_command`,
`no_migration_stores_a_secret_in_plaintext`

**The Web tab reads no page and stores no credential of an agent's.** A Web
tab's page is a native WKWebView santree only places and navigates: santree never
reads a page's content, and gives a page no IPC. What it keeps of a page is the
address a tab reopens on, cleaned of anything credential-shaped — a CLI's
sign-in callback (`codex login`'s `localhost:1455/success?id_token=…`) is just
the page a tab would otherwise remember.
→ `a_saved_address_keeps_no_credential`

Cookie import (docs/web.md, "Cookie import") is the one place santree reads
cookies, and it is the user's own browser cookies on this Mac, moved into the
Web tabs' store on the user's click, for the sites the user picks — the same
thing a browser's own import does. It reads one login-Keychain item per Chromium
source, with macOS's consent prompt, and writes the cookies only into WebKit's
store; nothing of a cookie is logged or stored elsewhere. This is distinct from
an agent CLI's credentials, which santree still never stores or proxies.

**Untrusted content must not be able to trigger tool use.** Text reaching a
model prompt from a diff, a PR, a Linear ticket, or a transcript is
attacker-influenceable — a malicious diff hunk, a comment any org member can
write. Headless helpers run with tool use denied by default for exactly this
reason, prompts go over stdin rather than argv (any local process can read
argv through `ps`), and untrusted spans are fenced.
→ `the_fix_prompt_boundary_survives_hostile_check_output`,
`a_suggestion_is_fenced_past_any_backticks_inside_it`

**Still forbidden, specifically:** storing or proxying a vendor credential;
using one to run an agent turn; driving a hidden `claude` session (`/usage` in a
PTY, which is how other tools scrape this); reading the credential of a vendor
santree isn't displaying usage for.

---

## Exceptions

Each is bounded. The bound is the point — a change that widens one past what is
written here needs the same scrutiny as a new exception.

**User-configured project environment.** The PTY inherits the ambient env —
minus the nested-session markers santree itself inherited (below) — plus the
user's own Settings → Environment variables, and `TERM`. santree does not
synthesize those values, read them from a CLI's config, or capture them from
anywhere. Launches also carry `SANTREE_REPO` / `SANTREE_TERM_KEY` so the hook
binary knows which row to update (and, on one of santree's accounts,
`SANTREE_ACCOUNT` plus the CLI's config-folder variable — "Agent accounts"
below), and pass through the `--permission-mode` and
`--remote-control` flags the user configured. **santree never selects a
permissive permission mode or defaults to one** — the prompt Claude shows is
Claude's, under the mode the user chose.

**Inherited nested-session markers are dropped.** santree is often launched from
inside an agent session, and an agent CLI stamps its children with markers saying
"you are a nested session of mine". Passing those on is a lie about the process
tree with real consequences: Claude Code reads an inherited
`CLAUDE_CODE_CHILD_SESSION` as proof it is nested and **turns transcript saving
off**, so the session becomes unresumable and invisible to Session History. Two
of the markers are worse than misleading — `CLAUDE_CODE_MESSAGING_SOCKET` and
`CLAUDE_CODE_MESSAGING_TOKEN` are the launching session's IPC channel and its
bearer token, which santree would otherwise forward into every agent PTY.
`crates/pty`'s `INHERITED_SESSION_MARKERS` removes them from the inherited env
before a session is built. The list is narrow by design — only what a parent
agent process writes into a child's env, never a knob a user sets for themselves
(`CLAUDE_CODE_SKIP_PROMPT_HISTORY` also suppresses transcripts and is
deliberately left alone) — and the removal happens *before* the user's own
variables are applied, so an explicit Settings → Environment value of the same
name still wins. Removal is the fix: santree does not set
`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` or any other force flag to override a
marker it could simply decline to pass on. Codex has no equivalent: it writes
`CODEX_SESSION_ID` / `CODEX_THREAD_ID` but never reads them back, so nothing is
stripped for it.
The strip belongs to *spawning*, not to one module, and there is one place
that spawns behind a PTY: `crates/pty`, which the in-app manager and the santree
server's host both use. `clippy.toml` holds it there (`CommandBuilder::new` is
forbidden everywhere but crates/pty's command builder), and setup scripts are
panes on the terminal facade, so they spawn where terminals do; a run on the
local server gets its environment through `base_env`, whose deny-list is built
from the same exported list. A copied list is a list that drifts.
→ `inherited_session_markers_are_stripped_but_a_user_set_value_wins`,
`a_spawned_process_does_not_inherit_the_nested_session_marker`,
`a_users_own_persistence_setting_is_not_stripped`,
`every_inherited_session_marker_is_denied`,
`the_inherited_session_markers_are_listed_once`

**Claude subscription usage.** `claude_usage.rs` reads Claude Code's own OAuth
token — from the keychain, else its credentials file, via a fixed argv with the
account taken from our own process, never from IPC. One GET to
`api.anthropic.com` per account, host matched by parse. Read-only: never
written, refreshed, or re-stored; expiry is Anthropic's call. Never logged or
persisted; only percentages and reset times reach SQLite. Identified honestly as
`santree/<version>`. The accounts are the Default one (Claude Code's own item
and file) plus each account the user created in santree ("Agent accounts"
below), and **each token is read separately, from that account's own keychain
item or file**: the item Claude Code names after the account's folder
(`Claude Code-credentials-<first 8 hex of sha256(folder)>`), else the folder's
`.credentials.json`. A named account with neither is "not signed in" — **never
the unscoped item**, which would show one login's usage as another's. Never
forwarded onward. It is the only module that does this and `claude_fetch_usage`
the only command.
→ `the_usage_credential_is_never_logged_serialized_or_stored`,
`every_host_allowlist_is_matched_by_a_parsed_host_not_a_string_prefix`,
`a_named_account_never_falls_back_to_the_default_credential`

**Agent accounts.** The user can keep several Claude Code and Codex logins:
each is a folder they created in santree,
`~/.config/santree/accounts/<claude|codex>/<id>/`, and a launch on it sets the
CLI's own documented override — `CLAUDE_CONFIG_DIR` or `CODEX_HOME` — to that
folder, plus `SANTREE_ACCOUNT=<agent>:<id>` so the hook records rate limits
under it (the hook takes the tag only for the agent it names). Account ids are
minted with a random suffix and never reused, because Claude names an account's
keychain item after its folder: a reused id would reopen a removed account's
login. The bound:

- **santree never reads, copies or writes a credential there.** Signing in is
  the vendor CLI's own login (`claude auth login`, `codex login`), run in a
  terminal the user watches; santree only builds the command line. Removing an
  account deletes the folder and leaves the CLI's keychain item alone.
- **What is shared is an allowlist of non-credential state.** `accounts.rs`
  symlinks named entries from the Default home into the folder — settings,
  instructions, skills, the transcript and rollout directories — so a session
  can be resumed under another account. Everything else (the credential,
  `.claude.json`'s login, Codex's auth storage, daemons, databases) stays per
  account by not being on the list. A new Claude account's `.claude.json` is
  seeded once with onboarding done, the theme, and workspace trust for exactly
  the folders already trusted in the Default account — no login.
- **A running session is never moved.** An account is fixed at launch and
  stored with the session. "Continue on account…" is a click: santree records
  the new account, ends the tab's process, and the tab resumes the same session
  id under it — the same human-opened resume as any other.
- **No automatic switching.** Nothing changes an account on the user's behalf:
  not on a rate limit, not on an error, not on a schedule. A launch on an
  account whose folder is gone fails with a message saying so, rather than
  running on the Default login. Removing an account in santree is the one
  reset, and it is the user's click: the sessions launched on it continue on
  the Default account, and its stored windows and the settings naming it go.
- **santree does not inherit an account.** Started from one of its own account
  tabs, santree drops `SANTREE_ACCOUNT` from its own environment at startup,
  and `CLAUDE_CONFIG_DIR` / `CODEX_HOME` when they point into the accounts
  root (a user's own value elsewhere stays), so its Default launches, Default
  usage read and the links every account points at stay the Default
  account's. Provisioning refuses a Default home inside the accounts root.
- **Daedalus sessions run on the box's Default account**, and a relayed hook's
  `SANTREE_ACCOUNT` is ignored.

**GitHub token.** `github.rs::token()` borrows a token from `gh auth token` —
GitHub's own documented lending interface, not an agent CLI's auth — and holds
it in memory for a TTL. It is never written to disk.

**Headless helpers.** `agent.rs` makes one-shot `claude -p` / `codex exec` calls
to draft a commit message, a PR body, or an English-tutor analysis. Five
conditions, all of which must hold: the vendor's own documented non-interactive
mode on the real binary; single-shot with no loop or retry; human-initiated by a
button, never in the background; bounded by a timeout; output lands under human
review. The Claude helper runs default permission mode with an explicit
allow/deny list and an empty strict MCP config; the Codex helper is ephemeral
and read-only with ambient extensions off, and runs **`--strict-config`**, which
makes the CLI reject an override it does not recognise instead of ignoring it —
so a renamed key fails the helper loudly rather than quietly running it with
ambient MCP servers, plugins, hooks and web search still on. That guarantee used
to come from the App Server's `config/read` handshake. **Any new headless call
site must be justified against these same conditions before merging.**
→ `codex_helpers_disable_ambient_extensions_and_writes`

**Transcript reads.** Five readers. `usage.rs` and `codex_rollouts.rs` are
display-only for *content* — a summary is shown, and no transcript text ever
reaches a model. One field is not content: the session **id**, which
`session::history` takes from those readers so the Session history pane can
resume a past conversation. On a click, `resume_worktree_session` writes that id
into `terminal_sessions` and the tab's ordinary launch builds `--resume <id>`
from it. The id is re-derived from the worktree's own listing rather than
trusted from IPC, and a human opening the tab is still the whole of the trigger.
A Daedalus project's records are the same records on the box, read over the
link by `daedalus/history.rs` with these same parsers, to the same ends.
The third reader is opt-in: with the transcripts checkbox
on, a single-shot PR-body draft receives the session text with tool calls and
results stripped, and the user reviews what comes back.

Expanding a history row reads more of the same records and shows more of them —
the full first prompt, the last few messages, the Task subagents a session
spawned and how each ended, and what it cost — and every one of those is still
display-only: none reaches a model, a prompt, or a PTY. Two things about that
surface are load-bearing. Its commands take the same `(repo, issue_id,
session_id)` and re-derive the candidate set from `worktree::sessions` exactly as
`resume_worktree_session` does, so an IPC value never becomes a path — the id is
compared against a located transcript's file stem and nothing else. And "Open
transcript" is the one place santree hands a transcript to something outside
itself: `reveal_worktree_session_transcript` derives the path in Rust and passes
it to the OS file browser (`open -R`, which selects the file rather than
launching it). The webview names a session; it never supplies, or receives, a
path.

The fourth reader is the Conversation view (`conversation.rs`, mapping through
`santree_core::conversation`). It renders a Claude session as a conversation
beside the terminal that is still running it: the transcript of the session a
tab's `terminal_sessions` row names, or of a session in the worktree's history,
and its subagents' transcripts. It is display-only in the same sense as the
first two: what it reads reaches a view and stops — no item becomes a prompt, a
model's input or a byte in a PTY, and what the view types (above) is only the
user's draft and the keys of the answer they pick. Its command takes a tab key, or the same `(repo, issue_id, session_id)`
as Session history, and derives the file in Rust: from the tab's own row (an id
santree minted, checked for that shape before it names a file), or by
re-deriving the listing. A subagent id is matched against its session's
`subagents/` listing, never joined from IPC. The watcher on the files views are
reading only tells a view to read again.

The fifth is the session-state reconciler (`hooks.rs`), which reads the end of
a session's record to settle a state the hooks left stale: record times, and
whether the newest record is Claude's interrupt marker, which Claude writes
when the user stops a turn mid-way and no hook reports. What it reads sets the
state shown and, as an interrupt, can make the composer's Send available
(above); none of it reaches a model, a prompt, or a PTY. It reads the file
the session's own id names: derived from the row, or the path the hook
reported only when that path is `<session id>.jsonl` inside Claude's projects
roots (a Codex thread's rollout, only inside Codex's sessions root). It reads an
idle row's record too, but only while the session's pane is live and the file
has changed since the idle was stored (a stat first; a file unchanged since a
read that found nothing is not read again): a turn Claude starts from its own
queue right after a `Stop` fires no hook, and a `promptSource: "queued"` user
line with no turn end after it is the only sign of one. That sets the state
shown; the stored row is never written.

The reconciler and the Conversation view open a record without following a
symlink and without blocking, take the file's identity from the open handle,
and check the opened file's real path against the vendor's own root, so a
swapped path, a symlinked directory or a FIFO cannot redirect a read or stall
one (`record_file.rs`).

**Session-state hooks + status line.** Every santree `claude` launch layers a
`--settings` file, which is a key-level override — the user's other keys are
untouched. It injects twelve events, each running the bundled hook binary, which
prints nothing on the hook path and always exits 0: `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
`Notification`, `PermissionRequest`, `Elicitation`, `ElicitationResult`, `Stop`,
`StopFailure` and `SessionEnd`. A thirteenth, `MessageDisplay` (Claude's reply as it renders, a
few lines at a time), is in the file only when Settings → Experimental →
Conversation view was on as it was built; never on a Daedalus launch, and the
relay refuses it. (A write it could not perform
appends one line to `<db_dir>/santree-hook-errors.log`, santree's own directory —
never to a stream the CLI can see, so the "silent to the agent" property is
unchanged; the file exists because a failure that leaves no trace anywhere is
indistinguishable from a hook that never ran.) The decision-capable ones are
`async: true` — the CLI's own schema defines that as "hook runs in background
without blocking" — so they structurally cannot approve or deny; `SessionEnd` is
synchronous only because it fires at teardown. The binary's silence matters past
the terminal too: Claude delivers an async hook's JSON `additionalContext` and
`systemMessage` to the model on the next turn, so a hook that printed them would
be injecting text into the conversation.

Most of the injected events are decision-capable and always were: Claude
documents `decision: "block"` for `Stop`, `UserPromptSubmit` **and**
`PostToolUse`, and `PermissionRequest` is a permission channel outright. `async`
is the whole of what makes any of them safe, which is why it — not a list of
event names — is the invariant under test. The newer ones decide too when
synchronous: an `Elicitation` hook can answer an MCP server's form for the user
(`hookSpecificOutput.action`; exit 2 declines it), an `ElicitationResult` hook
can override the answer, a synchronous `MessageDisplay` holds each rendered
batch until it returns and can replace the text shown, and a synchronous
`PostToolBatch` can block, which stops the tool loop. Async, all four only
report; probed, no event registered async changed any of Claude's dialogs.
`PostToolBatch` sets no state: santree reads only which calls a finished batch
held (thread, tool, input), to see a pending dialog's own call end, and a
rejection with the user's feedback fires nothing else.
Three events stay out on their own merits: **`PreToolUse`**, the only one that
can authorize or rewrite a tool call (`permissionDecision: allow|deny|ask`,
`updatedInput`), `PermissionDenied`, and `WorktreeCreate`, whose output Claude
reads as the new worktree's path, so registering it at all replaces Claude's
own worktree creation.
Captured state includes a pending dialog's own payload (the tool and its input,
`permission_suggestions`, the MCP server, the subagent that asked, the mode, the
turn's id; an elicitation's message and its form schema or URL), stored with the
row in the same statement and cleared by the write that leaves the dialog. With
it the hook keeps what it has seen of the dialog since: whether it was stacked
behind another, a hash identifying its call (never the input again), the start
of the first status-line render after it, and when its own call finished. It is
display-only, with two uses beyond display, both above: whether the
Conversation view may type, and, for an answer the user clicks, which keys that
choice has in Claude's dialog. It never types by itself, and the reply text
`MessageDisplay` streams reaches a view and stops. `permissions.deny` appears in restricted flows
and is **best-effort defence-in-depth, not a hard gate** — never build on it as a
security boundary.
→ `no_injected_hook_can_gate_claude_and_pretooluse_is_never_injected`

The app also applies hook payloads **relayed from Daedalus** (docs/remote.md):
agents on the user's home server run the same hooks through the session host's
`hook` subcommand, and the app applies each event with `crates/hook`'s own `apply` — the
same writes the binary makes, into the app's own database, with a failure
logged to the same `santree-hook-errors.log`. Nothing goes back to the agent:
the relay only records. Because the server is not trusted the way the local
binary is, an event whose terminal key or session id has a shape santree would
never mint, or that names a session a local project owns, is refused (logged
and acked), and the payload's `transcript_path` is dropped before it is applied
— a path on the server names nothing on the Mac.
→ `relayed_hooks_cannot_reach_local_sessions_or_carry_bad_ids`

**The status-line passthrough** is opt-in, rewrites one key, backs the file up
once, and is reversible. It forwards the same stdin bytes, stdout, stderr and
exit code, kills a hung command at 5s, and **never interprets the user's
command** — it is handed on as a single argument.
→ `the_status_line_passthrough_hands_the_users_command_on_as_one_argument`

**The English tutor** is the one feature that injects text into the model's
context on every turn, and it is off by default: it rides along only while both
its own switch ("Correct my English") and Settings → Experimental → English tutor
are on (`english_tutor::enabled`); with either off, no launch's `--settings` file
carries it.
→ `the_tutor_needs_its_experimental_switch_on_as_well`
When on, it adds a *second,
synchronous* `UserPromptSubmit` hook — synchronous precisely so its stdout
reaches the model with the prompt it belongs to (an async hook's plain output is
dropped, and its JSON context arrives only a turn later) — plus a `permissions.allow` for
`Edit` on the practice log. Its bound: the text is the user's own instruction
file, never derived from the agent's output, and it grants nothing beyond that
one file.

**Codex has no control plane.** santree once owned a local `codex app-server` —
a JSON-RPC service on a private Unix socket — and every Codex surface went
through it. It is gone. A Codex session is now the unmodified `codex` binary in
a PTY, exactly like a Claude one, and the surfaces that used the protocol ask
the CLI instead: `codex login status` for whether it is signed in, `codex debug
models` for the catalog, `codex logout` on a click. Each is one short-lived,
non-interactive invocation with stdin closed, bounded by a timeout and an output
cap. There is deliberately **no login command**: starting a ChatGPT login was a
protocol call, the CLI's own is an interactive browser flow, and santree points
the user at `codex login` in a terminal rather than reimplementing it (for one
of santree's accounts, the same command with `CODEX_HOME` set — "Agent
accounts").

Removing it removed a real cost as well as a rule to keep: that `codex
app-server` process outlived the app that started it with nothing to retire it
(87 orphans on one developer machine, the oldest four days old), and it held
Codex's per-thread writer lock, which is what made a resumed thread fail with
"already has an active writer". (The santree server below outlives the app on
purpose, holds only sessions the user opened, and retires when it has none.)

**Never credential material**, before or after: Codex owns its auth storage, and
santree does not read `~/.codex/auth.json` or any other credential file. Nothing
is left that could — there is no code path from santree to a Codex token.
→ `santree_owns_no_codex_control_plane`, `nothing_reads_codexs_auth_storage`

**Codex subscription usage** has no live source that santree may use. The
account API needs Codex's credentials and the protocol that exposed it is gone,
so the number comes from Codex's own rollout transcript: it writes a
`token_count` record after every turn carrying the rate-limit windows the API
returned, and `codex_rollouts.rs` reads back the most recent one. It is a
display-only transcript read like the two beside it, and it is **as fresh as the
user's last Codex turn and no fresher** — the UI must not imply otherwise. When
Codex has never run, or the plan reports no windows, the answer is empty. Every
account's rollouts share one directory, so a rollout counts for the account its
thread's `terminal_sessions` row names *now* — the launch account, until
"Continue on account" moves the row — else the Default one.
→ `nothing_reads_codexs_auth_storage`

**Review MCP server.** The AI review and Address review launch one santree-owned
server — the bundled hook binary in `mcp` mode, scoped by argv to a single PR.
It has no network access, no GitHub token, no `git`, and spawns no subprocess.
It writes three of santree's own tables, and in the work-item table the agent may
only mark an existing PR-scoped item complete — never add, rewrite, or delete.
Neither session can commit or push. Under Claude the grant covers the whole
server, so a tool added to it is reachable the moment it is served; the shared
list is what keeps the server's tools and the grant the same set.

Under Codex the same server is now launch configuration rather than an App
Server call: `codex_config.rs` emits
`-c 'mcp_servers.santree-review={command=…,args=[…],required=true,enabled_tools=[…]}'`,
one named server added beside the user's own rather than replacing the map. Two
things make it **fail closed**, and both were measured against codex-cli 0.150.1
in an isolated `CODEX_HOME`. `required = true` makes Codex refuse to create the
session when the server cannot start ("required MCP servers failed to
initialize") instead of quietly continuing as an ordinary agent with nowhere to
put what it found. And because the CLI *silently ignores* a `-c` key it does not
recognise — the trap that let a decorative `-c sandbox_permissions=[]` ship for
months — santree proves the override landed before it launches, with
`codex exec --strict-config --ephemeral --ignore-user-config` over its own
overrides only. `--strict-config` cannot ride on the interactive launch itself:
it would validate the user's `~/.codex/config.toml` too, so one unrecognised key
of theirs would block a launch that works today. The review's approval policy is
`never`, which makes the `enabled_tools` allowlist a hard gate rather than a
prompt — a tool missing from it is rejected with no explanation, which is why
both ends read the one shared list.
→ `the_review_tool_server_can_reach_neither_github_nor_the_network`,
`the_review_tools_write_only_santrees_own_three_tables`,
`the_review_agent_may_only_complete_a_work_item_never_create_or_delete_one`,
`every_advertised_tool_is_dispatchable_and_named_in_the_shared_list`,
`a_review_without_its_tools_refuses_to_launch`,
`the_review_server_carries_every_shared_tool_and_fails_closed`

**santree only tightens a Codex sandbox.** A Codex session's sandbox and approval
policy are the user's, set in their own `~/.codex/config.toml`; santree has no UI
for either. So it names them only where naming them restricts: the read-only
surfaces (triage investigation, "ask AI", the AI review) launch
`--sandbox read-only --ask-for-approval never`, and Address review takes the
approval policy without the sandbox. The work session gets neither — pinning
`workspace-write` there would override a user who chose `read-only`, which is
"santree never selects a permissive permission mode" in Codex's vocabulary. The
App Server did pin it; this is the one place the CLI mapping deliberately differs
from what it replaced. **`--dangerously-bypass-approvals-and-sandbox` is never
passed.** Other launchers default to it. A bypassed sandbox is the first step to
not needing `review_drafts::publish`, which is the decision the review feature
exists to preserve.

**Two bounded wideners, and the shape of the boundary.** "Only tightens" held
absolutely until a linked worktree made it untenable: the checkout's `.git` is a
*file* pointing at the main repo, so under Codex's own `workspace-write` default
every byte git writes for a fetch, merge or rebase — `FETCH_HEAD`, `index`, the
shared object store — sits outside the writable root, and the agent cannot
complete a merge it was asked to do. So santree now names two permissive things,
both narrow, both on the surfaces that write the checkout:

1. `--add-dir <the checkout's common git directory>`, unconditional on the work
   and Address-review surfaces. It grants no capability the agent lacked: it can
   already edit the files those objects record. The directory is resolved from
   the checkout's own pointer files and accepted only if it is demonstrably a git
   directory, so an unreadable or bogus `.git` degrades to *no flag* rather than
   to a wider root.
2. `sandbox_workspace_write.network_access`, off by default and behind a Settings
   toggle, because Codex has no host allowlist and this is every outbound
   connection a model-generated command makes.

The network knob reaches **the work session only**. Address review writes the
checkout and still never gets it: the setting is global, so a user enabling it for
their own work would otherwise hand api.github.com to a session santree pointed at
a pull request — and an agent that can reach the API posts without the click below.
Both wideners are inert on the read-only surfaces, which stay pinned to
`--sandbox read-only`.
→ `no_surface_can_produce_the_bypass_flag`,
`the_work_surface_does_not_override_the_users_own_sandbox`,
`nothing_asks_codex_to_bypass_its_sandbox`,
`network_access_is_opt_in_and_never_reaches_a_read_only_surface`,
`address_review_never_gets_the_network_even_when_the_user_opted_in`,
`an_unresolvable_git_directory_drops_the_grant_rather_than_widening_it`

**A draft becomes a comment only on a click.** `review_drafts::publish` is the
only path from an agent's finding to GitHub, it runs on a user action into their
pending review, and it refuses a draft written against a head the PR has moved
past. **Two human decisions stand between an agent's finding and anyone else
seeing it.**
→ `the_only_path_from_an_agents_draft_to_github_is_the_users_pending_review`

**santree derives its own paths.** The settings, prompt, and MCP file a session
launches with are derived in Rust from the tab's own row. Browser storage never
selects one, and a webview may supply a PR identity but never a path.

**Reading the OS process table is observation, not a loop.** santree asks the
kernel which process owns each pane's foreground process group, so it knows
*which agent* is in a pane rather than only which one it launched
(`proc_table.rs`, `agent_procs.rs`). Terminal output is untouched by this; it is
the same passive class as reading a pane's OSC title. It answers **identity,
never status** — the state ladder is still the hooks, then the title — and
nothing derived from it is written back into a PTY, gates a launch, chooses a
prompt, or becomes an argument to a command. It reaches the sidebar as a provider
mark, and the Conversation composer as the start of the process in a pane — the
floor a hook record must be newer than before it may enable Send, which can
only keep Send off — and stops. The `ps` argv is a constant, so no IPC value reaches it. The
inability to write is structural rather than a promise: whatever handle it held,
nothing outside `write_pty` can make the input a terminal accepts, and the raw
writes beneath it are lint errors outside their sanctioned sites.

The listing selects `ps`'s `command` column, so the read *transits* every host
process's full argv — which on any machine can carry a secret somebody put on a
command line. **Only `argv[0]`'s basename is retained**, at the parse
(`proc_table.rs`), before anything else sees a row: the rest is dropped and never
logged, persisted, or sent across IPC. `ucomm` would avoid the transit but is
unusable — it reported `claude.exe` for a running `claude` *and* for a `ugrep`
that Claude spawned — and no cross-platform column yields `argv[0]` alone. The
narrow retention is what makes the wider read acceptable; widening it is a change
to this paragraph, not just to a parser.

A Daedalus project's panes run on the user's home server, so their process table
is read there — the same constant `ps` argv through `exec.run`, the same parse,
the same foreground walk (`daedalus/agents.rs`), identity only. The full listing
crosses the link once per read and is parsed here the way the local one is: only
`argv[0]` basenames survive it.
→ the input types and `clippy.toml` (above)

**Hook binary freshness.** The `santree-hook` that agents' hooks run is a copy in
the user's data dir (`<app_data>/bin`), because the bundle path moves on every
update. A process with the user's uid can write there as it can write the bundle,
so the copy is re-compared with the bundle byte for byte, and healed, every time a
hook path is about to be written. That is a freshness check, **not integrity**:
nothing checks what the bundle itself is, and a swap between two such checks
stands until the next — the same window as a swapped bundle's, documented in
docs/server.md, "Hooks". The release asserts the shipped hook is signed by the
team with the hardened runtime. A launch line queued for a terminal that cannot
be reached is dropped after 45 s instead of being typed on a later
reconnect, so a command the user asked for long ago is not run unattended.
→ `a_tampered_stable_copy_is_healed_at_the_next_emission`,
`a_launch_line_queued_across_a_long_outage_is_not_typed_when_the_link_returns`

**Terminal reattach.** A session survives a webview reload: the PTY lives in the
Rust process (or, on a signed build and under `SANTREE_SERVER=1`, in the detached
santree server, below) and keeps a bounded ring of its recent output
(`docs/terminals.md`, `docs/server.md`). The ring is written by the reader
thread and read by the attach path (the app's, or the server's `pty.attach`) and
by the mode tracker below; nothing else inspects it, and its only consumer is an
xterm that would have received the same bytes live.

**Mode restoration reads output, within a fixed bound.** The ring's mode tracker
(`crates/pty/src/modes.rs`) follows a fixed, enumerated set of display modes and
nothing else, writes nothing toward the PTY, and answers no query: the webview's
xterm is the single query-reply authority. Its only product is a preamble of
DECSETs written into a viewer ahead of a replay. Widening the set, or giving it
any other consumer, is a change to this paragraph.

**The santree server is session persistence, like tmux.** `santree-server`
(`crates/server`, serving `crates/host`) holds the PTYs the user opened so a
terminal and the agent in it survive a quit, a crash or an update of the app.
It is the same PTY as before, one process further: it relays the bytes of a
`pty.write` request and nothing else, and **starts, resumes and retries
nothing** — it opens a session when the app asks, which is when a human opened
the tab, and it never decides to. It reads output for exactly one purpose: the
tracker (`crates/pty/src/modes.rs`) lives in the PTY ring (`crates/pty` `Ring`), so
the in-app manager does it too, and follows the last state of a fixed list of
display modes (bracketed paste, mouse protocol and encoding, focus reporting,
application cursor keys and keypad, alt screen) so a viewer that attaches after
the DECSET scrolled out can be handed a short preamble of the same sequences *before the replay*. The tracker
reads output only to replay display modes: it answers no query and writes nothing
to the PTY. Restored modes do change how the emulator encodes the user's own
keystrokes (a bracketed paste, a mouse report), but as the program asked for them
and exactly as its own DECSET would have; the emulator encodes the user's input as
the program requested, and santree sources and types nothing. Everything else about
the output is uninspected. It
retires when it holds no session and no client. It is not a second way into a
terminal: `clippy.toml` forbids `PtyManager::write` in the host everywhere but
its sessions' input thread, that thread is fed only by `Host::pty_input`, and
`pty_input` is forbidden everywhere but the `pty.write` handler — so a write
through any handle on the PTY table, `Host::pty()` included, fails the build.
Spawning is held the same way: `PtyManager::open` only in the `pty.open`
handler (and the app's in-app arm). (`server.keepAwake` runs
`caffeinate` and touches no session; the app's Restart, Stop and End-now
commands send `server.stop`, which closes sessions and writes nothing to one,
each behind a user click.)

Every agent in a santree PTY runs as the user's own uid, so a socket that
admitted by uid would let one agent type into another's terminal. The server
therefore admits **santree.app alone, by code signature** (the app's identifier
and the release's Team ID, read from the peer's audit token, never its pid), and
the app expects the same of the server. A signed server also serves only when
santree.app launched it, which it asks over its ready socket — and a ready
socket is accepted only as an unnamed socketpair end, because on macOS a client
connected to a *named* socket answers with the listener's identity, which would
let an agent hand a server a socket santree.app listens on. A session's
environment is the one the app forwards (`baseEnv`, required of the server): the
server's own environment, which is whatever launched it, never becomes one.
`baseEnv` is a name-blind pass-through of the app's ambient environment minus the
`SANTREE_`/`TAURI_`/`WEBKIT_`/`DYLD_`/`LD_` deny-list and the nested-session
markers (parity with how in-app terminals inherit it, and never a selection of
any vendor's variables), and the project secrets `resolve_env` reads travel only
in `env`. It is a **relay** of values the app process already inherited, read when a
session opens and written nowhere; no variable is looked up by name and no
credential file is read to build it. A same-user process connecting in a loop can
only delay the app: signature checks run four at a time, at most 32 connections
wait for one, and the rest are closed at once.

**The bound is the signature.** Unsigned and dev builds do not use the server
by default. Opting into it there is the documented exception: admission
is by uid alone, so **any agent in any of that user's sessions could drive
another's terminal.** That is the cost of a dev build, not something the app
does on the user's behalf, and a signed release never runs that way (a build with
its Team ID baked in refuses to serve unless it can confirm its own signature).
→ the input types and `clippy.toml` (above), which also hold that a pane is
opened, attached, adopted and closed by the adapter alone (`Terminals`' and
`RemoteTerminals`' `open`, `attach`, `adopt` and `close` are forbidden outside
`terminal.rs` and the facade's own arms);
`the_lint_exceptions_are_exactly_the_sanctioned_sites`,
`only_the_client_and_the_host_name_the_pty_write_method`,
`the_session_environment_builder_names_no_vendor_variable`,
`a_signed_server_serves_only_for_santree_app`,
`a_ready_fd_connected_to_a_named_listener_is_refused`,
`a_named_ready_socket_is_refused_signed_or_not`,
`a_release_build_serves_only_as_its_own_team`,
`a_refused_peer_is_closed_unanswered`,
`connections_waiting_for_a_check_are_capped_and_logged_once_per_burst`,
`a_host_requiring_a_base_env_refuses_an_open_without_one`,
`an_open_without_a_base_env_is_refused`,
`a_forwarded_base_env_is_the_whole_inheritance`

---

## What a test cannot judge

Kept in prose because they are judgment calls, not patterns: that captured state
stays display-only; that a helper is genuinely human-initiated; that a new
`Command::new` site is legitimate (the tree has 30+ that are); that we have not
re-implemented a vendor's control loop. These are what code review is for.
