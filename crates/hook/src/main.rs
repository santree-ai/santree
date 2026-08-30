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

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use santree_core::domain::{AgentKind, AgentState};
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
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
/// - `Notification` is refined by type: a plain `agent_completed` is `idle` (the
///   turn finished — not "needs you"), whereas a permission/input prompt is the
///   real "needs you" signal. Auth/elicitation-result notifications change
///   nothing.
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
fn resolve_state(event: &str, payload: &Value) -> Option<AgentState> {
    // Codex runs the same hook command for its subagents, tagging those payloads
    // with the child's `agent_id`. A subagent is not the surface's session: its
    // state would overwrite the user's, and its `SessionStart` would repoint the
    // terminal at a thread the user never opened. Ignore the whole payload.
    //
    // A *present but null* `agent_id` is the root session, not a subagent — the
    // shape a serializer emits for an absent optional. Reading it as "subagent"
    // would silently ignore every event the user's own session ever fires.
    if payload.get("agent_id").is_some_and(|id| !id.is_null()) {
        return None;
    }
    match event {
        // A turn is running — the user's prompt started it.
        "UserPromptSubmit" => Some(AgentState::Active),
        // Still running, mid-turn. A heartbeat, not a transition (see `record`).
        "PostToolUse" | "PostToolUseFailure" => Some(AgentState::Active),
        "SessionStart" | "Stop" => Some(AgentState::Idle),
        "SessionEnd" => Some(AgentState::Exited),
        "PermissionRequest" => Some(AgentState::Permission),
        "Notification" => match payload.get("notification_type").and_then(Value::as_str) {
            Some("permission_prompt") => Some(AgentState::Permission),
            Some("agent_completed") => Some(AgentState::Idle),
            Some("agent_needs_input") | Some("idle_prompt") | Some("elicitation_dialog") => {
                Some(AgentState::Waiting)
            }
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
}

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
/// permission, fall back to the tool name as "run <tool>".
fn read_hook_input(payload: &Value, state: AgentState) -> HookInput<'_> {
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
            _ => None,
        },
        source: field("source"),
    }
}

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

fn main() {
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
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);

    let Some(state) = resolve_state(&event, &payload) else {
        return; // event/notification that doesn't change state
    };

    let HookInput {
        session_id,
        cwd,
        transcript_path: transcript,
        message,
        source,
    } = read_hook_input(&payload, state);
    if session_id.is_empty() {
        return; // can't correlate without a session id
    }

    // A one-shot insert on a minimal current-thread runtime; swallow every error.
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let mut wrote = noted(
        &db_path,
        &event,
        "recording session state",
        rt.block_on(record(
            &db_path,
            session_id,
            state,
            &event,
            cwd,
            message.as_deref(),
            transcript,
        )),
    )
    .unwrap_or(false);

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
        let repo = std::env::var("SANTREE_REPO").unwrap_or_default();
        let term_key = std::env::var("SANTREE_TERM_KEY").unwrap_or_default();
        if repo.is_empty() || term_key.is_empty() {
            // The one failure that makes a session permanently unattributable:
            // without these the row can't be bound to a surface, and every
            // downstream symptom (no sidebar row, an unresumable session) reads
            // as "the hook never ran". Say so once, here.
            note(
                &db_path,
                &event,
                &format!(
                    "not binding session {session_id}: SANTREE_REPO/SANTREE_TERM_KEY \
                     missing from the hook's environment (repo={repo:?}, term_key={term_key:?})"
                ),
            );
        } else {
            let reconciled = noted(
                &db_path,
                &event,
                "binding the session to its terminal",
                rt.block_on(reconcile_terminal_session(
                    &db_path, &repo, &term_key, cwd, session_id, agent,
                )),
            )
            .unwrap_or(false);
            wrote = wrote || reconciled;
        }
    }

    // Nudge the app over its signal socket so the UI refreshes in realtime. Best
    // effort — if the app isn't running the connect just fails, and the app picks
    // up this row on its next read. Byte `s` = a state change (anything but `u`).
    if wrote {
        ping_socket(&db_path, b's');
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
fn note(db_path: &str, event: &str, detail: &str) {
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

/// Unwrap a hook-path result, leaving a [`note`] behind when it failed.
///
/// The error is dropped, not propagated: the caller's next step is still to exit
/// 0. What changes is that the failure is now recoverable *by a human reading
/// the log*, instead of being indistinguishable from a hook that never fired.
fn noted<T, E: std::fmt::Display>(
    db_path: &str,
    event: &str,
    what: &str,
    result: Result<T, E>,
) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(e) => {
            note(db_path, event, &format!("{what} failed: {e}"));
            None
        }
    }
}

