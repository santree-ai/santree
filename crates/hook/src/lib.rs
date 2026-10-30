//! `santree-hook` — the tiny CLI that agent-CLI hooks invoke.
//!
//! santree injects hook config into its own agent launches — Claude's as a
//! `claude --settings '<JSON>'` file, Codex's as repeated
//! `-c 'hooks.<Event>=[…]'` overrides (which Codex ignores without
//! `--dangerously-bypass-hook-trust`) — one hook per session-state event, each
//! running this binary. Every invocation reads the hook's JSON payload on
//! stdin, derives the agent's current state, and UPSERTs the single row for
//! that session in the app's `session_state` table — so the desktop app can
//! surface live session state. After writing, it bumps a tick file the app
//! watches, which pushes a realtime refresh to the UI.
//!
//! `--agent-kind <Provider>` says which CLI is calling (Claude when absent). The
//! two share the event vocabulary; they differ only in who mints the session id,
//! which is what [`binds_session_id`] and [`reconcile_terminal_session`] turn on.
//!
//! Invariant: this MUST NEVER disrupt the user's session. Every failure path
//! (bad args, unparseable stdin, empty session id, missing/locked db) exits 0
//! silently — a non-zero exit could block or warn inside the agent. Silent to
//! the *agent*, though, is not the same as silent full stop: a failed write
//! leaves a line in `<db_dir>/santree-hook-errors.log` ([`note`]), because
//! "nothing was recorded" and "the hook never ran" were otherwise the same
//! observation, and that ambiguity is what let a Codex bug survive three fixes.
//!
//! A library as well as the binary (`main.rs` is [`run`] and nothing else):
//! the app applies a hook that fired on a *Daedalus* server through the same
//! code ([`apply`] over its own pool connection), so a relayed event writes
//! exactly the rows this binary would have written for it (docs/remote.md).

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use santree_core::conversation::claude::is_subagent_id;
use santree_core::domain::{AgentKind, AgentState, DialogKind, DialogMarks};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{ConnectOptions, Connection};

mod mcp;
mod passthrough;
mod review_tools;

/// Map a hook event (and, for `Notification`, its `notification_type`) to the
/// agent state it implies. `None` = don't change the stored state.
///
/// Claude and Codex are mapped by the *same* table: Codex's hook event names are
/// a near-clone of Claude's, so one vocabulary means a state never depends on
/// which CLI reported it. `Notification` is Claude-only and Codex's extra events
/// (`PostCompact`, `SubagentStart`/`SubagentStop`) fall through to `None`, which
/// is what they mean anyway.
///
/// - `SessionStart` is `idle`, NOT `active`: it fires when a session comes up or
///   *resumes*, at which point the agent sits at the prompt — not running a turn.
///   Only `UserPromptSubmit` (a turn actually starting) means it's running.
/// - `PermissionRequest` → `permission`: a tool is blocked on the user's
///   approval. OBSERVED ONLY — the hook is registered async so it can never
///   approve/deny; the CLI still shows its normal prompt.
/// - `Notification` is refined by type, by what Claude's hooks reference says
///   each one means. Only a question on screen is "needs you": a permission
///   prompt, an MCP server's form or URL prompt, a session waiting on input, or
///   the Enter Claude waits for after a usage-limit reset. A finished turn is
///   `idle` — `agent_completed`, and `idle_prompt`, which fires when Claude
///   finished responding about a minute ago and nothing has been typed since.
///   Auth/elicitation-result notifications change nothing.
///
/// - `PostToolUse`/`PostToolUseFailure` → `active`, as a **heartbeat**: they are
///   the only thing that fires during a long turn, so without them a turn whose
///   transcript goes quiet for `IDLE_QUIET_MS` (one slow build, one long think)
///   reads as idle while the agent is plainly working. They are handled as
///   heartbeats rather than ordinary transitions — see [`is_heartbeat_event`] —
///   which is what makes injecting them safe where `PreToolUse` still isn't.
///
/// We only map events that *set* a state. Clearing a resolved `permission`/
/// `waiting` back to running is NOT done here — the app reconciles that against
/// the transcript on read (a manual accept/reject fires no reliable hook).
///
/// `SessionStart` from a compaction sets nothing: auto-compaction fires it in
/// the middle of a turn, which goes on afterwards (a manual `/compact` fires it
/// at the prompt, but no `UserPromptSubmit` before it, so the row is already
/// idle there).
///
/// - `StopFailure` ends a turn on an API error (Claude retries first: a 429 or
///   a 401 runs ten attempts over about three minutes, with no hook at all
///   until it gives up) and fires no `Stop`: `idle`, with the error as its
///   message.
/// - `Elicitation` is an MCP server's form or URL on screen: `waiting`, at once
///   (its `elicitation_dialog` Notification comes ~6 s later and says less).
///   `ElicitationResult` is the user's answer, after which the tool call goes
///   on: `active`, as a transition — it has to clear the dialog it answers,
///   and only that one (over a permission dialog it writes nothing:
///   `write_state`).
fn resolve_state(event: &str, agent: AgentKind, payload: &Value) -> Option<AgentState> {
    // A *present but null* `agent_id` is the root session, not a subagent — the
    // shape a serializer emits for an absent optional. Reading it as "subagent"
    // would silently ignore every event the user's own session ever fires.
    if payload.get("agent_id").is_some_and(|id| !id.is_null()) {
        return match agent {
            // Claude fires every hook of a subagent on the parent session
            // (`session_id` is the parent's), tagged with the subagent's
            // `agent_id`. Its turns are not the parent's state, but a question
            // it puts to the user is on the parent's screen: its permission
            // dialog is the parent session's "needs you" (CLI 2.1.312 runs
            // subagents in the background, and the main thread's `Stop` comes
            // while that dialog is still up).
            AgentKind::Claude => resolve_main(event, payload).filter(|s| s.is_blocked_on_user()),
            // Codex runs the same hook command for its subagents, tagging those
            // payloads with the child's `agent_id`, and a child is a thread of
            // its own: its state would overwrite the user's, and its
            // `SessionStart` would repoint the terminal at a thread the user
            // never opened. Ignore the whole payload.
            _ => None,
        };
    }
    resolve_main(event, payload)
}

/// [`resolve_state`] for an event of the session's own thread.
fn resolve_main(event: &str, payload: &Value) -> Option<AgentState> {
    match event {
        // A turn is running — the user's prompt started it.
        "UserPromptSubmit" => Some(AgentState::Active),
        // Still running, mid-turn. A heartbeat, not a transition (see `record`).
        "PostToolUse" | "PostToolUseFailure" => Some(AgentState::Active),
        "SessionStart" if payload.get("source").and_then(Value::as_str) == Some("compact") => None,
        "SessionStart" | "Stop" | "StopFailure" => Some(AgentState::Idle),
        "SessionEnd" => Some(AgentState::Exited),
        "PermissionRequest" => Some(AgentState::Permission),
        "Elicitation" => Some(AgentState::Waiting),
        "ElicitationResult" => Some(AgentState::Active),
        "Notification" => match payload.get("notification_type").and_then(Value::as_str) {
            // `worker_permission_prompt` is an agent-team worker's permission
            // dialog, shown to the user by the lead (in the CLI, not in its
            // hooks reference).
            Some("permission_prompt" | "worker_permission_prompt") => Some(AgentState::Permission),
            Some(
                "agent_needs_input"
                | "elicitation_dialog"
                | "elicitation_url_dialog"
                | "quota_auto_resume_stale",
            ) => Some(AgentState::Waiting),
            // At the prompt, not asked anything: reading `idle_prompt` as a
            // question showed every session left alone for a minute as "needs you".
            Some("agent_completed" | "idle_prompt") => Some(AgentState::Idle),
            // Auth / elicitation-result notifications aren't a state change.
            Some(_) => None,
            // Older CLIs send no type — fall back to the prior "needs input".
            None => Some(AgentState::Waiting),
        },
        _ => None,
    }
}

/// Whether an event is a *heartbeat* — evidence that the turn is still moving,
/// rather than a transition into a new state.
///
/// The distinction is what lets the per-tool events be injected at all. A
/// heartbeat may refresh "still working" and may advance the clock, but it must
/// never move the session *out* of a state the user has to answer: these hooks
/// are `async`, so two of them can land out of order, and a straggler writing
/// "active" over a live permission prompt is the failure the per-tool events were
/// previously excluded to avoid. Enforced in [`record`].
fn is_heartbeat_event(event: &str) -> bool {
    matches!(event, "PostToolUse" | "PostToolUseFailure")
}

/// Whether this `SessionStart` must repoint the terminal's stored session id.
///
/// The two providers answer it for opposite reasons:
///
/// - **Claude** launches under an id santree chose (`--session-id`), so the row
///   is already right; only `clear` and `fork` mint an id we never chose
///   (`startup`/`resume` run ours, `compact` keeps it). Gating on the `source`
///   is what stops a stray SessionStart — an env-inheriting subprocess, a
///   subagent — from hijacking the row.
/// - **Codex** has no launch-time id flag: it always mints its own, and this
///   hook is the *only* way santree learns it. So every SessionStart binds, and
///   the anti-hijack guard is elsewhere — the subagent check in
///   [`resolve_state`], plus the fact that Codex only runs this command when
///   santree injected it into that one launch.
fn binds_session_id(agent: AgentKind, source: Option<&str>) -> bool {
    match agent {
        AgentKind::Claude => matches!(source, Some("clear") | Some("fork")),
        AgentKind::Codex => true,
        // No other provider is wired to this binary; never touch a row for one.
        AgentKind::Cursor | AgentKind::Opencode => false,
    }
}

/// The fields one hook invocation takes out of its payload.
#[derive(Debug, PartialEq, Eq)]
struct HookInput<'a> {
    /// Empty when absent — a payload we can't correlate to a session.
    session_id: &'a str,
    cwd: &'a str,
    transcript_path: Option<&'a str>,
    /// Tooltip text for the "needs you" states only (see [`read_hook_input`]).
    message: Option<String>,
    /// `SessionStart`'s reason, which decides whether Claude rebinds the row.
    source: Option<&'a str>,
    /// Who put a pending prompt on screen, as `session_state.asker` stores it:
    /// `main` (the session's own thread), `agent:<id>` (a subagent), or `None`
    /// when it can't be told — a Notification is the session's even when the
    /// dialog it reports is a subagent's (CLI 2.1.312). `None` for every state
    /// that isn't pending.
    asker: Option<String>,
    /// The turn, mode and effort the payload names, when it does.
    header: Header<'a>,
}

/// What a payload says about the session beside its state: the turn it
/// belongs to and the header's permission mode and effort (CLI 2.1.312:
/// `PermissionRequest`, `PostToolUse`, `Stop` and `UserPromptSubmit` carry
/// `permission_mode`; all but `UserPromptSubmit` carry `effort`; the
/// Notifications, `SessionStart` and `SessionEnd` carry neither). A value
/// that isn't a short string reads as absent, and an absent one leaves the
/// stored value as it was.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Header<'a> {
    prompt_id: Option<&'a str>,
    permission_mode: Option<&'a str>,
    effort: Option<&'a str>,
}

/// The most a header value or an id may be. Real ones are a UUID or a word.
const MAX_SHORT: usize = 128;

impl<'a> Header<'a> {
    fn of(payload: &'a Value) -> Self {
        let short = |v: Option<&'a Value>| {
            v.and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= MAX_SHORT)
        };
        Self {
            prompt_id: short(payload.get("prompt_id")),
            permission_mode: short(payload.get("permission_mode")),
            effort: short(payload.get("effort").and_then(|e| e.get("level"))),
        }
    }
}

/// The most of an API error's text a `StopFailure` row keeps as its message.
const MAX_ERROR_MESSAGE: usize = 2 * 1024;

/// Read a hook payload's fields, by the key names both CLIs actually send.
///
/// Split out of `main` because those key *spellings* are the whole contract with
/// the vendors: Claude and Codex both send snake_case, and a payload read under
/// any other spelling parses fine, resolves a state, finds an empty session id and
/// exits 0 — no error, no row, no session on the sidebar. Nothing else in this
/// binary would notice, so the test that pins them needs a seam to read through.
///
/// Only the "needs you" states carry tooltip text; running/idle/exited don't (so
/// consecutive tool events dedup to a single "running", see [`record`]). For
/// permission, fall back to the tool name as "run <tool>". The one idle row
/// with a message is a `StopFailure`'s: the API error that ended the turn
/// (`last_assistant_message`, e.g. `API Error: Request rejected (429) · …`),
/// bounded.
fn read_hook_input<'a>(payload: &'a Value, event: &str, state: AgentState) -> HookInput<'a> {
    let field = |k: &str| payload.get(k).and_then(Value::as_str);
    HookInput {
        session_id: field("session_id").unwrap_or_default(),
        cwd: field("cwd").unwrap_or_default(),
        transcript_path: field("transcript_path"),
        message: match state {
            AgentState::Permission => field("message")
                .map(str::to_string)
                .or_else(|| field("tool_name").map(|t| format!("run {t}"))),
            AgentState::Waiting => field("message").map(str::to_string),
            AgentState::Idle if event == "StopFailure" => Some(
                field("last_assistant_message")
                    .or_else(|| field("error"))
                    .map(|text| cut(text, MAX_ERROR_MESSAGE).to_string())
                    .unwrap_or_else(|| "API error".to_string()),
            ),
            _ => None,
        },
        source: field("source"),
        asker: state
            .is_blocked_on_user()
            .then(
                || match payload.get("agent_id").filter(|id| !id.is_null()) {
                    Some(id) => id
                        .as_str()
                        // Any other shape is stored as an unknown asker.
                        .filter(|id| is_subagent_id(id))
                        .map(|id| format!("{SUBAGENT_ASKER}{id}")),
                    // The dialog's own event names who asked by leaving
                    // `agent_id` out; a Notification can't tell.
                    None if matches!(event, "PermissionRequest" | "Elicitation") => {
                        Some(MAIN_ASKER.to_string())
                    }
                    None => None,
                },
            )
            .flatten(),
        header: Header::of(payload),
    }
}

/// `text`'s first `max` bytes at most, ending on a char boundary.
fn cut(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// `text`'s last `max` bytes at most, starting on a char boundary.
fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

// ── The dialog on record ─────────────────────────────────────────────────────

/// The most of a dialog's input a row keeps, as JSON text.
const MAX_PENDING_INPUT: usize = 64 * 1024;
/// The most of a permission request's suggestions a row keeps, as JSON text.
const MAX_PENDING_SUGGESTIONS: usize = 16 * 1024;

/// The dialog a `PermissionRequest` or an `Elicitation` puts on screen, as
/// `session_state.pending_*` stores it beside the row's state: what the
/// Conversation view's card draws, and the bounds of what a click on it may
/// type (COMPLIANCE.md). Claude's only — Codex's `PermissionRequest` is
/// shaped differently and answered in the terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingDialog {
    kind: DialogKind,
    tool: Option<String>,
    /// JSON text, always valid ([`capped_json`]).
    input: String,
    /// JSON text of `permission_suggestions`, when the payload carried one.
    suggestions: Option<String>,
    mcp_server: Option<String>,
    agent_id: Option<String>,
    agent_type: Option<String>,
    mode: Option<String>,
    prompt_id: Option<String>,
    truncated: bool,
    /// A permission request's tool call ([`call_id`]), which the hooks that
    /// report it finished name the same way.
    call: Option<String>,
}

/// The dialog `event` announces, by the key names Claude sends (CLI 2.1.312,
/// captured: notes in the wave-3 contract). `None` for every other event, and
/// for any provider but Claude.
fn pending_dialog(event: &str, agent: AgentKind, payload: &Value) -> Option<PendingDialog> {
    if agent != AgentKind::Claude {
        return None;
    }
    let text = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .map(|s| cut(s, MAX_SHORT).to_string())
    };
    let (kind, tool, input, mcp_server) = match event {
        "PermissionRequest" => {
            let input = payload.get("tool_input").cloned().unwrap_or(Value::Null);
            // `{"name":"probe","source":"dynamic"}`; read a bare name too.
            let server = payload.get("mcp_server");
            let server = text(server.and_then(|s| s.get("name")).or(server));
            (
                DialogKind::Permission,
                text(payload.get("tool_name")),
                input,
                server,
            )
        }
        "Elicitation" => {
            // The elicitation's own fields, as one object: a form's schema or
            // a URL, and what the server says.
            let mut fields = serde_json::Map::new();
            for key in [
                "message",
                "mode",
                "requested_schema",
                "url",
                "elicitation_id",
            ] {
                if let Some(v) = payload.get(key).filter(|v| !v.is_null()) {
                    fields.insert(key.to_string(), v.clone());
                }
            }
            (
                DialogKind::Elicitation,
                None,
                Value::Object(fields),
                text(payload.get("mcp_server_name")),
            )
        }
        _ => return None,
    };
    let (input, input_cut) = capped_json(&input, MAX_PENDING_INPUT);
    let suggestions = payload
        .get("permission_suggestions")
        .filter(|s| s.is_array())
        .map(|s| capped_json(s, MAX_PENDING_SUGGESTIONS));
    let header = Header::of(payload);
    Some(PendingDialog {
        kind,
        tool,
        input,
        truncated: input_cut || suggestions.as_ref().is_some_and(|(_, cut)| *cut),
        suggestions: suggestions.map(|(json, _)| json),
        mcp_server,
        agent_id: text(payload.get("agent_id")),
        agent_type: text(payload.get("agent_type")),
        mode: header.permission_mode.map(str::to_string),
        prompt_id: header.prompt_id.map(str::to_string),
        call: (kind == DialogKind::Permission).then(|| {
            call_id(
                payload.get("agent_id"),
                payload.get("tool_name"),
                payload.get("tool_input"),
            )
        }),
    })
}

