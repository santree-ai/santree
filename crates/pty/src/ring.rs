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

use crate::modes::ModeTracker;

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
    /// The position the client should count from after writing `bytes`. A
    /// `Tail` replay may begin with a short mode preamble that is not part of
    /// the stream, so its length is not `seq - start`.
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
    /// The process ended (the reader sent its exit sentinel). Kept with the
    /// chunks, under their lock, so an attach sees the output and the end of
    /// it as one state.
    exited: bool,
    /// The terminal modes where the retained part begins: every evicted chunk
    /// went through it, so a `Tail` replay is that state, then the tail
    /// (`modes.rs`).
    modes_at_start: ModeTracker,
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
            exited: false,
            modes_at_start: ModeTracker::default(),
        }
    }

    /// Nothing more will be pushed: the session's process ended.
    pub fn mark_exited(&mut self) {
        self.exited = true;
    }

    pub fn exited(&self) -> bool {
        self.exited
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
            let Some(dropped) = self.chunks.pop_front() else {
                break;
            };
            self.bytes -= dropped.len();
            self.start_seq += dropped.len() as u64;
            self.modes_at_start.feed(&dropped);
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
            Anchor::Fresh => {
                // A fresh viewer has none of the modes the program set long ago:
                // the preamble puts it where the tail begins. `seq` counts the
                // stream, so the extra bytes move no position.
                let mut bytes = self.modes_at_start.snapshot().preamble(self.exited);
                bytes.extend_from_slice(&self.read_from(self.start_seq));
                Replay {
                    mode: ReplayMode::Tail,
                    epoch: epoch.to_string(),
                    seq: self.seq,
                    bytes,
                }
            }
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

    fn at(seq: u64) -> Anchor {
        Anchor::At {
            epoch: "e1".into(),
            seq,
        }
    }

    /// Positions count what was produced, not what was kept: eviction moves
    /// the start, never the stream, and the last chunk is never evicted (with
    /// nothing to redraw from, every attach would reanchor).
    #[test]
    fn eviction_keeps_stream_positions_and_the_last_chunk() {
        let ring = ring_of(4, &[b"aaaa", b"bbbb", b"cccc"]);
        assert_eq!((ring.start_seq, ring.seq), (8, 12));

        let mut ring = Ring::with_cap(16);
        for i in 0..200u8 {
            ring.push(&[i; 5]);
        }
        ring.push(b"");
        assert_eq!(ring.seq, 1000, "an empty write does not move the stream");
        assert_eq!(ring.start_seq + ring.bytes as u64, ring.seq);
        let replay = ring.replay_for("e1", &Anchor::Fresh);
        assert_eq!(replay.bytes.len() as u64, ring.seq - ring.start_seq);

        let ring = ring_of(4, &[b"aaaaaaaaaaaaaaaa"]);
        assert_eq!(
            ring.replay_for("e1", &Anchor::Fresh).bytes,
            b"aaaaaaaaaaaaaaaa"
        );
    }

    /// A provable position gets exactly what it lacks: the gap, nothing when
    /// caught up, the whole ring when fresh.
    #[test]
    fn a_provable_anchor_gets_exactly_what_it_lacks() {
        let ring = ring_of(64, &[b"hello ", b"world"]);
        for (anchor, mode, bytes) in [
            (at(6), ReplayMode::Exact, &b"world"[..]),
            (at(11), ReplayMode::Exact, b""),
            (Anchor::Fresh, ReplayMode::Tail, b"hello world"),
        ] {
            let replay = ring.replay_for("e1", &anchor);
            assert_eq!(
                (replay.mode, &replay.bytes[..]),
                (mode, bytes),
                "{anchor:?}"
            );
            assert_eq!(replay.seq, 11);
        }
    }

    /// The rule the whole design rests on: when the client's position can't be
    /// proven — another epoch, unknown, evicted, or past the head (a corrupt
    /// anchor clamping would let persist) — its own screen is better than
    /// anything we could synthesize. It still learns where the stream is.
    #[test]
    fn an_unprovable_anchor_reanchors_with_nothing() {
        let ring = ring_of(8, &[b"aaaaaaaa", b"bbbbbbbb"]);
        for (epoch, anchor) in [
            ("e2", at(12)),
            ("e1", Anchor::Unknown),
            ("e1", at(0)),
            ("e1", at(99)),
        ] {
            let replay = ring.replay_for(epoch, &anchor);
            assert_eq!(replay.mode, ReplayMode::Reanchor, "{epoch} {anchor:?}");
            assert!(replay.bytes.is_empty());
            assert_eq!(replay.seq, 16);
        }
    }

    // ── mode preamble on a fresh replay ─────────────────────────────────────

    #[test]
    fn a_tail_that_lost_the_decset_starts_with_a_mode_preamble() {
        // Cap 16: the DECSET chunk is evicted, the text chunks stay.
        let ring = ring_of(16, &[b"\x1b[?2004h", b"0123456789", b"abcdefghij"]);
        let replay = ring.replay_for("e1", &Anchor::Fresh);
        assert_eq!(replay.mode, ReplayMode::Tail);
        assert_eq!(replay.bytes, b"\x1b[?2004habcdefghij");
        // Positions still count the stream, not the preamble.
        assert_eq!(replay.seq, 28);
    }

    /// The preamble of a ring whose first chunk (`gone`) was evicted by a
    /// 16-byte text chunk.
    fn preamble_after(gone: &[u8], exited: bool) -> Vec<u8> {
        let mut ring = ring_of(16, &[gone, b"0123456789abcdef"]);
        if exited {
            ring.mark_exited();
        }
        let replay = ring.replay_for("e1", &Anchor::Fresh);
        replay.bytes[..replay.bytes.len() - 16].to_vec()
    }

    #[test]
    fn a_reset_of_any_mouse_protocol_turns_reporting_off() {
        // xterm.js keeps one mouse protocol: `?1002l` ends `?1000h` as well.
        assert_eq!(
            preamble_after(b"\x1b[?1000h\x1b[?1002h\x1b[?1002l", false),
            b""
        );
        assert_eq!(
            preamble_after(b"\x1b[?1006h\x1b[?1016h\x1b[?1016l", false),
            b""
        );
        assert_eq!(
            preamble_after(b"\x1b[?1000h\x1b[?1003h\x1b[?1006h", false),
            b"\x1b[?1003h\x1b[?1006h"
        );
    }

    #[test]
    fn a_soft_reset_keeps_the_alt_screen_and_the_mouse() {
        assert_eq!(
            preamble_after(
                b"\x1b[?1049h\x1b[?1000h\x1b[?2004h\x1b[?1004h\x1b[!p",
                false
            ),
            b"\x1b[?1049h\x1b[?1000h"
        );
    }

    #[test]
    fn a_lone_0x9b_is_not_a_csi() {
        // xterm.js decodes UTF-8 first and drops an invalid lead byte.
        assert_eq!(preamble_after(b"\x9b?2004h", false), b"");
    }

    #[test]
    fn an_exited_session_gets_the_alt_screen_and_no_input_modes() {
        // Nothing reads its input any more: reporting modes would only make the
        // viewer send mouse and focus reports into a dead pane.
        let gone = b"\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[?2004h";
        assert_eq!(preamble_after(gone, true), b"\x1b[?1049h");
    }

    /// What a fresh viewer ends in after the preamble and the tail is what the
    /// whole stream left, at every eviction point.
    #[test]
    fn a_fresh_replay_settles_the_modes_of_the_whole_stream() {
        let chunks: [&[u8]; 9] = [
            b"\x1b[?1049h",
            b"\x1b[?1000h\x1b[?1006h",
            b"frame one",
            b"\x1b[?2004h\x1b[?1004h",
            b"\x1b[!p",
            b"\x1b[?1002h\x1b[?1h",
            b"\x1b[?1049l",
            b"\x1b[?1000l\x1b[?2004h",
            b"prompt",
        ];
        for cap in 1..=chunks.concat().len() {
            let ring = ring_of(cap, &chunks);
            let replay = ring.replay_for("e1", &Anchor::Fresh);
            let (mut viewer, mut whole) = (ModeTracker::default(), ModeTracker::default());
            viewer.feed(&replay.bytes);
            whole.feed(&chunks.concat());
            assert_eq!(viewer.snapshot(), whole.snapshot(), "cap {cap}");
        }
    }

    #[test]
    fn an_exact_replay_and_a_reanchor_get_no_preamble() {
        let ring = ring_of(16, &[b"\x1b[?2004h", b"0123456789", b"abcdefghij"]);
        let exact = ring.replay_for(
            "e1",
            &Anchor::At {
                epoch: "e1".into(),
                seq: 18,
            },
        );
        assert_eq!(exact.mode, ReplayMode::Exact);
        assert_eq!(exact.bytes, b"abcdefghij");
        let unknown = ring.replay_for("e1", &Anchor::Unknown);
        assert!(unknown.bytes.is_empty());
    }
}
