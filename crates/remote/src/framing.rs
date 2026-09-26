//! Newline framing, shared by the client and the fake daemon.

use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// Why a link stopped yielding frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReadEnd {
    /// Clean EOF at a frame boundary.
    Closed,
    /// Anything else, as a short human reason.
    Failed(String),
}

/// Read one line into `buf` (without its `\n` or a trailing `\r`).
///
/// A line longer than `max` ends the link rather than growing without bound:
/// a peer that never sends a newline must not be able to exhaust memory.
/// `idle` bounds each wait for more bytes, which is how a silent link (no
/// data and no ping) is noticed.
pub(crate) async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
    idle: Option<Duration>,
) -> Result<(), ReadEnd> {
    buf.clear();
    loop {
        let available = match idle {
            Some(idle) => match tokio::time::timeout(idle, reader.fill_buf()).await {
                Ok(read) => read,
                Err(_) => {
                    return Err(ReadEnd::Failed(format!(
                        "no traffic for {}s",
                        idle.as_secs_f32().round()
                    )))
                }
            },
            None => reader.fill_buf().await,
        }
        .map_err(|e| ReadEnd::Failed(format!("read failed: {e}")))?;

        if available.is_empty() {
            return Err(if buf.is_empty() {
                ReadEnd::Closed
            } else {
                ReadEnd::Failed("connection closed mid-message".into())
            });
        }
        let (take, done) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (available.len(), false),
        };
        // `max` counts the line's content; the newline itself is free.
        if buf.len() + take - usize::from(done) > max {
            return Err(ReadEnd::Failed(format!("message over {max} bytes")));
        }
        buf.extend_from_slice(&available[..take]);
        reader.consume(take);
        if done {
            buf.pop();
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(());
        }
    }
}
