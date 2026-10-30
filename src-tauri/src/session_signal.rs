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

/// "The reply a session is drawing changed" — its `MessageDisplay` line
/// batches (`session_live_text`), or a state event that ended them. Fired once
/// per rendered line batch while Claude streams, so it is kept apart from
/// [`SessionStateChanged`] (which refetches every session row) and names its
/// session: only a Conversation view showing that session reads again.
/// `None` when the nudge named nothing usable — then every shown view reads.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct SessionLiveTextChanged {
    pub session_id: Option<String>,
}

/// Which table a nudge is about, from the tag byte the sender wrote first.
///
/// An unknown byte means session state: that was the original, untagged signal, so
/// treating it as the default keeps an older `santree-hook` (one left in a stale
/// bundle) working instead of silently doing nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    Usage,
    ReviewAi,
    RateLimits,
    State,
    /// `t` and the session id after it (`None` if it isn't one).
    LiveText(Option<String>),
}

/// The signal a nudge's bytes name: its first byte, and for `t` the session
/// id that follows. Any local process can connect to the socket, so the id is
/// only passed on when it has the shape of one santree minted.
fn kind_for(nudge: &[u8]) -> Signal {
    match nudge.first() {
        Some(b'u') => Signal::Usage,
        Some(b'r') => Signal::ReviewAi,
        Some(b'l') => Signal::RateLimits,
        Some(b't') => Signal::LiveText(
            std::str::from_utf8(&nudge[1..])
                .ok()
                .filter(|id| crate::session::is_session_id(id))
                .map(str::to_string),
        ),
        _ => Signal::State,
    }
}

/// The most of a nudge read: a tag byte and a session id.
const MAX_NUDGE: usize = 128;

/// A nudge's bytes: its tag, and for `t` what follows it up to the sender's
/// hang-up — all within one [`READ_TIMEOUT`], however the sender paces them
/// (the accept loop serves one connection at a time).
fn read_nudge(stream: &mut std::os::unix::net::UnixStream) -> Vec<u8> {
    let deadline = std::time::Instant::now() + READ_TIMEOUT;
    let mut nudge = Vec::with_capacity(MAX_NUDGE);
    let mut chunk = [0u8; MAX_NUDGE];
    while nudge.len() < MAX_NUDGE && !(nudge.len() == 1 && nudge[0] != b't') {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            break;
        }
        let want = if nudge.is_empty() {
            1
        } else {
            MAX_NUDGE - nudge.len()
        };
        match stream.read(&mut chunk[..want]) {
            Ok(0) | Err(_) => break,
            Ok(n) => nudge.extend_from_slice(&chunk[..n]),
        }
    }
    nudge
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
            // The nudge's arrival is the whole signal; its first byte tags which
            // table changed — `u` = live usage, `r` = review drafts, `l` = rate
            // limits, `t` = a session's live text (its id follows), anything
            // else = session state.
            emit(&app, kind_for(&read_nudge(&mut stream)));
        }
    });
    Ok(())
}

/// What a nudge does: tell the frontend which table to refetch. Also how a
/// hook relayed from Daedalus refreshes the UI (`daedalus::host`) — the same
/// events, without a socket round trip to ourselves.
pub fn emit(app: &AppHandle, signal: Signal) {
    let _ = match signal {
        Signal::Usage => SessionUsageChanged {}.emit(app),
        Signal::ReviewAi => ReviewAiChanged {}.emit(app),
        Signal::RateLimits => ClaudeRateLimitsChanged {}.emit(app),
        Signal::State => SessionStateChanged {}.emit(app),
        Signal::LiveText(session_id) => SessionLiveTextChanged { session_id }.emit(app),
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tag_byte_picks_the_table() {
        assert_eq!(kind_for(b"u"), Signal::Usage);
        assert_eq!(kind_for(b"r"), Signal::ReviewAi);
        assert_eq!(kind_for(b"l"), Signal::RateLimits);
        assert_eq!(kind_for(b"s"), Signal::State);
        // An empty or unrecognised nudge is the original, untagged signal.
        assert_eq!(kind_for(b""), Signal::State);
        assert_eq!(kind_for(b"?"), Signal::State);
        // The live-text nudge carries its session, passed on only in the shape
        // santree mints (the socket takes any local process's bytes).
        let sid = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f";
        assert_eq!(
            kind_for(format!("t{sid}").as_bytes()),
            Signal::LiveText(Some(sid.to_string()))
        );
        for junk in [&b"t"[..], b"t../../etc", b"t\xff\xfe"] {
            assert_eq!(kind_for(junk), Signal::LiveText(None), "{junk:?}");
        }
    }
}