/// One tool call as the hooks name it, the same in the `PermissionRequest`
/// that asked about it and in the hooks that report it finished: the thread
/// that made it (`agent_id`; absent or null for the session's own), the tool,
/// and its whole input — never the stored copy, which can be cut. The request
/// carries no `tool_use_id`, but its `tool_input` is the finished call's, key
/// for key (CLI 2.1.312, captured: all 67 requests of the stacked and serial
/// probes against their `PostToolBatch` entries, and the `Bash`, `Read` and
/// `Edit` ones against their `PostToolUse`; a question's and a plan's
/// `PostToolUse` carries the answer instead).
///
/// SHA-256 rather than a fast hash: the input is the model's to choose, and
/// a collision would read an open dialog as answered.
fn call_id(
    agent_id: Option<&Value>,
    tool_name: Option<&Value>,
    tool_input: Option<&Value>,
) -> String {
    let null = Value::Null;
    let mut text = String::from("[");
    canonical_json(agent_id.unwrap_or(&null), &mut text);
    text.push(',');
    canonical_json(tool_name.unwrap_or(&null), &mut text);
    text.push(',');
    canonical_json(tool_input.unwrap_or(&null), &mut text);
    text.push(']');
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// `value` as compact JSON text with every object's keys in order, so equal
/// values always read the same: whether serde_json keeps a payload's key order
/// depends on the build (`preserve_order` is on in the app, which applies the
/// relayed hooks).
fn canonical_json(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                canonical_json(item, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_json(item, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

/// The tool calls a hook reports finished ([`call_id`]): a `PostToolUse`'s or
/// `PostToolUseFailure`'s own, or every call a `PostToolBatch` lists — which
/// is the one hook a rejection with feedback fires, and the one that names a
/// question's or a plan's call as it was asked. Claude's only, like the dialogs
/// they resolve.
fn finished_calls(event: &str, agent: AgentKind, payload: &Value) -> Vec<String> {
    if agent != AgentKind::Claude {
        return Vec::new();
    }
    let thread = payload.get("agent_id");
    let one = |call: &Value| call_id(thread, call.get("tool_name"), call.get("tool_input"));
    match event {
        "PostToolUse" | "PostToolUseFailure" => vec![one(payload)],
        "PostToolBatch" => payload
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|calls| calls.iter().map(one).collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// `value` as JSON text of at most `max` bytes, and whether anything was cut.
///
/// Cut by shortening the longest strings inside — an edit's `new_string`, a
/// written file's `content`, a plan — never by cutting the text, so what is
/// stored always parses. A value still too long with every string down to a
/// few characters (thousands of keys) is stored as `null`.
fn capped_json(value: &Value, max: usize) -> (String, bool) {
    let whole = value.to_string();
    if whole.len() <= max {
        return (whole, false);
    }
    let mut keep = max / 2;
    while keep >= 16 {
        let mut shortened = value.clone();
        shorten_strings(&mut shortened, keep);
        let text = shortened.to_string();
        if text.len() <= max {
            return (text, true);
        }
        keep /= 2;
    }
    ("null".to_string(), true)
}

/// Cut every string in `value` (keys excepted) to at most `max` bytes.
fn shorten_strings(value: &mut Value, max: usize) {
    match value {
        Value::String(s) if s.len() > max => {
            let kept = cut(s, max).len();
            s.truncate(kept);
        }
        Value::Array(items) => items.iter_mut().for_each(|v| shorten_strings(v, max)),
        Value::Object(map) => map.values_mut().for_each(|v| shorten_strings(v, max)),
        _ => {}
    }
}

/// `session_state.asker` for a prompt the session's own thread put up.
const MAIN_ASKER: &str = "main";
/// `session_state.asker`'s prefix for a prompt a subagent put up.
const SUBAGENT_ASKER: &str = "agent:";

/// What this invocation is. The trailing positional selects it: a hook event
/// name, Claude's `statusline` command, or `mcp` — the AI-review tool server.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    /// One hook event, from the provider `--agent-kind` named (Claude when the
    /// flag is absent).
    Hook {
        event: String,
        agent: AgentKind,
    },
    /// `then`: the user's own status-line command to hand the payload to once
    /// it's recorded (the global passthrough — see [`passthrough`]). `None`
    /// prints santree's own bar instead.
    Statusline {
        then: Option<String>,
    },
    Mcp(mcp::McpScope),
}

/// Parse `santree-hook --db <path> [--agent-kind <Provider>] <Event>` /
/// `… statusline [--then <command>]` /
/// `… mcp --pr <owner/name> --number <n> --head <sha> --diff <path>`.
///
/// `None` means "don't run": the caller then exits 0 silently, because a hook that
/// complains about its own arguments would surface inside the user's session.
fn parse_args(args: impl Iterator<Item = String>) -> Option<(String, Mode)> {
    let mut db_path: Option<String> = None;
    let mut positional: Option<String> = None;
    let (mut pr, mut number, mut head, mut diff, mut agent_kind) = (None, None, None, None, None);
    let mut then: Option<String> = None;

    let mut args = args.peekable();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--db" => db_path = args.next(),
            "--pr" => pr = args.next(),
            "--number" => number = args.next(),
            "--head" => head = args.next(),
            "--diff" => diff = args.next(),
            "--agent-kind" => agent_kind = args.next(),
            // The whole user command is ONE argv element (the app shell-quotes it
            // as such), so this consumes exactly one — never a re-tokenised tail.
            "--then" => then = args.next(),
            other => positional = Some(other.to_string()),
        }
    }

    let (db_path, positional) = (db_path?, positional?);
    let mode = match positional.as_str() {
        "statusline" => Mode::Statusline {
            // An empty command is "no status line"; print our own bar instead of
            // handing the payload to a shell that would show nothing.
            then: then.filter(|c| !c.trim().is_empty()),
        },
        "mcp" => {
            let scope = mcp::McpScope::new(pr?, number?, head?, diff?)?;
            Mode::Mcp(match agent_kind {
                Some(kind) => scope.with_agent_kind(&kind)?,
                None => scope,
            })
        }
        event => Mode::Hook {
            event: event.to_string(),
            // Only these two run this binary; an unrecognised provider must not
            // fall through to Claude's rules and rewrite a row under them.
            agent: match agent_kind {
                Some(value) => {
                    let kind: AgentKind = value.parse().ok()?;
                    if !matches!(kind, AgentKind::Claude | AgentKind::Codex) {
                        return None;
                    }
                    kind
                }
                None => AgentKind::Claude,
            },
        },
    };
    Some((db_path, mode))
}

/// The binary: `santree-hook --db <path> …` (see [`parse_args`]).
pub fn run() {
    // Before anything is read: the closest this process comes to when the
    // event fired (see `StateWrite::fired_ms`).
    let fired_ms = now_ms();
    install_exit_zero_panic_hook();

    let Some((db_path, mode)) = parse_args(std::env::args().skip(1)) else {
        return; // exit 0
    };
    let (event, agent) = match mode {
        // Claude's status-line command, not a hook: it reads the status-line JSON,
        // captures the live usage, and prints the bar Claude renders — ours, or
        // the user's own command's output when passing through.
        Mode::Statusline { then } => {
            let mut raw = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut raw);
            let code = statusline(
                &db_path,
                then.as_deref(),
                &raw,
                &mut std::io::stdout().lock(),
                &mut std::io::stderr().lock(),
                fired_ms,
            );
            if code != 0 {
                std::process::exit(code);
            }
            return;
        }
        // The AI-review MCP server: a long-lived stdio session, not a one-shot.
        Mode::Mcp(scope) => {
            mcp::serve(&db_path, scope);
            return;
        }
        Mode::Hook { event, agent } => (event, agent),
    };

    // Read the hook JSON payload from stdin (both CLIs always pipe it).
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);

    // A one-shot insert on a minimal current-thread runtime; swallow every error.
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    rt.block_on(apply_hook(
        &mut PathStore(&db_path),
        &event,
        agent,
        raw.as_bytes(),
        &HookEnv::from_process(),
        fired_ms,
    ));
}

/// One hook event, start to finish, against any [`Store`]: derive the state,
/// record it, bind the session to its terminal, nudge the app. This is the
/// binary's hook mode and the app's relay alike — one flow, so they can't drift.
async fn apply_hook<S: Store>(
    store: &mut S,
    event: &str,
    agent: AgentKind,
    stdin: &[u8],
    env: &HookEnv,
    fired_ms: i64,
) {
    let payload: Value = serde_json::from_slice(stdin).unwrap_or(Value::Null);

    // The reply as Claude draws it: its own table and its own nudge, never the
    // session's state (it fires once per line batch).
    if event == LIVE_TEXT_EVENT {
        if agent != AgentKind::Claude {
            return;
        }
        let Some(batch) = live_batch(&payload, fired_ms) else {
            return;
        };
        let recorded = store.record_live_text(&batch).await;
        if store
            .noted(event, "recording the live text", recorded)
            .unwrap_or(false)
        {
            store.nudge_live_text(batch.session_id);
        }
        return;
    }

    // A call that finished resolves the permission dialog that asked about it,
    // whichever thread made it — so before the state, which a subagent's tool
    // events and a `PostToolBatch` never move.
    let finished = finished_calls(event, agent, &payload);
    let session = payload.get("session_id").and_then(Value::as_str);
    if let Some(session_id) = session.filter(|s| !s.is_empty() && !finished.is_empty()) {
        let resolved = store.resolve_calls(session_id, &finished, fired_ms).await;
        if store
            .noted(event, "resolving the dialog's call", resolved)
            .unwrap_or(false)
        {
            store.nudge(STATE_TAG);
        }
    }

    let Some(state) = resolve_state(event, agent, &payload) else {
        return; // event/notification that doesn't change state
    };

    let HookInput {
        session_id,
        cwd,
        transcript_path: transcript,
        message,
        source,
        asker,
        header,
    } = read_hook_input(&payload, event, state);
    if session_id.is_empty() {
        return; // can't correlate without a session id
    }
    let pending = pending_dialog(event, agent, &payload);

    let recorded = store
        .record(&StateWrite {
            session_id,
            state,
            event,
            cwd,
            message: message.as_deref(),
            transcript,
            asker: asker.as_deref(),
            source,
            fired_ms,
            header,
            pending: pending.as_ref(),
            live_text: live_text_clear(event, state, header.prompt_id),
            notice: (event == "Notification")
                .then(|| payload.get("notification_type").and_then(Value::as_str))
                .flatten(),
        })
        .await;
    let recorded = store
        .noted(event, "recording session state", recorded)
        .unwrap_or_default();
    let mut wrote = recorded.state;
    if recorded.live_text {
        store.nudge_live_text(session_id);
    }

    // Bind the live session id to the terminal that launched it (see
    // [`binds_session_id`] for why each provider needs this). For Claude it
    // repairs a `/clear` or `/fork`, whose brand-new id santree would otherwise
    // never learn — leaving every reopen `--resume`ing the cleared conversation.
    // For Codex it *is* how the session becomes ours at all.
    //
    // The terminal's own identity is exported into our env at launch, so we write
    // *only that one terminal's* row — never another tab's, even though sibling
    // tabs share a cwd.
    if event == "SessionStart" && binds_session_id(agent, source) {
        let account = env.account_for(agent);
        let HookEnv { repo, term_key, .. } = env;
        if repo.is_empty() || term_key.is_empty() {
            // The one failure that makes a session permanently unattributable:
            // without these the row can't be bound to a surface, and every
            // downstream symptom (no sidebar row, an unresumable session) reads
            // as "the hook never ran". Say so once, here.
            store.note(
                event,
                &format!(
                    "not binding session {session_id}: SANTREE_REPO/SANTREE_TERM_KEY \
                     missing from the hook's environment (repo={repo:?}, term_key={term_key:?})"
                ),
            );
        } else {
            let bound = store
                .reconcile_terminal_session(repo, term_key, cwd, session_id, agent, account)
                .await;
            let reconciled = store
                .noted(event, "binding the session to its terminal", bound)
                .unwrap_or(false);
            wrote = wrote || reconciled;
        }
    }

    // Nudge the app over its signal socket so the UI refreshes in realtime. Best
    // effort — if the app isn't running the connect just fails, and the app picks
    // up this row on its next read. Byte `s` = a state change (anything but `u`).
    if wrote {
        store.nudge(STATE_TAG);
    }
}

/// The signal-socket tag byte for "a session's state changed".
const STATE_TAG: u8 = b's';
/// The signal-socket tag byte for "a session's live usage changed".
const USAGE_TAG: u8 = b'u';
/// The signal-socket tag byte for "a session's live text changed", followed
/// by the session id, so only a view showing that session reads again.
const LIVE_TEXT_TAG: u8 = b't';

// ── The reply as it streams (`MessageDisplay`) ───────────────────────────────

/// The event that carries the reply Claude is drawing. santree registers it
/// only on this Mac and only while Settings → Experimental → Conversation
/// view is on (`hooks.rs`); the Daedalus relay refuses it.
const LIVE_TEXT_EVENT: &str = "MessageDisplay";

/// The most of one message's text the live-text table keeps: its tail.
const MAX_LIVE_TEXT: usize = 32 * 1024;

/// What a batch counts against [`MAX_LIVE_TEXT`] at least: a real batch is a
/// line or more, and this keeps a message to 512 rows whatever its batches
/// hold.
const MIN_BATCH_WEIGHT: usize = 64;

/// One `MessageDisplay` event: a batch of whole lines of the main thread's
/// reply (CLI 2.1.312, captured): `turn_id`, `message_id`, `index` (from 0 per
/// message), `final` on the message's last batch, `delta` the lines.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LiveBatch<'a> {
    session_id: &'a str,
    message_id: &'a str,
    index: i64,
    turn_id: Option<&'a str>,
    prompt_id: Option<&'a str>,
    /// The batch's text, its tail only when it alone is over the cap.
    delta: &'a str,
    /// `delta` lost its head to the cap.
    cut: bool,
    is_final: bool,
    fired_ms: i64,
}

/// A `MessageDisplay` payload as a [`LiveBatch`], or `None` when it is not
/// one — a missing id or index, or a subagent's (which 2.1.312 never sends:
/// only the session's own reply is drawn live).
fn live_batch(payload: &Value, fired_ms: i64) -> Option<LiveBatch<'_>> {
    if payload.get("agent_id").is_some_and(|id| !id.is_null()) {
        return None;
    }
    let short = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= MAX_SHORT)
    };
    let index = payload
        .get("index")?
        .as_i64()
        .filter(|i| (0..=1_000_000).contains(i))?;
    let delta = payload.get("delta")?.as_str().filter(|d| !d.is_empty())?;
    let kept = tail(delta, MAX_LIVE_TEXT);
    Some(LiveBatch {
        session_id: short("session_id")?,
        message_id: short("message_id")?,
        index,
        turn_id: short("turn_id"),
        prompt_id: short("prompt_id"),
        delta: kept,
        cut: kept.len() < delta.len(),
        is_final: payload.get("final").and_then(Value::as_bool) == Some(true),
        fired_ms,
    })
}

/// Which of a session's live text a state event ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LiveTextClear<'a> {
    /// All of it: the process started or ended, or Claude went idle on its
    /// own (a Notification names no turn).
    All,
    /// The turn `prompt_id`'s: it ended (`Stop`, `StopFailure`), or put up a
    /// dialog, which means the message before it is in the transcript.
    Turn(&'a str),
    /// Every turn's but `prompt_id`'s: a new turn began. A message queued
    /// mid-turn fires `UserPromptSubmit` with the running turn's id, so it
    /// clears nothing of the turn it joins.
    Before(&'a str),
}

/// What a state event clears of the live text. A heartbeat clears nothing,
/// and neither does a Notification about a dialog (the dialog's own event
/// already did).
fn live_text_clear<'a>(
    event: &str,
    state: AgentState,
    prompt_id: Option<&'a str>,
) -> Option<LiveTextClear<'a>> {
    match (event, state) {
        ("SessionStart" | "SessionEnd", _) | (_, AgentState::Exited) => Some(LiveTextClear::All),
        ("UserPromptSubmit", _) => {
            Some(prompt_id.map_or(LiveTextClear::All, LiveTextClear::Before))
        }
        ("Stop" | "StopFailure" | "PermissionRequest" | "Elicitation", _) => {
            Some(prompt_id.map_or(LiveTextClear::All, LiveTextClear::Turn))
        }
        ("Notification", AgentState::Idle) => Some(LiveTextClear::All),
        _ => None,
    }
}

/// Exit 0 even on a panic.
///
/// "Always exits 0 on every failure path" is the invariant COMPLIANCE.md leans on so
/// this binary can never disrupt the user's Claude session — but a panic bypasses
/// every hand-written failure path and exits 101 (or aborts, under the release
/// profile's `panic = "abort"`). Claude surfaces a non-zero hook exit to the user,
/// and `SessionEnd` — the one hook registered synchronously — would show it right at
/// teardown. So panic like normal (the message still reaches stderr, which Claude
/// does not display at exit 0, but `claude --debug` does), then exit 0 regardless.
fn install_exit_zero_panic_hook() {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        report(info);
        std::process::exit(0);
    }));
}

/// The file [`note`] appends to, beside the db this hook was pointed at.
const FAILURE_LOG: &str = "santree-hook-errors.log";

/// Past this the log is truncated before the next line. Failures are rare by
/// construction, so this is a backstop against an unbounded file, not a budget.
const FAILURE_LOG_MAX_BYTES: u64 = 64 * 1024;

/// Leave one line in `<db_dir>/santree-hook-errors.log` saying what went wrong.
///
/// This binary's contract is that it prints nothing on the hook path and exits 0
/// however badly it fails (COMPLIANCE.md) — which also meant that *every* way it
/// could fail was invisible. A Codex session that never reached the sidebar, a
/// `--db` bound to the wrong path, a locked database: all of them looked
/// identical from outside, and identical to "the hook never ran at all". Three
/// separate fixes were aimed at the wrong half of that ambiguity before the real
/// cause was found.
///
/// A file, not stdout/stderr: the invariant above is load-bearing and this must
/// not become output the agent CLI can see. Every step is best-effort — a hook
/// that cannot write its own error log still exits 0 and says nothing.
pub fn note(db_path: &str, event: &str, detail: &str) {
    let Some(path) = Path::new(db_path).parent().map(|d| d.join(FAILURE_LOG)) else {
        return;
    };
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > FAILURE_LOG_MAX_BYTES) {
        let _ = std::fs::remove_file(&path);
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(file, "{} [{event}] {detail}", now_ms());
}

/// Send a one-byte nudge over the app's signal socket (`<db_dir>/santree-signal.sock`).
/// The tag byte tells the app which table changed (`u` = live usage, `l` = rate
/// limits, `r` = review drafts, else state). Best-effort: a not-running app just
/// fails to connect.
pub(crate) fn ping_socket(db_path: &str, tag: u8) {
    ping_socket_with(db_path, &[tag]);
}

/// [`ping_socket`] with a tag and what follows it (the live-text nudge names
/// its session).
fn ping_socket_with(db_path: &str, signal: &[u8]) {
    if let Some(dir) = Path::new(db_path).parent() {
        if let Ok(mut stream) = UnixStream::connect(dir.join("santree-signal.sock")) {
            let _ = stream.write_all(signal);
        }
    }
}

// ── Status line (`santree-hook --db <path> statusline [--then <command>]`) ──
//
// Claude pipes the status-line JSON on stdin and renders whatever we print. We
// print a colored context-fill bar (Claude's own `used_percentage`) AND persist
// that authoritative number to `session_usage_live` + nudge the app, so the GUI's
// inline bar shows the exact same figure the terminal does. The same payload's
// optional `rate_limits` (the account's 5-hour / 7-day subscription windows) is
// persisted app-wide to `claude_rate_limits` the same display-only way. Never
// disrupts the session: any failure still prints (an empty bar at worst) and
// exits 0.
//
// With `--then <command>` — the opt-in *global* passthrough the app writes into
// the user's own `~/.claude/settings.json` — the recording is identical, but
// what Claude renders is the user's own status line: the same payload bytes are
// handed to their command and its stdout/stderr/exit code are forwarded verbatim
// (see `passthrough.rs`). A db failure never reaches them; only a command that
// can't even start falls back to our bar.

/// santree-cli's convention: inflate the shown context % by 20% (clamped) so the
/// warning colors trip earlier and nudge `/compact` while there's still headroom.
const CONTEXT_DISPLAY_MULTIPLIER: f64 = 1.2;

/// The status-line run: `raw` is the payload Claude piped in; what to render
/// goes to `out`/`err`; the return value is the process exit code. Split from
/// `main` so the passthrough contract can be tested without a real stdin.
/// `started_ms` is when this run began, before it read anything: when Claude
/// started the render.
fn statusline(
    db_path: &str,
    then: Option<&str>,
    raw: &[u8],
    out: &mut dyn Write,
    err: &mut dyn Write,
    started_ms: i64,
) -> i32 {
    // Start the user's command first: its runtime then overlaps the db write
    // below instead of adding to it. Its output is forwarded once both are done
    // (Claude renders on exit, so nothing is gained by streaming it earlier).
    let running = then.and_then(|command| match passthrough::spawn(command, raw) {
        Ok(running) => Some(running),
        Err(e) => {
            let _ = writeln!(
                err,
                "santree-hook: could not start the status line command ({e}); showing santree's bar"
            );
            None
        }
    });

    let p: Value = serde_json::from_slice(raw).unwrap_or(Value::Null);
    let reading = StatuslineReading::of(&p);

    // Without a passthrough this IS the status line: print the bar first so the
    // terminal renders promptly, then persist.
    if running.is_none() {
        let bar = render_bar(
            reading.used_pct,
            reading.input_tokens,
            reading.model_display,
        );
        let _ = out.write_all(bar.as_bytes());
        let _ = out.flush();
    }

    record_statusline(db_path, &p, &reading, started_ms);

    let Some(running) = running else {
        return 0;
    };
    let outcome = running.finish(passthrough::TIMEOUT);
    let _ = out.write_all(&outcome.stdout);
    let _ = out.flush();
    let _ = err.write_all(&outcome.stderr);
    match outcome.exit {
        passthrough::Exit::Code(code) => code,
        passthrough::Exit::TimedOut => {
            let _ = writeln!(
                err,
                "santree-hook: the status line command was still running after {}s and was stopped",
                passthrough::TIMEOUT.as_secs()
            );
            0
        }
    }
}

/// What the status line reads off its payload: the numbers it both renders
/// and records.
struct StatuslineReading<'a> {
    used_pct: f64,
    input_tokens: f64,
    context_size: f64,
    cost: f64,
    /// Stored (family mapping).
    model_id: &'a str,
    /// Shown.
    model_display: &'a str,
    /// `output_style.name`, for the Conversation view's header.
    output_style: Option<&'a str>,
    /// `vim.mode`, present only while vim mode is on.
    vim_mode: Option<&'a str>,
    /// `effort.level`, stored on the session's state row.
    effort: Option<&'a str>,
}

impl<'a> StatuslineReading<'a> {
    fn of(p: &'a Value) -> Self {
        let cw = p.get("context_window");
        let num = |v: Option<&Value>| v.and_then(Value::as_f64).unwrap_or(0.0);
        let model_obj = p.get("model");
        // Store the id (family mapping); show the display name.
        let model_id = model_obj
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let model_display = model_obj
            .and_then(|m| m.get("display_name"))
            .and_then(Value::as_str)
            .unwrap_or(model_id);
        let short = |v: Option<&'a Value>| {
            v.and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= MAX_SHORT)
        };
        Self {
            used_pct: num(cw.and_then(|c| c.get("used_percentage"))),
            input_tokens: num(cw.and_then(|c| c.get("total_input_tokens"))),
            context_size: num(cw.and_then(|c| c.get("context_window_size"))),
            cost: num(p.get("cost").and_then(|c| c.get("total_cost_usd"))),
            model_id,
            model_display,
            output_style: short(p.get("output_style").and_then(|o| o.get("name"))),
            vim_mode: short(p.get("vim").and_then(|v| v.get("mode"))),
            effort: short(p.get("effort").and_then(|e| e.get("level"))),
        }
    }
}

/// Persist what the payload carried — the session's live usage and the account's
/// rate-limit windows — and nudge the app for whichever changed. Best-effort in
/// every branch: a missing db, a locked db, or no runtime all mean "record
/// nothing", never "fail the status line".
fn record_statusline(db_path: &str, p: &Value, reading: &StatuslineReading<'_>, started_ms: i64) {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let env = HookEnv::from_process();
    rt.block_on(record_statusline_to(
        &mut PathStore(db_path),
        p,
        reading,
        env.account_for(AgentKind::Claude),
        Some(started_ms),
    ));
}

/// [`record_statusline`]'s writes against any [`Store`].
///
/// `account` is the santree account the session runs on (`SANTREE_ACCOUNT`):
/// its windows are that account's, and writing them over the Default
/// account's would show one account's usage as another's. `started_ms` is
/// when the render started, when that is known ([`note_render_on`]).
async fn record_statusline_to<S: Store>(
    store: &mut S,
    p: &Value,
    reading: &StatuslineReading<'_>,
    account: Option<&str>,
    started_ms: Option<i64>,
) {
    let session_id = p
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !session_id.is_empty() {
        let wrote = store
            .record_usage(session_id, reading, started_ms)
            .await
            .unwrap_or_default();
        if wrote.usage {
            store.nudge(USAGE_TAG);
        }
        if wrote.state {
            store.nudge(STATE_TAG);
        }
    }

    // The account-level rate-limit windows ride the same payload. They're not
    // tied to the session (every session reports the same numbers), so they're
    // recorded even without a session id, and skipped entirely when the payload
    // has none (API-key / Bedrock / Vertex sessions, or before the first response).
    let windows = parse_rate_limits(p);
    if !windows.is_empty() {
        let wrote = store
            .record_rate_limits(account, &windows)
            .await
            .unwrap_or(false);
        if wrote {
            store.nudge(RATE_LIMITS_TAG);
        }
    }
}

/// The signal-socket tag byte for "the rate-limit windows changed". `u` is the
/// per-session usage row and `r` the review server's writes; the app maps this
/// one to its own event so a limits repaint doesn't refetch either of those.
const RATE_LIMITS_TAG: u8 = b'l';

/// One subscription rate-limit window as the status line reported it.
#[derive(Debug, Clone, PartialEq)]
struct RateLimitWindow {
    /// The payload member name (`five_hour`, `seven_day`, ...).
    window: String,
    /// Claude's `used_percentage`, 0..100.
    used_pct: f64,
    /// Epoch ms the window resets, when the payload said.
    resets_at_ms: Option<i64>,
}

/// Every window under the payload's optional `rate_limits` object, in member
/// order. Claude Code 2.1.247 emits `five_hour` and/or `seven_day`, each
/// `{ used_percentage: 0..100, resets_at: <epoch seconds> }`, and only for
/// subscribers after the first API response. The members are read *generically*
/// (any object with a numeric `used_percentage`), so a window this build doesn't
/// know — a per-model weekly bucket, say — is recorded under its own name rather
/// than dropped. A member without a usable `used_percentage` is skipped; a
/// missing or non-object `rate_limits` yields nothing.
fn parse_rate_limits(payload: &Value) -> Vec<RateLimitWindow> {
    let Some(limits) = payload.get("rate_limits").and_then(Value::as_object) else {
        return Vec::new();
    };
    limits
        .iter()
        .filter_map(|(window, entry)| {
            let used_pct = entry.get("used_percentage")?.as_f64()?;
            if !used_pct.is_finite() {
                return None;
            }
            Some(RateLimitWindow {
                window: window.clone(),
                used_pct,
                resets_at_ms: entry.get("resets_at").and_then(epoch_ms),
            })
        })
        .collect()
}

