//! Realtime push for `session_state`, via a Unix domain socket.
//!
//! The shipped `santree-hook` binary runs as a *separate process* (Claude spawns
//! it), so it can't emit a Tauri event directly. After writing a state row it
//! connects to this socket and sends a byte; the app's accept loop turns each
//! nudge into a typed [`SessionStateChanged`] event, and the frontend refetches.
//! A direct process-to-process signal — no filesystem watching, no polling.
//!
//! (Earlier this watched a tick file with `notify`, but single-file watches are
//! unreliable on macOS/FSEvents — the socket is deterministic and lower latency.)

use std::io::Read;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

/// "A session's state changed" — the frontend invalidates its session-states
/// query and refetches. Empty payload: the table is tiny, so a bare signal is
/// enough (mirrors how `WorktreeChanged` drives a targeted invalidation).
#[derive(Clone, Serialize, Type, Event)]
pub struct SessionStateChanged {}

/// "A session's live token/context usage changed" — the frontend invalidates its
/// session-usage-live query. Fired far more often than [`SessionStateChanged`]
/// (once per status-line render), so it's a *separate* event to avoid refetching
/// the state table on every status-line tick. The hook tags its socket byte to
/// pick which one this is.
#[derive(Clone, Serialize, Type, Event)]
pub struct SessionUsageChanged {}

/// "An AI-review session wrote something" — a draft review comment or a review
/// brief, through the `santree-review` MCP server (which is the same binary, in
/// `mcp` mode). The frontend refetches the drafts and the brief, so a comment the
/// agent writes appears in the diff while the user is looking at it.
///
/// Empty like its siblings: the tables are small, and the signal's arrival is the
/// whole message.
#[derive(Clone, Serialize, Type, Event)]
pub struct ReviewAiChanged {}

/// "Claude's account rate-limit windows changed" — the frontend invalidates its
/// claude-rate-limits query. Written by the same status-line render as
/// [`SessionUsageChanged`], but the limits move far less often than a session's
/// context fill (the hook only nudges when a window actually changed), and they
/// are account-wide rather than per session — so a separate event, not a rider
/// on the usage one.
#[derive(Clone, Serialize, Type, Event)]
pub struct ClaudeRateLimitsChanged {}

/// Which table a nudge is about, from the tag byte the sender wrote first.
///
/// An unknown byte means session state: that was the original, untagged signal, so
/// treating it as the default keeps an older `santree-hook` (one left in a stale
/// bundle) working instead of silently doing nothing.
#[derive(Debug, PartialEq, Eq)]
enum Signal {
    Usage,
    ReviewAi,
    RateLimits,
    State,
}

fn kind_for_tag(tag: Option<u8>) -> Signal {
    match tag {
        Some(b'u') => Signal::Usage,
        Some(b'r') => Signal::ReviewAi,
        Some(b'l') => Signal::RateLimits,
        _ => Signal::State,
    }
}

/// A nudge is a single byte written straight after connecting, so a client that
/// sends nothing is broken — give up on it rather than let it stall the loop
/// (and with it every other session's live updates).
const READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Pause after a failed `accept` so a persistent error (e.g. EMFILE while many
/// PTYs are open) can't spin the loop hot while it lasts.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

/// Bind the signal socket and accept nudges from `santree-hook` for the app's
/// lifetime, emitting [`SessionStateChanged`] on each. Runs its accept loop on a
/// detached thread (kept alive for the process's lifetime; the OS reclaims it on
/// exit). Best-effort: if binding fails the UI simply falls back to its on-mount
/// / on-focus fetch.
pub fn start(app: &AppHandle, socket_path: &Path) -> Result<()> {
    if let Some(dir) = socket_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // A crash can leave a stale socket file that makes `bind` fail with
    // "address already in use"; clear it first (safe — only this app binds here).
    let _ = std::fs::remove_file(socket_path);
    let listener = UnixListener::bind(socket_path)?;

    let app = app.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let mut stream = match conn {
                Ok(s) => s,
                Err(e) => {
                    // An accept error is per-connection, not fatal to the listener:
                    // bailing out here would kill live session updates for the rest
                    // of the app's life over a transient fd exhaustion.
                    log::warn!("session-signal accept failed: {e}");
                    std::thread::sleep(ACCEPT_BACKOFF);
                    continue;
                }
            };
            let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
            // The nudge's arrival is the whole signal; its first byte tags which
            // table changed — `u` = live usage, `r` = review drafts, `l` = rate
            // limits, anything else = session state.
            let mut buf = [0u8; 8];
            let n = stream.read(&mut buf).unwrap_or(0);
            match kind_for_tag((n > 0).then(|| buf[0])) {
                Signal::Usage => {
                    let _ = SessionUsageChanged {}.emit(&app);
                }
                Signal::ReviewAi => {
                    let _ = ReviewAiChanged {}.emit(&app);
                }
                Signal::RateLimits => {
                    let _ = ClaudeRateLimitsChanged {}.emit(&app);
                }
                Signal::State => {
                    let _ = SessionStateChanged {}.emit(&app);
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tag_byte_picks_the_table() {
        assert_eq!(kind_for_tag(Some(b'u')), Signal::Usage);
        assert_eq!(kind_for_tag(Some(b'r')), Signal::ReviewAi);
        assert_eq!(kind_for_tag(Some(b'l')), Signal::RateLimits);
        assert_eq!(kind_for_tag(Some(b's')), Signal::State);
        // An empty or unrecognised nudge is the original, untagged signal.
        assert_eq!(kind_for_tag(None), Signal::State);
        assert_eq!(kind_for_tag(Some(b'?')), Signal::State);
    }
}
