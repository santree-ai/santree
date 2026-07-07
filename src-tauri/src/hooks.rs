//! Claude Code hooks integration.
//!
//! santree captures live Claude session state by injecting hook config into its
//! own `claude` launches (`claude --settings '<JSON>'`), one hook per
//! session-state event, each running the shipped `santree-hook` binary. This
//! module builds that `--settings` JSON (with the resolved binary + db paths
//! baked in) and reads back the states the binary records into `session_state`.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use santree_core::domain::{SessionState, SessionUsageLive};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::db::Db;

/// The session-state events we inject. The CLI (`santree-hook`) owns the
/// event→state mapping; this list only decides which events fire our binary.
///
/// We inject only the events that *set* a state — turn start (`UserPromptSubmit`),
/// a prompt appearing (`Notification`/`PermissionRequest`), and turn/session end
/// (`Stop`/`SessionEnd`). We deliberately do NOT inject the per-tool events
/// (`PreToolUse`/`PostToolUse`/`PermissionDenied`): they fire fire-and-forget
/// (`async`) with no ordering guarantee, so a `PreToolUse`→running write could
/// land *after* the permission write and clobber it, showing "running" while a
/// prompt is up. Clearing a resolved prompt is instead done authoritatively by
/// [`reconcile_attention`] against the transcript, so those noisy racers aren't
/// needed. `PermissionRequest` is a blocking decision channel, but we register it
/// `async: true` (below) so our hook can NEVER approve/deny — Claude still shows
/// its own prompt; we only observe it.
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
];

/// Resolve the absolute path to the bundled `santree-hook` binary: the resource
/// dir in a bundled build, else a sibling of the running executable in dev (both
/// land in `target/debug`). `None` if neither exists.
fn hook_bin(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("santree-hook");
        if p.exists() {
            return Some(p);
        }
    }
    let sib = std::env::current_exe().ok()?.parent()?.join("santree-hook");
    sib.exists().then_some(sib)
}

/// The sqlite db path — recomputed from `app_data_dir` (the setup path isn't
/// retained), matching `lib.rs`'s `db::init(data_dir.join("santree.db"))`.
pub fn db_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("santree.db"))
}

/// Build the `--settings` JSON santree layers over the user's own settings for
/// its `claude` launches, write it to `<app_data_dir>/claude-hooks.json`, and
/// return that file's **path**. Two things go in it, both invoking the bundled
/// `santree-hook` binary (so both need it + the db path to resolve):
///  - the session-state **hooks** (one per event);
///  - a **`statusLine`** pointing at the binary's `statusline` mode — santree's
///    own context-fill bar, which *always* captures Claude's authoritative usage
///    into the db (so the app can render the inline bar for any session) and
///    overrides the user's/project's status line for these launches.
///
/// The status line is injected **unconditionally**: capture is decoupled from
/// display. Whether the app *shows* the inline usage bar is a pure runtime,
/// frontend decision (the `claude_status_line` setting) — so toggling it lights
/// up already-running tabs without relaunching. This file is therefore
/// setting-independent and cached forever by the caller.
///
/// `--settings` is a *key-level* override (the keys we set win over the user's
/// `settings.json`; keys we omit keep their file values), so setting `statusLine`
/// replaces the user's whole status-line config for these launches only.
///
/// Returns `None` when nothing resolves to inject (no hook binary/db) or when no
/// writable data dir resolves — the caller then launches without `--settings`.
///
/// We pass Claude a settings *file* (`--settings <path>`), not inline JSON: the
/// JSON is large, and inlining it into the interactive-shell seed command
/// overflowed the line and left the shell stuck at a `quote>` continuation.
pub fn claude_settings(app: &AppHandle) -> Option<String> {
    // Both the hooks and the statusline invoke `santree-hook` against the db, so
    // resolve them once; without them there's nothing to inject (a dev build
    // before the hook is compiled has neither).
    let (Some(bin), Some(db_pathbuf)) = (hook_bin(app), db_path(app)) else {
        return None;
    };
    let (Some(bin), Some(db)) = (bin.to_str(), db_pathbuf.to_str()) else {
        return None;
    };

    let mut root = Map::new();

    let mut hooks = Map::new();
    for &event in EVENTS {
        // SessionEnd runs synchronously (short timeout) so "exited" reliably lands
        // before session teardown; the rest are async so they never add latency to
        // a turn. Paths are shell-double-quoted (app_data_dir has a space:
        // "Application Support") since Claude runs `command` via a shell.
        let is_end = event == "SessionEnd";
        let command = format!("\"{bin}\" --db \"{db}\" {event}");

        let mut hook = Map::new();
        hook.insert("type".into(), json!("command"));
        hook.insert("command".into(), json!(command));
        hook.insert("timeout".into(), json!(if is_end { 5 } else { 10 }));
        if !is_end {
            hook.insert("async".into(), json!(true));
        }

        hooks.insert(
            event.to_string(),
            json!([{ "hooks": [Value::Object(hook)] }]),
        );
    }
    root.insert("hooks".into(), Value::Object(hooks));

    // santree's own status line: the `statusline` mode of the same binary. Prints
    // a context-fill bar AND captures Claude's authoritative usage into the db.
    // Always injected — the app gates *display* of the inline bar at runtime, so
    // capture must run regardless of the setting (see the fn doc).
    root.insert(
        "statusLine".into(),
        json!({ "type": "command", "command": format!("\"{bin}\" --db \"{db}\" statusline") }),
    );

    let json = serde_json::to_string_pretty(&Value::Object(root)).ok()?;
    let out = app.path().app_data_dir().ok()?.join("claude-hooks.json");
    std::fs::write(&out, json).ok()?;
    Some(out.to_str()?.to_string())
}

