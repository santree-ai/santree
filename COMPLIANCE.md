# Compliance constraints — terminals

santree runs **real, unmodified CLI binaries in a real terminal**. A kernel PTY
hosts the vendor's own process and we stream raw bytes to and from it. The user
is a human driving their own session, as in iTerm or VS Code's integrated
terminal. santree is **not** a terminal server, an agent harness, or an
automation driver.

Each agent CLI has its own terms of service. Staying a plain terminal emulator
keeps us clearly on the right side of them. The moment the app handles tokens,
parses output to decide what to type, or runs unattended, it stops being a
terminal and becomes a harness — a different product, with riskier obligations,
and the user's vendor account carries the consequence.

> **If a change introduces output parsing that influences input, token handling,
> or an unattended loop, it violates these constraints and must not be merged.**

Most of this file is now executable. `src-tauri/src/compliance.rs` and
`src/features/terminal/compliance.test.ts` hold the tests named below; each was
verified to fail on a real violation, not merely to pass. What stays in prose is
what a test cannot judge.

---

## The rules

**No output-parsing influences input.** Nothing derived from hook payloads,
transcript reconciliation, or the status line is ever written back to a PTY.
**The only bytes santree writes to a terminal are the user's keystrokes and the
single human-initiated seed prompt.** Orchestration stops at: choose a cwd,
place the pane, send one seed.
→ `only_the_terminal_adapter_writes_bytes_into_a_pty`, and four frontend tests
that no PTY output is decoded and fed back.

**No unattended loop.** No auto-responders, no retry or "keep going" loops, no
always-on drivers. santree never starts, resumes, retries, or continues a
session on the user's behalf. A `--resume` seed is built only when a human opens
the tab.

**No harness behavior.** Do not wrap, re-implement, or spoof any agent's control
loop or SDK. No outbound request may claim to be a vendor CLI.
→ `no_outbound_request_claims_to_be_a_vendor_cli`

**No credential handling.** santree never stores, proxies, injects, or
intercepts an agent CLI's auth tokens, and never reads one **to forward it
anywhere**. The user runs `claude login` themselves, inside the terminal. The
one bounded read is below. App-owned secrets never land in plaintext SQLite.
→ `a_vendor_credential_is_read_in_one_module_and_reachable_through_one_command`,
`no_migration_stores_a_secret_in_plaintext`

**Untrusted content must not be able to trigger tool use.** Text reaching a
model prompt from a diff, a PR, a Linear ticket, or a transcript is
attacker-influenceable — a malicious diff hunk, a comment any org member can
write. Headless helpers run with tool use denied by default for exactly this
reason, prompts go over stdin rather than argv (argv is world-readable on
Linux), and untrusted spans are fenced.
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
binary knows which row to update, and pass through the `--permission-mode` and
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
bearer token, which santree was forwarding into every agent PTY it spawned.
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
The strip belongs to *spawning*, not to one module: santree runs a process
behind a PTY in two places, and background runs (setup scripts, builds) go
through the second one. Both call the same exported helper with the same list —
a copied list is a list that drifts.
→ `inherited_session_markers_are_stripped_but_a_user_set_value_wins`,
`a_spawned_process_does_not_inherit_the_nested_session_marker`,
`a_users_own_persistence_setting_is_not_stripped`,
`a_background_run_does_not_inherit_the_launching_sessions_markers`,
`every_pty_spawn_site_strips_the_inherited_session_markers`

**Claude subscription usage.** `claude_usage.rs` reads Claude Code's own OAuth
token — from the keychain, else its credentials file, via a fixed argv with the
account taken from our own process, never from IPC. One GET to
`api.anthropic.com`, host matched by parse. Read-only: never written, refreshed,
or re-stored; expiry is Anthropic's call. Never logged or persisted; only
percentages and reset times reach SQLite. Identified honestly as
`santree/<version>`. This account only, never forwarded onward. It is the only
module that does this and `claude_fetch_usage` the only command.
→ `the_usage_credential_is_never_logged_serialized_or_stored`,
`every_host_allowlist_is_matched_by_a_parsed_host_not_a_string_prefix`

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

**Transcript reads.** Three readers. `usage.rs` and `codex_rollouts.rs` are
display-only — a summary is shown, never fed to a session. The third is opt-in:
with the transcripts checkbox on, a single-shot PR-body draft receives the
session text with tool calls and results stripped, and the user reviews what
comes back.

