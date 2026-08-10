//! `santree-hook` — the tiny CLI that Claude Code hooks invoke.
//!
//! santree injects hook config into its own `claude` launches
//! (`claude --settings '<JSON>'`), one hook per session-state event, each
//! running this binary. Every invocation reads the hook's JSON payload on
//! stdin, derives the agent's current state, and UPSERTs the single row for
//! that session in the app's `session_state` table — so the desktop app can
//! surface live Claude session state. After writing, it bumps a tick file the
//! app watches, which pushes a realtime refresh to the UI.
//!
//! Invariant: this MUST NEVER disrupt the user's Claude session. Every failure
//! path (bad args, unparseable stdin, empty session id, missing/locked db)
//! exits 0 silently — a non-zero exit could block or warn inside Claude.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use santree_core::domain::AgentState;
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};

/// Map a Claude hook event (and, for `Notification`, its `notification_type`) to
/// the agent state it implies. `None` = don't change the stored state.
///
/// - `SessionStart` is `idle`, NOT `active`: it fires when a session comes up or
///   *resumes*, at which point the agent sits at the prompt — not running a turn.
///   Only `UserPromptSubmit` (a turn actually starting) means it's running.
/// - `PermissionRequest` → `permission`: a tool is blocked on the user's
///   approval. OBSERVED ONLY — the hook is registered async so it can never
///   approve/deny; Claude still shows its normal prompt.
/// - `Notification` is refined by type: a plain `agent_completed` is `idle` (the
///   turn finished — not "needs you"), whereas a permission/input prompt is the
///   real "needs you" signal. Auth/elicitation-result notifications change
///   nothing.
///
/// We only map events that *set* a state. Clearing a resolved `permission`/
/// `waiting` back to running is NOT done here — the app reconciles that against
/// the transcript on read (a manual accept/reject fires no reliable hook, and the
/// per-tool events that would race a permission write are not injected).
fn resolve_state(event: &str, payload: &Value) -> Option<AgentState> {
    match event {
        // A turn is running — the user's prompt started it.
        "UserPromptSubmit" => Some(AgentState::Active),
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

/// Whether a `SessionStart` `source` means Claude minted a *new* session id that
/// santree didn't choose — the only case where the terminal's stored id must be
/// repointed. `startup`/`resume` run the id we launched with, and `compact` keeps
/// the id; only `clear` and `fork` diverge. Gating on these is what stops a stray
/// SessionStart (an env-inheriting subprocess, a subagent) from hijacking the row.
fn session_id_changed(source: Option<&str>) -> bool {
    matches!(source, Some("clear") | Some("fork"))
}

fn main() {
    install_exit_zero_panic_hook();

    // Args: santree-hook --db <path> <EventName>
    let mut db_path: Option<String> = None;
    let mut event: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--db" => db_path = args.next(),
            other => event = Some(other.to_string()),
        }
    }
    let (Some(db_path), Some(event)) = (db_path, event) else {
        return; // exit 0
    };

    // The `statusline` "event" is Claude's status-line command, not a hook: it
    // reads the status-line JSON, prints the bar Claude renders, and captures the
    // live usage. Handled entirely separately from the state-event path below.
    if event == "statusline" {
        handle_statusline(&db_path);
        return;
    }

    // Read the Claude hook JSON payload from stdin (always piped by Claude).
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let field = |k: &str| payload.get(k).and_then(Value::as_str);

    let Some(state) = resolve_state(&event, &payload) else {
        return; // event/notification that doesn't change state
    };

    let session_id = field("session_id").unwrap_or_default();
    if session_id.is_empty() {
        return; // can't correlate without a session id
    }
    let cwd = field("cwd").unwrap_or_default();
    let transcript = field("transcript_path");
    // Only the "needs you" states carry tooltip text; running/idle/exited don't
    // (so consecutive tool events dedup to a single "running", see `record`). For
    // permission, fall back to the tool name as "run <tool>".
    let message = match state {
        AgentState::Permission => field("message")
            .map(str::to_string)
            .or_else(|| field("tool_name").map(|t| format!("run {t}"))),
        AgentState::Waiting => field("message").map(str::to_string),
        _ => None,
    };

    // A one-shot insert on a minimal current-thread runtime; swallow every error.
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let mut wrote = rt
        .block_on(record(
            &db_path,
            session_id,
            state,
            &event,
            cwd,
            message.as_deref(),
            transcript,
        ))
        .unwrap_or(false);

    // When the user `/clear`s (or `/fork`s), Claude abandons the session santree
    // launched and mints a brand-new session id we never chose and would otherwise
    // never learn — so the stored id keeps pointing at the cleared conversation and
    // every reopen `--resume`s it. Repoint the terminal's row to the live id.
    //
    // The terminal's own identity is exported into our env at launch, so we rewrite
    // *only that one terminal's* row — never another tab's, even though sibling
    // Claude tabs share a cwd. And we gate on the SessionStart `source`: only `clear`
    // and `fork` change the id, so a normal startup/resume/compact — or a stray
    // SessionStart from an env-inheriting subprocess — can never hijack the row.
    if event == "SessionStart" && session_id_changed(field("source")) {
        if let (Ok(repo), Ok(term_key)) = (
            std::env::var("SANTREE_REPO"),
            std::env::var("SANTREE_TERM_KEY"),
        ) {
            if !repo.is_empty() && !term_key.is_empty() {
                let reconciled = rt
                    .block_on(reconcile_terminal_session(
                        &db_path, &repo, &term_key, session_id,
                    ))
                    .unwrap_or(false);
                wrote = wrote || reconciled;
            }
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

/// Send a one-byte nudge over the app's signal socket (`<db_dir>/santree-signal.sock`).
/// The tag byte tells the app which table changed (`u` = live usage, else state).
/// Best-effort: a not-running app just fails to connect.
fn ping_socket(db_path: &str, tag: u8) {
    if let Some(dir) = Path::new(db_path).parent() {
        if let Ok(mut stream) = UnixStream::connect(dir.join("santree-signal.sock")) {
            let _ = stream.write_all(&[tag]);
        }
    }
}

// ── Status line (`santree-hook --db <path> statusline`) ─────────────────────
//
// Claude pipes the status-line JSON on stdin and renders whatever we print. We
// print a colored context-fill bar (Claude's own `used_percentage`) AND persist
// that authoritative number to `session_usage_live` + nudge the app, so the GUI's
// inline bar shows the exact same figure the terminal does. Never disrupts the
// session: any failure still prints (an empty bar at worst) and exits 0.

/// santree-cli's convention: inflate the shown context % by 20% (clamped) so the
/// warning colors trip earlier and nudge `/compact` while there's still headroom.
const CONTEXT_DISPLAY_MULTIPLIER: f64 = 1.2;

fn handle_statusline(db_path: &str) {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let p: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);

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

    // Print the bar first so the terminal renders promptly, then persist.
    let bar = render_bar(used_pct, input_tokens, model_display);
    let _ = std::io::stdout().write_all(bar.as_bytes());
    let _ = std::io::stdout().flush();

    let session_id = p
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if session_id.is_empty() {
        return;
    }
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
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

fn now_ms() -> i64 {
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
    // false → no UI nudge). This keeps high-frequency PreToolUse/PostToolUse
    // events from re-nudging every tool call while already "running" — only real
    // transitions (e.g. permission → running, running → idle) write and notify.
    let current: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT state, message FROM session_state WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(&mut conn)
            .await?;
    if let Some((cur_state, cur_message)) = &current {
        if cur_state == state.as_str() && cur_message.as_deref() == message {
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

/// Point the terminal `(repo, term_key)`'s stored session id at `session_id` — the
/// session Claude is currently running under. Returns `Ok(true)` when a row's id
/// actually changed (so the caller nudges the app to re-resolve). UPDATE-only: the
/// row is created by the app when it launches the terminal, so a missing row means
/// this isn't a santree-launched session we track (or the app db predates it) —
/// either way there's nothing to reconcile, and we never fabricate a row. The
/// `session_id <> ?` guard makes the common case (id unchanged) a no-op write.
async fn reconcile_terminal_session(
    db_path: &str,
    repo: &str,
    term_key: &str,
    session_id: &str,
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

    let affected = sqlx::query(
        "UPDATE terminal_sessions SET session_id = ? \
         WHERE repo = ? AND term_key = ? AND session_id <> ?",
    )
    .bind(session_id)
    .bind(repo)
    .bind(term_key)
    .bind(session_id)
    .execute(&mut conn)
    .await?
    .rows_affected();

    conn.close().await?;
    Ok(affected > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // Per-tool events are not mapped — clearing a resolved permission is the
        // app's transcript reconciliation's job, not this binary's.
        assert_eq!(resolve_state("PreToolUse", &nil), None);
        assert_eq!(resolve_state("PostToolUse", &nil), None);
        assert_eq!(resolve_state("PermissionDenied", &nil), None);
        assert_eq!(resolve_state("PreCompact", &nil), None);
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

    #[test]
    fn only_clear_and_fork_change_the_session_id() {
        // The divergence cases — a new id santree never chose.
        assert!(session_id_changed(Some("clear")));
        assert!(session_id_changed(Some("fork")));
        // Everything else runs the id santree launched with (or keeps it), so a
        // sibling tab / subprocess SessionStart can never repoint the row.
        assert!(!session_id_changed(Some("startup")));
        assert!(!session_id_changed(Some("resume")));
        assert!(!session_id_changed(Some("compact")));
        assert!(!session_id_changed(None));
    }

    #[tokio::test]
    async fn reconcile_adopts_the_live_session_id_for_the_terminal() {
        let base =
            std::env::temp_dir().join(format!("santree-hook-reconcile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");
        let db = db_path.to_str().unwrap();

        // No db yet ⇒ silent no-op, never creates one (COMPLIANCE: never disrupt).
        assert!(
            !reconcile_terminal_session(db, "@dev", "dev:/checkout", "new-id")
                .await
                .unwrap()
        );
        assert!(!db_path.exists(), "reconcile must not create the db");

        // The app owns this table (mirrors migration 0007). Seed one terminal
        // pointing at the pre-`/clear` session, plus a decoy the update must not touch.
        {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE terminal_sessions (repo TEXT NOT NULL, term_key TEXT NOT NULL, \
                 cwd TEXT NOT NULL, session_id TEXT NOT NULL, \
                 created_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (repo, term_key))",
            )
            .execute(&mut c)
            .await
            .unwrap();
            for (repo, key, sid) in [
                ("@dev", "dev:/checkout", "old-cleared-id"),
                ("@dev", "dev:/other", "untouched-id"),
            ] {
                sqlx::query(
                    "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id) \
                     VALUES (?, ?, '/checkout', ?)",
                )
                .bind(repo)
                .bind(key)
                .bind(sid)
                .execute(&mut c)
                .await
                .unwrap();
            }
            c.close().await.unwrap();
        }

        // The `/clear` reconcile flips the stored id to the new live session.
        assert!(
            reconcile_terminal_session(db, "@dev", "dev:/checkout", "new-clear-id")
                .await
                .unwrap()
        );
        // Same id again ⇒ no-op (a normal startup/resume writes nothing, nudges nothing).
        assert!(
            !reconcile_terminal_session(db, "@dev", "dev:/checkout", "new-clear-id")
                .await
                .unwrap()
        );
        // A term_key with no row (never launched by santree) ⇒ nothing to adopt.
        assert!(!reconcile_terminal_session(db, "@dev", "dev:/never", "x")
            .await
            .unwrap());

        let mut c = SqliteConnectOptions::new()
            .filename(&db_path)
            .connect()
            .await
            .unwrap();
        let ids: Vec<(String, String)> =
            sqlx::query_as("SELECT term_key, session_id FROM terminal_sessions ORDER BY term_key")
                .fetch_all(&mut c)
                .await
                .unwrap();
        assert_eq!(
            ids,
            vec![
                ("dev:/checkout".to_string(), "new-clear-id".to_string()),
                ("dev:/other".to_string(), "untouched-id".to_string()),
            ]
        );
        c.close().await.unwrap();

        let _ = std::fs::remove_dir_all(&base);
    }
}