/// Every session's live usage row (from the status-line capture), newest first.
pub async fn session_usage_live(db: &Db) -> Result<Vec<SessionUsageLive>> {
    let rows = sqlx::query_as::<_, (String, f64, i64, i64, String, f64, i64)>(
        "SELECT session_id, used_pct, input_tokens, context_size, model, cost_usd, updated_at_ms \
         FROM session_usage_live ORDER BY updated_at_ms DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(session_id, used_pct, input_tokens, context_size, model, cost_usd, updated_at_ms)| {
                SessionUsageLive {
                    session_id,
                    used_pct,
                    input_tokens: input_tokens as f64,
                    context_size: context_size as f64,
                    model,
                    cost_usd,
                    updated_at_ms: updated_at_ms as f64,
                }
            },
        )
        .collect())
}

/// All current session states, most-recently-updated first.
///
/// The `permission`/`waiting` rows are reconciled against the session transcript
/// before returning (see [`reconcile_attention`]): those "needs-you" states are
/// set by a hook, but the user *resolving* the prompt in the terminal (accept /
/// reject a permission, or type a reply) fires no hook, so a stored row can be
/// stale. The transcript is the ground truth, so we correct it on read.
pub async fn session_states(db: &Db) -> Result<Vec<SessionState>> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            i64,
        ),
    >(
        "SELECT session_id, state, event, cwd, message, transcript_path, updated_at_ms \
         FROM session_state ORDER BY updated_at_ms DESC",
    )
    .fetch_all(db)
    .await?;

    let now_ms = now_ms();
    Ok(rows
        .into_iter()
        .map(
            |(session_id, mut state, event, cwd, mut message, transcript_path, updated_at_ms)| {
                // The hook events set a state but can't reliably clear it (a manual
                // accept/reject and a turn that ends without a `Stop` both fire
                // nothing). So we reconcile the live state against the transcript —
                // the ground truth — and drop the now-irrelevant prompt text when the
                // state is no longer a "needs-you" one.
                if let Some(live) =
                    reconcile_live_state(&state, transcript_path.as_deref(), updated_at_ms, now_ms)
                {
                    if live != "permission" && live != "waiting" {
                        message = None;
                    }
                    state = live.to_string();
                }
                SessionState {
                    session_id,
                    state,
                    event,
                    cwd,
                    message,
                    transcript_path,
                    updated_at_ms: updated_at_ms as f64,
                }
            },
        )
        .collect())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read the last `max_bytes` of a file as text (lossy). Used to scan a session
/// transcript's tail cheaply — they grow to many MB over a long session, but the
/// only thing that matters here is the most recent few conversation turns. A
/// partial first line (from seeking mid-file) just fails to parse and is skipped.
fn read_tail(path: &str, max_bytes: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(max_bytes)))
        .ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// How far past `recorded_at_ms` the transcript must have advanced before we call
/// a prompt resolved. The turn that *triggers* a prompt is written to the
/// transcript ~immediately before the hook records the state, so we need a small
/// margin to not mistake that triggering turn for a resolution. A real user
/// action (accept/reject/reply) always lands seconds later, well past this.
const RESOLVED_MARGIN_MS: i64 = 1_000;

/// How long the transcript must be quiet (no new conversation entry) before we
/// call a running agent idle. Long enough to sit through the agent's own pauses
/// (thinking, a slow tool) without flapping to idle; short enough that a finished
/// turn reads as idle promptly. Paired with the ~10s frontend poll.
const IDLE_QUIET_MS: i64 = 30_000;