/// A `resets_at` as epoch ms. Claude sends epoch *seconds* (its own docs and the
/// unified-ratelimit headers it derives them from agree), but the same field is
/// epoch ms elsewhere in its wire formats, so scale by magnitude: no timestamp in
/// seconds reaches 10^11 before the year 5138, and none in ms is below it after
/// 1973. Anything non-numeric or non-finite is "unknown", never a guess.
fn epoch_ms(value: &Value) -> Option<i64> {
    let n = value.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    let ms = if n < 1e11 { n * 1000.0 } else { n };
    Some(ms.round() as i64)
}

/// UPSERT each window's row. Returns `Ok(true)` when any row actually changed —
/// the status line repaints far more often than the limits move, so an unchanged
/// set writes nothing and doesn't nudge the UI. Never creates the db.
async fn record_rate_limits(
    db_path: &str,
    account: Option<&str>,
    windows: &[RateLimitWindow],
) -> Result<bool, sqlx::Error> {
    let Some(mut conn) = open(db_path).await? else {
        return Ok(false);
    };
    let wrote = record_rate_limits_on(&mut conn, account, windows).await?;

    // Same as `record_usage`: close before the caller nudges the app to read.
    conn.close().await?;
    Ok(wrote)
}

/// `account` picks the table: `None` (the Default account) is
/// `claude_rate_limits`, as it always was, so an older hook binary and this one
/// write the same rows; a named account's windows are keyed by it in
/// `claude_account_rate_limits`.
async fn record_rate_limits_on(
    conn: &mut SqliteConnection,
    account: Option<&str>,
    windows: &[RateLimitWindow],
) -> Result<bool, sqlx::Error> {
    let mut wrote = false;
    for w in windows {
        let current: Option<(f64, Option<i64>)> = match account {
            None => {
                sqlx::query_as(
                    "SELECT used_pct, resets_at_ms FROM claude_rate_limits WHERE window = ?",
                )
                .bind(&w.window)
                .fetch_optional(&mut *conn)
                .await?
            }
            Some(account) => {
                sqlx::query_as(
                    "SELECT used_pct, resets_at_ms FROM claude_account_rate_limits \
                     WHERE account = ? AND window = ?",
                )
                .bind(account)
                .bind(&w.window)
                .fetch_optional(&mut *conn)
                .await?
            }
        };
        if let Some((used, resets)) = current {
            if (used - w.used_pct).abs() < 1e-9 && resets == w.resets_at_ms {
                continue;
            }
        }
        let upsert = match account {
            None => sqlx::query(
                "INSERT INTO claude_rate_limits (window, used_pct, resets_at_ms, updated_at_ms) \
                 VALUES (?, ?, ?, ?) \
                 ON CONFLICT(window) DO UPDATE SET \
                   used_pct = excluded.used_pct, \
                   resets_at_ms = excluded.resets_at_ms, \
                   updated_at_ms = excluded.updated_at_ms",
            ),
            Some(account) => sqlx::query(
                "INSERT INTO claude_account_rate_limits \
                   (account, window, used_pct, resets_at_ms, updated_at_ms) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT(account, window) DO UPDATE SET \
                   used_pct = excluded.used_pct, \
                   resets_at_ms = excluded.resets_at_ms, \
                   updated_at_ms = excluded.updated_at_ms",
            )
            .bind(account),
        };
        upsert
            .bind(&w.window)
            .bind(w.used_pct)
            .bind(w.resets_at_ms)
            .bind(now_ms())
            .execute(&mut *conn)
            .await?;
        wrote = true;
    }
    Ok(wrote)
}

/// The colored 20-cell context bar Claude renders in the terminal — mirrors
/// santree-cli's `formatContextUsage` (same thresholds + 1.2x nudge) plus the
/// context tokens and model, so it lines up with the app's inline bar.
fn render_bar(used_pct: f64, input_tokens: f64, model: &str) -> String {
    let used = (used_pct * CONTEXT_DISPLAY_MULTIPLIER)
        .round()
        .clamp(0.0, 100.0) as i64;
    let color = if used >= 80 {
        "\x1b[01;31m" // red
    } else if used >= 60 {
        "\x1b[01;33m" // yellow
    } else {
        "\x1b[01;32m" // green
    };
    let width = 20i64;
    let filled = (used * width / 100).clamp(0, width) as usize;
    let bar = "▓".repeat(filled) + &"░".repeat(width as usize - filled);
    let mut out = format!("{color}[{bar}] {used}%\x1b[00m");
    if input_tokens > 0.0 {
        out.push_str(&format!(" · {}", compact(input_tokens)));
    }
    if !model.is_empty() {
        out.push_str(&format!(" · \x1b[01;34m{model}\x1b[00m"));
    }
    out
}

/// Compact token count: `604k`, `1.2M`, or a bare number.
fn compact(n: f64) -> String {
    if n >= 1_000_000.0 {
        format!("{:.1}M", n / 1_000_000.0)
    } else if n >= 1_000.0 {
        format!("{:.0}k", n / 1_000.0)
    } else {
        format!("{n:.0}")
    }
}

/// What one status-line render changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct UsageWrite {
    /// `session_usage_live` (a usage nudge).
    usage: bool,
    /// Something the state row shows (a state nudge): its effort, or the
    /// dialog on record closing ([`note_render_on`]).
    state: bool,
}

/// UPSERT the session's live usage. Dedups on an unchanged reading so identical
/// re-renders don't nudge the UI. Never creates the db.
async fn record_usage(
    db_path: &str,
    session_id: &str,
    reading: &StatuslineReading<'_>,
    started_ms: Option<i64>,
) -> Result<UsageWrite, sqlx::Error> {
    let Some(mut conn) = open(db_path).await? else {
        return Ok(UsageWrite::default());
    };
    let wrote = record_usage_on(&mut conn, session_id, reading, started_ms).await?;

    // Close before returning: the caller nudges the app the moment this resolves, and
    // the app then reads the row. Letting the connection drop instead hands the WAL
    // handoff to a background close that can still be racing that read.
    conn.close().await?;
    Ok(wrote)
}

