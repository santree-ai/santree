//! The parses a Conversation view reads from: one per record file, kept warm
//! in a small LRU and brought up to date by reading only what the agent
//! appended since the last read.
//!
//! A parse is named by its *epoch*. A reader's cursor carries the epoch it was
//! handed, so anything that starts a parse over — the app restarting, the parse
//! being evicted, the file shrinking or being replaced, a parse that has grown
//! past its bound — makes that reader's next read a reset instead of a diff
//! against items it no longer matches.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use santree_core::conversation::claude::{ClaudeTranscript, TranscriptKind};
use santree_core::conversation::{ConversationCursor, ConversationItem, ConversationMeta};

use crate::record_file;

/// The most of a record a parse reads from scratch. A longer record is read
/// from its tail and says so (`meta.truncated`): a long session's transcript
/// runs to hundreds of MB, and the view is for following a conversation, not
/// for archaeology. A parse kept live is allowed twice this before it starts
/// over from the tail — the slack is what keeps it from starting over on
/// every append.
const TAIL_BYTES: u64 = 32 * 1024 * 1024;

/// The longest line held whole. A line past it is skipped without ever being
/// buffered — nothing a conversation draws is that large, but a pasted image
/// or a giant tool result can be, and a line is parsed whole.
const MAX_LINE: u64 = 8 * 1024 * 1024;

/// Parses kept at once, and the heap they may hold between them. The one being
/// read is never evicted.
const MAX_PARSES: usize = 24;
const MAX_CACHE_BYTES: usize = 128 * 1024 * 1024;

/// The largest subagent sidecar read; a real one is a few hundred bytes.
const MAX_SIDECAR: u64 = 64 * 1024;

/// What one read hands back.
pub(super) struct Snapshot {
    pub cursor: ConversationCursor,
    pub reset: bool,
    pub items: Vec<ConversationItem>,
    pub meta: ConversationMeta,
}

/// This process's parses are told apart from the last run's: an epoch a
/// reader carries across an app restart never matches.
static BOOT: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().simple().to_string());
static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

fn next_epoch() -> String {
    format!(
        "{}-{}",
        &BOOT[..8],
        NEXT_EPOCH.fetch_add(1, Ordering::Relaxed)
    )
}

/// One record file's parse, and the span of the file it has read.
pub(super) struct FileParse {
    kind: TranscriptKind,
    epoch: String,
    /// `(device, inode)` of the file read; another means it was replaced.
    identity: Option<(u64, u64)>,
    /// Where the parse began: 0, or a tail's start.
    start: u64,
    /// Where the next read begins: the end of the last complete line applied.
    offset: u64,
    transcript: ClaudeTranscript,
    /// Subagents whose sidecar was already offered to the transcript.
    sidecars: HashSet<String>,
}

impl FileParse {
    pub(super) fn new(kind: TranscriptKind) -> Self {
        Self {
            kind,
            epoch: next_epoch(),
            identity: None,
            start: 0,
            offset: 0,
            transcript: ClaudeTranscript::new(kind),
            sidecars: HashSet::new(),
        }
    }

    pub(super) fn approx_bytes(&self) -> usize {
        self.transcript.approx_bytes()
            + self
                .sidecars
                .iter()
                .map(|id| std::mem::size_of::<String>() + id.len() + 16)
                .sum::<usize>()
    }