/// The `subagents/` dir for a session, derived from its transcript path:
/// `.../<sid>.jsonl` → `.../<sid>/subagents`. Claude writes each Task-tool
/// subagent's transcript to its own `agent-*.jsonl` here.
fn subagents_dir(transcript_path: &str) -> Option<PathBuf> {
    let p = Path::new(transcript_path);
    Some(p.parent()?.join(p.file_stem()?).join("subagents"))
}

/// Newest mtime (epoch-ms) across the session's subagent transcript files, or
/// `None` if there are none. While a subagent (Task tool) runs, the *main*
/// transcript stays silent for its whole duration — only the spawn + the final
/// result land there — so without this a subagent running longer than
/// `IDLE_QUIET_MS` would make the parent look idle. Subagent files are pure agent
/// conversation (no remote-control trailer), so their mtime is a clean "a
/// subagent just did something" signal.
fn newest_subagent_write_ms(transcript_path: &str) -> Option<i64> {
    let dir = subagents_dir(transcript_path)?;
    let mut newest: Option<i64> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if entry.path().extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(ms) = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
        {
            newest = Some(newest.map_or(ms, |cur| cur.max(ms)));
        }
    }
    newest
}

/// Epoch-ms of the newest `assistant`/`user` entry in the *main* transcript — how
/// recently the main agent loop itself did anything. `None` if unreadable / no
/// such entry. cmux/remote-control metadata lines (`mode`, `pr-link`, …) are
/// ignored, so raw file mtime is deliberately not used here (that trailer churns
/// without a real turn).
fn main_activity_ms(transcript_path: &str) -> Option<i64> {
    let text = read_tail(transcript_path, 128 * 1024)?;
    let mut newest_ms: Option<i64> = None;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue; // partial/metadata line
        };
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") | Some("user") => {}
            _ => continue, // skip metadata entries
        }
        if let Some(ms) = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
            .map(|dt| dt.timestamp_millis())
        {
            newest_ms = Some(newest_ms.map_or(ms, |cur| cur.max(ms)));
        }
    }
    newest_ms
}