/// The usage row, and the session's effort: the status line is the one
/// payload that carries `effort.level` before the first turn (and through a
/// `/effort` change, which fires no hook), so it keeps the state row's copy
/// current too.
async fn record_usage_on(
    conn: &mut SqliteConnection,
    session_id: &str,
    r: &StatuslineReading<'_>,
    started_ms: Option<i64>,
) -> Result<UsageWrite, sqlx::Error> {
    let closed = match started_ms {
        Some(started_ms) => note_render_on(conn, session_id, started_ms).await?,
        None => false,
    };
    let effort = match r.effort {
        Some(level) => {
            sqlx::query(
                "UPDATE session_state SET effort_level = ?1 \
                 WHERE session_id = ?2 AND effort_level IS NOT ?1",
            )
            .bind(level)
            .bind(session_id)
            .execute(&mut *conn)
            .await?
            .rows_affected()
                > 0
        }
        None => false,
    };
    let current: Option<(f64, i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT used_pct, input_tokens, output_style, vim_mode \
         FROM session_usage_live WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((up, it, style, vim)) = current {
        if (up - r.used_pct).abs() < 1e-9
            && it == r.input_tokens as i64
            && style.as_deref() == r.output_style
            && vim.as_deref() == r.vim_mode
        {
            return Ok(UsageWrite {
                usage: false,
                state: effort || closed,
            });
        }
    }

    sqlx::query(
        "INSERT INTO session_usage_live \
           (session_id, used_pct, input_tokens, context_size, model, cost_usd, updated_at_ms, \
            output_style, vim_mode) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(session_id) DO UPDATE SET \
           used_pct = excluded.used_pct, \
           input_tokens = excluded.input_tokens, \
           context_size = excluded.context_size, \
           model = excluded.model, \
           cost_usd = excluded.cost_usd, \
           updated_at_ms = excluded.updated_at_ms, \
           output_style = excluded.output_style, \
           vim_mode = excluded.vim_mode",
    )
    .bind(session_id)
    .bind(r.used_pct)
    .bind(r.input_tokens as i64)
    .bind(r.context_size as i64)
    .bind(r.model_id)
    .bind(r.cost)
    .bind(now_ms())
    .bind(r.output_style)
    .bind(r.vim_mode)
    .execute(&mut *conn)
    .await?;
    Ok(UsageWrite {
        usage: true,
        state: effort || closed,
    })
}

/// How long after a dialog was recorded a status-line render must start to
/// say the dialog closed. Claude can launch a render just before a dialog
/// draws (serial probe `sp1`: ~35 ms before), and a process starts when the
/// scheduler gets to it, not in launch order (a third of a second late and
/// more under load), while the dialog's own hook records it ~50 ms after the
/// draw. A false close costs more than a late one: the next request reads
/// whether it is stacked from it, and one behind the dialog would read
/// unstacked. At 1 s, a false close needs the render's process to start a
/// full second after the dialog's own hook landed; an answer within 1 s of a
/// dialog appearing closes it by its call, or by the next render.
const RENDER_MARGIN_MS: i64 = 1_000;

/// Note that Claude started a status-line render at `started_ms` (the
/// status-line command's own start), when it is the first to start after the
/// dialog on record was recorded ([`RENDER_MARGIN_MS`] after):
/// `pending_rendered_at_ms`, set once, and never `updated_at_ms` — that is the
/// dialog's record time and the reconciler's anchor. Returns whether that
/// closed the dialog ([`DialogMarks::closed_at`]).
///
/// Claude renders no status line while a dialog is open (CLI 2.1.312: none in
/// 35.8 s of stacked dialogs with a 15 s refresh), and renders 65-120 ms after
/// an answer when no dialog follows — the one sign an approval leaves until
/// the tool ends, and the only one an Esc leaves at all. A render that started
/// before the dialog was recorded and only lands after it says nothing about
/// it. One writer from the read to the write, like [`record_on`].
async fn note_render_on(
    conn: &mut SqliteConnection,
    session_id: &str,
    started_ms: i64,
) -> Result<bool, sqlx::Error> {
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let Some((recorded_at, marks)) = dialog_on_record(&mut tx, session_id).await? else {
        return Ok(false);
    };
    if started_ms <= recorded_at + RENDER_MARGIN_MS || marks.rendered_at_ms.is_some() {
        return Ok(false);
    }
    sqlx::query("UPDATE session_state SET pending_rendered_at_ms = ? WHERE session_id = ?")
        .bind(started_ms)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let rendered = DialogMarks {
        rendered_at_ms: Some(started_ms),
        ..marks
    };
    Ok(marks.closed_at().is_none() && rendered.closed_at().is_some())
}

/// The dialog the row holds, while it is still the row's — the write that
/// stored it is the row's latest (`pending_at_ms` is its `updated_at_ms`) and
/// the row is in that dialog's state — as when it was recorded and what has
/// been seen of it since. The app's reader (`hooks.rs` `pending_prompt`)
/// offers a dialog by the same test.
async fn dialog_on_record(
    conn: &mut SqliteConnection,
    session_id: &str,
) -> Result<Option<(i64, DialogMarks)>, sqlx::Error> {
    type Row = (
        String,
        Option<String>,
        Option<i64>,
        i64,
        Option<bool>,
        Option<i64>,
        Option<i64>,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT state, pending_kind, pending_at_ms, updated_at_ms, pending_stacked, \
                pending_rendered_at_ms, pending_resolved_at_ms \
         FROM session_state WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.and_then(
        |(state, kind, pending_at, updated_at, stacked, rendered, resolved)| {
            let kind = DialogKind::parse(kind.as_deref()?)?;
            let held =
                AgentState::parse(&state) == Some(kind.state()) && pending_at == Some(updated_at);
            held.then_some((
                updated_at,
                DialogMarks {
                    kind,
                    stacked: stacked.unwrap_or(false),
                    rendered_at_ms: rendered,
                    resolved_at_ms: resolved,
                },
            ))
        },
    ))
}

/// Note that the tool calls `finished` ended, at `ended_ms`: when one is the
/// call the permission dialog on record asked about, its
/// `pending_resolved_at_ms`, set once. Nothing else of the row moves — not its
/// state, not `updated_at_ms`: a dialog's own call ending is not the turn
/// moving on, and only some dialogs close by it ([`DialogMarks::closed_at`]).
/// Returns whether it was that call.
async fn resolve_calls_on(
    conn: &mut SqliteConnection,
    session_id: &str,
    finished: &[String],
    ended_ms: i64,
) -> Result<bool, sqlx::Error> {
    for call in finished {
        let resolved = sqlx::query(
            "UPDATE session_state SET pending_resolved_at_ms = ?1 \
             WHERE session_id = ?2 AND pending_call = ?3 AND pending_resolved_at_ms IS NULL \
               AND pending_kind = ?4 AND state = ?5 AND pending_at_ms = updated_at_ms",
        )
        .bind(ended_ms)
        .bind(session_id)
        .bind(call)
        .bind(DialogKind::Permission.as_str())
        .bind(DialogKind::Permission.state().as_str())
        .execute(&mut *conn)
        .await?
        .rows_affected()
            > 0;
        if resolved {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One write to `session_state`: what one hook event says about its session.
#[derive(Debug, Clone, Copy)]
struct StateWrite<'a> {
    session_id: &'a str,
    state: AgentState,
    event: &'a str,
    cwd: &'a str,
    message: Option<&'a str>,
    transcript: Option<&'a str>,
    /// Who asked, for a pending state ([`HookInput::asker`]).
    asker: Option<&'a str>,
    /// `SessionStart`'s reason ([`HookInput::source`]).
    source: Option<&'a str>,
    /// When this invocation began, epoch ms, before it read anything: the
    /// closest the hook gets to when the event fired (Claude spawns an `async`
    /// hook as the event happens). For a relayed event, when the app began
    /// applying it.
    fired_ms: i64,
    /// The turn, mode and effort the payload names ([`Header`]).
    header: Header<'a>,
    /// The dialog this event puts on screen, stored with the row
    /// ([`pending_dialog`]).
    pending: Option<&'a PendingDialog>,
    /// What of the session's live text this event ends ([`live_text_clear`]).
    live_text: Option<LiveTextClear<'a>>,
    /// A `Notification`'s `notification_type`.
    notice: Option<&'a str>,
}

/// What one [`record`] changed: the session's row (worth a state nudge), and
/// its live text (worth a live-text nudge).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Recorded {
    state: bool,
    live_text: bool,
}

/// Record one state write. Never creates the db — if the app hasn't made it
/// yet, no-op.
async fn record(db_path: &str, write: &StateWrite<'_>) -> Result<Recorded, sqlx::Error> {
    let Some(mut conn) = open(db_path).await? else {
        return Ok(Recorded::default());
    };
    let recorded = record_on(&mut conn, write).await?;
    conn.close().await?;
    Ok(recorded)
}

/// The row, then the live text the event ends. The live text goes whatever
/// the row did: a guard that keeps a subagent's dialog on record past the
/// main thread's `Stop` keeps the dialog, not the turn's streaming text.
///
/// One writer at a time from the read to the write: parallel tool calls fire
/// their `PermissionRequest`s within ~5 ms of each other, each in its own
/// hook process, and the second has to see the first to know it is stacked
/// ([`write_state`]). `IMMEDIATE` takes the write lock at `BEGIN`, so the
/// second waits on the busy timeout instead of reading a row the first is
/// about to replace.
async fn record_on(
    conn: &mut SqliteConnection,
    write: &StateWrite<'_>,
) -> Result<Recorded, sqlx::Error> {
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let state = write_state(&mut tx, write).await?;
    let live_text = match write.live_text {
        Some(clear) => clear_live_text_on(&mut tx, write.session_id, clear).await?,
        None => false,
    };
    tx.commit().await?;
    Ok(Recorded { state, live_text })
}

/// A `session_state` row as [`write_state`] reads it: state, message, asker,
/// `updated_at_ms`, `pending_kind`, permission mode, effort.
type CurrentRow = (
    String,
    Option<String>,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// UPSERT the session's current state, with the dialog it puts up and the
/// header values it carries. Returns whether anything the app shows changed
/// (so the caller nudges it).
async fn write_state(
    conn: &mut SqliteConnection,
    write: &StateWrite<'_>,
) -> Result<bool, sqlx::Error> {
    let &StateWrite {
        session_id,
        state,
        event,
        cwd,
        message,
        transcript,
        asker,
        source,
        fired_ms,
        header,
        pending,
        live_text: _,
        notice,
    } = write;
    // Dedup: if the stored state + message already match, do nothing (return
    // false → no UI nudge). This keeps high-frequency tool events from
    // re-nudging every tool call while already "running" — only real transitions
    // (e.g. permission → running, running → idle) write and notify.
    let current: Option<CurrentRow> = sqlx::query_as(
        "SELECT state, message, asker, updated_at_ms, pending_kind, permission_mode, \
                effort_level \
         FROM session_state WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    // A dialog recorded while the one on record is still open is behind it on
    // screen (`1 of 2`): parallel calls and a subagent asking beside the main
    // thread fire every `PermissionRequest` at once, and the ones behind fire
    // nothing when they come forward (CLI 2.1.312, probed). Open is "no sign
    // of its close yet" ([`DialogMarks::closed_at`]). In a serial pair the
    // first call's `PostToolUse` landed 4-11 ms before the next request in 9
    // of 9 runs; one that loses that race reads stacked, which only costs the
    // card.
    let stacked = match pending {
        Some(_) => dialog_on_record(conn, session_id)
            .await?
            .is_some_and(|(_, marks)| marks.closed_at().is_none()),
        None => false,
    };
    if let Some((cur_state, cur_message, cur_asker, cur_at, cur_pending, cur_mode, cur_effort)) =
        &current
    {
        let stored = AgentState::parse(cur_state);
        // A subagent's question outlives the main thread's turn: Claude runs
        // subagents in the background, and the main thread ends its turn (its
        // `Stop`, then `idle_prompt`) while the subagent's dialog is still on
        // screen. The session is at a dialog, not at its prompt, until a new
        // turn, a new process or the end of the session says otherwise.
        let subagents_dialog = state == AgentState::Idle
            && event != "SessionStart"
            && stored.is_some_and(AgentState::is_blocked_on_user)
            && cur_asker
                .as_deref()
                .is_some_and(|a| a.starts_with(SUBAGENT_ASKER));
        // A launch that carries its first prompt fires `SessionStart` and that
        // prompt's `UserPromptSubmit` ~50 ms apart, both `async`, so their writes
        // can land in either order. A row written after this `SessionStart`
        // began is the new process's own first turn — newer than this event —
        // and is not overwritten. Only a fresh or resumed process: `clear` and
        // `fork` start a session under a new id, and `compact` sets no state.
        let older_start = event == "SessionStart"
            && matches!(source, Some("startup" | "resume"))
            && *cur_at > fired_ms;
        // Claude's `permission_prompt` notification comes ~6 s into a dialog its
        // `PermissionRequest` already recorded, and says less about it (for a
        // subagent's dialog, not even the tool); an `elicitation_dialog` one
        // comes ~6 s into an `Elicitation` the same way. The record stays as
        // written — its dialog and its time the dialog's.
        let said_less = event == "Notification"
            && stored == Some(state)
            && ((state == AgentState::Permission && cur_message.is_some())
                || (state.is_blocked_on_user() && cur_pending.is_some()));
        // Nor does a notice about a dialog replace a dialog on record of the
        // other kind: a dialog recorded after the one the notice is about is
        // stacked with it (a subagent asks while the main thread's form is up,
        // and the form's notice lands ~6 s after the form), and writing the
        // notice there would drop that dialog's record.
        let notice_behind = cur_pending.is_some()
            && stored.is_some_and(AgentState::is_blocked_on_user)
            && matches!(
                notice,
                Some("permission_prompt" | "elicitation_dialog" | "elicitation_url_dialog")
            );
        // A heartbeat must never overrule a state the user still has to answer.
        // Tool hooks are registered `async`, so they are fire-and-forget with no
        // ordering guarantee: a `PostToolUse` from the *previous* tool can land
        // after the `PermissionRequest` for the next one, and writing "active"
        // there would clear a prompt that is still on screen. This is the whole
        // reason per-tool events were kept out before; handling them as
        // heartbeats — rather than as transitions — is what makes them safe.
        let stale_heartbeat =
            is_heartbeat_event(event) && stored.is_some_and(AgentState::is_blocked_on_user);
        // `ElicitationResult` answers an MCP server's form, and nothing else:
        // over a permission dialog — one a subagent raised while the form was
        // up, recorded stacked behind it — it is not that dialog's answer, and
        // the dialog comes forward firing nothing. Clearing it would read the
        // session as running with a dialog on screen, and the next request as
        // the only one up.
        let answers_another =
            event == "ElicitationResult" && stored == Some(AgentState::Permission);
        if subagents_dialog
            || older_start
            || said_less
            || notice_behind
            || stale_heartbeat
            || answers_another
        {
            return touch_header(conn, session_id, header).await;
        }
        // A dialog's own event always writes: the next of two parallel tool
        // calls asks with the same state and the same "run <tool>", and is a
        // new dialog all the same.
        if pending.is_none() && cur_state == state.as_str() && cur_message.as_deref() == message {
            // Same state, so no UI nudge — but the clock still advances when the
            // state is one the app reads as "working". `updated_at_ms` is the
            // app's evidence that the turn is still moving (see `hooks.rs`'s
            // `reconcile_live_state`), and a dedup'd write that left it frozen is
            // exactly how a busy agent decayed to idle mid-turn.
            //
            // Never for a blocked-on-user state: there `updated_at_ms` means
            // *when the prompt was recorded*, and the reconciler compares the
            // transcript against it to notice the user answered. Bumping it would
            // make a resolved prompt look pending forever.
            if state.is_blocked_on_user() {
                return touch_header(conn, session_id, header).await;
            }
            sqlx::query(
                "UPDATE session_state SET updated_at_ms = ?, \
                   prompt_id = COALESCE(?, prompt_id), \
                   permission_mode = COALESCE(?, permission_mode), \
                   effort_level = COALESCE(?, effort_level) \
                 WHERE session_id = ?",
            )
            .bind(now_ms())
            .bind(header.prompt_id)
            .bind(header.permission_mode)
            .bind(header.effort)
            .bind(session_id)
            .execute(&mut *conn)
            .await?;
            // A changed mode or effort is something the header shows.
            let moved = |new: Option<&str>, cur: &Option<String>| {
                new.is_some_and(|new| cur.as_deref() != Some(new))
            };
            return Ok(moved(header.permission_mode, cur_mode) || moved(header.effort, cur_effort));
        }
    }

    // A repeat of the same pending state that can't say who asked (the
    // Notification about a dialog already recorded) keeps the asker on record.
    // The dialog is the write's own: any write that gets here takes the row out
    // of the one on record, and a new dialog replaces it.
    let at = now_ms();
    sqlx::query(
        "INSERT INTO session_state \
           (session_id, state, event, cwd, message, transcript_path, updated_at_ms, asker, \
            prompt_id, permission_mode, effort_level, \
            pending_kind, pending_tool, pending_input, pending_suggestions, pending_mcp_server, \
            pending_agent_id, pending_agent_type, pending_mode, pending_prompt_id, \
            pending_truncated, pending_at_ms, pending_stacked, pending_call) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(session_id) DO UPDATE SET \
           state = excluded.state, \
           event = excluded.event, \
           cwd = excluded.cwd, \
           message = excluded.message, \
           transcript_path = excluded.transcript_path, \
           updated_at_ms = excluded.updated_at_ms, \
           asker = CASE WHEN excluded.asker IS NULL AND excluded.state = session_state.state \
                        THEN session_state.asker ELSE excluded.asker END, \
           prompt_id = COALESCE(excluded.prompt_id, session_state.prompt_id), \
           permission_mode = COALESCE(excluded.permission_mode, session_state.permission_mode), \
           effort_level = COALESCE(excluded.effort_level, session_state.effort_level), \
           pending_kind = excluded.pending_kind, \
           pending_tool = excluded.pending_tool, \
           pending_input = excluded.pending_input, \
           pending_suggestions = excluded.pending_suggestions, \
           pending_mcp_server = excluded.pending_mcp_server, \
           pending_agent_id = excluded.pending_agent_id, \
           pending_agent_type = excluded.pending_agent_type, \
           pending_mode = excluded.pending_mode, \
           pending_prompt_id = excluded.pending_prompt_id, \
           pending_truncated = excluded.pending_truncated, \
           pending_at_ms = excluded.pending_at_ms, \
           pending_stacked = excluded.pending_stacked, \
           pending_call = excluded.pending_call, \
           pending_rendered_at_ms = NULL, \
           pending_resolved_at_ms = NULL",
    )
    .bind(session_id)
    .bind(state.as_str())
    .bind(event)
    .bind(cwd)
    .bind(message)
    .bind(transcript)
    .bind(at)
    .bind(asker)
    .bind(header.prompt_id)
    .bind(header.permission_mode)
    .bind(header.effort)
    .bind(pending.map(|p| p.kind.as_str()))
    .bind(pending.and_then(|p| p.tool.as_deref()))
    .bind(pending.map(|p| p.input.as_str()))
    .bind(pending.and_then(|p| p.suggestions.as_deref()))
    .bind(pending.and_then(|p| p.mcp_server.as_deref()))
    .bind(pending.and_then(|p| p.agent_id.as_deref()))
    .bind(pending.and_then(|p| p.agent_type.as_deref()))
    .bind(pending.and_then(|p| p.mode.as_deref()))
    .bind(pending.and_then(|p| p.prompt_id.as_deref()))
    .bind(pending.map(|p| p.truncated))
    .bind(pending.map(|_| at))
    .bind(pending.map(|_| stacked))
    .bind(pending.and_then(|p| p.call.as_deref()))
    .execute(&mut *conn)
    .await?;
    Ok(true)
}

/// Store the mode and effort a payload carried, and nothing else — not the
/// state, the clock or the dialog — for an event a guard keeps from writing
/// the row. Returns whether either changed.
async fn touch_header(
    conn: &mut SqliteConnection,
    session_id: &str,
    header: Header<'_>,
) -> Result<bool, sqlx::Error> {
    if header.permission_mode.is_none() && header.effort.is_none() {
        return Ok(false);
    }
    let changed = sqlx::query(
        "UPDATE session_state SET \
           permission_mode = COALESCE(?1, permission_mode), \
           effort_level = COALESCE(?2, effort_level) \
         WHERE session_id = ?3 \
           AND (permission_mode IS NOT COALESCE(?1, permission_mode) \
                OR effort_level IS NOT COALESCE(?2, effort_level))",
    )
    .bind(header.permission_mode)
    .bind(header.effort)
    .bind(session_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(changed > 0)
}

/// Delete what `clear` ends of a session's live text. Returns whether
/// anything was there.
async fn clear_live_text_on(
    conn: &mut SqliteConnection,
    session_id: &str,
    clear: LiveTextClear<'_>,
) -> Result<bool, sqlx::Error> {
    let query = match clear {
        LiveTextClear::All => {
            sqlx::query("DELETE FROM session_live_text WHERE session_id = ?").bind(session_id)
        }
        LiveTextClear::Turn(prompt_id) => {
            sqlx::query("DELETE FROM session_live_text WHERE session_id = ? AND prompt_id = ?")
                .bind(session_id)
                .bind(prompt_id)
        }
        LiveTextClear::Before(prompt_id) => {
            sqlx::query("DELETE FROM session_live_text WHERE session_id = ? AND prompt_id IS NOT ?")
                .bind(session_id)
                .bind(prompt_id)
        }
    };
    Ok(query.execute(&mut *conn).await?.rows_affected() > 0)
}

/// Store one line batch of the reply Claude is drawing. Returns whether it
/// was stored (so the caller nudges the view).
///
/// - A batch of a turn already over is dropped: a message's final batch fires
///   in the same millisecond as the turn's `Stop` (captured), and both hooks
///   are async, so it can land after the `Stop` cleared the turn. Over means
///   the row is idle or exited from that same turn, or holds a dialog of that
///   turn recorded after the batch fired (the message before a tool call is
///   in the transcript once its dialog is up).
/// - Batches are rows keyed by their `index`, not appended text: a message's
///   batches can land out of order (captured: two fired in the same
///   millisecond and landed swapped), and the reader joins them in order.
/// - Only the session's newest message is kept, and its text is capped at
///   [`MAX_LIVE_TEXT`] by dropping its oldest batches (each counting at least
///   [`MIN_BATCH_WEIGHT`]); the first one kept is then marked `cut`.
async fn record_live_text_on(
    conn: &mut SqliteConnection,
    batch: &LiveBatch<'_>,
) -> Result<bool, sqlx::Error> {
    // The check and the insert under one write lock, or a `Stop` committing
    // between them would let a batch of its turn back in.
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let row: Option<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT state, prompt_id, updated_at_ms FROM session_state WHERE session_id = ?",
    )
    .bind(batch.session_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((state, prompt_id, at)) = row {
        if batch.prompt_id.is_some() && prompt_id.as_deref() == batch.prompt_id {
            let over = match AgentState::parse(&state) {
                Some(AgentState::Idle | AgentState::Exited) => true,
                Some(s) => s.is_blocked_on_user() && at >= batch.fired_ms,
                None => false,
            };
            if over {
                return Ok(false);
            }
        }
    }

    sqlx::query(
        "INSERT INTO session_live_text \
           (session_id, message_id, idx, turn_id, prompt_id, delta, final, cut, fired_ms) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(session_id, message_id, idx) DO UPDATE SET \
           turn_id = excluded.turn_id, \
           prompt_id = excluded.prompt_id, \
           delta = excluded.delta, \
           final = excluded.final, \
           cut = excluded.cut, \
           fired_ms = excluded.fired_ms",
    )
    .bind(batch.session_id)
    .bind(batch.message_id)
    .bind(batch.index)
    .bind(batch.turn_id)
    .bind(batch.prompt_id)
    .bind(batch.delta)
    .bind(batch.is_final)
    .bind(batch.cut)
    .bind(batch.fired_ms)
    .execute(&mut *tx)
    .await?;
    // An older message's text is in the transcript by the time the next one
    // streams. A straggler of an older message deletes nothing newer than it.
    sqlx::query(
        "DELETE FROM session_live_text \
         WHERE session_id = ? AND message_id <> ? AND fired_ms < ?",
    )
    .bind(batch.session_id)
    .bind(batch.message_id)
    .bind(batch.fired_ms)
    .execute(&mut *tx)
    .await?;
    // The cap: drop the oldest batches while the rest of the message is over it.
    let dropped = sqlx::query(
        "DELETE FROM session_live_text \
         WHERE session_id = ?1 AND message_id = ?2 AND idx <= ( \
           SELECT idx FROM ( \
             SELECT idx, SUM(MAX(length(CAST(delta AS BLOB)), ?4)) \
                      OVER (ORDER BY idx DESC) AS kept \
             FROM session_live_text WHERE session_id = ?1 AND message_id = ?2) \
           WHERE kept > ?3 ORDER BY idx DESC LIMIT 1)",
    )
    .bind(batch.session_id)
    .bind(batch.message_id)
    .bind(MAX_LIVE_TEXT as i64)
    .bind(MIN_BATCH_WEIGHT as i64)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if dropped > 0 {
        sqlx::query(
            "UPDATE session_live_text SET cut = 1 \
             WHERE session_id = ?1 AND message_id = ?2 AND idx = ( \
               SELECT MIN(idx) FROM session_live_text WHERE session_id = ?1 AND message_id = ?2)",
        )
        .bind(batch.session_id)
        .bind(batch.message_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// [`record_live_text_on`] against the db file at `db_path`.
async fn record_live_text(db_path: &str, batch: &LiveBatch<'_>) -> Result<bool, sqlx::Error> {
    let Some(mut conn) = open(db_path).await? else {
        return Ok(false);
    };
    let stored = record_live_text_on(&mut conn, batch).await?;
    conn.close().await?;
    Ok(stored)
}

/// Point the terminal `(repo, term_key, agent)`'s stored session id at
/// `session_id` — the session that provider is currently running under. Returns
/// `Ok(true)` when a row actually changed (so the caller nudges the app to
/// re-resolve); the `session_id <> …` guards make the common case (id unchanged)
/// a no-op write. Never creates the db.
///
/// Scoping to `agent` is load-bearing, not decoration. Since migration 0025 the
/// primary key is (repo, term_key, agent_kind), so one logical surface can hold a
/// Claude row AND a Codex row at once — that is how a worktree runs both. Without
/// it a Claude `/clear` rewrites the sibling *Codex* row's session_id to a Claude
/// UUID, throwing away the thread id: the next resolve finds no rollout for it and
/// starts a replacement, so the user's conversation is gone. `session.rs`'s reaper
/// scopes its DELETE the same way, for the same reason.
///
/// Whether a *missing* row may be created is the one place the providers differ,
/// and it follows from who mints the id:
///
/// - **Claude**: the app writes the row when it launches the terminal (it chose
///   the id), so this is repair only. A missing row means a session santree
///   doesn't track — an env-inheriting subprocess, a hand-run `claude` — and we
///   never fabricate one for it.
/// - **Codex**: `codex` mints its own id, so no row *can* exist before this hook
///   reports it. The insert is the binding; without it the session stays invisible
///   to the sidebar and can never be resumed.
async fn reconcile_terminal_session(
    db_path: &str,
    repo: &str,
    term_key: &str,
    cwd: &str,
    session_id: &str,
    agent: AgentKind,
    account: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let Some(mut conn) = open(db_path).await? else {
        return Ok(false);
    };
    let changed =
        reconcile_terminal_session_on(&mut conn, repo, term_key, cwd, session_id, agent, account)
            .await?;
    conn.close().await?;
    Ok(changed)
}

/// `account` is the santree account the session was launched on
/// (`SANTREE_ACCOUNT`). Only Codex's insert records it: a Claude row is written
/// by the app at launch with its account already in it.
async fn reconcile_terminal_session_on(
    conn: &mut SqliteConnection,
    repo: &str,
    term_key: &str,
    cwd: &str,
    session_id: &str,
    agent: AgentKind,
    account: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let statement = match agent {
        // A new thread on the surface is the launch's own: it runs on the
        // account the launch chose, so the row follows it.
        AgentKind::Codex => sqlx::query(
            "INSERT INTO terminal_sessions \
               (repo, term_key, cwd, session_id, agent_kind, account) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT (repo, term_key, agent_kind) DO UPDATE SET \
               session_id = excluded.session_id, \
               cwd = excluded.cwd, \
               account = excluded.account \
             WHERE terminal_sessions.session_id <> excluded.session_id",
        )
        .bind(repo)
        .bind(term_key)
        .bind(cwd)
        .bind(session_id)
        .bind(agent.as_str())
        .bind(account),
        _ => sqlx::query(
            "UPDATE terminal_sessions SET session_id = ? \
             WHERE repo = ? AND term_key = ? AND agent_kind = ? AND session_id <> ?",
        )
        .bind(session_id)
        .bind(repo)
        .bind(term_key)
        .bind(agent.as_str())
        .bind(session_id),
    };
    let affected = statement.execute(&mut *conn).await?.rows_affected();
    Ok(affected > 0)
}

/// A connection to the app's db for one write, or `None` when the db isn't
/// there — never creates it (if the app hasn't made it yet, the write is a
/// no-op).
///
/// WAL mode is a persistent property of the file, so a fresh connection
/// inherits it; just don't create a stray db and give writes room under the
/// app's concurrent access.
async fn open(db_path: &str) -> Result<Option<SqliteConnection>, sqlx::Error> {
    if !Path::new(db_path).exists() {
        return Ok(None);
    }
    SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(3))
        .connect()
        .await
        .map(Some)
}

// ── Where a hook's rows go ───────────────────────────────────────────────────

/// The writes one hook invocation makes, and where their side effects go. The
/// binary opens the db file per write and pings the signal socket
/// ([`PathStore`]); the app's relay writes through a connection from its own
/// pool and collects what to refresh ([`ConnStore`]). The *decisions* —
/// [`apply_hook`], [`record_statusline_to`] — are shared, so a relayed event
/// can't be recorded differently from a local one.
trait Store {
    async fn record(&mut self, write: &StateWrite<'_>) -> Result<Recorded, sqlx::Error>;

    /// Tool calls that finished ([`resolve_calls_on`]).
    async fn resolve_calls(
        &mut self,
        session_id: &str,
        finished: &[String],
        ended_ms: i64,
    ) -> Result<bool, sqlx::Error>;

    /// One `MessageDisplay` batch ([`record_live_text_on`]).
    async fn record_live_text(&mut self, batch: &LiveBatch<'_>) -> Result<bool, sqlx::Error>;

    async fn reconcile_terminal_session(
        &mut self,
        repo: &str,
        term_key: &str,
        cwd: &str,
        session_id: &str,
        agent: AgentKind,
        account: Option<&str>,
    ) -> Result<bool, sqlx::Error>;

    async fn record_usage(
        &mut self,
        session_id: &str,
        reading: &StatuslineReading<'_>,
        started_ms: Option<i64>,
    ) -> Result<UsageWrite, sqlx::Error>;

    async fn record_rate_limits(
        &mut self,
        account: Option<&str>,
        windows: &[RateLimitWindow],
    ) -> Result<bool, sqlx::Error>;

    /// Something failed that a human should be able to find later.
    fn note(&mut self, event: &str, detail: &str);

    /// A table changed; `tag` is the signal-socket byte naming which.
    fn nudge(&mut self, tag: u8);

    /// `session_id`'s live text changed.
    fn nudge_live_text(&mut self, session_id: &str);

    /// Unwrap a hook-path result, leaving a [`Store::note`] behind when it
    /// failed.
    ///
    /// The error is dropped, not propagated: the caller's next step is still to
    /// exit 0. What changes is that the failure is now recoverable *by a human
    /// reading the log*, instead of being indistinguishable from a hook that
    /// never fired.
    fn noted<T, E: std::fmt::Display>(
        &mut self,
        event: &str,
        what: &str,
        result: Result<T, E>,
    ) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(e) => {
                self.note(event, &format!("{what} failed: {e}"));
                None
            }
        }
    }
}

/// The binary's store: the db file at this path, one connection per write.
struct PathStore<'a>(&'a str);

impl Store for PathStore<'_> {
    async fn record(&mut self, write: &StateWrite<'_>) -> Result<Recorded, sqlx::Error> {
        record(self.0, write).await
    }

    async fn resolve_calls(
        &mut self,
        session_id: &str,
        finished: &[String],
        ended_ms: i64,
    ) -> Result<bool, sqlx::Error> {
        let Some(mut conn) = open(self.0).await? else {
            return Ok(false);
        };
        let resolved = resolve_calls_on(&mut conn, session_id, finished, ended_ms).await?;
        conn.close().await?;
        Ok(resolved)
    }

    async fn record_live_text(&mut self, batch: &LiveBatch<'_>) -> Result<bool, sqlx::Error> {
        record_live_text(self.0, batch).await
    }

    async fn reconcile_terminal_session(
        &mut self,
        repo: &str,
        term_key: &str,
        cwd: &str,
        session_id: &str,
        agent: AgentKind,
        account: Option<&str>,
    ) -> Result<bool, sqlx::Error> {
        reconcile_terminal_session(self.0, repo, term_key, cwd, session_id, agent, account).await
    }

    async fn record_usage(
        &mut self,
        session_id: &str,
        r: &StatuslineReading<'_>,
        started_ms: Option<i64>,
    ) -> Result<UsageWrite, sqlx::Error> {
        record_usage(self.0, session_id, r, started_ms).await
    }

    async fn record_rate_limits(
        &mut self,
        account: Option<&str>,
        windows: &[RateLimitWindow],
    ) -> Result<bool, sqlx::Error> {
        record_rate_limits(self.0, account, windows).await
    }

    fn note(&mut self, event: &str, detail: &str) {
        note(self.0, event, detail);
    }

    fn nudge(&mut self, tag: u8) {
        ping_socket(self.0, tag);
    }

    fn nudge_live_text(&mut self, session_id: &str) {
        let mut signal = Vec::with_capacity(1 + session_id.len());
        signal.push(LIVE_TEXT_TAG);
        signal.extend_from_slice(session_id.as_bytes());
        ping_socket_with(self.0, &signal);
    }
}

/// The relay's store: a connection the caller owns, and a record of what to
/// refresh and what failed instead of a socket and a log file.
struct ConnStore<'c> {
    conn: &'c mut SqliteConnection,
    applied: Applied,
}

impl Store for ConnStore<'_> {
    async fn record(&mut self, write: &StateWrite<'_>) -> Result<Recorded, sqlx::Error> {
        record_on(self.conn, write).await
    }

    async fn resolve_calls(
        &mut self,
        session_id: &str,
        finished: &[String],
        ended_ms: i64,
    ) -> Result<bool, sqlx::Error> {
        resolve_calls_on(self.conn, session_id, finished, ended_ms).await
    }

    async fn record_live_text(&mut self, batch: &LiveBatch<'_>) -> Result<bool, sqlx::Error> {
        record_live_text_on(self.conn, batch).await
    }

    async fn reconcile_terminal_session(
        &mut self,
        repo: &str,
        term_key: &str,
        cwd: &str,
        session_id: &str,
        agent: AgentKind,
        account: Option<&str>,
    ) -> Result<bool, sqlx::Error> {
        reconcile_terminal_session_on(self.conn, repo, term_key, cwd, session_id, agent, account)
            .await
    }

    async fn record_usage(
        &mut self,
        session_id: &str,
        r: &StatuslineReading<'_>,
        started_ms: Option<i64>,
    ) -> Result<UsageWrite, sqlx::Error> {
        record_usage_on(self.conn, session_id, r, started_ms).await
    }

    async fn record_rate_limits(
        &mut self,
        account: Option<&str>,
        windows: &[RateLimitWindow],
    ) -> Result<bool, sqlx::Error> {
        record_rate_limits_on(self.conn, account, windows).await
    }

    fn note(&mut self, _event: &str, detail: &str) {
        self.applied.failures.push(detail.to_string());
    }

    fn nudge(&mut self, tag: u8) {
        let nudges = &mut self.applied.nudges;
        match tag {
            USAGE_TAG => nudges.usage = true,
            RATE_LIMITS_TAG => nudges.rate_limits = true,
            _ => nudges.state = true,
        }
    }

    /// The relay never applies `MessageDisplay` ([`Invocation::parse_relayed`]),
    /// and a Daedalus session has no live text for a state event to clear, so
    /// there is nothing for a view to read again.
    fn nudge_live_text(&mut self, _session_id: &str) {}
}

// ── The relay's entry point ──────────────────────────────────────────────────

/// What santree exports into an agent's environment at launch and a hook reads
/// back: the terminal the session belongs to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookEnv {
    /// `SANTREE_REPO`.
    pub repo: String,
    /// `SANTREE_TERM_KEY`.
    pub term_key: String,
    /// `SANTREE_ACCOUNT` as found: the santree account the session was
    /// launched on, when it is not the Default one, agent-qualified
    /// (`claude:work`). Read it through [`HookEnv::account_for`], which accepts
    /// only a well-formed tag for the agent asking.
    pub account: Option<String>,
}

impl HookEnv {
    /// This process's own environment — the local binary's case.
    pub fn from_process() -> Self {
        Self {
            repo: std::env::var("SANTREE_REPO").unwrap_or_default(),
            term_key: std::env::var("SANTREE_TERM_KEY").unwrap_or_default(),
            account: std::env::var("SANTREE_ACCOUNT").ok(),
        }
    }

    /// The account id `agent`'s session runs on, or `None` for the Default
    /// account — including for a tag naming the other agent or malformed.
    pub fn account_for(&self, agent: AgentKind) -> Option<&str> {
        santree_core::domain::account_of_tag(self.account.as_deref()?, agent)
    }

    /// An environment captured elsewhere — the `env` pairs a relayed hook
    /// carries. The last value of a repeated name wins, as in a real env.
    /// `SANTREE_ACCOUNT` is not read: a Daedalus session always runs on the
    /// Default account, so a relayed one names nothing santree launched.
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut env = Self::default();
        for (key, value) in pairs {
            match key {
                "SANTREE_REPO" => env.repo = value.to_string(),
                "SANTREE_TERM_KEY" => env.term_key = value.to_string(),
                _ => {}
            }
        }
        env
    }
}

/// What a relayed invocation is — the binary's hook and status-line modes.
/// Never the MCP server: that is a live stdio session, not an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Hook {
        event: String,
        agent: AgentKind,
    },
    /// Recording only: the bar (or the user's own status line) is rendered
    /// where Claude runs, never relayed.
    Statusline,
}

impl Invocation {
    /// A relayed hook's `event`: the words the hook command passed after
    /// `santree-remote hook`, space-joined — exactly what follows `--db <path>`
    /// in the local `santree-hook` command, so `SessionStart`,
    /// `--agent-kind Codex SessionStart` and `statusline` all mean what they
    /// mean locally. Parsed by the binary's own [`parse_args`], so the two
    /// vocabularies can't drift. `None` for `mcp` and anything the binary
    /// wouldn't run, and for `MessageDisplay`: santree never registers it on
    /// the box, and a line-by-line feed is not something the relay takes.
    pub fn parse_relayed(event: &str) -> Option<Self> {
        let args = ["--db", "<relayed>"]
            .into_iter()
            .map(str::to_string)
            .chain(event.split_whitespace().map(str::to_string));
        match parse_args(args)?.1 {
            Mode::Hook { event, .. } if event == LIVE_TEXT_EVENT => None,
            Mode::Hook { event, agent } => Some(Self::Hook { event, agent }),
            Mode::Statusline { .. } => Some(Self::Statusline),
            Mode::Mcp(_) => None,
        }
    }
}

