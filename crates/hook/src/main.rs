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
fn resolve_state(event: &str, payload: &Value) -> Option<&'static str> {
    match event {
        // A turn is running — the user's prompt started it.
        "UserPromptSubmit" => Some("active"),
        "SessionStart" | "Stop" => Some("idle"),
        "SessionEnd" => Some("exited"),
        "PermissionRequest" => Some("permission"),
        "Notification" => match payload.get("notification_type").and_then(Value::as_str) {
            Some("permission_prompt") => Some("permission"),
            Some("agent_completed") => Some("idle"),
            Some("agent_needs_input") | Some("idle_prompt") | Some("elicitation_dialog") => {
                Some("waiting")
            }
            // Auth / elicitation-result notifications aren't a state change.
            Some(_) => None,
            // Older CLIs send no type — fall back to the prior "needs input".
            None => Some("waiting"),
        },
        _ => None,
    }
}

fn main() {
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
        "permission" => field("message")
            .map(str::to_string)
            .or_else(|| field("tool_name").map(|t| format!("run {t}"))),
        "waiting" => field("message").map(str::to_string),
        _ => None,
    };

    // A one-shot insert on a minimal current-thread runtime; swallow every error.
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let wrote = rt
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

    // Nudge the app over its signal socket so the UI refreshes in realtime. Best
    // effort — if the app isn't running the connect just fails, and the app picks
    // up this row on its next read. Byte `s` = a state change (anything but `u`).
    if wrote {
        ping_socket(&db_path, b's');
    }
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
    state: &str,
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
        if cur_state == state && cur_message.as_deref() == message {
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
    .bind(state)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_events_to_states() {
        let nil = Value::Null;
        // SessionStart is idle (resumed / at the prompt), not active.
        assert_eq!(resolve_state("SessionStart", &nil), Some("idle"));
        assert_eq!(resolve_state("UserPromptSubmit", &nil), Some("active"));
        assert_eq!(resolve_state("Stop", &nil), Some("idle"));
        assert_eq!(resolve_state("SessionEnd", &nil), Some("exited"));
        assert_eq!(resolve_state("PermissionRequest", &nil), Some("permission"));
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
            Some("permission")
        );
        // A completed turn is idle, not a red "waiting".
        assert_eq!(
            resolve_state("Notification", &with_type("agent_completed")),
            Some("idle")
        );
        assert_eq!(
            resolve_state("Notification", &with_type("agent_needs_input")),
            Some("waiting")
        );
        // Non-state notifications don't change anything.
        assert_eq!(
            resolve_state("Notification", &with_type("auth_success")),
            None
        );
        // No type (older CLI) falls back to "waiting".
        assert_eq!(resolve_state("Notification", &Value::Null), Some("waiting"));
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
            !record(db, "s1", "active", "SessionStart", "/w", None, None)
                .await
                .unwrap()
        );

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

        assert!(record(db, "s1", "active", "SessionStart", "/w", None, None)
            .await
            .unwrap());
        // Dedup: the same state + message again is a no-op (no UI nudge) — this is
        // what keeps repeated PreToolUse/PostToolUse from re-notifying every tool.
        assert!(!record(db, "s1", "active", "PreToolUse", "/w", None, None)
            .await
            .unwrap());
        assert!(record(db, "s1", "idle", "Stop", "/w", None, None)
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
}
