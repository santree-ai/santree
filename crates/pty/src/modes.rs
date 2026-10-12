//! The terminal modes in effect where a ring's retained tail begins, so a
//! viewer that attaches late can be put in them before the tail is replayed.
//!
//! A TUI sets bracketed paste, mouse reporting, focus reporting and application
//! cursor keys once, at startup. Those bytes leave the ring (`ring.rs`) within
//! minutes, and a new terminal that replays only the retained tail never learns
//! of them: paste arrives as keystrokes and the mouse is dead on a live program.
//! The ring feeds every chunk it evicts to a [`ModeTracker`], whose snapshot is
//! then the state at the tail's first byte; [`ModeSnapshot::preamble`] writes
//! it, and the tail replayed after it moves the viewer on exactly as it moved
//! the original terminal.
//!
//! The model is xterm.js's (6.0), the only renderer santree ships: the mouse
//! protocols are one state and so are the mouse encodings; 1005/1015, the kitty
//! keyboard protocol and 8-bit C1 controls are not implemented there (a lone
//! `0x9B` is invalid UTF-8 to its decoder), so they are not tracked here.
//!
//! COMPLIANCE.md: this parses output only to replay terminal modes into a
//! viewer. It answers no query, writes nothing to the PTY and decides nothing
//! about input; its only product is bytes for the *display* side.
//!
//! The parser is a byte-stream state machine: a sequence split across two reads
//! is one sequence, memory is bounded (a parameter buffer of [`PARAMS_MAX`]
//! bytes), and nothing in the stream can make it fail.

use std::fmt::Write;

/// Independent DEC private flags: application cursor keys, application keypad,
/// focus reporting, bracketed paste. DECSTR resets these and nothing else.
const FLAGS: [u16; 4] = [1, 66, 1004, 2004];
/// Mouse protocols. Setting one replaces the others, resetting any is "off".
const MOUSE: [u16; 4] = [9, 1000, 1002, 1003];
/// Mouse encodings (SGR, SGR pixels): one state, like the protocols.
const ENCODINGS: [u16; 2] = [1006, 1016];
/// A CSI longer than this is not one of the sequences tracked.
const PARAMS_MAX: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModeSnapshot {
    alt: bool,
    /// Which of [`FLAGS`] are on.
    flags: [bool; FLAGS.len()],
    mouse: Option<u16>,
    encoding: Option<u16>,
}

impl ModeSnapshot {
    fn set(&mut self, mode: u32, on: bool) {
        let Ok(mode) = u16::try_from(mode) else {
            return;
        };
        if matches!(mode, 47 | 1047 | 1049) {
            self.alt = on;
        } else if MOUSE.contains(&mode) {
            self.mouse = on.then_some(mode);
        } else if ENCODINGS.contains(&mode) {
            self.encoding = on.then_some(mode);
        } else if let Some(i) = FLAGS.iter().position(|f| *f == mode) {
            self.flags[i] = on;
        }
    }

    /// The bytes that put a fresh terminal in this state: the alt screen first,
    /// so the modes after it land on the buffer the tail draws into. An exited
    /// session reads no input, so it gets the alt screen only: a reporting mode
    /// would just have the viewer send mouse and focus reports to a dead pane.
    pub fn preamble(&self, exited: bool) -> Vec<u8> {
        let mut out = String::new();
        if self.alt {
            out.push_str("\x1b[?1049h");
        }
        if !exited {
            let flags = FLAGS.iter().zip(self.flags).filter(|(_, on)| *on);
            for mode in flags
                .map(|(f, _)| *f)
                .chain(self.mouse)
                .chain(self.encoding)
            {
                let _ = write!(out, "\x1b[?{mode}h");
            }
        }
        out.into_bytes()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Ground,
    /// After `ESC`.
    Esc,
    /// Inside a CSI, collecting parameters.
    Csi,
    /// Inside OSC / DCS / SOS / PM / APC: ignored to its terminator. `osc`
    /// strings also end at BEL.
    Str { osc: bool },
}

/// Follows the bytes of one session's output.
#[derive(Debug, Default)]
pub struct ModeTracker {
    state: State,
    params: Vec<u8>,
    /// The CSI outgrew [`PARAMS_MAX`]: it is not one we track.
    overflow: bool,
    snapshot: ModeSnapshot,
}

impl ModeTracker {
    pub fn snapshot(&self) -> &ModeSnapshot {
        &self.snapshot
    }