    /// Bring the parse up to date with `path` and answer a reader holding
    /// `cursor`. `roots` are the canonical directories a record may be read
    /// from. `subagents` lists the session's subagent transcripts; it is asked
    /// only while an Agent call is still waiting to learn which subagent it
    /// started. Blocking.
    pub(super) fn read(
        &mut self,
        path: &Path,
        roots: &[PathBuf],
        cursor: Option<&ConversationCursor>,
        subagents: impl FnOnce() -> Vec<PathBuf>,
    ) -> std::io::Result<Snapshot> {
        // What is read is what was opened: its identity and length come from
        // the handle, a link in the file's place is refused, not followed, and
        // the handle's own path must be inside `roots` (a directory above the
        // file can be a link too).
        let record_file::Record { mut file, meta, .. } = record_file::open(path, roots)?;
        let identity = (meta.dev(), meta.ino());
        let len = meta.len();
        let start_over = match self.identity {
            None => true,
            // Replaced, cut short, or grown past twice the bound since the
            // parse began.
            Some(read) => {
                read != identity || len < self.offset || len - self.start > 2 * TAIL_BYTES
            }
        };
        if start_over {
            if self.identity.is_some() {
                *self = FileParse::new(self.kind);
            }
            self.identity = Some(identity);
            let from = len.saturating_sub(TAIL_BYTES);
            if from > 0 {
                self.transcript.mark_truncated();
            }
            (self.start, self.offset) = (from, from);
            self.ingest(&mut file, len, from > 0)?;
        } else if len > self.offset {
            self.ingest(&mut file, len, false)?;
        }
        if self.transcript.wants_subagent_links() {
            self.offer_sidecars(subagents(), roots);
        }
        Ok(self.snapshot(cursor))
    }

    /// Apply the complete lines from `offset` to `to`. A line the agent is
    /// still writing is left for the next read. `align`: the read starts
    /// mid-file (a tail), so it first skips to the start of a line — and when
    /// no line starts before `to`, stays put: the fragment that follows fails
    /// to parse on the next read and is dropped there.
    fn ingest(&mut self, file: &mut File, to: u64, align: bool) -> std::io::Result<()> {
        if align && !line_starts_at(file, self.offset)? {
            file.seek(SeekFrom::Start(self.offset))?;
            let mut reader = BufReader::new((&mut *file).take(to - self.offset));
            match skip_line(&mut reader)? {
                Some(skipped) => self.offset += skipped,
                None => return Ok(()),
            }
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::with_capacity(256 * 1024, (&mut *file).take(to - self.offset));
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = (&mut reader).take(MAX_LINE).read_until(b'\n', &mut line)?;
            if n == 0 {
                break;
            }
            if line.last() != Some(&b'\n') {
                if n as u64 == MAX_LINE {
                    // Too long to hold: skipped, never buffered whole.
                    match skip_line(&mut reader)? {
                        Some(rest) => {
                            self.offset += n as u64 + rest;
                            continue;
                        }
                        None => break,
                    }
                }
                // The agent is still writing this line.
                break;
            }
            self.offset += n as u64;
            self.transcript.push_line(&line[..n - 1]);
        }
        Ok(())
    }

    /// Offer the transcript what each subagent's `agent-<id>.meta.json`
    /// sidecar says about the call that started it. A sidecar is read once per
    /// parse; one that is missing or not yet whole is retried next read.
    fn offer_sidecars(&mut self, transcripts: Vec<PathBuf>, roots: &[PathBuf]) {
        for transcript in transcripts {
            let Some(agent_id) = transcript
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("agent-"))
                .and_then(|n| n.strip_suffix(".jsonl"))
            else {
                continue;
            };
            if self.sidecars.contains(agent_id) {
                continue;
            }
            let Some(sidecar) = read_sidecar(&transcript.with_extension("meta.json"), roots) else {
                continue;
            };
            if let Some(tool_use_id) = sidecar.tool_use_id.as_deref() {
                self.transcript
                    .link_subagent(tool_use_id, agent_id, sidecar.agent_type.as_deref());
            }
            self.sidecars.insert(agent_id.to_string());
        }
    }

    fn snapshot(&self, cursor: Option<&ConversationCursor>) -> Snapshot {
        let journal = self.transcript.journal();
        // A cursor from another parse, or one this parse never handed out, is
        // a reader that must start over.
        let held = cursor.filter(|c| c.epoch == self.epoch && c.rev <= journal.rev());
        Snapshot {
            cursor: ConversationCursor {
                epoch: self.epoch.clone(),
                rev: journal.rev(),
            },
            reset: held.is_none(),
            items: match held {
                Some(c) => journal.changed_since(c.rev),
                None => journal.items(),
            },
            meta: self.transcript.meta().clone(),
        }
    }
}

