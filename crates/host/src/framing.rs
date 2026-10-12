//! Newline framing for the host's side of a connection.
//!
//! The client's `read_line` (`crates/remote/src/framing.rs`) without its idle
//! bound — the client times a silent link out, the host never does — and with
//! a buffer grown past [`KEEP_CAPACITY`] shrunk back before the next line.

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// The capacity a line buffer keeps between lines: one 32 MiB request must
/// not pin 32 MiB for the rest of its connection.
pub const KEEP_CAPACITY: usize = 1024 * 1024;

/// Why a link stopped yielding frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadEnd {
    /// Clean EOF at a frame boundary.
    Closed,
    /// Anything else, as a short human reason.
    Failed(String),
}

/// Read one line into `buf` (without its `\n` or a trailing `\r`).
///
/// A line longer than `max` ends the link rather than growing without bound:
/// a peer that never sends a newline must not be able to exhaust memory.
pub async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> Result<(), ReadEnd> {
    buf.clear();
    buf.shrink_to(KEEP_CAPACITY);
    loop {
        let available = reader
            .fill_buf()
            .await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_big_line_does_not_keep_its_buffer() {
        let big = vec![b'x'; 4 * KEEP_CAPACITY];
        let mut input = big.clone();
        input.extend_from_slice(b"\nsmall\n");
        let mut reader = tokio::io::BufReader::new(&input[..]);
        let mut buf = Vec::new();
        read_line(&mut reader, &mut buf, usize::MAX).await.unwrap();
        assert_eq!(buf, big);
        read_line(&mut reader, &mut buf, usize::MAX).await.unwrap();
        assert_eq!(buf, b"small");
        assert!(buf.capacity() <= KEEP_CAPACITY, "kept {}", buf.capacity());
    }
}
