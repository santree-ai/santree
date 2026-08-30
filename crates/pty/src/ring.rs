//! A session's recent output, kept so a client that lost its view can be caught
//! up instead of losing the session.
//!
//! The unit is the **chunk the pump read**, never a byte offset into a circular
//! buffer. A PTY read routinely ends in the middle of an escape sequence, and
//! slicing a circular buffer would put a cut inside one on every wrap; keeping
//! whole chunks means the only cut we ever make is at a boundary the reader
//! already chose. Reading from an absolute position is then a skip-walk, which
//! is cheap enough at this size and correct at every size.
//!
//! Positions are absolute byte counts over the life of the session (`seq`), so
//! a client can say "I have everything through N" without either side keeping a
//! per-client cursor.

use std::collections::VecDeque;

/// How much output a session keeps for catch-up.
///
/// Sized off superset's measurement rather than guessed: their reproducible
/// "ghost frame" case — a pane that missed a TUI's repaints and rendered a
/// stale frame under the live one — was ~105 KB of missed output, and they took
/// 2 MiB for ~20x margin. The same number is right here for the same reason,
/// and it bounds a session's idle cost at something a few dozen terminals can
/// afford.
pub const RING_CAP_BYTES: usize = 2 * 1024 * 1024;

/// Where a client is in the stream, as it understands things.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Anchor {
    /// "I have every byte of `epoch` through `seq`."
    At { epoch: String, seq: u64 },
    /// A brand-new terminal with nothing on it: send whatever there is.
    Fresh,
    /// There are bytes on this terminal but its position is unknown or not
    /// trustworthy. Distinct from `Fresh` because the correct answer is the
    /// opposite one — send nothing rather than everything.
    Unknown,
}

/// What the ring can do for an attaching client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayMode {
    /// The anchor was inside the ring: the bytes returned are exactly what the
    /// client missed, and nothing else.
    Exact,
    /// The client had nothing, so it gets whatever the ring still holds. Best
    /// effort — the ring is not the whole session.
    Tail,
    /// The client's position can't be established (a different epoch, or a gap
    /// older than the ring). **No bytes are returned.** The client keeps
    /// whatever it has and the caller repaints from the program instead.
    Reanchor,
}

/// The answer to an attach: where the client now is, and what to write first.
#[derive(Debug, Clone)]
pub struct Replay {
    pub mode: ReplayMode,
    /// The stream this position refers to. Returned even on a `Reanchor`, since
    /// that is exactly the case where the client's own epoch was wrong and it
    /// needs the right one to anchor against next time.
    pub epoch: String,
    /// The position the client should count from after writing `bytes`.
    pub seq: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub struct Ring {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    /// Absolute position of the first byte still retained.
    start_seq: u64,
    /// Total bytes ever produced by this session.
    seq: u64,
    cap: usize,
}

impl Default for Ring {
    fn default() -> Self {
        Self::with_cap(RING_CAP_BYTES)
    }
}

impl Ring {
    pub fn with_cap(cap: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            start_seq: 0,
            seq: 0,
            cap,
        }
    }