    /// Follow `bytes`, which may begin and end anywhere inside a sequence.
    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.byte(b);
        }
    }

    fn byte(&mut self, b: u8) {
        match self.state {
            State::Ground => {
                if b == 0x1b {
                    self.state = State::Esc;
                }
            }
            State::Esc => match b {
                b'[' => {
                    self.params.clear();
                    self.overflow = false;
                    self.state = State::Csi;
                }
                b']' => self.state = State::Str { osc: true },
                b'P' | b'X' | b'^' | b'_' => self.state = State::Str { osc: false },
                // RIS.
                b'c' => {
                    self.snapshot = ModeSnapshot::default();
                    self.state = State::Ground;
                }
                0x1b => {}
                _ => self.state = State::Ground,
            },
            State::Csi => match b {
                0x1b => self.state = State::Esc,
                0x18 | 0x1a => self.state = State::Ground,
                0x20..=0x3f => {
                    if self.params.len() < PARAMS_MAX {
                        self.params.push(b);
                    } else {
                        self.overflow = true;
                    }
                }
                0x40..=0x7e => {
                    if !self.overflow {
                        dispatch(&mut self.snapshot, &self.params, b);
                    }
                    self.params.clear();
                    self.state = State::Ground;
                }
                // Other C0 controls run without ending the sequence.
                0x00..=0x1f | 0x7f => {}
                // Not a byte a CSI holds: the sequence is broken.
                _ => self.state = State::Ground,
            },
            State::Str { osc } => match b {
                // Any `ESC` ends the string (`ESC \`) or begins a new sequence;
                // the next byte says which.
                0x1b => self.state = State::Esc,
                0x18 | 0x1a => self.state = State::Ground,
                0x07 if osc => self.state = State::Ground,
                _ => {}
            },
        }
    }
}

/// Apply a finished CSI (`params` are its bytes after `CSI`, `fin` its final)
/// to `snapshot`. Allocates nothing: this runs for every escape sequence a
/// session ever prints.
fn dispatch(snapshot: &mut ModeSnapshot, params: &[u8], fin: u8) {
    match (params, fin) {
        ([b'?', rest @ ..], b'h' | b'l') => {
            for mode in numbers(rest).flatten() {
                snapshot.set(mode, fin == b'h');
            }
        }
        // DECSTR.
        (b"!", b'p') => snapshot.flags = Default::default(),
        _ => {}
    }
}

/// `;`-separated numeric parameters; an empty or non-numeric one is `None`
/// (a default, or something that is not a plain number).
fn numbers(rest: &[u8]) -> impl Iterator<Item = Option<u32>> + '_ {
    rest.split(|b| *b == b';').map(|p| {
        std::str::from_utf8(p)
            .ok()
            .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|s| s.parse().ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pre(bytes: &[u8]) -> String {
        let mut t = ModeTracker::default();
        t.feed(bytes);
        String::from_utf8(t.snapshot().preamble(false)).unwrap()
    }

    /// The last explicit state of each tracked mode: several parameters in one
    /// sequence, untracked ones ignored, the three alt-screen modes as one
    /// state, and RIS resetting everything.
    #[test]
    fn the_tracker_keeps_the_last_explicit_state_of_each_mode() {
        for (stream, preamble) in [
            (
                &b"\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1000l\x1b[?1002h\x1b[?1h"[..],
                "\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h",
            ),
            (b"\x1b[?2004h\x1b[?2004l", ""),
            (b"\x1b[?1;2004;25;1049h", "\x1b[?1049h\x1b[?1h\x1b[?2004h"),
            (b"\x1b[?25l\x1b[?7h\x1b[?1005h\x1b[?1015h", ""),
            (b"\x1b[?47h", "\x1b[?1049h"),
            (b"\x1b[?1047h\x1b[?1049l", ""),
            (b"\x1b[?2004h\x1b[?1049h\x1b[?1000h\x1bc", ""),
        ] {
            assert_eq!(
                pre(stream),
                preamble,
                "{:?}",
                String::from_utf8_lossy(stream)
            );
        }
    }

    #[test]
    fn a_sequence_split_across_chunks_is_one_sequence() {
        let whole = b"\x1b[?2004h\x1b[?1000h";
        for cut in 1..whole.len() {
            let mut t = ModeTracker::default();
            t.feed(&whole[..cut]);
            t.feed(&whole[cut..]);
            assert_eq!(
                t.snapshot().preamble(false),
                b"\x1b[?2004h\x1b[?1000h",
                "cut at {cut}"
            );
        }
    }

    #[test]
    fn sequences_inside_strings_are_not_sequences() {
        // Text that looks like a DECSET inside an OSC / DCS is string content,
        // whatever ends the string.
        assert_eq!(pre(b"\x1b]0;[?2004h\x07"), "");
        assert_eq!(pre(b"\x1b]0;[?2004h\x1b\\"), "");
        assert_eq!(pre(b"\x1bPq[?2004h\x07\x1b\\"), "");
        // An `ESC` ends a string (xterm's rule) and the next byte says what
        // follows, so a real sequence after a truncated string is tracked.
        assert_eq!(pre(b"\x1b]0;t\x1b[?2004h"), "\x1b[?2004h");
        // After the string ends, tracking resumes.
        assert_eq!(pre(b"\x1b]0;t\x07\x1b[?2004h"), "\x1b[?2004h");
        // CAN aborts a string.
        assert_eq!(pre(b"\x1b]0;\x18\x1b[?1h"), "\x1b[?1h");
    }

    #[test]
    fn noise_and_oversized_sequences_change_nothing_and_cannot_fail() {
        assert_eq!(pre(b"hello \xff\xfe world \x1b[31mred\x1b[0m"), "");
        let mut long = b"\x1b[?".to_vec();
        long.extend(std::iter::repeat_n(b'1', 10_000));
        long.extend_from_slice(b"h\x1b[?2004h");
        assert_eq!(pre(&long), "\x1b[?2004h");
        // A broken sequence is dropped; the next one stands.
        assert_eq!(pre(b"\x1b[?20\xc3\xa9\x1b[?1h"), "\x1b[?1h");
    }
}
