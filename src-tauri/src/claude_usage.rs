//! Claude's account usage, read from Anthropic's own OAuth usage endpoint.
//!
//! This is the **one** place santree reads an agent CLI's credential, and it is a
//! deliberate, documented exception — see COMPLIANCE.md, "Claude subscription
//! usage". The alternative source, Claude's status line, only reports for
//! sessions santree itself launched, so the meters sat empty while the user's
//! own sessions ran elsewhere.
//!
//! The rules that keep the exception narrow, all enforced below:
//!
//! * **Read-only.** The token is read from wherever Claude Code already put it
//!   and never written, refreshed, or copied anywhere. Expiry is the server's
//!   call, not ours (an expired token simply answers 401).
//! * **One host, checked by parse.** The token is sent to `api.anthropic.com`
//!   and nowhere else, matched on the parsed host rather than a string prefix.
//! * **Never logged, never stored.** It lives in a local `String` for the
//!   duration of one request; only the derived percentages and reset times reach
//!   SQLite. No type here derives `Debug` or `Serialize` over it.
//! * **Display-only.** What comes back is a number for a meter. Nothing derived
//!   from it is ever written toward a session, same bound as the status line.
use std::path::PathBuf;
// macOS-only: the keychain read shells `security`. On Linux the credential
// file is read directly (see the `cfg(not(target_os = "macos"))` branch below),
// so importing this unconditionally is an unused import there — which CI's
// Linux clippy job denies.
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result};
use santree_core::domain::{ClaudeRateLimitWindow, ClaudeUsageFetch, ClaudeUsageStatus};
use serde::Deserialize;

use crate::db::Db;

/// Anthropic's usage endpoint for OAuth (subscription) credentials.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// The only host this module will ever send the token to. Compared against the
/// parsed host, never as a prefix — `api.anthropic.com.evil.test` must not match.
const USAGE_HOST: &str = "api.anthropic.com";
/// The endpoint answers in well under a second; past this something is wrong and
/// a usage meter is not worth hanging a refresh on.
/// How we identify ourselves to Anthropic when reading the user's own usage.
///
/// Truthful on purpose. This used to send `claude-code/2.1.0`, which
/// COMPLIANCE.md's own forbidden list bans in the same breath as re-implementing
/// a vendor's control loop — santree is not Claude Code and must not claim to
/// be. The exception that permits this request is narrow (read-only, the user's
/// own token, one host matched by parse, display-only), and it does not need a
/// disguise to hold: we are reading the user's usage as santree, with the
/// user's credential, and saying so.
const USER_AGENT: &str = concat!("santree/", env!("CARGO_PKG_VERSION"));

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A keychain prompt that nobody answers must not wedge the refresh.
#[cfg(target_os = "macos")]
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(3);
/// The generic-password service Claude Code stores its credentials under.
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

// ── Credentials ─────────────────────────────────────────────────────────────

/// Claude Code's credential file/keychain payload. Only the access token is
/// read; `refreshToken`/`expiresAt` are deliberately ignored — santree never
/// refreshes, so it never has to write anything back.
#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<OauthCredentials>,
}

#[derive(Deserialize)]
struct OauthCredentials {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
}