/// Whether byte `at` of `file` starts a line: the byte before it is a newline.
/// A byte that can't be read reads as mid-line, which costs one line at most.
fn line_starts_at(file: &mut File, at: u64) -> std::io::Result<bool> {
    file.seek(SeekFrom::Start(at - 1))?;
    let mut byte = [0u8; 1];
    Ok(file.read_exact(&mut byte).is_ok() && byte[0] == b'\n')
}

/// Discard the rest of the current line without buffering it: the bytes
/// consumed, newline included, or `None` at the end of input.
fn skip_line(reader: &mut impl BufRead) -> std::io::Result<Option<u64>> {
    let mut skipped = 0u64;
    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            return Ok(None);
        }
        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
            reader.consume(i + 1);
            return Ok(Some(skipped + i as u64 + 1));
        }
        let n = buf.len();
        reader.consume(n);
        skipped += n as u64;
    }
}

#[derive(serde::Deserialize)]
struct Sidecar {
    #[serde(rename = "toolUseId")]
    tool_use_id: Option<String>,
    #[serde(rename = "agentType")]
    agent_type: Option<String>,
}

/// A subagent's sidecar, when it is a regular file of a sane size inside
/// `roots` that parses. Opened as a record ([`record_file::open`]), like the
/// listing it sits beside refuses links (`usage::subagent_files`).
fn read_sidecar(path: &Path, roots: &[PathBuf]) -> Option<Sidecar> {
    let record_file::Record { file, meta, .. } = record_file::open(path, roots).ok()?;
    if meta.len() > MAX_SIDECAR {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_SIDECAR).read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// A parse and its last measured size.
pub(super) struct Slot {
    pub parse: Mutex<FileParse>,
    bytes: AtomicUsize,
}

impl Slot {
    pub(super) fn measured(&self, bytes: usize) {
        self.bytes.store(bytes, Ordering::Relaxed);
    }
}

/// The parses, least recently read evicted first.
pub(super) struct Parses {
    slots: Vec<(PathBuf, Arc<Slot>, Instant)>,
    /// The heap the parses may hold between them ([`MAX_CACHE_BYTES`]).
    budget: usize,
}

impl Default for Parses {
    fn default() -> Self {
        Self {
            slots: Vec::new(),
            budget: MAX_CACHE_BYTES,
        }
    }
}

impl Parses {
    /// The parse of `path`, made fresh (with a new epoch) when there is none.
    pub(super) fn slot(&mut self, path: &Path, kind: TranscriptKind) -> Arc<Slot> {
        let now = Instant::now();
        if let Some((_, slot, used)) = self.slots.iter_mut().find(|(p, ..)| p.as_path() == path) {
            *used = now;
            return slot.clone();
        }
        let slot = Arc::new(Slot {
            parse: Mutex::new(FileParse::new(kind)),
            bytes: AtomicUsize::new(0),
        });
        self.slots.push((path.to_path_buf(), slot.clone(), now));
        self.fit();
        slot
    }

    /// Drop the least recently read parses no read holds until the count and
    /// the byte budget fit.
    pub(super) fn fit(&mut self) {
        loop {
            let bytes: usize = self
                .slots
                .iter()
                .map(|(_, s, _)| s.bytes.load(Ordering::Relaxed))
                .sum();
            if self.slots.len() <= MAX_PARSES && bytes <= self.budget {
                return;
            }
            let Some(oldest) = self
                .slots
                .iter()
                .enumerate()
                .filter(|(_, (_, slot, _))| Arc::strong_count(slot) == 1)
                .min_by_key(|(_, (.., used))| *used)
                .map(|(i, _)| i)
            else {
                return;
            };
            self.slots.remove(oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use santree_core::conversation::{ItemBody, ToolStatus};
    use serde_json::json;

    use super::*;

    fn line(record: serde_json::Value) -> String {
        format!("{record}\n")
    }

    fn append(path: &Path, text: &str) {
        std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }

    fn ids(snapshot: &Snapshot) -> Vec<&str> {
        snapshot.items.iter().map(|i| i.id.as_str()).collect()
    }

    #[test]
    fn a_read_applies_only_new_whole_lines_and_starts_over_when_the_file_does() {
        let dir = std::env::temp_dir().join(format!("santree-conversation-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        let roots = record_file::canonical(std::slice::from_ref(&dir));
        let prompt = line(json!({
            "type": "user", "uuid": "u1", "promptSource": "typed",
            "message": {"role": "user", "content": "placeholder prompt"},
        }));
        let reply = line(json!({
            "type": "assistant", "uuid": "a1",
            "message": {"id": "m1", "model": "placeholder", "content": [{"type": "text", "text": "placeholder reply"}]},
        }));
        let call = line(json!({
            "type": "assistant", "uuid": "a2",
            "message": {"id": "m1", "model": "placeholder", "content": [
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "true"}},
            ]},
        }));
        let result = line(json!({
            "type": "user", "uuid": "r1",
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": ""}]},
        }));

        // Claude is mid-write: the reply's line has no newline yet.
        let (head, tail) = reply.split_at(reply.len() / 2);
        std::fs::write(&path, format!("{prompt}{head}")).unwrap();
        let mut parse = FileParse::new(TranscriptKind::Main);
        let first = parse.read(&path, &roots, None, Vec::new).unwrap();
        assert!(first.reset);
        assert_eq!(ids(&first), ["u1"], "the half-written line waits");

        // It completes and a call follows: only what is new comes back.
        append(&path, &format!("{tail}{call}"));
        let second = parse
            .read(&path, &roots, Some(&first.cursor), Vec::new)
            .unwrap();
        assert!(!second.reset);
        assert_eq!(ids(&second), ["a1", "tool:t1"]);

        // The call's result lands: the call comes back, changed in place.
        append(&path, &result);
        let third = parse
            .read(&path, &roots, Some(&second.cursor), Vec::new)
            .unwrap();
        assert_eq!(ids(&third), ["tool:t1"]);
        assert!(matches!(&third.items[0].body, ItemBody::Tool(c) if c.status == ToolStatus::Done));
        let idle = parse
            .read(&path, &roots, Some(&third.cursor), Vec::new)
            .unwrap();
        assert!(!idle.reset && idle.items.is_empty());

        // A cursor this parse never handed out is a reader starting over.
        let stranger = ConversationCursor {
            epoch: "another-parse".into(),
            rev: third.cursor.rev,
        };
        let restart = parse
            .read(&path, &roots, Some(&stranger), Vec::new)
            .unwrap();
        assert!(restart.reset);
        assert_eq!(ids(&restart), ["u1", "a1", "tool:t1"]);

        // The file is cut short: the parse starts over under a new epoch, and
        // a reader holding the old cursor is told to drop what it holds.
        std::fs::write(&path, &prompt).unwrap();
        let fourth = parse
            .read(&path, &roots, Some(&third.cursor), Vec::new)
            .unwrap();
        assert!(fourth.reset);
        assert_ne!(fourth.cursor.epoch, third.cursor.epoch);
        assert_eq!(ids(&fourth), ["u1"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The bug: the byte budget was checked only when a new parse joined, so
    /// a parse that grew while its session ran could hold the cache over it
    /// indefinitely. A read's `fit` must drop the idle parses then — never
    /// the one being read.
    #[test]
    fn a_parse_that_grows_past_the_budget_evicts_the_idle_ones() {
        let mut parses = Parses {
            budget: 1_000,
            ..Parses::default()
        };
        let idle = parses.slot(Path::new("/idle.jsonl"), TranscriptKind::Main);
        idle.measured(400);
        drop(idle);
        let reading = parses.slot(Path::new("/live.jsonl"), TranscriptKind::Main);
        reading.measured(900);
        parses.fit();
        let held: Vec<&Path> = parses.slots.iter().map(|(p, ..)| p.as_path()).collect();
        assert_eq!(held, [Path::new("/live.jsonl")]);
    }
}