/// Reconcile a stored session state against the transcript — the ground truth for
/// what the agent is *actually* doing. The hooks reliably *set* a state (turn
/// start, a prompt appearing) but can't reliably *clear* it: a manual accept/
/// reject fires no hook, and a turn can end with no `Stop`. So the transcript's
/// activity, not the event stream, decides when running/pending is stale.
///
/// The signal is **how recently there was activity**, tracked separately for the
/// main loop and its subagents. We deliberately don't parse the transcript's
/// structure (`stop_reason`, tool_use vs result) — under remote control the last
/// line is often a bare tool_result or metadata, so structure is unreliable; a
/// plain "has it gone quiet" is not.
///
/// Returns an override state, or `None` to keep the stored one.
/// - `permission`/`waiting`: while genuinely pending the transcript is *frozen* at
///   the pre-prompt turn (Claude withholds the blocked `tool_use` until you
///   approve it). So it's still pending until the transcript advances past when we
///   recorded the prompt; once it has, the prompt is resolved and it falls through
///   to the liveness check below.
/// - resolved-prompt / `active`: `idle` once everything (main + subagents) has been
///   quiet for `IDLE_QUIET_MS`; else `delegating` if the freshest activity is a
///   subagent (the main loop is blocked on a Task subagent), else `active`.
/// - `idle`/`exited`: settled — left untouched (`idle`→`active` only ever comes
///   from a real `UserPromptSubmit`; liveness owns `exited`).
fn reconcile_live_state(
    state: &str,
    transcript_path: Option<&str>,
    recorded_at_ms: i64,
    now_ms: i64,
) -> Option<&'static str> {
    let is_pending = state == "permission" || state == "waiting";
    if !is_pending && state != "active" {
        return None; // idle / exited: settled
    }
    let path = transcript_path?;

    let main_ms = main_activity_ms(path);
    let sub_ms = newest_subagent_write_ms(path);
    let last_ms = main_ms.max(sub_ms)?; // Option::max: None if neither is readable

    // A pending prompt whose transcript hasn't advanced past when we recorded it is
    // still genuinely waiting on the user — keep it.
    if is_pending && last_ms <= recorded_at_ms + RESOLVED_MARGIN_MS {
        return None;
    }

    if now_ms - last_ms >= IDLE_QUIET_MS {
        return Some("idle"); // everything quiet → idle
    }

    // Active. Distinguish the main loop working from it being blocked on a subagent:
    // the freshest activity being a subagent write (main loop older / absent) means
    // the agent has delegated and is itself waiting on the Task subagent.
    let delegating = match (sub_ms, main_ms) {
        (Some(s), Some(m)) => s > m,
        (Some(_), None) => true,
        (None, _) => false,
    };
    Some(if delegating { "delegating" } else { "active" })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Write a throwaway transcript; the unique name per call avoids cross-test
    // collisions (no tempfile dep in src-tauri — mirrors the hook crate's tests).
    fn transcript(tag: &str, lines: &[String]) -> String {
        let path = std::env::temp_dir().join(format!(
            "santree-reconcile-{}-{tag}.jsonl",
            std::process::id()
        ));
        std::fs::write(&path, lines.join("\n")).unwrap();
        path.to_str().unwrap().to_string()
    }

    // A conversation entry stamped `ms` epoch-millis (only `type` + `timestamp`
    // are read by the reconciler; content shape is irrelevant now).
    fn conv(role: &str, ms: i64) -> String {
        let ts = chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339();
        format!(
            r#"{{"type":"{role}","timestamp":"{ts}","message":{{"role":"{role}","content":[]}}}}"#
        )
    }
    // cmux/remote-control trailer noise — no role, no useful timestamp. Must be
    // ignored, else its churn would look like the transcript advancing.
    const META: &str = r#"{"type":"pr-link"}"#;

    const T: i64 = 1_700_000_000_000; // an arbitrary "prompt recorded at" instant

    #[test]
    fn settled_states_are_never_reconciled() {
        let p = transcript("settled", &[conv("assistant", T + 5000)]);
        assert_eq!(reconcile_live_state("idle", Some(&p), T, T + 5000), None);
        assert_eq!(reconcile_live_state("exited", Some(&p), T, T + 5000), None);
    }

    #[test]
    fn pending_when_transcript_is_frozen_before_the_prompt() {
        // The real failing case: a permission is showing, but its tool_use is
        // withheld from the transcript — the newest entry predates the prompt, and
        // a trailing metadata line must not be mistaken for progress.
        let p = transcript(
            "frozen",
            &[
                conv("assistant", T - 60_000),
                conv("user", T - 40_000),
                META.to_string(),
            ],
        );
        let now = T + 5_000;
        assert_eq!(reconcile_live_state("permission", Some(&p), T, now), None);
        assert_eq!(reconcile_live_state("waiting", Some(&p), T, now), None);
    }

    #[test]
    fn resolved_prompt_is_running_while_still_active() {
        // Reject/accept fed back; the agent is still busy (recent activity).
        let p = transcript(
            "mid",
            &[conv("assistant", T - 60_000), conv("user", T + 3_000)],
        );
        let now = T + 5_000; // only 2s since the last entry → not quiet
        assert_eq!(
            reconcile_live_state("permission", Some(&p), T, now),
            Some("active")
        );
    }

    #[test]
    fn resolved_prompt_goes_idle_once_quiet() {
        // The user's ask: after a reject, once the agent stops doing anything the
        // badge flips to idle — even under remote control where the last transcript
        // line is a bare tool_result, not an `end_turn`.
        let p = transcript("reject-idle", &[conv("user", T + 5_000)]);
        let now = T + 5_000 + IDLE_QUIET_MS + 1; // quiet past the threshold
        assert_eq!(
            reconcile_live_state("permission", Some(&p), T, now),
            Some("idle")
        );
    }

    #[test]
    fn active_goes_idle_when_quiet_but_stays_running_when_recent() {
        let p = transcript("active", &[conv("assistant", T)]);
        // Quiet long enough → idle even though no `Stop` fired.
        assert_eq!(
            reconcile_live_state("active", Some(&p), T, T + IDLE_QUIET_MS + 1),
            Some("idle")
        );
        // Recent main-loop activity (mid-turn / thinking pause) → running.
        assert_eq!(
            reconcile_live_state("active", Some(&p), T, T + 2_000),
            Some("active")
        );
    }

    #[test]
    fn subagent_run_reads_as_delegating_not_running() {
        // Real `now`, because we compare against a real file mtime below.
        let now = now_ms();
        // Main transcript last wrote 5 min ago — the agent handed off to a subagent
        // and the main transcript then stayed silent for the whole subagent run.
        let main = transcript("subagent", &[conv("assistant", now - 300_000)]);
        // Without the subagent that silence reads as idle…
        assert_eq!(
            reconcile_live_state("active", Some(&main), now - 600_000, now),
            Some("idle")
        );
        // …but a subagent actively writing its own file means the main loop is
        // blocked on it → "delegating", distinct from the agent itself running.
        let dir = subagents_dir(&main).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent-x.jsonl"), "{}").unwrap(); // mtime ≈ now
        assert_eq!(
            reconcile_live_state("active", Some(&main), now - 600_000, now),
            Some("delegating")
        );
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn missing_or_unreadable_transcript_leaves_state_untouched() {
        assert_eq!(reconcile_live_state("permission", None, T, T), None);
        assert_eq!(
            reconcile_live_state("active", Some("/no/such/file.jsonl"), T, T),
            None
        );
    }
}