/// Which of the app's live reads an invocation changed — the signal-socket
/// tags the local binary would have sent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Nudges {
    /// `s`: `session_state` / `terminal_sessions`.
    pub state: bool,
    /// `u`: `session_usage_live`.
    pub usage: bool,
    /// `l`: `claude_rate_limits`.
    pub rate_limits: bool,
}

/// What [`apply`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    pub nudges: Nudges,
    /// What the binary would have written to `santree-hook-errors.log` — one
    /// line each, for the caller to log the same way.
    pub failures: Vec<String>,
}

/// Apply one hook invocation to the app's database through `conn`: the same
/// rows, in the same order, that `santree-hook --db <db> <args>` writes for
/// it with `stdin` on its stdin and `env` in its environment. Never fails —
/// like the binary, a failed write is reported (in [`Applied::failures`]),
/// not raised.
pub async fn apply(
    conn: &mut SqliteConnection,
    invocation: &Invocation,
    stdin: &[u8],
    env: &HookEnv,
) -> Applied {
    let mut store = ConnStore {
        conn,
        applied: Applied::default(),
    };
    match invocation {
        Invocation::Hook { event, agent } => {
            apply_hook(&mut store, event, *agent, stdin, env, now_ms()).await;
        }
        Invocation::Statusline => {
            let p: Value = serde_json::from_slice(stdin).unwrap_or(Value::Null);
            let reading = StatuslineReading::of(&p);
            // When the render started is on the box, and a render that started
            // just before a dialog fired can reach the queue after the dialog's
            // own hook: dated here it would read as that dialog's close. A
            // relayed render closes nothing.
            record_statusline_to(
                &mut store,
                &p,
                &reading,
                env.account_for(AgentKind::Claude),
                None,
            )
            .await;
        }
    }
    store.applied
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hook stays silent to the agent and still leaves a trace for a human.
    ///
    /// The bug this test exists for was invisible for a day: every failure path
    /// exits 0 and prints nothing, so "the write failed" and "the hook never
    /// fired" produced exactly the same evidence — none — and three fixes were
    /// aimed at the wrong one.
    #[test]
    fn a_failed_write_leaves_a_line_beside_the_db() {
        let dir = std::env::temp_dir().join(format!("santree-hook-note-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("santree.db");
        let log = dir.join(FAILURE_LOG);
        let _ = std::fs::remove_file(&log);

        let kept: Option<u8> = PathStore(db.to_str().unwrap()).noted(
            "SessionStart",
            "binding the session to its terminal",
            Err::<u8, _>("database is locked"),
        );
        assert!(kept.is_none());

        let written = std::fs::read_to_string(&log).unwrap();
        assert!(written.contains("[SessionStart]"), "{written}");
        assert!(written.contains("database is locked"), "{written}");

        // A success writes nothing: the log is for failures, not a trace of
        // every hook invocation.
        std::fs::remove_file(&log).unwrap();
        assert_eq!(
            PathStore(db.to_str().unwrap()).noted("Stop", "recording", Ok::<_, String>(7)),
            Some(7)
        );
        assert!(!log.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Unbounded append is how a "harmless" log becomes a real problem on a
    /// machine that hits the failure in a loop.
    #[test]
    fn the_failure_log_is_bounded() {
        let dir = std::env::temp_dir().join(format!("santree-hook-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("santree.db");
        let log = dir.join(FAILURE_LOG);
        std::fs::write(&log, "x".repeat(FAILURE_LOG_MAX_BYTES as usize + 1)).unwrap();

        note(db.to_str().unwrap(), "Stop", "over the cap");
        let len = std::fs::metadata(&log).unwrap().len();
        assert!(len < FAILURE_LOG_MAX_BYTES, "log kept growing: {len} bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn parse(args: &[&str]) -> Option<(String, Mode)> {
        parse_args(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parse_args_picks_the_mode_off_the_trailing_positional() {
        assert_eq!(
            parse(&["--db", "/d.db", "Stop"]),
            Some((
                "/d.db".into(),
                Mode::Hook {
                    event: "Stop".into(),
                    agent: AgentKind::Claude,
                }
            ))
        );
        // Codex's launches name themselves; everything else stays Claude's.
        assert_eq!(
            parse(&["--db", "/d.db", "--agent-kind", "Codex", "SessionStart"]),
            Some((
                "/d.db".into(),
                Mode::Hook {
                    event: "SessionStart".into(),
                    agent: AgentKind::Codex,
                }
            ))
        );
        assert_eq!(
            parse(&["--db", "/d.db", "statusline"]),
            Some(("/d.db".into(), Mode::Statusline { then: None }))
        );
        // The passthrough form: the user's whole command is one argv element, kept
        // verbatim — spaces, quotes and all — never split into more positionals.
        let theirs = "~/.claude/statusline.sh --style 'fancy' | head -1";
        assert_eq!(
            parse(&["--db", "/d.db", "statusline", "--then", theirs]),
            Some((
                "/d.db".into(),
                Mode::Statusline {
                    then: Some(theirs.into())
                }
            ))
        );
        // A blank command is no command: fall back to our own bar.
        assert_eq!(
            parse(&["--db", "/d.db", "statusline", "--then", "  "]),
            Some(("/d.db".into(), Mode::Statusline { then: None }))
        );
        let (db, mode) = parse(&[
            "--db", "/d.db", "mcp", "--pr", "acme/web", "--number", "42", "--head", "abc1234",
            "--diff", "/i.json",
        ])
        .unwrap();
        assert_eq!(db, "/d.db");
        assert_eq!(
            mode,
            Mode::Mcp(mcp::McpScope {
                pr_repo: "acme/web".into(),
                number: 42,
                head_sha: "abc1234".into(),
                diff_index: "/i.json".into(),
                agent_kind: santree_core::domain::AgentKind::Claude,
            })
        );
    }

    #[test]
    fn parse_args_refuses_anything_it_cannot_run() {
        // Each of these would otherwise start a server scoped to nothing, or a hook
        // with no db. Refusing means exit 0 and silence, never a half-run.
        for args in [
            vec![],
            vec!["--db"],
            vec!["Stop"],
            vec!["--db", "/d.db"],
            vec!["--db", "/d.db", "mcp"],
            vec!["--db", "/d.db", "mcp", "--pr", "acme/web", "--number", "42"],
            vec![
                "--db", "/d.db", "mcp", "--pr", "acme/web", "--number", "42", "--head", "abc1234",
            ],
            vec![
                "--db", "/d.db", "mcp", "--pr", "acmeweb", "--number", "42", "--head", "abc1234",
                "--diff", "/i.json",
            ],
            // A provider that never runs this binary must not fall through to
            // Claude's id rules and rewrite a row under them.
            vec!["--db", "/d.db", "--agent-kind", "Cursor", "SessionStart"],
            vec!["--db", "/d.db", "--agent-kind", "nonsense", "SessionStart"],
        ] {
            assert!(parse(&args).is_none(), "{args:?} should not run");
        }
    }

    /// Claude's and Codex's hook events go through one table: the names they
    /// share mean the same state, and the extras invent none (`PostCompact` is the
    /// tail of a compaction still under way, `Subagent*` belong to a child).
    /// `PostToolUse`/`PostToolUseFailure` are the mid-turn heartbeat; `PreToolUse`
    /// stays unmapped because it fires *before* the tool and so races its own
    /// permission prompt. The state-setting events are transitions, never
    /// heartbeats — they must be free to move a session out of a blocked state.
    #[test]
    fn events_map_to_states_and_only_post_tool_events_are_heartbeats() {
        let nil = Value::Null;
        for (event, want) in [
            ("SessionStart", Some(AgentState::Idle)),
            ("UserPromptSubmit", Some(AgentState::Active)),
            ("Stop", Some(AgentState::Idle)),
            ("SessionEnd", Some(AgentState::Exited)),
            ("PermissionRequest", Some(AgentState::Permission)),
            ("PostToolUse", Some(AgentState::Active)),
            ("PostToolUseFailure", Some(AgentState::Active)),
            ("StopFailure", Some(AgentState::Idle)),
            ("Elicitation", Some(AgentState::Waiting)),
            ("ElicitationResult", Some(AgentState::Active)),
            // The reply line by line: its own table, never a state.
            ("MessageDisplay", None),
            ("PreToolUse", None),
            ("PermissionDenied", None),
            ("PreCompact", None),
            ("PostCompact", None),
            ("SubagentStart", None),
            ("SubagentStop", None),
        ] {
            assert_eq!(
                resolve_state(event, AgentKind::Claude, &nil),
                want,
                "{event}"
            );
            assert_eq!(
                is_heartbeat_event(event),
                event.starts_with("PostToolUse"),
                "{event}"
            );
        }
        // Auto-compaction fires `SessionStart` in the middle of a turn that goes
        // on afterwards: it is no sign the session is at its prompt.
        assert_eq!(
            resolve_state(
                "SessionStart",
                AgentKind::Claude,
                &serde_json::json!({ "source": "compact" })
            ),
            None
        );
    }

    /// Both CLIs run the injected hook command inside a subagent and tag the
    /// payload with its `agent_id`. A Codex child is a thread of its own:
    /// recording it would show a helper's state on the user's surface, and its
    /// `SessionStart` would repoint the terminal at a thread the user never
    /// opened. A Claude subagent's events land on the parent session (CLI
    /// 2.1.312, captured): its turns are not the parent's state, but the dialog
    /// it puts up is on the parent's screen — the one thing recorded.
    #[test]
    fn a_subagent_payload_records_only_a_claude_subagents_question() {
        let subagent = |agent: AgentKind, event: &str, kind: Option<&str>| {
            resolve_state(
                event,
                agent,
                &serde_json::json!({
                    "session_id": "parent",
                    "agent_id": "a3a8e734fe1a2da00",
                    "hook_event_name": event,
                    "notification_type": kind,
                }),
            )
        };
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PostToolUse",
            "Stop",
            "SessionEnd",
            "PermissionRequest",
        ] {
            assert_eq!(subagent(AgentKind::Codex, event, None), None, "{event}");
        }
        for (event, kind, want) in [
            ("PermissionRequest", None, Some(AgentState::Permission)),
            (
                "Notification",
                Some("permission_prompt"),
                Some(AgentState::Permission),
            ),
            (
                "Notification",
                Some("elicitation_dialog"),
                Some(AgentState::Waiting),
            ),
            ("Notification", Some("idle_prompt"), None),
            ("SessionStart", None, None),
            ("UserPromptSubmit", None, None),
            ("PostToolUse", None, None),
            ("Stop", None, None),
            ("SessionEnd", None, None),
        ] {
            assert_eq!(
                subagent(AgentKind::Claude, event, kind),
                want,
                "{event} {kind:?}"
            );
        }
        // The same events without an `agent_id` are the user's own session — and
        // so is a null one, the shape an absent optional serializes to. Reading
        // that as "subagent" would ignore every event the root session fires.
        for agent in [AgentKind::Claude, AgentKind::Codex] {
            assert_eq!(
                resolve_state("Stop", agent, &serde_json::json!({ "session_id": "root" })),
                Some(AgentState::Idle)
            );
            assert_eq!(
                resolve_state(
                    "Stop",
                    agent,
                    &serde_json::json!({ "session_id": "root", "agent_id": null })
                ),
                Some(AgentState::Idle)
            );
        }
    }

    /// The `notification_type`s Claude's hooks reference documents, each read as
    /// what is on screen. "Waiting" is never seen-gated, so a type that is not a
    /// question must not map to it: `idle_prompt` (finished a minute ago, nothing
    /// typed since) once did, and every quiet session said "needs you".
    #[test]
    fn refines_notification_by_type() {
        for (kind, want) in [
            ("permission_prompt", Some(AgentState::Permission)),
            // An agent-team worker's permission request, shown by the lead.
            ("worker_permission_prompt", Some(AgentState::Permission)),
            ("agent_needs_input", Some(AgentState::Waiting)),
            ("elicitation_dialog", Some(AgentState::Waiting)),
            ("elicitation_url_dialog", Some(AgentState::Waiting)),
            ("quota_auto_resume_stale", Some(AgentState::Waiting)),
            // A finished turn is idle, not a red "waiting".
            ("agent_completed", Some(AgentState::Idle)),
            ("idle_prompt", Some(AgentState::Idle)),
            // Non-state notifications don't change anything.
            ("auth_success", None),
            ("elicitation_complete", None),
            ("elicitation_response", None),
        ] {
            assert_eq!(
                resolve_state(
                    "Notification",
                    AgentKind::Claude,
                    &serde_json::json!({ "notification_type": kind })
                ),
                want,
                "{kind}"
            );
        }
        // No type (older CLI) falls back to "waiting".
        assert_eq!(
            resolve_state("Notification", AgentKind::Claude, &Value::Null),
            Some(AgentState::Waiting)
        );
    }

    /// Claude Code's own payload, verbatim.
    ///
    /// The key *spellings* are the whole contract with the vendor, so they are in
    /// this test's source as literal JSON rather than built from the same
    /// constants the code reads with — a rename to any other spelling parses,
    /// resolves a state, finds no session id and exits 0, and every other test in
    /// this file still passes while no session ever reaches the sidebar.
    #[test]
    fn reads_claudes_hook_payload_by_its_real_key_names() {
        // PermissionRequest: santree's "needs you" tooltip comes from `message`.
        let permission: Value = serde_json::from_str(
            r#"{
              "session_id": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
              "transcript_path": "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl",
              "cwd": "/Users/me/dev/app",
              "permission_mode": "default",
              "hook_event_name": "PermissionRequest",
              "tool_name": "Bash",
              "tool_input": { "command": "rm -rf build", "description": "Clean" }
            }"#,
        )
        .unwrap();
        assert_eq!(
            read_hook_input(&permission, "PermissionRequest", AgentState::Permission),
            HookInput {
                session_id: "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
                cwd: "/Users/me/dev/app",
                transcript_path: Some(
                    "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl"
                ),
                // No `message` on this one, so the tool name is the tooltip.
                message: Some("run Bash".into()),
                source: None,
                asker: Some(MAIN_ASKER.into()),
                header: Header {
                    prompt_id: None,
                    permission_mode: Some("default"),
                    effort: None,
                },
            }
        );

        // The same event from a subagent (CLI 2.1.312, captured): the parent's
        // session and transcript, and the subagent named by `agent_id`. Its
        // dialog is on the parent's screen, so it is recorded there, as asked by
        // that subagent.
        let subagent: Value = serde_json::from_str(
            r#"{
              "session_id": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
              "transcript_path": "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl",
              "cwd": "/Users/me/dev/app",
              "permission_mode": "default",
              "agent_id": "a3a8e734fe1a2da00",
              "agent_type": "general-purpose",
              "hook_event_name": "PermissionRequest",
              "tool_name": "Bash",
              "tool_input": { "command": "touch x", "description": "Touch" }
            }"#,
        )
        .unwrap();
        let state = resolve_state("PermissionRequest", AgentKind::Claude, &subagent);
        assert_eq!(state, Some(AgentState::Permission));
        assert_eq!(
            read_hook_input(&subagent, "PermissionRequest", state.unwrap()).asker,
            Some(format!("{SUBAGENT_ASKER}a3a8e734fe1a2da00"))
        );

        // Notification: the type refines the state. This is the one Claude sends
        // a minute after a turn with nothing typed — its wording reads like a
        // question, but the session is at its prompt, so it is idle and carries
        // no "needs you" tooltip.
        let notification: Value = serde_json::from_str(
            r#"{
              "session_id": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
              "transcript_path": "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl",
              "cwd": "/Users/me/dev/app",
              "hook_event_name": "Notification",
              "notification_type": "idle_prompt",
              "message": "Claude is waiting for your input"
            }"#,
        )
        .unwrap();
        let state = resolve_state("Notification", AgentKind::Claude, &notification);
        assert_eq!(state, Some(AgentState::Idle));
        assert_eq!(
            read_hook_input(&notification, "Notification", state.unwrap()).message,
            None
        );

        // StopFailure (CLI 2.1.312, captured: a 429 the fake API answered with
        // `x-should-retry: false`): the turn ended on an API error and no `Stop`
        // follows. Idle, carrying the error the transcript's synthetic message
        // holds.
        let failed: Value = serde_json::from_str(
            r#"{
              "session_id": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
              "transcript_path": "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl",
              "cwd": "/Users/me/dev/app",
              "prompt_id": "ce327951-4429-4cbe-a0d1-82c781c74959",
              "effort": { "level": "medium" },
              "hook_event_name": "StopFailure",
              "error": "rate_limit",
              "last_assistant_message": "API Error: Request rejected (429) · placeholder"
            }"#,
        )
        .unwrap();
        let state = resolve_state("StopFailure", AgentKind::Claude, &failed);
        assert_eq!(state, Some(AgentState::Idle));
        let input = read_hook_input(&failed, "StopFailure", state.unwrap());
        assert_eq!(
            (input.message.as_deref(), input.header),
            (
                Some("API Error: Request rejected (429) · placeholder"),
                Header {
                    prompt_id: Some("ce327951-4429-4cbe-a0d1-82c781c74959"),
                    permission_mode: None,
                    effort: Some("medium"),
                }
            )
        );

        // SessionStart: `source` is what decides whether Claude rebinds the row.
        let cleared: Value = serde_json::from_str(
            r#"{
              "session_id": "1a2b3c4d-5e6f-4071-8899-aabbccddeeff",
              "transcript_path": "/Users/me/.claude/projects/-Users-me-dev-app/1a2b3c4d.jsonl",
              "cwd": "/Users/me/dev/app",
              "hook_event_name": "SessionStart",
              "source": "clear"
            }"#,
        )
        .unwrap();
        let input = read_hook_input(&cleared, "SessionStart", AgentState::Idle);
        assert_eq!(input.source, Some("clear"));
        assert!(
            binds_session_id(AgentKind::Claude, input.source),
            "a /clear mints an id santree never chose; the row must be repointed"
        );
    }

    /// Codex's own payload, verbatim — the shapes its binary publishes as JSON
    /// Schema (`session-start.command.input` / `permission-request.command.input`,
    /// codex-cli 0.151.0). It shares Claude's snake_case names and adds two of its
    /// own: a nullable `transcript_path`, and `agent_id` on a subagent's events.
    #[test]
    fn reads_codexs_hook_payload_by_its_real_key_names() {
        let session_start: Value = serde_json::from_str(
            r#"{
              "cwd": "/Users/me/dev/app",
              "hook_event_name": "SessionStart",
              "model": "gpt-5.1-codex",
              "permission_mode": "default",
              "session_id": "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d",
              "source": "startup",
              "transcript_path": null
            }"#,
        )
        .unwrap();
        assert_eq!(
            read_hook_input(&session_start, "SessionStart", AgentState::Idle),
            HookInput {
                session_id: "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d",
                cwd: "/Users/me/dev/app",
                // A JSON null is absent, not the string "null".
                transcript_path: None,
                message: None,
                source: Some("startup"),
                asker: None,
                header: Header {
                    prompt_id: None,
                    permission_mode: Some("default"),
                    effort: None,
                },
            }
        );
        // Codex mints its own id, so every SessionStart binds it to the terminal.
        assert!(binds_session_id(AgentKind::Codex, Some("startup")));

        // Codex's PermissionRequest carries no `message` at all — the tool-name
        // fallback is the only tooltip a Codex permission prompt ever gets.
        let permission: Value = serde_json::from_str(
            r#"{
              "cwd": "/Users/me/dev/app",
              "hook_event_name": "PermissionRequest",
              "model": "gpt-5.1-codex",
              "permission_mode": "default",
              "session_id": "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d",
              "tool_input": { "command": ["bash", "-lc", "cargo test"] },
              "tool_name": "shell",
              "transcript_path": "/Users/me/.codex/sessions/2026/08/30/rollout-01998f6c.jsonl",
              "turn_id": "turn_3"
            }"#,
        )
        .unwrap();
        let input = read_hook_input(&permission, "PermissionRequest", AgentState::Permission);
        assert_eq!(input.message.as_deref(), Some("run shell"));
        assert_eq!(
            input.transcript_path,
            Some("/Users/me/.codex/sessions/2026/08/30/rollout-01998f6c.jsonl")
        );

        // The same event from a Codex *subagent* carries `agent_id`, and the whole
        // payload is ignored — that spelling is what keeps a helper's state off the
        // user's surface.
        let subagent: Value = serde_json::from_str(
            r#"{
              "agent_id": "agent_01",
              "agent_type": "reviewer",
              "cwd": "/Users/me/dev/app",
              "hook_event_name": "PermissionRequest",
              "model": "gpt-5.1-codex",
              "permission_mode": "default",
              "session_id": "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d",
              "tool_input": {},
              "tool_name": "shell",
              "transcript_path": null,
              "turn_id": "turn_4"
            }"#,
        )
        .unwrap();
        assert_eq!(
            resolve_state("PermissionRequest", AgentKind::Codex, &subagent),
            None
        );
    }

    /// A camelCase payload must read as *nothing*, not as a session.
    ///
    /// Accepting both spellings would look like robustness and would instead hide
    /// the day a vendor changed its wire format: the state would keep being
    /// recorded under whichever name still matched, and the drift would surface as
    /// an unexplained empty sidebar much later.
    #[test]
    fn a_camel_case_payload_is_not_a_session() {
        let payload: Value = serde_json::from_str(
            r#"{
              "sessionId": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
              "transcriptPath": "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl",
              "toolName": "Bash",
              "hookEventName": "PermissionRequest"
            }"#,
        )
        .unwrap();
        assert_eq!(
            read_hook_input(&payload, "PermissionRequest", AgentState::Permission),
            HookInput {
                // Empty ⇒ `main` returns before writing anything.
                session_id: "",
                cwd: "",
                transcript_path: None,
                message: None,
                source: None,
                asker: Some(MAIN_ASKER.into()),
                header: Header::default(),
            }
        );
    }

    /// Each dialog's own payload, as CLI 2.1.312 sends it (captured, texts and
    /// paths replaced), is what its card draws: the dialog stored with the row
    /// reads every field by Claude's spelling, keeps the JSON as Claude sent
    /// it, and says when it is not there to read — `[]` suggestions are kept
    /// apart from none, because a dialog with `[]` has no "don't ask again" row.
    #[test]
    fn a_dialogs_own_payload_is_what_its_card_draws() {
        const ENVELOPE: &str = r#""session_id": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
            "transcript_path": "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl",
            "cwd": "/Users/me/dev/app", "prompt_id": "8706343f-0000-4000-8000-000000000001",
            "effort": { "level": "medium" }"#;
        let payload = |rest: &str| -> Value {
            serde_json::from_str(&format!("{{ {ENVELOPE}, {rest} }}")).unwrap()
        };
        let json = |v: &Value| v.to_string();
        // (event, payload, kind, tool, server, agent, mode)
        let cases = [
            (
                "PermissionRequest",
                payload(
                    r#""permission_mode": "default", "hook_event_name": "PermissionRequest",
                    "tool_name": "Bash", "tool_input": { "command": "touch probe-a", "description": "Create probe file" },
                    "permission_suggestions": [
                      { "type": "addDirectories", "directories": ["/Users/me/dev/app"], "destination": "session" },
                      { "type": "setMode", "mode": "acceptEdits", "destination": "session" }]"#,
                ),
                DialogKind::Permission,
                Some("Bash"),
                None,
                None,
                Some("default"),
            ),
            (
                // No rule to offer: `[]`, and the dialog's row 2 is auto mode.
                "PermissionRequest",
                payload(
                    r#""permission_mode": "default", "hook_event_name": "PermissionRequest",
                    "tool_name": "Bash", "tool_input": { "command": "eval \"$PLACEHOLDER\"", "description": "Eval a variable" },
                    "permission_suggestions": []"#,
                ),
                DialogKind::Permission,
                Some("Bash"),
                None,
                None,
                Some("default"),
            ),
            (
                "PermissionRequest",
                payload(
                    r#""permission_mode": "default", "agent_id": "a8b673e1aefb31430",
                    "agent_type": "general-purpose", "hook_event_name": "PermissionRequest",
                    "tool_name": "Bash", "tool_input": { "command": "touch sub-file", "description": "Subagent touch" },
                    "permission_suggestions": [{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }]"#,
                ),
                DialogKind::Permission,
                Some("Bash"),
                None,
                Some(("a8b673e1aefb31430", "general-purpose")),
                Some("default"),
            ),
            (
                "PermissionRequest",
                payload(
                    r#""permission_mode": "default", "hook_event_name": "PermissionRequest",
                    "tool_name": "mcp__probe__echo", "tool_input": { "text": "hello mcp" },
                    "permission_suggestions": [{ "type": "addRules", "rules": [{ "toolName": "mcp__probe__echo" }],
                      "behavior": "allow", "destination": "localSettings" }],
                    "mcp_server": { "name": "probe", "source": "dynamic" }"#,
                ),
                DialogKind::Permission,
                Some("mcp__probe__echo"),
                Some("probe"),
                None,
                Some("default"),
            ),
            (
                // Questions and plans carry no suggestions at all.
                "PermissionRequest",
                payload(
                    r#""permission_mode": "default", "hook_event_name": "PermissionRequest",
                    "tool_name": "AskUserQuestion", "tool_input": { "questions": [{ "question": "Which color?",
                      "header": "Color", "options": [{ "label": "Red", "description": "A warm color" },
                      { "label": "Blue", "description": "A cool color" }], "multiSelect": false }] }"#,
                ),
                DialogKind::Permission,
                Some("AskUserQuestion"),
                None,
                None,
                Some("default"),
            ),
            (
                "PermissionRequest",
                payload(
                    r##""permission_mode": "plan", "hook_event_name": "PermissionRequest",
                    "tool_name": "ExitPlanMode", "tool_input": { "plan": "# Placeholder plan\n\n1. Step\n",
                      "planFilePath": "/Users/me/.claude/plans/placeholder.md" }"##,
                ),
                DialogKind::Permission,
                Some("ExitPlanMode"),
                None,
                None,
                Some("plan"),
            ),
            (
                "Elicitation",
                payload(
                    r#""hook_event_name": "Elicitation", "mcp_server_name": "probe",
                    "message": "Pick a deploy target", "mode": "form",
                    "requested_schema": { "type": "object", "properties": { "target": { "type": "string",
                      "title": "Target", "enum": ["staging", "production"] } }, "required": ["target"] }"#,
                ),
                DialogKind::Elicitation,
                None,
                Some("probe"),
                None,
                None,
            ),
        ];
        for (event, p, kind, tool, server, agent, mode) in cases {
            let dialog = pending_dialog(event, AgentKind::Claude, &p).expect(event);
            let input: Value = serde_json::from_str(&dialog.input).unwrap();
            let want_input = match kind {
                DialogKind::Permission => p["tool_input"].clone(),
                DialogKind::Elicitation => serde_json::json!({
                    "message": p["message"], "mode": p["mode"],
                    "requested_schema": p["requested_schema"],
                }),
            };
            assert_eq!(
                (
                    dialog.kind,
                    dialog.tool.as_deref(),
                    input,
                    dialog.suggestions.clone(),
                    dialog.mcp_server.as_deref(),
                    dialog.agent_id.as_deref().zip(dialog.agent_type.as_deref()),
                    dialog.mode.as_deref(),
                    dialog.prompt_id.as_deref(),
                    dialog.truncated,
                ),
                (
                    kind,
                    tool,
                    want_input,
                    p.get("permission_suggestions").map(json),
                    server,
                    agent,
                    mode,
                    Some("8706343f-0000-4000-8000-000000000001"),
                    false,
                ),
                "{event} {tool:?}"
            );
        }
        // A URL elicitation keeps its URL and id.
        let url = payload(
            r#""hook_event_name": "Elicitation", "mcp_server_name": "probe",
            "message": "Sign in to the probe service", "mode": "url",
            "url": "https://example.invalid/probe-auth", "elicitation_id": "probe-url-1""#,
        );
        let dialog = pending_dialog("Elicitation", AgentKind::Claude, &url).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&dialog.input).unwrap(),
            serde_json::json!({ "message": "Sign in to the probe service", "mode": "url",
                "url": "https://example.invalid/probe-auth", "elicitation_id": "probe-url-1" })
        );

        // A file written whole is over the cap: the content is cut, the JSON
        // still parses, and the dialog says it was cut.
        let big = payload(&format!(
            r#""permission_mode": "default", "hook_event_name": "PermissionRequest",
            "tool_name": "Write", "tool_input": {{ "file_path": "/Users/me/dev/app/big.txt", "content": "{}" }}"#,
            "x".repeat(200 * 1024)
        ));
        let dialog = pending_dialog("PermissionRequest", AgentKind::Claude, &big).unwrap();
        let input: Value = serde_json::from_str(&dialog.input).unwrap();
        assert!(dialog.truncated && dialog.input.len() <= MAX_PENDING_INPUT);
        assert_eq!(input["file_path"], "/Users/me/dev/app/big.txt");
        assert!(input["content"].as_str().unwrap().starts_with("xxxx"));

        // Codex's PermissionRequest is answered in the terminal; nothing else
        // puts a dialog on record.
        assert_eq!(
            pending_dialog("PermissionRequest", AgentKind::Codex, &big),
            None
        );
        assert_eq!(
            pending_dialog("Notification", AgentKind::Claude, &big),
            None
        );
    }

    /// Which states carry a tooltip, and where the text comes from. Consecutive
    /// tool events have to dedup to a single "running" (see `record`), which they
    /// only do while running/idle/exited keep carrying no message.
    #[test]
    fn only_the_needs_you_states_carry_a_message() {
        let payload: Value = serde_json::from_str(
            r#"{
              "session_id": "s1",
              "cwd": "/w",
              "hook_event_name": "PermissionRequest",
              "message": "Claude needs your permission to use Bash",
              "tool_name": "Bash"
            }"#,
        )
        .unwrap();
        // The explicit message wins over the tool-name fallback.
        let message = |state| read_hook_input(&payload, "PermissionRequest", state).message;
        assert_eq!(
            message(AgentState::Permission).as_deref(),
            Some("Claude needs your permission to use Bash")
        );
        assert_eq!(
            message(AgentState::Waiting).as_deref(),
            Some("Claude needs your permission to use Bash")
        );
        for state in [AgentState::Active, AgentState::Idle, AgentState::Exited] {
            assert_eq!(message(state), None, "{state:?} must carry no tooltip");
        }

        // Waiting has no tool-name fallback: a tool name is not what the user is
        // being asked, so a bare tool name must not become the tooltip.
        let no_message: Value =
            serde_json::from_str(r#"{ "session_id": "s1", "cwd": "/w", "tool_name": "Bash" }"#)
                .unwrap();
        assert_eq!(
            read_hook_input(&no_message, "Notification", AgentState::Waiting).message,
            None
        );
        assert_eq!(
            read_hook_input(&no_message, "PermissionRequest", AgentState::Permission)
                .message
                .as_deref(),
            Some("run Bash")
        );
    }

    // The wire form the app reads back out of the `state` column.
    #[test]
    fn states_round_trip_through_the_db_column() {
        for s in [
            AgentState::Active,
            AgentState::Permission,
            AgentState::Waiting,
            AgentState::Idle,
            AgentState::Exited,
        ] {
            assert_eq!(AgentState::parse(s.as_str()), Some(s));
        }
    }

    /// The bar Claude renders. The 1.2x display nudge trips the warning colors
    /// early, and the raw percentage is what gets persisted — so the two must not be
    /// confused.
    #[test]
    fn renders_a_context_bar() {
        let green = "\x1b[01;32m";
        let red = "\x1b[01;31m";
        // 50% raw → 60% shown by the 1.2x nudge, which is exactly what trips yellow.
        let bar = render_bar(50.0, 604_000.0, "Opus");
        assert!(
            bar.starts_with("\x1b[01;33m"),
            "60% shown → yellow: {bar:?}"
        );
        assert!(bar.contains("60%"), "{bar:?}");
        assert!(bar.contains("604k"), "compact token count: {bar:?}");
        assert!(bar.contains("Opus"), "{bar:?}");

        assert!(render_bar(0.0, 0.0, "").starts_with(green));
        assert!(render_bar(90.0, 0.0, "").starts_with(red));
        // Over-full and nonsense inputs clamp instead of panicking on the repeat().
        assert!(render_bar(150.0, 0.0, "").contains("100%"));
        assert!(render_bar(-5.0, 0.0, "").contains("0%"));
        assert!(render_bar(f64::NAN, 0.0, "").contains("0%"));
        // No tokens / no model → those segments are simply omitted.
        let bare = render_bar(10.0, 0.0, "");
        assert!(!bare.contains('·'), "{bare:?}");
    }

    /// I5: the status line's usage write must land *and be closed* before the app is
    /// nudged, and must dedup an unchanged re-render so identical status-line
    /// repaints don't wake the UI.
    #[tokio::test]
    async fn upsert_records_live_usage_and_dedups_unchanged_repaints() {
        let base = std::env::temp_dir().join(format!("santree-hook-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");
        let db = db_path.to_str().unwrap();
        // A render as CLI 2.1.312 sends it (keymap §9), vim mode on.
        let payload = |used: f64, tokens: f64, vim: &str| {
            serde_json::json!({
                "session_id": "s1",
                "effort": { "level": "medium" },
                "model": { "id": "claude-opus-4-8", "display_name": "Opus" },
                "output_style": { "name": "default" },
                "context_window": {
                    "total_input_tokens": tokens,
                    "context_window_size": 200_000,
                    "used_percentage": used,
                },
                "vim": { "mode": vim },
            })
        };
        let usage = |p: &Value| {
            let p = p.clone();
            async move {
                record_usage(db, "s1", &StatuslineReading::of(&p), Some(now_ms()))
                    .await
                    .unwrap()
            }
        };

        // No db yet → no-op, no panic, and crucially no db created.
        assert_eq!(
            usage(&payload(10.0, 100.0, "NORMAL")).await,
            UsageWrite::default()
        );
        assert!(!db_path.exists(), "must never create the app's db");

        // The tables the app owns ([`USAGE_DDL`], and the state row the effort
        // lands on).
        let mut c = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        for ddl in [USAGE_DDL, STATE_DDL[0]] {
            sqlx::query(ddl).execute(&mut c).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO session_state (session_id, state, event, updated_at_ms) \
             VALUES ('s1', 'idle', 'SessionStart', 1)",
        )
        .execute(&mut c)
        .await
        .unwrap();

        // The first render writes the usage, and the effort onto the state row
        // (no hook before the first turn carries it).
        assert_eq!(
            usage(&payload(10.0, 100.0, "NORMAL")).await,
            UsageWrite {
                usage: true,
                state: true
            }
        );
        // Identical → no write, no UI nudge.
        assert_eq!(
            usage(&payload(10.0, 100.0, "NORMAL")).await,
            UsageWrite::default()
        );
        // The vim mode alone moving is a change the header shows.
        assert!(usage(&payload(10.0, 100.0, "INSERT")).await.usage);
        // A real change writes again.
        assert!(usage(&payload(24.0, 500.0, "INSERT")).await.usage);

        let row: (i64, f64, i64, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT COUNT(*), used_pct, input_tokens, output_style, vim_mode \
             FROM session_usage_live",
        )
        .fetch_one(&mut c)
        .await
        .unwrap();
        assert_eq!(
            row,
            (1, 24.0, 500, Some("default".into()), Some("INSERT".into())),
            "one row per session, latest render"
        );
        let (effort,): (Option<String>,) =
            sqlx::query_as("SELECT effort_level FROM session_state WHERE session_id = 's1'")
                .fetch_one(&mut c)
                .await
                .unwrap();
        assert_eq!(effort.as_deref(), Some("medium"));
        c.close().await.unwrap();

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The status line's `rate_limits` is read member-by-member, not by a fixed
    /// list: today's `five_hour`/`seven_day` come through, and so would a window
    /// this build has never heard of. `resets_at` is epoch seconds on the wire.
    #[test]
    fn statusline_rate_limits_are_parsed_generically() {
        let payload = serde_json::json!({
            "session_id": "s1",
            "context_window": { "used_percentage": 12.5 },
            "rate_limits": {
                "five_hour": { "used_percentage": 37.0, "resets_at": 1_787_000_000 },
                "seven_day": { "used_percentage": 81.25, "resets_at": 1_787_400_000 },
                "seven_day_opus": { "used_percentage": 4.0 },
                "malformed": { "resets_at": 1 },
                "not_an_object": 5
            }
        });
        let windows = parse_rate_limits(&payload);
        assert_eq!(
            windows,
            vec![
                RateLimitWindow {
                    window: "five_hour".into(),
                    used_pct: 37.0,
                    resets_at_ms: Some(1_787_000_000_000),
                },
                RateLimitWindow {
                    window: "seven_day".into(),
                    used_pct: 81.25,
                    resets_at_ms: Some(1_787_400_000_000),
                },
                RateLimitWindow {
                    window: "seven_day_opus".into(),
                    used_pct: 4.0,
                    resets_at_ms: None,
                },
            ]
        );

        // No `rate_limits` (API-key sessions, or before the first response) → nothing.
        assert!(parse_rate_limits(&serde_json::json!({ "session_id": "s1" })).is_empty());
        assert!(parse_rate_limits(&serde_json::json!({ "rate_limits": null })).is_empty());
        assert!(parse_rate_limits(&Value::Null).is_empty());

        // A ms timestamp, an ISO string and junk: scaled, unknown, unknown.
        assert_eq!(
            epoch_ms(&serde_json::json!(1_787_000_000_000_i64)),
            Some(1_787_000_000_000)
        );
        assert_eq!(epoch_ms(&serde_json::json!("2026-09-01T00:00:00Z")), None);
        assert_eq!(epoch_ms(&serde_json::json!(-5)), None);
        assert_eq!(epoch_ms(&Value::Null), None);
    }

    /// One row per window, latest write wins, and an unchanged set must not write
    /// (or nudge the UI) — the status line repaints on every turn, the limits move
    /// far less often.
    #[tokio::test]
    async fn upsert_records_rate_limit_windows_and_dedups_unchanged_ones() {
        let base = std::env::temp_dir().join(format!("santree-hook-limits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");
        let db = db_path.to_str().unwrap();

        let five = |used_pct: f64, resets_at_ms: Option<i64>| RateLimitWindow {
            window: "five_hour".into(),
            used_pct,
            resets_at_ms,
        };
        let week = RateLimitWindow {
            window: "seven_day".into(),
            used_pct: 60.0,
            resets_at_ms: Some(1_787_400_000_000),
        };

        // No db yet → no-op, no panic, and crucially no db created.
        assert!(!record_rate_limits(db, None, &[five(10.0, None)])
            .await
            .unwrap());
        assert!(!db_path.exists(), "must never create the app's db");

        // The table the app owns (mirrors migration 0027).
        {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE claude_rate_limits (window TEXT PRIMARY KEY, used_pct REAL NOT NULL, \
                 resets_at_ms INTEGER, updated_at_ms INTEGER NOT NULL)",
            )
            .execute(&mut c)
            .await
            .unwrap();
            c.close().await.unwrap();
        }

        let first = [five(37.0, Some(1_787_000_000_000)), week.clone()];
        assert!(record_rate_limits(db, None, &first).await.unwrap());
        // The identical set again → no write, no UI nudge.
        assert!(!record_rate_limits(db, None, &first).await.unwrap());
        // One window moving is enough to write (and only that row changes).
        assert!(record_rate_limits(
            db,
            None,
            &[five(42.0, Some(1_787_000_000_000)), week.clone()]
        )
        .await
        .unwrap());
        // A reset time changing counts as a change too, even at the same percentage.
        assert!(
            record_rate_limits(db, None, &[five(42.0, Some(1_787_018_000_000))])
                .await
                .unwrap()
        );

        let mut c = SqliteConnectOptions::new()
            .filename(&db_path)
            .connect()
            .await
            .unwrap();
        let rows: Vec<(String, f64, Option<i64>)> = sqlx::query_as(
            "SELECT window, used_pct, resets_at_ms FROM claude_rate_limits ORDER BY window",
        )
        .fetch_all(&mut c)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("five_hour".to_string(), 42.0, Some(1_787_018_000_000)),
                ("seven_day".to_string(), 60.0, Some(1_787_400_000_000)),
            ],
            "one row per window, latest values"
        );
        c.close().await.unwrap();

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn upsert_records_then_updates_latest_state() {
        let base = std::env::temp_dir().join(format!("santree-hook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");
        let db = db_path.to_str().unwrap();

        // No db yet → no-op, no panic.
        assert!(
            !record_state(db, &write(AgentState::Active, "SessionStart", None, None))
                .await
                .unwrap()
        );

        // Create the tables the app owns ([`STATE_DDL`]).
        {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            for ddl in STATE_DDL {
                sqlx::query(ddl).execute(&mut c).await.unwrap();
            }
            c.close().await.unwrap();
        }

        assert!(
            record_state(db, &write(AgentState::Active, "SessionStart", None, None))
                .await
                .unwrap()
        );
        // Dedup: the same state + message again is a no-op (no UI nudge) — this is
        // what keeps repeated PreToolUse/PostToolUse from re-notifying every tool.
        assert!(
            !record_state(db, &write(AgentState::Active, "PreToolUse", None, None))
                .await
                .unwrap()
        );
        assert!(
            record_state(db, &write(AgentState::Idle, "Stop", None, None))
                .await
                .unwrap()
        );

        // One row for the session, holding the latest state.
        let mut c = SqliteConnectOptions::new()
            .filename(&db_path)
            .connect()
            .await
            .unwrap();
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM session_state")
            .fetch_one(&mut c)
            .await
            .unwrap();
        assert_eq!(count, 1, "upsert keeps one row per session");
        let (state, event): (String, String) =
            sqlx::query_as("SELECT state, event FROM session_state WHERE session_id = 's1'")
                .fetch_one(&mut c)
                .await
                .unwrap();
        assert_eq!(state, "idle");
        assert_eq!(event, "Stop");
        c.close().await.unwrap();

        let _ = std::fs::remove_dir_all(&base);
    }

    /// [`record`], for the tests that only check whether the row changed.
    async fn record_state(db: &str, write: &StateWrite<'_>) -> Result<bool, sqlx::Error> {
        Ok(record(db, write).await?.state)
    }

    /// `session_state` as migrations 0010, 0042 and 0043 leave it, and the
    /// live-text table 0043 adds.
    const STATE_DDL: [&str; 2] = [
        "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, state TEXT NOT NULL, \
         event TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '', message TEXT, \
         transcript_path TEXT, updated_at_ms INTEGER NOT NULL, asker TEXT, \
         prompt_id TEXT, permission_mode TEXT, effort_level TEXT, pending_kind TEXT, \
         pending_tool TEXT, pending_input TEXT, pending_suggestions TEXT, \
         pending_mcp_server TEXT, pending_agent_id TEXT, pending_agent_type TEXT, \
         pending_mode TEXT, pending_prompt_id TEXT, pending_truncated INTEGER, \
         pending_at_ms INTEGER, pending_stacked INTEGER, pending_call TEXT, \
         pending_rendered_at_ms INTEGER, pending_resolved_at_ms INTEGER)",
        "CREATE TABLE session_live_text (session_id TEXT NOT NULL, message_id TEXT NOT NULL, \
         idx INTEGER NOT NULL, turn_id TEXT, prompt_id TEXT, delta TEXT NOT NULL, \
         final INTEGER NOT NULL DEFAULT 0, cut INTEGER NOT NULL DEFAULT 0, \
         fired_ms INTEGER NOT NULL, PRIMARY KEY (session_id, message_id, idx))",
    ];

    /// `session_usage_live` as migrations 0011 and 0043 leave it.
    const USAGE_DDL: &str =
        "CREATE TABLE session_usage_live (session_id TEXT PRIMARY KEY, used_pct REAL NOT NULL, \
         input_tokens INTEGER NOT NULL, context_size INTEGER NOT NULL, model TEXT NOT NULL, \
         cost_usd REAL NOT NULL, updated_at_ms INTEGER NOT NULL, output_style TEXT, vim_mode TEXT)";

    /// What the hook writes for one of session `s1`'s events, fired now.
    fn write<'a>(
        state: AgentState,
        event: &'a str,
        message: Option<&'a str>,
        asker: Option<&'a str>,
    ) -> StateWrite<'a> {
        StateWrite {
            session_id: "s1",
            state,
            event,
            cwd: "/w",
            message,
            transcript: None,
            asker,
            source: None,
            fired_ms: now_ms(),
            header: Header::default(),
            pending: None,
            live_text: None,
            notice: None,
        }
    }

    /// A db holding just `session_state` and the live text ([`STATE_DDL`]),
    /// for the tests that exercise [`record`] directly.
    async fn state_db(name: &str) -> (std::path::PathBuf, String) {
        let base = std::env::temp_dir().join(format!("santree-hook-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");
        let mut c = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        for ddl in STATE_DDL {
            sqlx::query(ddl).execute(&mut c).await.unwrap();
        }
        c.close().await.unwrap();
        (base, db_path.to_str().unwrap().to_string())
    }

    async fn row_of(db: &str, session: &str) -> (String, Option<String>, i64) {
        let mut c = SqliteConnectOptions::new()
            .filename(db)
            .connect()
            .await
            .unwrap();
        let row = sqlx::query_as(
            "SELECT state, message, updated_at_ms FROM session_state WHERE session_id = ?",
        )
        .bind(session)
        .fetch_one(&mut c)
        .await
        .unwrap();
        c.close().await.unwrap();
        row
    }

    /// The tool events are what keep a long turn from decaying to idle, so a
    /// repeat "active" has to move `updated_at_ms` even though it writes no new
    /// state and raises no UI nudge. Dedup suppresses the *notification*, not the
    /// clock — a dedup that froze the timestamp is precisely how a busy agent
    /// aged out into "Idle" mid-turn.
    #[tokio::test]
    async fn a_deduped_heartbeat_still_advances_the_clock() {
        let (base, db) = state_db("heartbeat-clock").await;

        assert!(record_state(
            &db,
            &write(AgentState::Active, "UserPromptSubmit", None, None)
        )
        .await
        .unwrap());
        let (_, _, first) = row_of(&db, "s1").await;

        // Far enough apart that a frozen clock is unambiguous.
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !record_state(&db, &write(AgentState::Active, "PostToolUse", None, None))
                .await
                .unwrap(),
            "an unchanged state must not nudge the UI"
        );
        let (state, _, second) = row_of(&db, "s1").await;
        assert_eq!(state, "active");
        assert!(
            second > first,
            "the heartbeat must advance updated_at_ms ({first} → {second})"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The dialog on record for `session`: its kind, its tool, when it was
    /// stored, and the row's own clock (the two agree while it is the row's).
    async fn dialog_of(
        db: &str,
        session: &str,
    ) -> (Option<String>, Option<String>, Option<i64>, i64) {
        let mut c = SqliteConnectOptions::new()
            .filename(db)
            .connect()
            .await
            .unwrap();
        let row = sqlx::query_as(
            "SELECT pending_kind, pending_tool, pending_at_ms, updated_at_ms \
             FROM session_state WHERE session_id = ?",
        )
        .bind(session)
        .fetch_one(&mut c)
        .await
        .unwrap();
        c.close().await.unwrap();
        row
    }

    /// A Claude dialog's event for session `s1`, with the dialog its payload
    /// puts up, as [`apply_hook`] builds it.
    fn dialog(event: &str, tool_input: Value) -> PendingDialog {
        let payload = serde_json::json!({
            "tool_name": "Bash", "tool_input": tool_input, "permission_suggestions": [],
            "mcp_server_name": "probe", "message": "Pick one", "mode": "form",
        });
        pending_dialog(event, AgentKind::Claude, &payload).unwrap()
    }

    /// The reason per-tool events were kept out of the injected set for so long,
    /// now handled instead of avoided: these hooks are `async`, so a `PostToolUse`
    /// from the previous tool can land *after* the `PermissionRequest` for the
    /// next one. Writing "active" there would clear a prompt still on screen.
    ///
    /// It must not touch the clock either: for a pending prompt `updated_at_ms`
    /// means *when the prompt was recorded*, and the app decides the user answered
    /// by comparing the transcript against it. Bumping it would make a resolved
    /// prompt look pending forever. Nor the dialog stored with it, which the
    /// Conversation view's card draws and types its answer into.
    #[tokio::test]
    async fn a_straggling_tool_heartbeat_never_clears_a_live_permission_prompt() {
        let (base, db) = state_db("heartbeat-permission").await;
        let asks = dialog(
            "PermissionRequest",
            serde_json::json!({ "command": "touch a" }),
        );

        assert!(record_state(
            &db,
            &StateWrite {
                pending: Some(&asks),
                ..write(
                    AgentState::Permission,
                    "PermissionRequest",
                    Some("run Bash"),
                    Some(MAIN_ASKER)
                )
            }
        )
        .await
        .unwrap());
        let (_, _, recorded_at) = row_of(&db, "s1").await;
        let stored = dialog_of(&db, "s1").await;
        assert_eq!(
            stored,
            (
                Some("permission".into()),
                Some("Bash".into()),
                Some(recorded_at),
                recorded_at
            )
        );

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !record_state(&db, &write(AgentState::Active, "PostToolUse", None, None))
                .await
                .unwrap()
        );

        let (state, message, updated) = row_of(&db, "s1").await;
        assert_eq!(state, "permission", "the prompt is still up");
        assert_eq!(message.as_deref(), Some("run Bash"));
        assert_eq!(
            updated, recorded_at,
            "a blocked-on-user row's clock is when the prompt appeared, not now"
        );
        assert_eq!(dialog_of(&db, "s1").await, stored, "and its dialog with it");

        // A real transition still gets through — this guard is about heartbeats,
        // not about freezing the row — and takes the dialog with it.
        assert!(
            record_state(&db, &write(AgentState::Idle, "Stop", None, None))
                .await
                .unwrap()
        );
        assert_eq!(row_of(&db, "s1").await.0, "idle");
        assert_eq!(dialog_of(&db, "s1").await.0, None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The next of two parallel tool calls asks ~90 ms after the first is
    /// answered, with the same state and the same "run Bash" (CLI 2.1.312): it
    /// is a new dialog, and replaces the first — a card that kept drawing the
    /// first command would type its answer into the second. An MCP server's
    /// form is a dialog of its own: its Notification ~6 s later keeps it, and
    /// the user's answer (`ElicitationResult`) clears it.
    #[tokio::test]
    async fn each_dialog_replaces_the_last_and_its_answer_clears_it() {
        let (base, db) = state_db("dialog-replaced").await;
        let first = dialog(
            "PermissionRequest",
            serde_json::json!({ "command": "touch a" }),
        );
        let second = dialog(
            "PermissionRequest",
            serde_json::json!({ "command": "touch b" }),
        );
        let asks = |d| StateWrite {
            pending: Some(d),
            ..write(
                AgentState::Permission,
                "PermissionRequest",
                Some("run Bash"),
                Some(MAIN_ASKER),
            )
        };
        let input_of = || {
            let db = db.clone();
            async move {
                let mut c = SqliteConnectOptions::new()
                    .filename(&db)
                    .connect()
                    .await
                    .unwrap();
                let (input,): (Option<String>,) = sqlx::query_as(
                    "SELECT pending_input FROM session_state WHERE session_id = 's1'",
                )
                .fetch_one(&mut c)
                .await
                .unwrap();
                input
            }
        };

        assert!(record_state(&db, &asks(&first)).await.unwrap());
        let (_, _, first_at, _) = dialog_of(&db, "s1").await;
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(record_state(&db, &asks(&second)).await.unwrap());
        let (kind, _, second_at, updated) = dialog_of(&db, "s1").await;
        assert_eq!(kind.as_deref(), Some("permission"));
        assert!(second_at > first_at && second_at == Some(updated));
        assert_eq!(input_of().await.as_deref(), Some(second.input.as_str()));

        let form = dialog("Elicitation", Value::Null);
        assert!(record_state(
            &db,
            &StateWrite {
                pending: Some(&form),
                ..write(
                    AgentState::Waiting,
                    "Elicitation",
                    Some("Pick one"),
                    Some(MAIN_ASKER)
                )
            }
        )
        .await
        .unwrap());
        let stored = dialog_of(&db, "s1").await;
        assert_eq!(stored.0.as_deref(), Some("elicitation"));
        assert!(
            !record_state(
                &db,
                &write(
                    AgentState::Waiting,
                    "Notification",
                    Some("Claude Code needs your input"),
                    None
                )
            )
            .await
            .unwrap(),
            "the form's Notification says less than the form did"
        );
        assert_eq!(dialog_of(&db, "s1").await, stored);
        assert!(record_state(
            &db,
            &write(AgentState::Active, "ElicitationResult", None, None)
        )
        .await
        .unwrap());
        assert_eq!(
            (row_of(&db, "s1").await.0, dialog_of(&db, "s1").await.0),
            ("active".to_string(), None)
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    async fn connect(db: &str) -> SqliteConnection {
        SqliteConnectOptions::new()
            .filename(db)
            .connect()
            .await
            .unwrap()
    }

    /// A db for the dialog tests: [`STATE_DDL`], and [`USAGE_DDL`] for the
    /// usage a status-line render records too.
    async fn dialog_db(name: &str) -> (std::path::PathBuf, String) {
        let (base, db) = state_db(name).await;
        let mut c = connect(&db).await;
        sqlx::query(USAGE_DDL).execute(&mut c).await.unwrap();
        c.close().await.unwrap();
        (base, db)
    }

    /// A subagent's id, as CLI 2.1.312 names one.
    const SUBAGENT: &str = "a646af0b6bd309ebc";

    /// Session `s1`'s hook `event` with `payload`, through the flow the binary
    /// and the relay share ([`apply_hook`]); whether it nudged the state.
    async fn fire(db: &str, event: &str, mut payload: Value) -> bool {
        payload["session_id"] = "s1".into();
        payload["hook_event_name"] = event.into();
        let mut c = connect(db).await;
        let applied = apply(
            &mut c,
            &Invocation::Hook {
                event: event.into(),
                agent: AgentKind::Claude,
            },
            payload.to_string().as_bytes(),
            &HookEnv::default(),
        )
        .await;
        c.close().await.unwrap();
        assert!(
            applied.failures.is_empty(),
            "{event}: {:?}",
            applied.failures
        );
        applied.nudges.state
    }

    /// The fields CLI 2.1.312 sends with a tool call's hooks: the call, the
    /// turn's header, and `agent_id`/`agent_type` for a subagent's.
    fn call(tool: &str, input: &Value, agent: Option<&str>) -> Value {
        let mut payload = serde_json::json!({
            "cwd": "/run/work", "prompt_id": "p-1", "permission_mode": "default",
            "effort": { "level": "medium" }, "tool_name": tool, "tool_input": input,
        });
        if let Some(agent) = agent {
            payload["agent_id"] = agent.into();
            payload["agent_type"] = "general-purpose".into();
        }
        payload
    }

    /// A `PermissionRequest` for that call.
    fn asks(tool: &str, input: &Value, agent: Option<&str>) -> Value {
        let mut payload = call(tool, input, agent);
        payload["permission_suggestions"] = serde_json::json!([]);
        payload
    }

    /// The call's `PostToolUse`.
    fn ran(tool: &str, input: &Value, agent: Option<&str>) -> Value {
        let mut payload = call(tool, input, agent);
        payload["tool_response"] = serde_json::json!({ "stdout": "", "stderr": "" });
        payload["tool_use_id"] = "toolu_01".into();
        payload["duration_ms"] = 12.into();
        payload
    }

    /// The main thread's `PostToolBatch` listing these calls.
    fn batch(calls: &[(&str, &Value)]) -> Value {
        let calls: Vec<Value> = calls
            .iter()
            .map(|(tool, input)| {
                serde_json::json!({
                    "tool_name": tool, "tool_input": input, "tool_use_id": "toolu_02",
                    "tool_response": "done",
                })
            })
            .collect();
        let mut payload = call("", &Value::Null, None);
        let fields = payload.as_object_mut().unwrap();
        fields.remove("tool_name");
        fields.remove("tool_input");
        payload["tool_calls"] = calls.into();
        payload
    }

    /// A status-line render of `s1` that started at `started_ms`, recorded as
    /// the binary records one; whether it nudged the state.
    async fn render(db: &str, started_ms: i64) -> bool {
        let mut c = connect(db).await;
        let mut store = ConnStore {
            conn: &mut c,
            applied: Applied::default(),
        };
        let p = serde_json::json!({ "session_id": "s1" });
        let reading = StatuslineReading::of(&p);
        record_statusline_to(&mut store, &p, &reading, None, Some(started_ms)).await;
        let nudged = store.applied.nudges.state;
        c.close().await.unwrap();
        nudged
    }

    /// The render an answer to `s1`'s dialog on record leaves: the first that
    /// can say it closed ([`RENDER_MARGIN_MS`]); whether it nudged the state.
    async fn answered(db: &str) -> bool {
        let recorded = dialog_of(db, "s1").await.2.unwrap();
        render(db, recorded + RENDER_MARGIN_MS + 1).await
    }

    /// `s1`'s dialog on record as the next write reads it: stored stacked,
    /// and closed. `None` while the row holds none.
    async fn on_record(db: &str) -> Option<(bool, bool)> {
        let mut c = connect(db).await;
        let found = dialog_on_record(&mut c, "s1").await.unwrap();
        c.close().await.unwrap();
        found.map(|(_, marks)| (marks.stacked, marks.closed_at().is_some()))
    }

    /// S1-S3 as probed (CLI 2.1.312): parallel calls fire every
    /// `PermissionRequest` within ~5 ms, in any order, and a background
    /// subagent asking beside the main thread fires its own seconds later;
    /// Claude shows one dialog at a time, and the ones behind fire nothing
    /// when they come forward. So the second request reads stacked whichever
    /// landed first, and a stack closes only on a render: the call that
    /// finished may be the one that was in front.
    #[tokio::test]
    async fn parallel_requests_stack_and_only_a_render_closes_them() {
        let alpha = serde_json::json!({ "file_path": "/run/outA/alpha-first.txt" });
        let beta = serde_json::json!({ "file_path": "/run/outB/beta-second.txt" });
        let sub = serde_json::json!({ "command": "touch sub-a" });
        for (n, (first, second)) in [(&alpha, &beta), (&beta, &alpha)].into_iter().enumerate() {
            let (base, db) = dialog_db(&format!("parallel-{n}")).await;
            assert!(fire(&db, "PermissionRequest", asks("Read", first, None)).await);
            assert_eq!(on_record(&db).await, Some((false, false)));
            assert!(fire(&db, "PermissionRequest", asks("Read", second, None)).await);
            assert_eq!(on_record(&db).await, Some((true, false)));

            // Either call can be the one answered first.
            fire(&db, "PostToolUse", ran("Read", second, None)).await;
            fire(&db, "PostToolUse", ran("Read", first, None)).await;
            assert_eq!(on_record(&db).await, Some((true, false)));

            // S3: a subagent asks while the stack is still up.
            assert!(fire(&db, "PermissionRequest", asks("Bash", &sub, Some(SUBAGENT))).await);
            assert_eq!(on_record(&db).await, Some((true, false)));

            // Every dialog answered, the status line renders, and the next
            // request is behind nothing.
            assert!(answered(&db).await);
            assert_eq!(on_record(&db).await, Some((true, true)));
            assert!(fire(&db, "PermissionRequest", asks("Read", &alpha, None)).await);
            assert_eq!(on_record(&db).await, Some((false, false)));

            let _ = std::fs::remove_dir_all(&base);
        }
    }

    /// Serial calls ask one after the other (S2's `touch` pairs and the serial
    /// probes, CLI 2.1.312): the next dialog draws 33-54 ms after the answer,
    /// and the render that would have followed is dropped. What separates the
    /// two is the first call finishing: its `PostToolUse` landed 4-11 ms
    /// before the next request in 9 of 9 pairs, and after "No, and tell
    /// Claude" the `PostToolBatch` listing the rejected call came first in 5
    /// of 5.
    #[tokio::test]
    async fn a_request_after_its_predecessors_call_finished_is_not_stacked() {
        let (base, db) = dialog_db("serial").await;
        let touch = |n: u32| serde_json::json!({ "command": format!("touch ../outside/x-{n}"), "description": "Touch" });

        // Approved: the call runs and says so, once.
        fire(&db, "PermissionRequest", asks("Bash", &touch(1), None)).await;
        assert!(fire(&db, "PostToolUse", ran("Bash", &touch(1), None)).await);
        assert_eq!(on_record(&db).await, Some((false, true)));
        assert!(!fire(&db, "PostToolBatch", batch(&[("Bash", &touch(1))])).await);
        fire(&db, "PermissionRequest", asks("Bash", &touch(2), None)).await;
        assert_eq!(on_record(&db).await, Some((false, false)));

        // Rejected with feedback: only the batch reports the call.
        assert!(fire(&db, "PostToolBatch", batch(&[("Bash", &touch(2))])).await);
        fire(&db, "PermissionRequest", asks("Bash", &touch(3), None)).await;
        assert_eq!(on_record(&db).await, Some((false, false)));

        // The hooks are async: a request that lands before the previous call's
        // report reads stacked, until a render.
        fire(&db, "PermissionRequest", asks("Bash", &touch(4), None)).await;
        fire(&db, "PostToolUse", ran("Bash", &touch(3), None)).await;
        assert_eq!(on_record(&db).await, Some((true, false)));
        assert!(answered(&db).await);

        // [Glob, Read, Read]: the auto-allowed Glob finishing between the two
        // requests is not the first Read's call.
        let read = |path: &str| serde_json::json!({ "file_path": path });
        fire(
            &db,
            "PermissionRequest",
            asks("Read", &read("/run/outA/a"), None),
        )
        .await;
        fire(
            &db,
            "PostToolUse",
            ran("Glob", &serde_json::json!({ "pattern": "*" }), None),
        )
        .await;
        fire(
            &db,
            "PermissionRequest",
            asks("Read", &read("/run/outB/b"), None),
        )
        .await;
        assert_eq!(on_record(&db).await, Some((true, false)));
        assert!(answered(&db).await);

        // A question's `PostToolUse` carries the answer; the batch carries the
        // question as it was asked.
        let question = serde_json::json!({ "questions": [{
            "question": "Which color for probe 1?", "header": "Color", "multiSelect": false,
            "options": [{ "label": "Red", "description": "" }, { "label": "Blue", "description": "" }],
        }] });
        let mut answered = question.clone();
        answered["answers"] = serde_json::json!({ "Which color for probe 1?": "Red" });
        answered["annotations"] = serde_json::json!({});
        fire(
            &db,
            "PermissionRequest",
            asks("AskUserQuestion", &question, None),
        )
        .await;
        fire(&db, "PostToolUse", ran("AskUserQuestion", &answered, None)).await;
        assert_eq!(on_record(&db).await, Some((false, false)));
        assert!(
            fire(
                &db,
                "PostToolBatch",
                batch(&[("AskUserQuestion", &question)])
            )
            .await
        );
        assert_eq!(on_record(&db).await, Some((false, true)));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A dialog's call is matched by its thread, its tool and its whole input
    /// (the request carries no `tool_use_id`): a subagent's call with the same
    /// tool and input is not the main thread's, and an input too long to store
    /// whole still matches, whatever order its keys come in.
    #[tokio::test]
    async fn a_dialogs_call_is_its_thread_tool_and_whole_input() {
        let (base, db) = dialog_db("call-identity").await;
        let ls = serde_json::json!({ "command": "ls /run/dirA" });
        fire(&db, "PermissionRequest", asks("Bash", &ls, None)).await;
        fire(&db, "PostToolUse", ran("Bash", &ls, Some(SUBAGENT))).await;
        let other = serde_json::json!({ "command": "ls /run/dirB" });
        fire(&db, "PostToolUse", ran("Bash", &other, None)).await;
        assert_eq!(on_record(&db).await, Some((false, false)));

        // S3 the other way round: the subagent asks beside the main thread's
        // open dialog. Its own call finishing is its, but it was stacked.
        let sub = serde_json::json!({ "command": "touch sub-a" });
        fire(&db, "PermissionRequest", asks("Bash", &sub, Some(SUBAGENT))).await;
        fire(&db, "PostToolUse", ran("Bash", &sub, Some(SUBAGENT))).await;
        assert_eq!(on_record(&db).await, Some((true, false)));
        assert!(answered(&db).await);

        // A subagent's own dialog, alone, closes with its own call.
        fire(&db, "PermissionRequest", asks("Bash", &ls, Some(SUBAGENT))).await;
        fire(&db, "PostToolUse", ran("Bash", &ls, None)).await;
        assert_eq!(on_record(&db).await, Some((false, false)));
        fire(&db, "PostToolUse", ran("Bash", &ls, Some(SUBAGENT))).await;
        assert_eq!(on_record(&db).await, Some((false, true)));

        // A write the row keeps only part of.
        let content = "x".repeat(MAX_PENDING_INPUT * 2);
        let write = serde_json::json!({ "file_path": "/run/work/big.txt", "content": content });
        let reordered = serde_json::json!({ "content": content, "file_path": "/run/work/big.txt" });
        fire(&db, "PermissionRequest", asks("Write", &write, None)).await;
        fire(&db, "PostToolUse", ran("Write", &reordered, None)).await;
        assert_eq!(on_record(&db).await, Some((false, true)));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// An MCP server's form closes by neither sign: neither was probed for
    /// one, and a wrong "closed" lets an Enter land on the open form. A render
    /// after it closes nothing, and a request while it is up is behind it.
    #[tokio::test]
    async fn an_elicitation_closes_only_by_its_answer() {
        let (base, db) = dialog_db("elicitation").await;
        assert!(
            fire(
                &db,
                "Elicitation",
                serde_json::json!({
                    "cwd": "/run/work", "mcp_server_name": "probe", "message": "Pick one",
                    "mode": "form", "requested_schema": { "type": "object", "properties": {} },
                }),
            )
            .await
        );
        assert!(!answered(&db).await);
        assert_eq!(on_record(&db).await, Some((false, false)));
        let ls = serde_json::json!({ "command": "ls /run/dirA" });
        fire(&db, "PermissionRequest", asks("Bash", &ls, None)).await;
        assert_eq!(on_record(&db).await, Some((true, false)));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The main thread's MCP form is up and a background subagent asks
    /// permission: its request is recorded stacked behind the form. The
    /// form's own notice lands ~6 s after the form, and the user answers the
    /// form in the terminal. Neither is about the subagent's dialog, which
    /// comes forward firing nothing (payloads as CLI 2.1.312 sends them): the
    /// row keeps that dialog, still stacked, and a request after it is behind
    /// it too. Over a form on record, the answer still clears it.
    #[tokio::test]
    async fn a_forms_answer_leaves_a_permission_dialog_on_record() {
        let form = serde_json::json!({
            "cwd": "/run/work", "mcp_server_name": "probe", "message": "Pick one",
            "mode": "form", "requested_schema": { "type": "object", "properties": {} },
        });
        let notice = serde_json::json!({
            "cwd": "/run/work", "message": "Claude Code needs your input",
            "notification_type": "elicitation_dialog",
        });
        let answer = serde_json::json!({
            "cwd": "/run/work", "mcp_server_name": "probe", "mode": "form",
            "action": "accept", "content": { "confirm": true },
        });
        let (base, db) = dialog_db("form-answer").await;
        fire(&db, "Elicitation", form.clone()).await;
        let sub = serde_json::json!({ "command": "touch sub-a" });
        fire(&db, "PermissionRequest", asks("Bash", &sub, Some(SUBAGENT))).await;
        assert_eq!(on_record(&db).await, Some((true, false)));
        assert!(!fire(&db, "Notification", notice).await);
        assert!(!fire(&db, "ElicitationResult", answer.clone()).await);
        assert_eq!(row_of(&db, "s1").await.0, "permission");
        assert_eq!(on_record(&db).await, Some((true, false)));
        let ls = serde_json::json!({ "command": "ls /run/dirA" });
        fire(&db, "PermissionRequest", asks("Bash", &ls, None)).await;
        assert_eq!(on_record(&db).await, Some((true, false)));

        let (base2, db2) = dialog_db("form-answered").await;
        fire(&db2, "Elicitation", form).await;
        assert!(fire(&db2, "ElicitationResult", answer).await);
        assert_eq!(
            (row_of(&db2, "s1").await.0, on_record(&db2).await),
            ("active".to_string(), None)
        );

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&base2);
    }

    /// The two hooks of a parallel pair land 0-5 ms apart, in separate
    /// processes: the second must see the first, so exactly one of them reads
    /// stacked, every time.
    #[tokio::test]
    async fn two_dialogs_written_at_once_stack_exactly_one() {
        let (base, db) = state_db("stacked-race").await;
        let first = dialog(
            "PermissionRequest",
            serde_json::json!({ "command": "ls /a" }),
        );
        let second = dialog(
            "PermissionRequest",
            serde_json::json!({ "command": "ls /b" }),
        );
        for n in 0..20 {
            let session = format!("race-{n}");
            let asks = |d| StateWrite {
                session_id: &session,
                pending: Some(d),
                ..write(
                    AgentState::Permission,
                    "PermissionRequest",
                    Some("run Bash"),
                    Some(MAIN_ASKER),
                )
            };
            let (one, other) = (asks(&first), asks(&second));
            let (a, b) = tokio::join!(record(&db, &one), record(&db, &other));
            assert!(a.unwrap().state && b.unwrap().state);
            // The one that landed second is the one stored, and it saw the first.
            let mut c = connect(&db).await;
            let (stacked,): (Option<bool>,) =
                sqlx::query_as("SELECT pending_stacked FROM session_state WHERE session_id = ?")
                    .bind(&session)
                    .fetch_one(&mut c)
                    .await
                    .unwrap();
            c.close().await.unwrap();
            assert_eq!(stacked, Some(true), "{session}");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The first render to start well after a dialog was recorded
    /// ([`RENDER_MARGIN_MS`]) closes it, once, and never moves the row's clock,
    /// which is the dialog's record time. A render launched before the dialog
    /// drew closes nothing, whether it lands after the dialog's hook or starts
    /// after it (`sp1`) — 330 ms late, as a process can under load, or a full
    /// second — and neither does a relayed one, whose start is on the box.
    #[tokio::test]
    async fn the_first_render_after_a_dialog_closes_it_once() {
        let (base, db) = dialog_db("render-closes").await;
        let sleep = serde_json::json!({ "command": "sleep 8 && touch s4-done" });
        fire(&db, "PermissionRequest", asks("Bash", &sleep, None)).await;
        let (_, _, recorded, clock) = dialog_of(&db, "s1").await;
        let recorded = recorded.unwrap();

        assert!(
            !render(&db, recorded - 1).await,
            "launched before the dialog fired"
        );
        assert!(
            !render(&db, recorded + 330).await,
            "launched as the dialog drew, its process stalled under load"
        );
        assert!(
            !render(&db, recorded + RENDER_MARGIN_MS).await,
            "launched as the dialog drew, started a second after its hook"
        );
        let mut c = connect(&db).await;
        let relayed = apply(
            &mut c,
            &Invocation::Statusline,
            br#"{"session_id":"s1"}"#,
            &HookEnv::default(),
        )
        .await;
        c.close().await.unwrap();
        assert!(!relayed.nudges.state && relayed.failures.is_empty());
        assert_eq!(on_record(&db).await, Some((false, false)));

        assert!(answered(&db).await, "the approval's render");
        assert!(
            !render(&db, recorded + RENDER_MARGIN_MS + 15_000).await,
            "the next refresh"
        );
        assert_eq!(on_record(&db).await, Some((false, true)));
        assert_eq!(dialog_of(&db, "s1").await.3, clock);

        // The next dialog is a new one to close.
        fire(&db, "PermissionRequest", asks("Bash", &sleep, None)).await;
        assert_eq!(on_record(&db).await, Some((false, false)));
        assert!(answered(&db).await);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// What CLI 2.1.312 fires when a background subagent asks permission
    /// (captured): the subagent's `PermissionRequest`, the main thread's `Stop`
    /// ~20 ms later with the dialog still up, then the `permission_prompt`
    /// Notification ~6 s later naming no agent. The dialog stays on record
    /// through all of it, asked by that subagent, until a new turn: a `Stop`
    /// that cleared it would read a session with a dialog on screen as one at
    /// its prompt.
    #[tokio::test]
    async fn a_subagents_dialog_outlives_the_main_threads_turn() {
        let (base, db) = state_db("subagent-dialog").await;
        let asked = format!("{SUBAGENT_ASKER}a3a8e734fe1a2da00");
        let row = || {
            let db = db.clone();
            async move {
                let mut c = SqliteConnectOptions::new()
                    .filename(&db)
                    .connect()
                    .await
                    .unwrap();
                let row: (String, Option<String>, Option<String>) = sqlx::query_as(
                    "SELECT state, message, asker FROM session_state WHERE session_id = 's1'",
                )
                .fetch_one(&mut c)
                .await
                .unwrap();
                row
            }
        };
        let on_record = || {
            (
                "permission".to_string(),
                Some("run Bash".to_string()),
                Some(asked.clone()),
            )
        };

        let subagents = dialog(
            "PermissionRequest",
            serde_json::json!({ "command": "touch x" }),
        );
        let asks = StateWrite {
            pending: Some(&subagents),
            ..write(
                AgentState::Permission,
                "PermissionRequest",
                Some("run Bash"),
                Some(&asked),
            )
        };
        assert!(record_state(&db, &asks).await.unwrap());
        let stored = dialog_of(&db, "s1").await;
        for (state, event, message) in [
            // The main thread's turn ends behind the dialog…
            (AgentState::Idle, "Stop", None),
            (AgentState::Idle, "Notification", None),
            // …and the notification about the dialog says less than the
            // request did: no tool, no asker.
            (
                AgentState::Permission,
                "Notification",
                Some("Claude needs your permission"),
            ),
        ] {
            assert!(
                !record_state(&db, &write(state, event, message, None))
                    .await
                    .unwrap(),
                "{event} {state:?}"
            );
            assert_eq!(row().await, on_record(), "after {event} {state:?}");
            assert_eq!(
                dialog_of(&db, "s1").await,
                stored,
                "the dialog stays on record after {event} {state:?}"
            );
        }

        // A new turn ends it, and that turn's `Stop` is the prompt again.
        assert!(record_state(
            &db,
            &write(AgentState::Active, "UserPromptSubmit", None, None)
        )
        .await
        .unwrap());
        assert_eq!(row().await, ("active".to_string(), None, None));
        assert_eq!(dialog_of(&db, "s1").await.0, None);
        assert!(
            record_state(&db, &write(AgentState::Idle, "Stop", None, None))
                .await
                .unwrap()
        );
        assert_eq!(row().await.0, "idle");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A launch that carries its first prompt fires `SessionStart` and that
    /// prompt's `UserPromptSubmit` ~50 ms apart, both `async`, so their writes
    /// can land in either order. A `SessionStart` that began before the
    /// prompt's row was written must not read the turn as idle; one that
    /// began after it (a later process resuming) still lands.
    #[tokio::test]
    async fn a_session_start_landing_after_its_first_prompt_keeps_the_turn_running() {
        let (base, db) = state_db("launch-race").await;
        let started = |fired_ms| StateWrite {
            source: Some("startup"),
            fired_ms,
            ..write(AgentState::Idle, "SessionStart", None, None)
        };
        let began = now_ms() - 50;
        assert!(record_state(
            &db,
            &write(AgentState::Active, "UserPromptSubmit", None, None)
        )
        .await
        .unwrap());
        assert!(!record_state(&db, &started(began)).await.unwrap());
        assert_eq!(row_of(&db, "s1").await.0, "active");

        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(record_state(&db, &started(now_ms())).await.unwrap());
        assert_eq!(row_of(&db, "s1").await.0, "idle");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A db with the tables the status line writes (migrations 0011 + 0027 +
    /// 0043, and `session_state` for the effort).
    async fn statusline_db(name: &str) -> (std::path::PathBuf, String) {
        let base = std::env::temp_dir().join(format!("santree-hook-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");
        let mut c = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        for ddl in [
            USAGE_DDL,
            "CREATE TABLE claude_rate_limits (window TEXT PRIMARY KEY, used_pct REAL NOT NULL, \
             resets_at_ms INTEGER, updated_at_ms INTEGER NOT NULL)",
            STATE_DDL[0],
        ] {
            sqlx::query(ddl).execute(&mut c).await.unwrap();
        }
        c.close().await.unwrap();
        let db = db_path.to_str().unwrap().to_string();
        (base, db)
    }

    async fn recorded(db_path: &str) -> (Vec<(String, f64)>, Vec<(String, f64)>) {
        let mut c = SqliteConnectOptions::new()
            .filename(db_path)
            .connect()
            .await
            .unwrap();
        let usage = sqlx::query_as("SELECT session_id, used_pct FROM session_usage_live")
            .fetch_all(&mut c)
            .await
            .unwrap();
        let limits =
            sqlx::query_as("SELECT window, used_pct FROM claude_rate_limits ORDER BY window")
                .fetch_all(&mut c)
                .await
                .unwrap();
        c.close().await.unwrap();
        (usage, limits)
    }

    const STATUSLINE_PAYLOAD: &str = r#"{"session_id":"s-global","model":{"id":"claude-opus-4-8","display_name":"Opus"},"context_window":{"used_percentage":42,"total_input_tokens":84000,"context_window_size":200000},"rate_limits":{"five_hour":{"used_percentage":37,"resets_at":1787000000},"seven_day":{"used_percentage":81.25}}}"#;

    /// Our own bar without `--then`; with it, the payload is recorded exactly as
    /// for our bar, but what Claude renders is the user's command's own output, fed the
    /// same stdin bytes, with its stderr and exit code intact.
    #[test]
    fn statusline_passthrough_records_then_forwards_the_users_status_line() {
        // `statusline` builds its own runtime, so it runs outside any test runtime.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (base, db) = rt.block_on(statusline_db("passthrough"));
        let raw = STATUSLINE_PAYLOAD.as_bytes();

        // Without `--then` the status line is santree's own bar.
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(statusline(&db, None, raw, &mut out, &mut err, now_ms()), 0);
        let shown = String::from_utf8(out).unwrap();
        // 42% raw → 50% with the 1.2x display nudge.
        assert!(shown.contains("50%") && shown.contains("Opus"), "{shown:?}");

        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = statusline(&db, Some("cat"), raw, &mut out, &mut err, now_ms());
        assert_eq!(code, 0);
        assert_eq!(out, raw, "the user's command saw the exact payload bytes");
        assert!(err.is_empty(), "{}", String::from_utf8_lossy(&err));
        let (usage, limits) = rt.block_on(recorded(&db));
        assert_eq!(usage, vec![("s-global".to_string(), 42.0)]);
        assert_eq!(
            limits,
            vec![
                ("five_hour".to_string(), 37.0),
                ("seven_day".to_string(), 81.25)
            ]
        );

        // stderr and a non-zero exit are the user's own, forwarded unchanged.
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = statusline(
            &db,
            Some("cat >&2; exit 7"),
            raw,
            &mut out,
            &mut err,
            now_ms(),
        );
        assert_eq!(code, 7);
        assert!(out.is_empty());
        assert_eq!(err, raw);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The invariant the global opt-in rests on: a db problem (here, no db at
    /// all) must never change what the user's status line shows.
    #[test]
    fn statusline_passthrough_survives_a_missing_db() {
        let raw = STATUSLINE_PAYLOAD.as_bytes();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = statusline(
            "/nonexistent/santree.db",
            Some("cat"),
            raw,
            &mut out,
            &mut err,
            now_ms(),
        );
        assert_eq!(code, 0);
        assert_eq!(out, raw);
        assert!(err.is_empty(), "{}", String::from_utf8_lossy(&err));
    }

    /// Claude runs the id santree launched it with, so only `/clear` and a fork
    /// (an id santree never chose) may repoint the row — never a sibling tab's or
    /// subprocess's SessionStart. Codex mints every id itself, so every
    /// SessionStart is the only chance to learn it; a `source` gate there would
    /// leave the launch invisible. Providers that never run this binary bind
    /// nothing.
    #[test]
    fn which_session_starts_rebind_the_terminals_session_id() {
        for (source, claude) in [
            (Some("clear"), true),
            (Some("fork"), true),
            (Some("startup"), false),
            (Some("resume"), false),
            (Some("compact"), false),
            (None, false),
        ] {
            assert_eq!(
                binds_session_id(AgentKind::Claude, source),
                claude,
                "{source:?}"
            );
            assert!(binds_session_id(AgentKind::Codex, source), "{source:?}");
        }
        for kind in [AgentKind::Cursor, AgentKind::Opencode] {
            assert!(!binds_session_id(kind, Some("startup")));
        }
    }

    /// The `terminal_sessions` table the app owns (mirrors migration 0025: the
    /// primary key carries `agent_kind`, so one logical surface can hold a Claude
    /// row and a Codex row at once).
    async fn registry_db(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("santree-hook-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");
        let mut c = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE terminal_sessions (repo TEXT NOT NULL, term_key TEXT NOT NULL, \
             cwd TEXT NOT NULL, session_id TEXT NOT NULL, \
             created_at TEXT NOT NULL DEFAULT '', \
             agent_kind TEXT NOT NULL DEFAULT 'Claude' \
               CHECK (agent_kind IN ('Claude', 'Codex', 'Cursor', 'Opencode')), \
             account TEXT, \
             PRIMARY KEY (repo, term_key, agent_kind))",
        )
        .execute(&mut c)
        .await
        .unwrap();
        c.close().await.unwrap();
        (base, db_path)
    }

    async fn registry_rows(db_path: &std::path::Path) -> Vec<(String, String, String, String)> {
        let mut c = SqliteConnectOptions::new()
            .filename(db_path)
            .connect()
            .await
            .unwrap();
        let rows = sqlx::query_as(
            "SELECT term_key, agent_kind, session_id, cwd FROM terminal_sessions \
             ORDER BY term_key, agent_kind",
        )
        .fetch_all(&mut c)
        .await
        .unwrap();
        c.close().await.unwrap();
        rows
    }

    #[tokio::test]
    async fn reconcile_adopts_the_live_session_id_for_the_terminal() {
        let (base, db_path) = registry_db("reconcile").await;
        let db = db_path.to_str().unwrap();
        let claude = |key: &'static str, sid: &'static str| {
            reconcile_terminal_session(
                db,
                "acme/app",
                key,
                "/checkout",
                sid,
                AgentKind::Claude,
                None,
            )
        };

        // No db yet ⇒ silent no-op, never creates one (COMPLIANCE: never disrupt).
        let missing = base.join("nothing-here/santree.db");
        assert!(!reconcile_terminal_session(
            missing.to_str().unwrap(),
            "acme/app",
            "tree:AK-1",
            "/checkout",
            "new-id",
            AgentKind::Claude,
            None,
        )
        .await
        .unwrap());
        assert!(!missing.exists(), "reconcile must not create the db");

        // Seed one terminal pointing at the pre-`/clear` session, plus a decoy the
        // update must not touch.
        {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .connect()
                .await
                .unwrap();
            for (repo, key, sid, kind) in [
                ("acme/app", "tree:AK-1", "old-cleared-id", "Claude"),
                ("acme/app", "tree:AK-2", "untouched-id", "Claude"),
                // The decoy that matters: a Codex thread on the SAME logical
                // surface as the session being reconciled.
                ("acme/app", "tree:AK-1", "codex-thread-id", "Codex"),
            ] {
                sqlx::query(
                    "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind) \
                     VALUES (?, ?, '/checkout', ?, ?)",
                )
                .bind(repo)
                .bind(key)
                .bind(sid)
                .bind(kind)
                .execute(&mut c)
                .await
                .unwrap();
            }
            c.close().await.unwrap();
        }

        // The `/clear` reconcile flips the stored id to the new live session.
        assert!(claude("tree:AK-1", "new-clear-id").await.unwrap());
        // Same id again ⇒ no-op (a normal startup/resume writes nothing, nudges nothing).
        assert!(!claude("tree:AK-1", "new-clear-id").await.unwrap());
        // A term_key with no row (never launched by santree) ⇒ nothing to adopt,
        // and nothing fabricated: Claude's id is santree's, so a missing row means
        // a session we don't track.
        assert!(!claude("tree:AK-9", "x").await.unwrap());

        // The Codex row on `tree:AK-1` keeps its thread id. Without the
        // `agent_kind = ?` predicate this reconcile overwrites it with the Claude
        // UUID, the next resolve finds no rollout for that id and starts a
        // replacement thread, and the user's Codex conversation is gone.
        assert_eq!(
            registry_rows(&db_path).await,
            vec![
                (
                    "tree:AK-1".to_string(),
                    "Claude".to_string(),
                    "new-clear-id".to_string(),
                    "/checkout".to_string()
                ),
                (
                    "tree:AK-1".to_string(),
                    "Codex".to_string(),
                    "codex-thread-id".to_string(),
                    "/checkout".to_string()
                ),
                (
                    "tree:AK-2".to_string(),
                    "Claude".to_string(),
                    "untouched-id".to_string(),
                    "/checkout".to_string()
                ),
            ]
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Codex's `SessionStart` is the only place santree ever learns the id Codex
    /// minted, so unlike Claude's repair it has to *create* the row — otherwise
    /// the session never appears in the sidebar and can never be resumed. It must
    /// still land as `agent_kind = 'Codex'` on its own surface, leaving a sibling
    /// Claude row alone.
    #[tokio::test]
    async fn codex_session_start_binds_a_codex_row_for_the_terminal() {
        let (base, db_path) = registry_db("codex-bind").await;
        let db = db_path.to_str().unwrap();
        let codex = |sid: &'static str, cwd: &'static str| {
            reconcile_terminal_session(
                db,
                "acme/app",
                "tree:AK-1",
                cwd,
                sid,
                AgentKind::Codex,
                None,
            )
        };

        // A Claude session already runs on the same surface.
        {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .connect()
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind) \
                 VALUES ('acme/app', 'tree:AK-1', '/checkout', 'claude-id', 'Claude')",
            )
            .execute(&mut c)
            .await
            .unwrap();
            c.close().await.unwrap();
        }

        // The fresh launch's minted id arrives with no row to update.
        assert!(codex("codex-thread-1", "/checkout").await.unwrap());
        // A resume reports the same id ⇒ no write, no UI nudge.
        assert!(!codex("codex-thread-1", "/checkout").await.unwrap());
        // A `/new` inside Codex mints another id on the same surface: repoint it.
        assert!(codex("codex-thread-2", "/checkout").await.unwrap());

        assert_eq!(
            registry_rows(&db_path).await,
            vec![
                (
                    "tree:AK-1".to_string(),
                    "Claude".to_string(),
                    "claude-id".to_string(),
                    "/checkout".to_string()
                ),
                (
                    "tree:AK-1".to_string(),
                    "Codex".to_string(),
                    "codex-thread-2".to_string(),
                    "/checkout".to_string()
                ),
            ]
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A relayed hook's `event` is the local command's argv after `--db`, read
    /// by the same parser — and never the MCP server.
    #[test]
    fn relayed_events_parse_like_the_local_argv() {
        assert_eq!(
            Invocation::parse_relayed("SessionStart"),
            Some(Invocation::Hook {
                event: "SessionStart".into(),
                agent: AgentKind::Claude
            })
        );
        assert_eq!(
            Invocation::parse_relayed("--agent-kind Codex Stop"),
            Some(Invocation::Hook {
                event: "Stop".into(),
                agent: AgentKind::Codex
            })
        );
        assert_eq!(
            Invocation::parse_relayed("statusline"),
            Some(Invocation::Statusline)
        );
        for refused in [
            "",
            "mcp",
            "--agent-kind Cursor Stop",
            "--agent-kind Nope Stop",
            // Never registered on the box: a line-by-line feed is not relayed.
            "MessageDisplay",
        ] {
            assert_eq!(Invocation::parse_relayed(refused), None, "{refused:?}");
        }
        // `--db` can't be smuggled in to point anywhere: the relay has no path.
        assert!(matches!(
            Invocation::parse_relayed("--db /etc/x Stop"),
            Some(Invocation::Hook { .. })
        ));
    }

    #[test]
    fn a_relayed_env_is_read_like_the_process_env() {
        let env = HookEnv::from_pairs([
            ("SANTREE_REPO", "acme/app"),
            ("PATH", "/bin"),
            ("SANTREE_TERM_KEY", "old"),
            ("SANTREE_TERM_KEY", "tree:AK-1"),
        ]);
        assert_eq!(
            env,
            HookEnv {
                repo: "acme/app".into(),
                term_key: "tree:AK-1".into(),
                account: None,
            }
        );
    }

    /// Through a caller's connection, a hook writes what the binary writes and
    /// reports what the binary would have pinged and logged.
    #[tokio::test]
    async fn apply_on_a_connection_records_binds_and_reports() {
        let (base, db_path) = registry_db("apply-conn").await;
        let mut conn = SqliteConnectOptions::new()
            .filename(&db_path)
            .connect()
            .await
            .unwrap();
        for ddl in STATE_DDL {
            sqlx::query(ddl).execute(&mut conn).await.unwrap();
        }

        let start = Invocation::parse_relayed("--agent-kind Codex SessionStart").unwrap();
        let payload = br#"{"session_id":"t-1","cwd":"/srv/w","source":"startup"}"#;
        let env = HookEnv {
            repo: "acme/app".into(),
            term_key: "tree:AK-1".into(),
            account: None,
        };
        let applied = apply(&mut conn, &start, payload, &env).await;
        assert_eq!(
            applied,
            Applied {
                nudges: Nudges {
                    state: true,
                    ..Nudges::default()
                },
                failures: vec![],
            }
        );
        let (state, _, _): (String, Option<String>, i64) = sqlx::query_as(
            "SELECT state, message, updated_at_ms FROM session_state WHERE session_id = 't-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(state, "idle");
        conn.close().await.unwrap();
        assert_eq!(
            registry_rows(&db_path).await,
            vec![(
                "tree:AK-1".into(),
                "Codex".into(),
                "t-1".into(),
                "/srv/w".into()
            )]
        );

        // Without the terminal's identity it still records, and says why it
        // couldn't bind — to the caller, not to a log file.
        let mut conn = SqliteConnectOptions::new()
            .filename(&db_path)
            .connect()
            .await
            .unwrap();
        let payload = br#"{"session_id":"t-2","cwd":"/srv/w"}"#;
        let applied = apply(&mut conn, &start, payload, &HookEnv::default()).await;
        assert!(applied.nudges.state);
        assert_eq!(applied.failures.len(), 1);
        assert!(
            applied.failures[0].contains("SANTREE_REPO/SANTREE_TERM_KEY"),
            "{:?}",
            applied.failures
        );
        assert!(!base.join(FAILURE_LOG).exists());
        conn.close().await.unwrap();

        let _ = std::fs::remove_dir_all(&base);
    }
}