/// Send a one-byte nudge over the app's signal socket (`<db_dir>/santree-signal.sock`).
/// The tag byte tells the app which table changed (`u` = live usage, `l` = rate
/// limits, `r` = review drafts, else state). Best-effort: a not-running app just
/// fails to connect.
pub(crate) fn ping_socket(db_path: &str, tag: u8) {
    if let Some(dir) = Path::new(db_path).parent() {
        if let Ok(mut stream) = UnixStream::connect(dir.join("santree-signal.sock")) {
            let _ = stream.write_all(&[tag]);
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
fn statusline(
    db_path: &str,
    then: Option<&str>,
    raw: &[u8],
    out: &mut dyn Write,
    err: &mut dyn Write,
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
    let cw = p.get("context_window");
    let num = |v: Option<&Value>| v.and_then(Value::as_f64).unwrap_or(0.0);
    let used_pct = num(cw.and_then(|c| c.get("used_percentage")));
    let input_tokens = num(cw.and_then(|c| c.get("total_input_tokens")));
    let context_size = num(cw.and_then(|c| c.get("context_window_size")));
    let cost = num(p.get("cost").and_then(|c| c.get("total_cost_usd")));
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

    // Without a passthrough this IS the status line: print the bar first so the
    // terminal renders promptly, then persist.
    if running.is_none() {
        let bar = render_bar(used_pct, input_tokens, model_display);
        let _ = out.write_all(bar.as_bytes());
        let _ = out.flush();
    }

    record_statusline(
        db_path,
        &p,
        used_pct,
        input_tokens,
        context_size,
        model_id,
        cost,
    );

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

/// Persist what the payload carried — the session's live usage and the account's
/// rate-limit windows — and nudge the app for whichever changed. Best-effort in
/// every branch: a missing db, a locked db, or no runtime all mean "record
/// nothing", never "fail the status line".
fn record_statusline(
    db_path: &str,
    p: &Value,
    used_pct: f64,
    input_tokens: f64,
    context_size: f64,
    model_id: &str,
    cost: f64,
) {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };

    let session_id = p
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !session_id.is_empty() {
        let wrote = rt
            .block_on(record_usage(
                db_path,
                session_id,
                used_pct,
                input_tokens,
                context_size,
                model_id,
                cost,
            ))
            .unwrap_or(false);
        if wrote {
            ping_socket(db_path, b'u');
        }
    }

    // The account-level rate-limit windows ride the same payload. They're not
    // tied to the session (every session reports the same numbers), so they're
    // recorded even without a session id, and skipped entirely when the payload
    // has none (API-key / Bedrock / Vertex sessions, or before the first response).
    let windows = parse_rate_limits(p);
    if !windows.is_empty() {
        let wrote = rt
            .block_on(record_rate_limits(db_path, &windows))
            .unwrap_or(false);
        if wrote {
            ping_socket(db_path, RATE_LIMITS_TAG);
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
    windows: &[RateLimitWindow],
) -> Result<bool, sqlx::Error> {
    if !Path::new(db_path).exists() {
        return Ok(false);
    }
    let mut conn = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(3))
        .connect()
        .await?;

    let mut wrote = false;
    for w in windows {
        let current: Option<(f64, Option<i64>)> = sqlx::query_as(
            "SELECT used_pct, resets_at_ms FROM claude_rate_limits WHERE window = ?",
        )
        .bind(&w.window)
        .fetch_optional(&mut conn)
        .await?;
        if let Some((used, resets)) = current {
            if (used - w.used_pct).abs() < 1e-9 && resets == w.resets_at_ms {
                continue;
            }
        }
        sqlx::query(
            "INSERT INTO claude_rate_limits (window, used_pct, resets_at_ms, updated_at_ms) \
             VALUES (?, ?, ?, ?) \
             ON CONFLICT(window) DO UPDATE SET \
               used_pct = excluded.used_pct, \
               resets_at_ms = excluded.resets_at_ms, \
               updated_at_ms = excluded.updated_at_ms",
        )
        .bind(&w.window)
        .bind(w.used_pct)
        .bind(w.resets_at_ms)
        .bind(now_ms())
        .execute(&mut conn)
        .await?;
        wrote = true;
    }

    // Same as `record_usage`: close before the caller nudges the app to read.
    conn.close().await?;
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

/// UPSERT the session's live usage. Returns `Ok(true)` when a row was written.
/// Dedups on an unchanged `(used_pct, input_tokens)` so identical re-renders don't
/// nudge the UI. Never creates the db.
async fn record_usage(
    db_path: &str,
    session_id: &str,
    used_pct: f64,
    input_tokens: f64,
    context_size: f64,
    model: &str,
    cost: f64,
) -> Result<bool, sqlx::Error> {
    if !Path::new(db_path).exists() {
        return Ok(false);
    }
    let mut conn = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(3))
        .connect()
        .await?;

    let current: Option<(f64, i64)> = sqlx::query_as(
        "SELECT used_pct, input_tokens FROM session_usage_live WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(&mut conn)
    .await?;
    if let Some((up, it)) = current {
        if (up - used_pct).abs() < 1e-9 && it == input_tokens as i64 {
            return Ok(false);
        }
    }

    sqlx::query(
        "INSERT INTO session_usage_live \
           (session_id, used_pct, input_tokens, context_size, model, cost_usd, updated_at_ms) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(session_id) DO UPDATE SET \
           used_pct = excluded.used_pct, \
           input_tokens = excluded.input_tokens, \
           context_size = excluded.context_size, \
           model = excluded.model, \
           cost_usd = excluded.cost_usd, \
           updated_at_ms = excluded.updated_at_ms",
    )
    .bind(session_id)
    .bind(used_pct)
    .bind(input_tokens as i64)
    .bind(context_size as i64)
    .bind(model)
    .bind(cost)
    .bind(now_ms())
    .execute(&mut conn)
    .await?;

    // Close before returning: the caller nudges the app the moment this resolves, and
    // the app then reads the row. Letting the connection drop instead hands the WAL
    // handoff to a background close that can still be racing that read.
    conn.close().await?;
    Ok(true)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// UPSERT the session's current state. Returns `Ok(true)` when a row was
/// written. Never creates the db — if the app hasn't made it yet, no-op.
async fn record(
    db_path: &str,
    session_id: &str,
    state: AgentState,
    event: &str,
    cwd: &str,
    message: Option<&str>,
    transcript: Option<&str>,
) -> Result<bool, sqlx::Error> {
    if !Path::new(db_path).exists() {
        return Ok(false);
    }
    // WAL mode is a persistent property of the file, so a fresh connection
    // inherits it; just don't create a stray db and give writes room under the
    // app's concurrent access.
    let mut conn = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(3))
        .connect()
        .await?;

    // Dedup: if the stored state + message already match, do nothing (return
    // false → no UI nudge). This keeps high-frequency tool events from
    // re-nudging every tool call while already "running" — only real transitions
    // (e.g. permission → running, running → idle) write and notify.
    let current: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT state, message FROM session_state WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(&mut conn)
            .await?;
    if let Some((cur_state, cur_message)) = &current {
        let stored = AgentState::parse(cur_state);
        // A heartbeat must never overrule a state the user still has to answer.
        // Tool hooks are registered `async`, so they are fire-and-forget with no
        // ordering guarantee: a `PostToolUse` from the *previous* tool can land
        // after the `PermissionRequest` for the next one, and writing "active"
        // there would clear a prompt that is still on screen. This is the whole
        // reason per-tool events were kept out before; handling them as
        // heartbeats — rather than as transitions — is what makes them safe.
        if is_heartbeat_event(event) && stored.is_some_and(AgentState::is_blocked_on_user) {
            return Ok(false);
        }
        if cur_state == state.as_str() && cur_message.as_deref() == message {
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
            if !state.is_blocked_on_user() {
                sqlx::query("UPDATE session_state SET updated_at_ms = ? WHERE session_id = ?")
                    .bind(now_ms())
                    .bind(session_id)
                    .execute(&mut conn)
                    .await?;
            }
            return Ok(false);
        }
    }

    sqlx::query(
        "INSERT INTO session_state \
           (session_id, state, event, cwd, message, transcript_path, updated_at_ms) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(session_id) DO UPDATE SET \
           state = excluded.state, \
           event = excluded.event, \
           cwd = excluded.cwd, \
           message = excluded.message, \
           transcript_path = excluded.transcript_path, \
           updated_at_ms = excluded.updated_at_ms",
    )
    .bind(session_id)
    .bind(state.as_str())
    .bind(event)
    .bind(cwd)
    .bind(message)
    .bind(transcript)
    .bind(now_ms())
    .execute(&mut conn)
    .await?;

    conn.close().await?;
    Ok(true)
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
) -> Result<bool, sqlx::Error> {
    if !Path::new(db_path).exists() {
        return Ok(false);
    }
    let mut conn = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(3))
        .connect()
        .await?;

    let statement = match agent {
        AgentKind::Codex => sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT (repo, term_key, agent_kind) DO UPDATE SET \
               session_id = excluded.session_id, \
               cwd = excluded.cwd \
             WHERE terminal_sessions.session_id <> excluded.session_id",
        )
        .bind(repo)
        .bind(term_key)
        .bind(cwd)
        .bind(session_id)
        .bind(agent.as_str()),
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
    let affected = statement.execute(&mut conn).await?.rows_affected();

    conn.close().await?;
    Ok(affected > 0)
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

        let kept: Option<u8> = noted(
            db.to_str().unwrap(),
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
            noted(
                db.to_str().unwrap(),
                "Stop",
                "recording",
                Ok::<_, String>(7)
            ),
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

    #[test]
    fn maps_events_to_states() {
        let nil = Value::Null;
        // SessionStart is idle (resumed / at the prompt), not active.
        assert_eq!(resolve_state("SessionStart", &nil), Some(AgentState::Idle));
        assert_eq!(
            resolve_state("UserPromptSubmit", &nil),
            Some(AgentState::Active)
        );
        assert_eq!(resolve_state("Stop", &nil), Some(AgentState::Idle));
        assert_eq!(resolve_state("SessionEnd", &nil), Some(AgentState::Exited));
        assert_eq!(
            resolve_state("PermissionRequest", &nil),
            Some(AgentState::Permission)
        );
        // The post-tool events are the mid-turn heartbeat (see
        // `tool_events_are_heartbeats_and_pretooluse_is_not_mapped_at_all` for the
        // ordering guarantee that makes them safe).
        assert_eq!(resolve_state("PostToolUse", &nil), Some(AgentState::Active));
        assert_eq!(
            resolve_state("PostToolUseFailure", &nil),
            Some(AgentState::Active)
        );
        // `PreToolUse` is not mapped: it fires before the tool, so it races its
        // own permission prompt, and it adds nothing `PostToolUse` doesn't say.
        assert_eq!(resolve_state("PreToolUse", &nil), None);
        assert_eq!(resolve_state("PermissionDenied", &nil), None);
        assert_eq!(resolve_state("PreCompact", &nil), None);
    }

    /// Codex 0.150.1's hook events, mapped through the same table as Claude's.
    /// The names it shares with Claude must mean the same state, and the ones it
    /// adds must not invent one: `PostCompact` is the tail of a compaction the
    /// agent is still in the middle of, and the `Subagent*` pair belongs to a
    /// child, not to the user's session.
    #[test]
    fn maps_codex_events_to_the_same_states() {
        let nil = Value::Null;
        assert_eq!(resolve_state("SessionStart", &nil), Some(AgentState::Idle));
        assert_eq!(
            resolve_state("UserPromptSubmit", &nil),
            Some(AgentState::Active)
        );
        assert_eq!(resolve_state("Stop", &nil), Some(AgentState::Idle));
        assert_eq!(resolve_state("SessionEnd", &nil), Some(AgentState::Exited));
        assert_eq!(
            resolve_state("PermissionRequest", &nil),
            Some(AgentState::Permission)
        );
        // Codex fires `PostToolUse` too, and it means the same thing there: the
        // turn is still moving. It is the only one of Codex's extra six that
        // carries a state at all.
        assert_eq!(resolve_state("PostToolUse", &nil), Some(AgentState::Active));
        for event in [
            "PreToolUse",
            "SubagentStart",
            "SubagentStop",
            "PreCompact",
            "PostCompact",
        ] {
            assert_eq!(resolve_state(event, &nil), None, "{event}");
        }
    }

    /// Codex runs the injected hook command for its subagents too, tagging those
    /// payloads with the child's `agent_id`. Recording one would show a helper's
    /// state on the user's surface, and its `SessionStart` would repoint the
    /// terminal at a thread the user never opened.
    #[test]
    fn ignores_every_subagent_payload() {
        let subagent = |event: &str| {
            resolve_state(
                event,
                &serde_json::json!({
                    "session_id": "child-thread",
                    "agent_id": "agent_01",
                    "hook_event_name": event,
                }),
            )
        };
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "SessionEnd",
            "PermissionRequest",
        ] {
            assert_eq!(subagent(event), None, "{event}");
        }
        // The same events without an `agent_id` are the user's own session — and
        // so is a null one, the shape an absent optional serializes to. Reading
        // that as "subagent" would ignore every event the root session fires.
        assert_eq!(
            resolve_state("Stop", &serde_json::json!({ "session_id": "root" })),
            Some(AgentState::Idle)
        );
        assert_eq!(
            resolve_state(
                "Stop",
                &serde_json::json!({ "session_id": "root", "agent_id": null })
            ),
            Some(AgentState::Idle)
        );
    }

    #[test]
    fn refines_notification_by_type() {
        let with_type = |t: &str| serde_json::json!({ "notification_type": t });
        assert_eq!(
            resolve_state("Notification", &with_type("permission_prompt")),
            Some(AgentState::Permission)
        );
        // A completed turn is idle, not a red "waiting".
        assert_eq!(
            resolve_state("Notification", &with_type("agent_completed")),
            Some(AgentState::Idle)
        );
        assert_eq!(
            resolve_state("Notification", &with_type("agent_needs_input")),
            Some(AgentState::Waiting)
        );
        // Non-state notifications don't change anything.
        assert_eq!(
            resolve_state("Notification", &with_type("auth_success")),
            None
        );
        // No type (older CLI) falls back to "waiting".
        assert_eq!(
            resolve_state("Notification", &Value::Null),
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
            read_hook_input(&permission, AgentState::Permission),
            HookInput {
                session_id: "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
                cwd: "/Users/me/dev/app",
                transcript_path: Some(
                    "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl"
                ),
                // No `message` on this one, so the tool name is the tooltip.
                message: Some("run Bash".into()),
                source: None,
            }
        );

        // Notification: the type refines the state, the message is the tooltip.
        let notification: Value = serde_json::from_str(
            r#"{
              "session_id": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
              "transcript_path": "/Users/me/.claude/projects/-Users-me-dev-app/9f1c0e2a.jsonl",
              "cwd": "/Users/me/dev/app",
              "hook_event_name": "Notification",
              "notification_type": "agent_needs_input",
              "message": "Claude is waiting for your input"
            }"#,
        )
        .unwrap();
        let state = resolve_state("Notification", &notification);
        assert_eq!(state, Some(AgentState::Waiting));
        assert_eq!(
            read_hook_input(&notification, state.unwrap())
                .message
                .as_deref(),
            Some("Claude is waiting for your input")
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
        let input = read_hook_input(&cleared, AgentState::Idle);
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
            read_hook_input(&session_start, AgentState::Idle),
            HookInput {
                session_id: "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d",
                cwd: "/Users/me/dev/app",
                // A JSON null is absent, not the string "null".
                transcript_path: None,
                message: None,
                source: Some("startup"),
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
        let input = read_hook_input(&permission, AgentState::Permission);
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
        assert_eq!(resolve_state("PermissionRequest", &subagent), None);
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
            read_hook_input(&payload, AgentState::Permission),
            HookInput {
                // Empty ⇒ `main` returns before writing anything.
                session_id: "",
                cwd: "",
                transcript_path: None,
                message: None,
                source: None,
            }
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
        let message = |state| read_hook_input(&payload, state).message;
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
            read_hook_input(&no_message, AgentState::Waiting).message,
            None
        );
        assert_eq!(
            read_hook_input(&no_message, AgentState::Permission)
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

    #[test]
    fn compacts_token_counts() {
        assert_eq!(compact(999.0), "999");
        assert_eq!(compact(604_000.0), "604k");
        assert_eq!(compact(1_200_000.0), "1.2M");
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

        // No db yet → no-op, no panic, and crucially no db created.
        assert!(!record_usage(db, "s1", 10.0, 100.0, 200_000.0, "m", 0.1)
            .await
            .unwrap());
        assert!(!db_path.exists(), "must never create the app's db");

        // The table the app owns (mirrors migration 0011).
        {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE session_usage_live (session_id TEXT PRIMARY KEY, used_pct REAL NOT NULL, \
                 input_tokens INTEGER NOT NULL, context_size INTEGER NOT NULL, model TEXT NOT NULL, \
                 cost_usd REAL NOT NULL, updated_at_ms INTEGER NOT NULL)",
            )
            .execute(&mut c)
            .await
            .unwrap();
            c.close().await.unwrap();
        }

        assert!(
            record_usage(db, "s1", 10.0, 100.0, 200_000.0, "claude-opus-4-8", 0.1)
                .await
                .unwrap()
        );
        // Identical (used_pct, input_tokens) → no write, no UI nudge.
        assert!(
            !record_usage(db, "s1", 10.0, 100.0, 200_000.0, "claude-opus-4-8", 0.2)
                .await
                .unwrap()
        );
        // A real change writes again.
        assert!(
            record_usage(db, "s1", 24.0, 500.0, 200_000.0, "claude-opus-4-8", 0.3)
                .await
                .unwrap()
        );

        let mut c = SqliteConnectOptions::new()
            .filename(&db_path)
            .connect()
            .await
            .unwrap();
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM session_usage_live")
            .fetch_one(&mut c)
            .await
            .unwrap();
        assert_eq!(count, 1, "one row per session");
        let (used, tokens, cost): (f64, i64, f64) =
            sqlx::query_as("SELECT used_pct, input_tokens, cost_usd FROM session_usage_live")
                .fetch_one(&mut c)
                .await
                .unwrap();
        assert_eq!((used, tokens), (24.0, 500), "latest usage won");
        assert_eq!(cost, 0.3);
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
        assert!(!record_rate_limits(db, &[five(10.0, None)]).await.unwrap());
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
        assert!(record_rate_limits(db, &first).await.unwrap());
        // The identical set again → no write, no UI nudge.
        assert!(!record_rate_limits(db, &first).await.unwrap());
        // One window moving is enough to write (and only that row changes).
        assert!(
            record_rate_limits(db, &[five(42.0, Some(1_787_000_000_000)), week.clone()])
                .await
                .unwrap()
        );
        // A reset time changing counts as a change too, even at the same percentage.
        assert!(
            record_rate_limits(db, &[five(42.0, Some(1_787_018_000_000))])
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
        assert!(!record(
            db,
            "s1",
            AgentState::Active,
            "SessionStart",
            "/w",
            None,
            None
        )
        .await
        .unwrap());

        // Create the table the app owns (mirrors migration 0010).
        {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, state TEXT NOT NULL, \
                 event TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '', message TEXT, \
                 transcript_path TEXT, updated_at_ms INTEGER NOT NULL)",
            )
            .execute(&mut c)
            .await
            .unwrap();
            c.close().await.unwrap();
        }

        assert!(record(
            db,
            "s1",
            AgentState::Active,
            "SessionStart",
            "/w",
            None,
            None
        )
        .await
        .unwrap());
        // Dedup: the same state + message again is a no-op (no UI nudge) — this is
        // what keeps repeated PreToolUse/PostToolUse from re-notifying every tool.
        assert!(
            !record(db, "s1", AgentState::Active, "PreToolUse", "/w", None, None)
                .await
                .unwrap()
        );
        assert!(record(db, "s1", AgentState::Idle, "Stop", "/w", None, None)
            .await
            .unwrap());

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

    /// A db holding just `session_state` (migration 0010), for the tests that
    /// exercise [`record`] directly.
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
        sqlx::query(
            "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, state TEXT NOT NULL, \
             event TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '', message TEXT, \
             transcript_path TEXT, updated_at_ms INTEGER NOT NULL)",
        )
        .execute(&mut c)
        .await
        .unwrap();
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

        assert!(record(
            &db,
            "s1",
            AgentState::Active,
            "UserPromptSubmit",
            "/w",
            None,
            None
        )
        .await
        .unwrap());
        let (_, _, first) = row_of(&db, "s1").await;

        // Far enough apart that a frozen clock is unambiguous.
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !record(
                &db,
                "s1",
                AgentState::Active,
                "PostToolUse",
                "/w",
                None,
                None
            )
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

    /// The reason per-tool events were kept out of the injected set for so long,
    /// now handled instead of avoided: these hooks are `async`, so a `PostToolUse`
    /// from the previous tool can land *after* the `PermissionRequest` for the
    /// next one. Writing "active" there would clear a prompt still on screen.
    ///
    /// It must not touch the clock either: for a pending prompt `updated_at_ms`
    /// means *when the prompt was recorded*, and the app decides the user answered
    /// by comparing the transcript against it. Bumping it would make a resolved
    /// prompt look pending forever.
    #[tokio::test]
    async fn a_straggling_tool_heartbeat_never_clears_a_live_permission_prompt() {
        let (base, db) = state_db("heartbeat-permission").await;

        assert!(record(
            &db,
            "s1",
            AgentState::Permission,
            "PermissionRequest",
            "/w",
            Some("run Bash"),
            None
        )
        .await
        .unwrap());
        let (_, _, recorded_at) = row_of(&db, "s1").await;

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!record(
            &db,
            "s1",
            AgentState::Active,
            "PostToolUse",
            "/w",
            None,
            None
        )
        .await
        .unwrap());

        let (state, message, updated) = row_of(&db, "s1").await;
        assert_eq!(state, "permission", "the prompt is still up");
        assert_eq!(message.as_deref(), Some("run Bash"));
        assert_eq!(
            updated, recorded_at,
            "a blocked-on-user row's clock is when the prompt appeared, not now"
        );

        // A real transition still gets through — this guard is about heartbeats,
        // not about freezing the row.
        assert!(
            record(&db, "s1", AgentState::Idle, "Stop", "/w", None, None)
                .await
                .unwrap()
        );
        assert_eq!(row_of(&db, "s1").await.0, "idle");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// `PostToolUse`/`PostToolUseFailure` mean "still working", and are the only
    /// events that fire mid-turn. `PreToolUse` stays unmapped: it fires *before*
    /// the tool, so it is the one that genuinely races its own permission prompt,
    /// and it says nothing `PostToolUse` doesn't.
    #[test]
    fn tool_events_are_heartbeats_and_pretooluse_is_not_mapped_at_all() {
        let nil = Value::Null;
        for event in ["PostToolUse", "PostToolUseFailure"] {
            assert_eq!(
                resolve_state(event, &nil),
                Some(AgentState::Active),
                "{event}"
            );
            assert!(is_heartbeat_event(event), "{event}");
        }
        assert_eq!(resolve_state("PreToolUse", &nil), None);
        // The state-setting events are transitions, not heartbeats — they must be
        // free to move a session out of a blocked-on-user state.
        for event in [
            "UserPromptSubmit",
            "Stop",
            "SessionEnd",
            "PermissionRequest",
        ] {
            assert!(!is_heartbeat_event(event), "{event}");
        }
    }

    /// A db with the two tables the status line writes (migrations 0011 + 0027).
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
            "CREATE TABLE session_usage_live (session_id TEXT PRIMARY KEY, used_pct REAL NOT NULL, \
             input_tokens INTEGER NOT NULL, context_size INTEGER NOT NULL, model TEXT NOT NULL, \
             cost_usd REAL NOT NULL, updated_at_ms INTEGER NOT NULL)",
            "CREATE TABLE claude_rate_limits (window TEXT PRIMARY KEY, used_pct REAL NOT NULL, \
             resets_at_ms INTEGER, updated_at_ms INTEGER NOT NULL)",
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

    /// The global passthrough: the payload is recorded exactly as for our own
    /// bar, but what Claude renders is the user's command's own output, fed the
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

        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = statusline(&db, Some("cat"), raw, &mut out, &mut err);
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
        let code = statusline(&db, Some("cat >&2; exit 7"), raw, &mut out, &mut err);
        assert_eq!(code, 7);
        assert!(out.is_empty());
        assert_eq!(err, raw);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Without `--then` the status line is santree's own bar, exactly as before.
    #[test]
    fn statusline_without_a_passthrough_prints_our_bar() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (base, db) = rt.block_on(statusline_db("bar"));
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = statusline(&db, None, STATUSLINE_PAYLOAD.as_bytes(), &mut out, &mut err);
        assert_eq!(code, 0);
        let shown = String::from_utf8(out).unwrap();
        // 42% raw → 50% with the 1.2x display nudge.
        assert!(shown.contains("50%") && shown.contains("Opus"), "{shown:?}");
        assert!(err.is_empty());
        let (usage, limits) = rt.block_on(recorded(&db));
        assert_eq!(usage.len(), 1);
        assert_eq!(limits.len(), 2);
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
        );
        assert_eq!(code, 0);
        assert_eq!(out, raw);
        assert!(err.is_empty(), "{}", String::from_utf8_lossy(&err));
    }

    #[test]
    fn only_clear_and_fork_change_a_claude_session_id() {
        let claude = |source| binds_session_id(AgentKind::Claude, source);
        // The divergence cases — a new id santree never chose.
        assert!(claude(Some("clear")));
        assert!(claude(Some("fork")));
        // Everything else runs the id santree launched with (or keeps it), so a
        // sibling tab / subprocess SessionStart can never repoint the row.
        assert!(!claude(Some("startup")));
        assert!(!claude(Some("resume")));
        assert!(!claude(Some("compact")));
        assert!(!claude(None));
    }

    /// Codex mints every id itself, so every SessionStart is the *only* chance to
    /// learn it — a `source` gate here would leave the fresh launch unrecorded and
    /// its session invisible to the app.
    #[test]
    fn every_codex_session_start_binds_the_id() {
        for source in [Some("startup"), Some("resume"), Some("compact"), None] {
            assert!(binds_session_id(AgentKind::Codex, source), "{source:?}");
        }
        // Providers that never run this binary must not touch a row.
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
            reconcile_terminal_session(db, "acme/app", key, "/checkout", sid, AgentKind::Claude)
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
            reconcile_terminal_session(db, "acme/app", "tree:AK-1", cwd, sid, AgentKind::Codex)
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
}