    /// Record output. Always advances `seq` by `data.len()`, whether or not the
    /// bytes survive the cap: `seq` counts what the session produced, not what
    /// we still have.
    pub fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        self.seq += data.len() as u64;
        self.chunks.push_back(data.to_vec());
        self.bytes += data.len();
        // Evict whole chunks from the front, advancing `start_seq` by exactly
        // what left. Never drop the last one: a single chunk bigger than the cap
        // is still the only record of the current screen, and an empty ring
        // would turn every attach into a reanchor.
        while self.bytes > self.cap && self.chunks.len() > 1 {
            let dropped = self.chunks.pop_front().map(|c| c.len()).unwrap_or(0);
            self.bytes -= dropped;
            self.start_seq += dropped as u64;
        }
        debug_assert_eq!(self.start_seq + self.bytes as u64, self.seq);
    }

    /// Decide what an attaching client needs. `epoch` is the session's identity;
    /// an anchor minted against a different one is unusable by definition.
    pub fn replay_for(&self, epoch: &str, anchor: &Anchor) -> Replay {
        match anchor {
            // `seq > self.seq` is a client claiming to be ahead of the stream —
            // impossible unless its anchor is corrupt, so it's treated as
            // unrecoverable rather than clamped into a plausible-looking answer.
            Anchor::At { epoch: e, seq }
                if e == epoch && *seq >= self.start_seq && *seq <= self.seq =>
            {
                Replay {
                    mode: ReplayMode::Exact,
                    epoch: epoch.to_string(),
                    seq: self.seq,
                    bytes: self.read_from(*seq),
                }
            }
            Anchor::Fresh => Replay {
                mode: ReplayMode::Tail,
                epoch: epoch.to_string(),
                seq: self.seq,
                bytes: self.read_from(self.start_seq),
            },
            _ => Replay {
                mode: ReplayMode::Reanchor,
                epoch: epoch.to_string(),
                seq: self.seq,
                bytes: Vec::new(),
            },
        }
    }

    /// Everything retained from absolute position `from` onward.
    fn read_from(&self, from: u64) -> Vec<u8> {
        let mut skip = from.saturating_sub(self.start_seq) as usize;
        let mut out = Vec::with_capacity(self.bytes.saturating_sub(skip));
        for chunk in &self.chunks {
            if skip >= chunk.len() {
                skip -= chunk.len();
                continue;
            }
            out.extend_from_slice(&chunk[skip..]);
            skip = 0;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring_of(cap: usize, writes: &[&[u8]]) -> Ring {
        let mut ring = Ring::with_cap(cap);
        for w in writes {
            ring.push(w);
        }
        ring
    }

    #[test]
    fn seq_counts_what_was_produced_not_what_was_kept() {
        let ring = ring_of(4, &[b"aaaa", b"bbbb", b"cccc"]);
        assert_eq!(ring.seq, 12);
        // Only the last chunk survived the cap, so catching up from the start is
        // impossible — but the stream position is still the truth.
        assert_eq!(ring.start_seq, 8);
    }

    #[test]
    fn an_anchor_inside_the_ring_replays_exactly_what_was_missed() {
        let ring = ring_of(64, &[b"hello ", b"world"]);
        let replay = ring.replay_for(
            "e1",
            &Anchor::At {
                epoch: "e1".into(),
                seq: 6,
            },
        );
        assert_eq!(replay.mode, ReplayMode::Exact);
        assert_eq!(replay.bytes, b"world");
        assert_eq!(replay.seq, 11);
    }

    #[test]
    fn a_caught_up_client_gets_no_bytes_but_still_exact() {
        let ring = ring_of(64, &[b"hello"]);
        let replay = ring.replay_for(
            "e1",
            &Anchor::At {
                epoch: "e1".into(),
                seq: 5,
            },
        );
        assert_eq!(replay.mode, ReplayMode::Exact);
        assert!(replay.bytes.is_empty());
    }

    #[test]
    fn a_fresh_client_gets_the_whole_ring() {
        let ring = ring_of(64, &[b"hello ", b"world"]);
        let replay = ring.replay_for("e1", &Anchor::Fresh);
        assert_eq!(replay.mode, ReplayMode::Tail);
        assert_eq!(replay.bytes, b"hello world");
    }

    /// The rule the whole design rests on: when the client's position can't be
    /// proven, its own screen is better than anything we could synthesize.
    #[test]
    fn an_unrecoverable_position_sends_nothing() {
        let ring = ring_of(64, &[b"hello"]);

        let stale_epoch = ring.replay_for(
            "e2",
            &Anchor::At {
                epoch: "e1".into(),
                seq: 3,
            },
        );
        assert_eq!(stale_epoch.mode, ReplayMode::Reanchor);
        assert!(stale_epoch.bytes.is_empty());
        // It still learns where the stream actually is.
        assert_eq!(stale_epoch.seq, 5);

        let unknown = ring.replay_for("e1", &Anchor::Unknown);
        assert_eq!(unknown.mode, ReplayMode::Reanchor);
        assert!(unknown.bytes.is_empty());
    }

    #[test]
    fn a_gap_older_than_the_ring_reanchors_rather_than_guessing() {
        // Cap forces the first chunks out, so seq 0 is no longer reachable.
        let ring = ring_of(8, &[b"aaaaaaaa", b"bbbbbbbb"]);
        let replay = ring.replay_for(
            "e1",
            &Anchor::At {
                epoch: "e1".into(),
                seq: 0,
            },
        );
        assert_eq!(replay.mode, ReplayMode::Reanchor);
        assert!(replay.bytes.is_empty());
    }

    /// A client that claims to be ahead of the stream has a corrupt anchor.
    /// Clamping it would hand back a plausible-looking empty Exact and let the
    /// corruption persist; reanchoring repaints and resets it.
    #[test]
    fn an_anchor_past_the_head_reanchors() {
        let ring = ring_of(64, &[b"hello"]);
        let replay = ring.replay_for(
            "e1",
            &Anchor::At {
                epoch: "e1".into(),
                seq: 99,
            },
        );
        assert_eq!(replay.mode, ReplayMode::Reanchor);
    }

    #[test]
    fn the_last_chunk_is_never_evicted() {
        // One write far over the cap: dropping it would leave nothing to redraw
        // from and make every subsequent attach a reanchor.
        let ring = ring_of(4, &[b"aaaaaaaaaaaaaaaa"]);
        let replay = ring.replay_for("e1", &Anchor::Fresh);
        assert_eq!(replay.bytes, b"aaaaaaaaaaaaaaaa");
    }

    #[test]
    fn eviction_keeps_positions_consistent_across_many_writes() {
        let mut ring = Ring::with_cap(16);
        for i in 0..200u8 {
            ring.push(&[i; 5]);
        }
        assert_eq!(ring.seq, 1000);
        assert_eq!(ring.start_seq + ring.bytes as u64, ring.seq);
        // Whatever survived must be readable from its own start, and the answer
        // must be exactly as long as the retained span claims.
        let replay = ring.replay_for("e1", &Anchor::Fresh);
        assert_eq!(replay.bytes.len() as u64, ring.seq - ring.start_seq);
    }

    #[test]
    fn empty_writes_do_not_move_the_stream() {
        let mut ring = Ring::with_cap(64);
        ring.push(b"hi");
        ring.push(b"");
        assert_eq!(ring.seq, 2);
    }
}