/// The access token out of a credentials JSON blob, or `None` when the blob
/// isn't one (a different shape, an empty token, malformed JSON).
///
/// Exported for testing — the fixtures are shapes, never real tokens.
fn access_token(raw: &str) -> Option<String> {
    let parsed: Credentials = serde_json::from_str(raw).ok()?;
    parsed
        .oauth?
        .access_token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Claude's config directory — the same resolution `global_capture` and
/// `usage.rs` use, so all three agree on where Claude keeps its state.
fn config_dir() -> Option<PathBuf> {
    crate::global_capture::claude_config_dir()
}

/// Read the login keychain's Claude Code credentials (macOS only).
///
/// `security` is invoked with a fixed argv — the service name is a constant and
/// the account comes from the process's own user, never from IPC. A prompt or a
/// hung keychain is bounded by [`KEYCHAIN_TIMEOUT`]; the failure is silent
/// because "no credential" is an ordinary state, not an error to report.
#[cfg(target_os = "macos")]
fn keychain_credentials() -> Option<String> {
    let user = std::env::var("USER").ok();
    // With the account first (how Claude Code writes it), then without: an item
    // stored under a different account name is still ours to read.
    let attempts: Vec<Vec<String>> = match &user {
        Some(u) => vec![
            vec![
                "find-generic-password".into(),
                "-s".into(),
                KEYCHAIN_SERVICE.into(),
                "-a".into(),
                u.clone(),
                "-w".into(),
            ],
            vec![
                "find-generic-password".into(),
                "-s".into(),
                KEYCHAIN_SERVICE.into(),
                "-w".into(),
            ],
        ],
        None => vec![vec![
            "find-generic-password".into(),
            "-s".into(),
            KEYCHAIN_SERVICE.into(),
            "-w".into(),
        ]],
    };
    for args in attempts {
        let Ok(mut child) = Command::new("/usr/bin/security")
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        else {
            return None;
        };
        let deadline = std::time::Instant::now() + KEYCHAIN_TIMEOUT;
        let out = loop {
            match child.try_wait() {
                Ok(Some(_)) => break child.wait_with_output().ok(),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                // A prompt nobody answered, or the wait itself failed.
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let Some(out) = out else { continue };
        if !out.status.success() {
            continue;
        }
        let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !raw.is_empty() {
            return Some(raw);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn keychain_credentials() -> Option<String> {
    None
}

/// `<config dir>/.credentials.json` — where Claude Code keeps credentials off
/// macOS, and on macOS when the keychain isn't used.
fn file_credentials() -> Option<String> {
    let path = config_dir()?.join(".credentials.json");
    std::fs::read_to_string(path).ok()
}

/// Claude Code's current access token, keychain first, file second. Blocking, so
/// callers run it off the async runtime.
fn read_token() -> Option<String> {
    keychain_credentials()
        .as_deref()
        .and_then(access_token)
        .or_else(|| file_credentials().as_deref().and_then(access_token))
}

// ── The endpoint's answer ───────────────────────────────────────────────────

/// One window as the endpoint reports it. Both spellings of the percentage
/// appear in the wild (`utilization` on the OAuth response, `used_percentage` on
/// the status-line payload that shares this shape), and `resets_at` may be an
/// ISO timestamp, epoch seconds, or epoch millis.
#[derive(Deserialize, Default)]
struct RawWindow {
    utilization: Option<f64>,
    used_percentage: Option<f64>,
    resets_at: Option<serde_json::Value>,
}

/// A model-scoped entry of the response's `limits` array — how a per-model
/// weekly cap (Fable, Opus, …) is reported.
#[derive(Deserialize)]
struct RawLimit {
    kind: Option<String>,
    percent: Option<f64>,
    resets_at: Option<serde_json::Value>,
    scope: Option<RawScope>,
}

#[derive(Deserialize)]
struct RawScope {
    model: Option<RawModel>,
}

#[derive(Deserialize)]
struct RawModel {
    display_name: Option<String>,
}

#[derive(Deserialize, Default)]
struct UsageResponse {
    five_hour: Option<RawWindow>,
    seven_day: Option<RawWindow>,
    // The per-model weekly window has been spelled three ways; take whichever
    // this account's response carries.
    fable_weekly: Option<RawWindow>,
    fable_seven_day: Option<RawWindow>,
    seven_day_fable: Option<RawWindow>,
    limits: Option<Vec<RawLimit>>,
}

/// Epoch ms from a `resets_at`, whichever of its three forms arrived.
///
/// 1e10 sits between any plausible seconds epoch (< year 2286) and any millis
/// epoch (> 2001), which is what tells the two apart without extra metadata.
fn reset_ms(value: Option<&serde_json::Value>) -> Option<f64> {
    match value? {
        serde_json::Value::Number(n) => {
            let n = n.as_f64()?;
            if !n.is_finite() || n <= 0.0 {
                return None;
            }
            Some(if n > 10_000_000_000.0 { n } else { n * 1_000.0 })
        }
        serde_json::Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                return None;
            }
            if let Ok(n) = s.parse::<f64>() {
                if n.is_finite() && n > 0.0 {
                    return Some(if n > 10_000_000_000.0 { n } else { n * 1_000.0 });
                }
            }
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.timestamp_millis() as f64)
        }
        _ => None,
    }
}

fn window_pct(raw: &RawWindow) -> Option<f64> {
    raw.utilization
        .or(raw.used_percentage)
        .filter(|p| p.is_finite())
}

/// Fold the response into the windows santree stores. `now_ms` is passed in so
/// the mapping is testable without a clock.
fn map_windows(body: &str, now_ms: f64) -> Result<Vec<ClaudeRateLimitWindow>> {
    let parsed: UsageResponse = serde_json::from_str(body)
        .context("Anthropic's usage response wasn't the shape we know")?;
    let mut out = Vec::new();
    let mut push = |name: &str, pct: f64, resets: Option<f64>| {
        out.push(ClaudeRateLimitWindow {
            window: name.to_string(),
            used_pct: pct.clamp(0.0, 100.0),
            resets_at_ms: resets,
            updated_at_ms: now_ms,
        });
    };

    for (name, raw) in [
        ("five_hour", parsed.five_hour.as_ref()),
        ("seven_day", parsed.seven_day.as_ref()),
    ] {
        if let Some(raw) = raw {
            if let Some(pct) = window_pct(raw) {
                push(name, pct, reset_ms(raw.resets_at.as_ref()));
            }
        }
    }

    // Per-model weekly caps: the `limits` array is authoritative (it names the
    // model), with the three legacy top-level spellings as a fallback.
    let mut scoped = 0usize;
    for limit in parsed.limits.iter().flatten() {
        if limit.kind.as_deref() != Some("weekly_scoped") {
            continue;
        }
        let Some(pct) = limit.percent.filter(|p| p.is_finite()) else {
            continue;
        };
        let name = limit
            .scope
            .as_ref()
            .and_then(|s| s.model.as_ref())
            .and_then(|m| m.display_name.as_deref())
            .map(str::trim)
            .filter(|n| !n.is_empty());
        let Some(name) = name else { continue };
        scoped += 1;
        push(name, pct, reset_ms(limit.resets_at.as_ref()));
    }
    if scoped == 0 {
        let alias = parsed
            .fable_weekly
            .as_ref()
            .or(parsed.fable_seven_day.as_ref())
            .or(parsed.seven_day_fable.as_ref());
        if let Some(raw) = alias {
            if let Some(pct) = window_pct(raw) {
                push("Fable", pct, reset_ms(raw.resets_at.as_ref()));
            }
        }
    }
    Ok(out)
}

// ── Fetch + store ───────────────────────────────────────────────────────────

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or_default()
}

/// Write the windows to the same table the status-line capture writes, so both
/// sources feed one store and one reader.
async fn store(db: &Db, windows: &[ClaudeRateLimitWindow]) -> Result<()> {
    for w in windows {
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
        .bind(w.resets_at_ms.map(|ms| ms as i64))
        .bind(w.updated_at_ms as i64)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// Ask Anthropic for the account's current usage and record it.
///
/// Never returns `Err` for the ordinary states — not signed in, token rejected,
/// endpoint unreachable — because those are answers the meter should show, not
/// failures to toast. A real `Err` means the database write failed.
pub async fn fetch(db: &Db) -> Result<ClaudeUsageFetch> {
    let Some(token) = tokio::task::spawn_blocking(read_token).await.ok().flatten() else {
        return Ok(ClaudeUsageFetch {
            windows: crate::hooks::claude_rate_limits(db)
                .await
                .unwrap_or_default(),
            status: ClaudeUsageStatus::NoCredentials,
            detail: None,
        });
    };

    // Parse at the sink: the token goes to this host or nowhere.
    let url = reqwest::Url::parse(USAGE_URL).context("the usage URL is malformed")?;
    if url.host_str() != Some(USAGE_HOST) {
        return Ok(ClaudeUsageFetch {
            windows: Vec::new(),
            status: ClaudeUsageStatus::Unavailable,
            detail: Some("refusing to send the credential to an unexpected host".into()),
        });
    }

    let response = crate::gql::client()
        .get(url)
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await;
    drop(token);

    let response = match response {
        Ok(r) => r,
        // `reqwest`'s Display carries the URL and the cause, never a header.
        Err(e) => {
            return Ok(ClaudeUsageFetch {
                windows: Vec::new(),
                status: ClaudeUsageStatus::Unavailable,
                detail: Some(e.to_string()),
            })
        }
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Ok(ClaudeUsageFetch {
            windows: crate::hooks::claude_rate_limits(db)
                .await
                .unwrap_or_default(),
            status: ClaudeUsageStatus::Unauthorized,
            detail: None,
        });
    }
    if !response.status().is_success() {
        let code = response.status();
        // Logged, not just returned: the panel renders "unavailable" the same way
        // for a flaky network as for the endpoint rejecting us outright, and only
        // one of those is our problem to fix.
        log::warn!("Claude usage request answered {code}");
        return Ok(ClaudeUsageFetch {
            windows: Vec::new(),
            status: ClaudeUsageStatus::Unavailable,
            detail: Some(format!("Anthropic answered {code}")),
        });
    }

    let body = match response.text().await {
        Ok(b) => b,
        Err(e) => {
            return Ok(ClaudeUsageFetch {
                windows: Vec::new(),
                status: ClaudeUsageStatus::Unavailable,
                detail: Some(e.to_string()),
            })
        }
    };
    let windows = match map_windows(&body, now_ms()) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ClaudeUsageFetch {
                windows: Vec::new(),
                status: ClaudeUsageStatus::Unavailable,
                detail: Some(e.to_string()),
            })
        }
    };
    store(db, &windows).await?;
    log::debug!("recorded {} Claude usage window(s)", windows.len());
    Ok(ClaudeUsageFetch {
        windows,
        status: ClaudeUsageStatus::Ok,
        detail: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shapes, not secrets: every "token" here is a literal placeholder.
    #[test]
    fn access_token_reads_the_oauth_block_and_rejects_everything_else() {
        assert_eq!(
            access_token(r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r"}}"#),
            Some("tok".into())
        );
        // Trimmed, and an empty or whitespace-only token is no token.
        assert_eq!(
            access_token(r#"{"claudeAiOauth":{"accessToken":"  tok  "}}"#),
            Some("tok".into())
        );
        assert_eq!(
            access_token(r#"{"claudeAiOauth":{"accessToken":"   "}}"#),
            None
        );
        assert_eq!(access_token(r#"{"claudeAiOauth":{}}"#), None);
        assert_eq!(access_token(r#"{"other":{"accessToken":"tok"}}"#), None);
        assert_eq!(access_token("not json at all"), None);
        assert_eq!(access_token(""), None);
    }

    #[test]
    fn reset_ms_accepts_seconds_millis_and_iso() {
        let secs = serde_json::json!(1_787_000_000i64);
        let millis = serde_json::json!(1_787_000_000_000i64);
        let iso = serde_json::json!("2026-08-27T18:00:00Z");
        assert_eq!(reset_ms(Some(&secs)), Some(1_787_000_000_000.0));
        assert_eq!(reset_ms(Some(&millis)), Some(1_787_000_000_000.0));
        assert_eq!(reset_ms(Some(&iso)), Some(1_787_853_600_000.0));
        // A seconds epoch that arrived as a string is still seconds.
        assert_eq!(
            reset_ms(Some(&serde_json::json!("1787000000"))),
            Some(1_787_000_000_000.0)
        );
        assert_eq!(reset_ms(Some(&serde_json::json!("nonsense"))), None);
        assert_eq!(reset_ms(Some(&serde_json::json!(null))), None);
        assert_eq!(reset_ms(None), None);
    }

    #[test]
    fn map_windows_reads_both_percent_spellings_and_the_model_scoped_limit() {
        let body = r#"{
            "five_hour": {"utilization": 31.4, "resets_at": 1787000000},
            "seven_day": {"used_percentage": 40, "resets_at": "2026-08-27T18:00:00Z"},
            "limits": [
              {"kind": "weekly_scoped", "percent": 55, "resets_at": 1787000000,
               "scope": {"model": {"display_name": "Fable"}}},
              {"kind": "five_hour", "percent": 99},
              {"kind": "weekly_scoped", "percent": 12, "scope": {"model": {"display_name": "  "}}}
            ]
        }"#;
        let w = map_windows(body, 5.0).unwrap();
        let names: Vec<_> = w.iter().map(|w| w.window.as_str()).collect();
        assert_eq!(names, ["five_hour", "seven_day", "Fable"]);
        assert_eq!(w[0].used_pct, 31.4);
        assert_eq!(w[0].resets_at_ms, Some(1_787_000_000_000.0));
        assert_eq!(w[1].used_pct, 40.0);
        assert_eq!(w[1].resets_at_ms, Some(1_787_853_600_000.0));
        assert_eq!(w[2].used_pct, 55.0);
        // Every row is stamped with the caller's clock, not each window's.
        assert!(w.iter().all(|w| w.updated_at_ms == 5.0));
    }

    #[test]
    fn map_windows_falls_back_to_the_legacy_per_model_spellings() {
        for key in ["fable_weekly", "fable_seven_day", "seven_day_fable"] {
            let body = format!(r#"{{"{key}": {{"utilization": 55}}}}"#);
            let w = map_windows(&body, 0.0).unwrap();
            assert_eq!(w.len(), 1, "{key}");
            assert_eq!(w[0].window, "Fable");
            assert_eq!(w[0].used_pct, 55.0);
        }
        // The named limit wins when both are present — it says which model.
        let body = r#"{"fable_weekly": {"utilization": 55},
                       "limits": [{"kind":"weekly_scoped","percent":60,
                                   "scope":{"model":{"display_name":"Opus"}}}]}"#;
        let w = map_windows(body, 0.0).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].window, "Opus");
    }

    #[test]
    fn map_windows_survives_an_empty_or_unknown_response() {
        assert!(map_windows("{}", 0.0).unwrap().is_empty());
        // A window with no readable percentage contributes nothing.
        assert!(map_windows(r#"{"five_hour":{}}"#, 0.0).unwrap().is_empty());
        assert!(map_windows("[]", 0.0).is_err());
    }

    /// The host check is a parse, so a look-alike host can never match.
    #[test]
    fn the_usage_host_is_matched_by_parse_not_by_prefix() {
        let ours = reqwest::Url::parse(USAGE_URL).unwrap();
        assert_eq!(ours.host_str(), Some(USAGE_HOST));
        for evil in [
            "https://api.anthropic.com.evil.test/api/oauth/usage",
            "https://evil.test/api.anthropic.com/api/oauth/usage",
            "https://api.anthropic.com@evil.test/api/oauth/usage",
        ] {
            let url = reqwest::Url::parse(evil).unwrap();
            assert_ne!(url.host_str(), Some(USAGE_HOST), "{evil}");
            // …while a naive prefix test would have let the first one through.
        }
    }

    /// COMPLIANCE.md forbids spoofing a vendor client, and this request is the
    /// only place santree could be tempted to: the endpoint belongs to Claude
    /// Code and the token is Claude Code's. Identifying honestly is what keeps
    /// the read-only-usage exception narrow enough to defend.
    #[test]
    fn the_user_agent_identifies_santree_and_never_a_vendor_client() {
        assert!(USER_AGENT.starts_with("santree/"), "{USER_AGENT}");
        for vendor in ["claude", "codex", "cursor", "opencode"] {
            assert!(
                !USER_AGENT.to_ascii_lowercase().contains(vendor),
                "user agent must not claim to be {vendor}: {USER_AGENT}"
            );
        }
    }
}