**Session-state hooks + status line.** Every santree `claude` launch layers a
`--settings` file, which is a key-level override — the user's other keys are
untouched. It injects eight events, each running the bundled hook binary, which
prints nothing on the hook path and always exits 0. (A write it could not perform
appends one line to `<db_dir>/santree-hook-errors.log`, santree's own directory —
never to a stream the CLI can see, so the "silent to the agent" property is
unchanged; the file exists because a failure that leaves no trace anywhere is
indistinguishable from a hook that never ran.) The decision-capable ones are
`async: true` — the CLI's own schema defines that as "hook runs in background
without blocking" — so they structurally cannot approve or deny; `SessionEnd` is
synchronous only because it fires at teardown.

Most of the injected events are decision-capable and always were: Claude
documents `decision: "block"` for `Stop`, `UserPromptSubmit` **and**
`PostToolUse`, and `PermissionRequest` is a permission channel outright. `async`
is the whole of what makes any of them safe, which is why it — not a list of
event names — is the invariant under test. Two events stay out on their own
merits: **`PreToolUse`**, the only one that can authorize or rewrite a tool call
(`permissionDecision: allow|deny|ask`, `updatedInput`), and `PermissionDenied`.
Captured state is display-only. `permissions.deny` appears in restricted flows
and is **best-effort defence-in-depth, not a hard gate** — never build on it as a
security boundary.
→ `no_injected_hook_can_gate_claude_and_pretooluse_is_never_injected`

**The status-line passthrough** is opt-in, rewrites one key, backs the file up
once, and is reversible. It forwards the same stdin bytes, stdout, stderr and
exit code, kills a hung command at 5s, and **never interprets the user's
command** — it is handed on as a single argument.
→ `the_status_line_passthrough_hands_the_users_command_on_as_one_argument`

**The English tutor** is the one feature that injects text into the model's
context on every turn, and it is off by default. When on, it adds a *second,
synchronous* `UserPromptSubmit` hook — synchronous precisely so its stdout
reaches the model, which an async hook discards — plus a `permissions.allow` for
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
the user at `codex login` in a terminal rather than reimplementing it.

Removing it removed a real cost as well as a rule to keep: the server outlived
the app that started it (87 orphans on one developer machine, the oldest four
days old), and it held Codex's per-thread writer lock, which is what made a
resumed thread fail with "already has an active writer".

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
Codex has never run, or the plan reports no windows, the answer is empty.
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
→ `no_surface_can_produce_the_bypass_flag`,
`the_work_surface_does_not_override_the_users_own_sandbox`,
`nothing_asks_codex_to_bypass_its_sandbox`

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
mark and stops. The `ps` argv is a constant, so no IPC value reaches it. The
inability to write is structural rather than a promise: `agent_procs.rs` may not
name a `PtyManager` at all, so it holds no handle on a terminal.

The listing selects `ps`'s `command` column, so the read *transits* every host
process's full argv — which on any machine can carry a secret somebody put on a
command line. **Only `argv[0]`'s basename is retained**, at the parse
(`proc_table.rs`), before anything else sees a row: the rest is dropped and never
logged, persisted, or sent across IPC. `ucomm` would avoid the transit but is
unusable — it reported `claude.exe` for a running `claude` *and* for a `ugrep`
that Claude spawned — and no cross-platform column yields `argv[0]` alone. The
narrow retention is what makes the wider read acceptable; widening it is a change
to this paragraph, not just to a parser.
→ `only_the_terminal_adapter_writes_bytes_into_a_pty` (its allowlist is what
keeps that module away from the PTY)

**Terminal reattach.** A session survives a webview reload: the PTY lives in the
Rust process and keeps a bounded ring of its recent output
(`docs/terminals.md`). The ring is written by the reader
thread and read only by the attach path; nothing inspects it, and its only
consumer is an xterm that would have received the same bytes live.

> **If a mode mirror is ever built** — parsing output to restore terminal modes
> on reattach, as Phase 5 of that document proposes — it must extract a fixed,
> enumerated set of modes and nothing else, must never emit a reply toward the
> PTY, and must answer no query sequence: the webview's xterm is the single
> query-reply authority. It does not exist today, and this paragraph grants
> nothing until it does.

---

## What a test cannot judge

Kept in prose because they are judgment calls, not patterns: that captured state
stays display-only; that a helper is genuinely human-initiated; that a new
`Command::new` site is legitimate (the tree has 30+ that are); that we have not
re-implemented a vendor's control loop. These are what code review is for.
