//! Codex session history, read from the rollouts Codex writes to
//! `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`.
//!
//! A rollout is JSON Lines, one `{timestamp, type, payload}` record per line. The
//! first record is always `session_meta` (thread id, `cwd`, start time, and — for a
//! subagent's own rollout — its parent thread). The records this module reads:
//!
//! * `event_msg` / `user_message` — the user's prompts; the first is the title.
//! * `event_msg` / `agent_message` — the assistant's replies; the last is the
//!   last message.
//! * `response_item` / `message` — the conversation as sent to the model. The
//!   fallback for a rollout with no `event_msg` prompts at all (every thread
//!   santree started through the App Server it used to own is one, and those
//!   rollouts are still on disk): user-role messages are the prompts,
//!   assistant-role ones the replies. Developer-role messages are never
//!   read, and the user-role text Codex injects itself (the `# AGENTS.md
//!   instructions` block, `<environment_context>`, `<task-notification>`, …) is
//!   skipped — see [`is_injected`].
//! * `event_msg` / `thread_settings_applied` — the model, from `thread_settings`.
//!   `turn_context.payload.model` is the fallback.
//! * `event_msg` / `token_count` — the rate-limit windows the API returned for
//!   that turn. Read only by [`latest_rate_limits`], which is santree's whole
//!   source for Codex subscription usage now that the App Server is gone.
//! * `response_item` / `agent_message` — inter-agent mail. Its `author` /
//!   `recipient` agent paths back up the subagent count when a child's rollout
//!   isn't on disk, and a report addressed to the root agent is a candidate last
//!   message when it is the latest text in the file.
//!
//! Reasoning records are encrypted and skipped. This is read to *display* a
//! session in the UI, never to decide what is sent to one (see `COMPLIANCE.md`).
//!
//! Discovery is bounded the way `usage.rs`'s is: every rollout's first line is
//! peeked (and cached — it never changes), and only the ones whose `cwd` belongs
//! to the worktree, or whose thread the registry named, are parsed in full.
//! Parses are cached by byte length like the Claude transcript cache, so a
//! 30-second panel refresh re-reads nothing that didn't grow.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Deserializer};

use santree_core::domain::{CodexRateLimitWindow, CodexRateLimits, LastMessageFrom};

use crate::session::SessionSummary;
use crate::usage::{cwd_belongs_to, one_line, Blocks};

/// `$CODEX_HOME/sessions` (Codex's own override), else `~/.codex/sessions` — when
/// it exists.
pub(crate) fn sessions_root() -> Option<PathBuf> {
    let home = match std::env::var_os("CODEX_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".codex"),
    };
    let root = home.join("sessions");
    root.is_dir().then_some(root)
}

/// Every `rollout-*.jsonl` under `dir`, walking the `YYYY/MM/DD` partitions. Only
/// real directories are entered (no symlinks) and the walk is bounded to the
/// partition depth, so a stray link can't drag it elsewhere.
fn collect_rollouts(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else {
            continue;
        };
        let p = e.path();
        if ft.is_dir() {
            if depth < 3 {
                collect_rollouts(&p, depth + 1, out);
            }
        } else if ft.is_file()
            && p.extension().and_then(|x| x.to_str()) == Some("jsonl")
            && p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rollout-"))
        {
            out.push(p);
        }
    }
}

// ── Record shapes (parse only what we need) ─────────────────────────────────

/// A string field that may be something else in a record type we don't care
/// about — take it when it is one, never fail the line over it.
fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(serde_json::Value::deserialize(d)?
        .as_str()
        .map(str::to_string))
}

#[derive(Deserialize)]
struct Record {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<Payload>,
}

#[derive(Deserialize)]
struct Payload {
    #[serde(rename = "type")]
    kind: Option<String>,
    // session_meta
    #[serde(default, deserialize_with = "lenient_string")]
    id: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    timestamp: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    cwd: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    parent_thread_id: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    thread_source: Option<String>,
    // event_msg user_message / agent_message
    #[serde(default, deserialize_with = "lenient_string")]
    message: Option<String>,
    // response_item message (and agent_message's mail body)
    #[serde(default, deserialize_with = "lenient_string")]
    role: Option<String>,
    content: Option<Blocks>,
    // event_msg thread_settings_applied
    thread_settings: Option<ThreadSettings>,
    // turn_context
    #[serde(default, deserialize_with = "lenient_string")]
    model: Option<String>,
    // response_item agent_message (inter-agent mail)
    #[serde(default, deserialize_with = "lenient_string")]
    author: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    recipient: Option<String>,
}

#[derive(Deserialize)]
struct ThreadSettings {
    #[serde(default, deserialize_with = "lenient_string")]
    model: Option<String>,
}

/// Whether a user-role text is Codex's own injection rather than something the
/// user typed: the `# AGENTS.md instructions for <dir>` block, or a block that
/// opens with an XML-ish tag (`<environment_context>`, `<user_instructions>`,
/// `<permissions instructions>`, `<task-notification>`, …). The tag shape, not a
/// list of names, so the next injected block Codex adds doesn't become a title.
fn is_injected(text: &str) -> bool {
    let t = text.trim_start();
    if t.starts_with("# AGENTS.md instructions") {
        return true;
    }
    let Some(rest) = t.strip_prefix('<') else {
        return false;
    };
    let Some(tag) = rest.split('>').next() else {
        return false;
    };
    tag.starts_with(|c: char| c.is_ascii_alphabetic())
        && rest.len() > tag.len()
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | ' '))
}

/// The first display line of a user-authored text, skipping what Codex injected.
fn user_line(text: &str) -> Option<String> {
    if is_injected(text) {
        None
    } else {
        one_line(text)
    }
}

/// Epoch ms from an RFC3339 timestamp, when it parses.
fn ts_ms(ts: Option<&str>) -> Option<i64> {
    ts.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|dt| dt.timestamp_millis())
}

// ── The first line: which thread this is, and where it ran ──────────────────

/// A rollout's `session_meta`.
struct Meta {
    thread_id: String,
    cwd: String,
    started_ms: Option<i64>,
    /// The parent thread when this rollout is a subagent's own — those are folded
    /// into their parent's count, never listed.
    parent: Option<String>,
}

/// Cap on one record line. `session_meta` carries the base instructions, so a
/// line can run to tens of KB; nothing legitimate approaches this, and a line
/// past it is never buffered whole (see [`read_meta`], [`parse`]).
const MAX_LINE: u64 = 4 * 1024 * 1024;

fn read_meta(path: &Path) -> Option<Meta> {
    let file = std::fs::File::open(path).ok()?;
    let mut line = Vec::new();
    BufReader::new(file.take(MAX_LINE))
        .read_until(b'\n', &mut line)
        .ok()?;
    // Codex is still writing the first line: no newline yet, nothing to trust.
    if line.last() != Some(&b'\n') {
        return None;
    }
    let rec: Record = serde_json::from_slice(&line).ok()?;
    if rec.kind.as_deref() != Some("session_meta") {
        return None;
    }
    let p = rec.payload?;
    let is_subagent = p.thread_source.as_deref() == Some("subagent");
    Some(Meta {
        thread_id: p.id?,
        cwd: p.cwd?,
        started_ms: ts_ms(p.timestamp.as_deref()).or(ts_ms(rec.timestamp.as_deref())),
        parent: p.parent_thread_id.filter(|_| is_subagent),
    })
}

/// First lines by path. A rollout's `session_meta` never changes once written, so
/// a peek is cached for the process lifetime (pruned to the files still on disk).
static METAS: LazyLock<Mutex<HashMap<PathBuf, Arc<Meta>>>> = LazyLock::new(Default::default);

fn peek(path: &Path) -> Option<Arc<Meta>> {
    if let Some(m) = METAS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        .cloned()
    {
        return Some(m);
    }
    let m = Arc::new(read_meta(path)?);
    METAS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf(), m.clone());
    Some(m)
}

// ── The full parse ──────────────────────────────────────────────────────────

/// Which record supplied the last message — for the test that pins the
/// tie-break, and for anyone debugging a surprising one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LastSource {
    /// The user's own prompt (`user_message` event, or a user-role message).
    UserPrompt,
    /// The assistant's reply (`agent_message` event, or an assistant-role message).
    AssistantMessage,
    /// A `response_item` / `agent_message` addressed to the root agent.
    AgentMail,
}

impl LastSource {
    fn from(self) -> LastMessageFrom {
        match self {
            LastSource::UserPrompt => LastMessageFrom::You,
            LastSource::AssistantMessage | LastSource::AgentMail => LastMessageFrom::Agent,
        }
    }
}

/// The conversation as one path records it: the `event_msg` prompts/replies, or
/// the `response_item` messages. Kept separately during the parse; whichever has
/// prompts wins afterwards (`event_msg` first).
#[derive(Default)]
struct Thread {
    title: Option<String>,
    /// The latest prose from either side, with its timestamp (so a later record
    /// can supersede it) and where it came from.
    last: Option<(i64, String, LastSource)>,
    message_count: u32,
}

impl Thread {
    fn reply(&mut self, ts: Option<i64>, text: String, source: LastSource) {
        // Records are chronological, so "no timestamp" means "at least as late".
        let ts = ts.unwrap_or(i64::MAX);
        if self.last.as_ref().is_none_or(|(prev, _, _)| ts >= *prev) {
            self.last = Some((ts, text, source));
        }
    }
}

/// What a rollout says about its session, before the subagent count is known.
#[derive(Default)]
struct Parsed {
    /// From `event_msg` `user_message` / `agent_message`.
    events: Thread,
    /// From `response_item` `message` (+ `agent_message` mail to the root).
    items: Thread,
    settings_model: Option<String>,
    turn_model: Option<String>,
    started_ms: Option<i64>,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
    /// Agent paths seen in inter-agent mail, other than the root's own.
    agents: HashSet<String>,
    /// `inter_agent_communication_metadata` records — the last-resort count.
    handoffs: u32,
}

/// The root agent's path in inter-agent mail.
const ROOT_AGENT: &str = "/root";

/// Parse a whole rollout, streaming line by line (they run to hundreds of MB).
/// A line that isn't valid JSON, or not UTF-8, contributes nothing.
fn parse(path: &Path) -> Option<Parsed> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut out = Parsed::default();
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = match reader.by_ref().take(MAX_LINE).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => n as u64,
        };
        if line.last() != Some(&b'\n') {
            // Either the cap was hit — an oversized line, dropped without ever
            // being held whole — or this is the trailing partial line Codex is
            // still writing, which ends the parse.
            if n < MAX_LINE || !skip_line(&mut reader) {
                break;
            }
            continue;
        }
        let Ok(rec) = serde_json::from_slice::<Record>(&line) else {
            continue;
        };
        let rec_ms = ts_ms(rec.timestamp.as_deref());
        if let Some(ms) = rec_ms {
            out.first_ms.get_or_insert(ms);
            out.last_ms = Some(out.last_ms.map_or(ms, |cur| cur.max(ms)));
        }
        let Some(p) = rec.payload else {
            if rec.kind.as_deref() == Some("inter_agent_communication_metadata") {
                out.handoffs += 1;
            }
            continue;
        };
        match (rec.kind.as_deref(), p.kind.as_deref()) {
            (Some("session_meta"), _) => {
                if out.started_ms.is_none() {
                    out.started_ms = ts_ms(p.timestamp.as_deref());
                }
            }
            (Some("event_msg"), Some("user_message")) => {
                if let Some(text) = p.message.as_deref().and_then(user_line) {
                    out.events.message_count += 1;
                    out.events.title.get_or_insert(text.clone());
                    out.events.reply(rec_ms, text, LastSource::UserPrompt);
                }
            }
            (Some("event_msg"), Some("agent_message")) => {
                if let Some(text) = p.message.as_deref().and_then(one_line) {
                    out.events.message_count += 1;
                    out.events.reply(rec_ms, text, LastSource::AssistantMessage);
                }
            }
            (Some("response_item"), Some("message")) => {
                let blocks = p.content.map(|c| c.0).unwrap_or_default();
                match p.role.as_deref() {
                    // Injected blocks are dropped one by one, so a prompt that
                    // shares its message with an `<environment_context>` block
                    // still counts.
                    Some("user") => {
                        if let Some(text) = blocks.iter().find_map(|b| user_line(b)) {
                            out.items.message_count += 1;
                            out.items.title.get_or_insert(text.clone());
                            out.items.reply(rec_ms, text, LastSource::UserPrompt);
                        }
                    }
                    Some("assistant") => {
                        if let Some(text) = blocks.iter().find_map(|b| one_line(b)) {
                            out.items.message_count += 1;
                            out.items.reply(rec_ms, text, LastSource::AssistantMessage);
                        }
                    }
                    // developer / system: never the user's words.
                    _ => {}
                }
            }
            (Some("event_msg"), Some("thread_settings_applied")) => {
                if let Some(model) = p.thread_settings.and_then(|s| s.model) {
                    out.settings_model = Some(model);
                }
            }
            (Some("turn_context"), _) => {
                if let Some(model) = p.model {
                    out.turn_model = Some(model);
                }
            }
            (Some("response_item"), Some("agent_message")) => {
                // A child's report to the root is the latest text when the root
                // hasn't replied since; mail the root *sends* is a task brief,
                // not a reply.
                if p.recipient.as_deref() == Some(ROOT_AGENT) {
                    let blocks = p.content.map(|c| c.0).unwrap_or_default();
                    if let Some(text) = blocks.iter().find_map(|b| one_line(b)) {
                        out.items.reply(rec_ms, text, LastSource::AgentMail);
                    }
                }
                for agent in [p.author, p.recipient].into_iter().flatten() {
                    if agent != ROOT_AGENT {
                        out.agents.insert(agent);
                    }
                }
            }
            (Some("inter_agent_communication_metadata"), _) => out.handoffs += 1,
            _ => {}
        }
    }
    Some(out)
}

impl Parsed {
    /// The conversation to show: the `event_msg` prompts when the rollout has
    /// them (interactive CLI sessions), else the `response_item` messages (every
    /// App Server thread — those launches recorded no `event_msg` prompts).
    fn thread(&self) -> &Thread {
        if self.events.message_count > 0 {
            &self.events
        } else {
            &self.items
        }
    }
}

/// Discard the rest of the current line without buffering it. `false` at EOF.
fn skip_line(reader: &mut impl BufRead) -> bool {
    loop {
        let Ok(buf) = reader.fill_buf() else {
            return false;
        };
        if buf.is_empty() {
            return false;
        }
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => {
                reader.consume(i + 1);
                return true;
            }
            None => {
                let len = buf.len();
                reader.consume(len);
            }
        }
    }
}

/// A full parse, tagged with the byte length it was parsed at — rollouts are
/// append-only, so an unchanged length is an unchanged file.
struct ParseEntry {
    len: u64,
    parsed: Arc<Parsed>,
}

/// Entry cap on [`PARSES`]. An entry is a few hundred bytes (two capped lines
/// and a handful of agent paths), so a count bound is enough to keep it honest;
/// the oldest goes first, as in `usage.rs`'s byte-bounded cache.
const MAX_PARSES: usize = 4096;

#[derive(Default)]
struct ParseCache {
    map: HashMap<PathBuf, ParseEntry>,
    order: VecDeque<PathBuf>,
}

impl ParseCache {
    fn get(&self, path: &Path, len: u64) -> Option<Arc<Parsed>> {
        self.map
            .get(path)
            .filter(|e| e.len == len)
            .map(|e| e.parsed.clone())
    }

    fn insert(&mut self, path: PathBuf, len: u64, parsed: Arc<Parsed>) {
        if self
            .map
            .insert(path.clone(), ParseEntry { len, parsed })
            .is_none()
        {
            self.order.push_back(path);
        }
        while self.map.len() > MAX_PARSES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.map.remove(&oldest);
        }
    }

    /// Drop every entry whose file isn't in `live`.
    fn retain_existing(&mut self, live: &HashSet<&PathBuf>) {
        self.map.retain(|p, _| live.contains(p));
        let map = &self.map;
        self.order.retain(|p| map.contains_key(p));
    }
}

static PARSES: LazyLock<Mutex<ParseCache>> = LazyLock::new(Default::default);

fn parse_cached(path: &Path) -> Option<Arc<Parsed>> {
    let len = std::fs::metadata(path).ok()?.len();
    if let Some(parsed) = PARSES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path, len)
    {
        return Some(parsed);
    }
    // The lock is never held across the parse itself.
    let parsed = Arc::new(parse(path)?);
    PARSES.lock().unwrap_or_else(|e| e.into_inner()).insert(
        path.to_path_buf(),
        len,
        parsed.clone(),
    );
    Some(parsed)
}

// ── Per-worktree lookup ─────────────────────────────────────────────────────

/// Summaries of the Codex sessions that ran in `worktree`, keyed by thread id:
/// the `known` threads from the terminal registry (listed on the registry's
/// word, wherever they ran) plus every root rollout whose `cwd` is the worktree
/// or a directory under it, whoever launched it. Subagents' own rollouts are
/// never listed — they count toward their parent. Blocking (disk) — call from
/// `spawn_blocking`.
pub(crate) fn worktree_summaries(
    worktree: &Path,
    known: &[String],
) -> HashMap<String, SessionSummary> {
    match sessions_root() {
        Some(root) => summaries_in(&root, worktree, known),
        None => HashMap::new(),
    }
}

/// Whether `thread_id` still has a rollout under the `sessions` root — i.e.
/// whether `codex resume <thread_id>` has a conversation to open. Answered from
/// each rollout's own `session_meta.id`, never from the file name: a name-shaped
/// guess that missed would silently start a replacement thread and strand the
/// user's history. Blocking (disk) — call from `spawn_blocking`; peeks are
/// process-cached, so repeated checks re-read nothing.
pub(crate) fn rollout_exists_in(root: &Path, thread_id: &str) -> bool {
    let mut paths = Vec::new();
    collect_rollouts(root, 0, &mut paths);
    paths
        .iter()
        .any(|path| peek(path).is_some_and(|meta| meta.thread_id == thread_id))
}

/// [`worktree_summaries`] over an explicit `sessions` root (tests pin it).
fn summaries_in(root: &Path, worktree: &Path, known: &[String]) -> HashMap<String, SessionSummary> {
    let mut paths = Vec::new();
    collect_rollouts(root, 0, &mut paths);

    // One peek per rollout (cached after the first): which are ours, and how
    // many children each root thread has.
    let mut ours: Vec<(PathBuf, Arc<Meta>)> = Vec::new();
    let mut children: HashMap<String, u32> = HashMap::new();
    for p in &paths {
        let Some(meta) = peek(p) else {
            continue;
        };
        if let Some(parent) = &meta.parent {
            *children.entry(parent.clone()).or_default() += 1;
            continue;
        }
        if known.iter().any(|id| *id == meta.thread_id) || cwd_belongs_to(&meta.cwd, worktree) {
            ours.push((p.clone(), meta));
        }
    }

    let live: HashSet<&PathBuf> = paths.iter().collect();
    METAS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|p, _| live.contains(p));
    PARSES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain_existing(&live);

    let mut out = HashMap::new();
    for (path, meta) in ours {
        let Some(parsed) = parse_cached(&path) else {
            continue;
        };
        let spawned = children.get(&meta.thread_id).copied().unwrap_or(0);
        let subagent_count = if spawned > 0 {
            spawned
        } else if !parsed.agents.is_empty() {
            parsed.agents.len() as u32
        } else {
            parsed.handoffs
        };
        let thread = parsed.thread();
        out.insert(
            meta.thread_id.clone(),
            SessionSummary {
                title: thread.title.clone(),
                last_message: thread.last.as_ref().map(|(_, text, _)| text.clone()),
                last_message_from: thread.last.as_ref().map(|(_, _, src)| src.from()),
                message_count: thread.message_count,
                subagent_count,
                model: parsed
                    .settings_model
                    .clone()
                    .or_else(|| parsed.turn_model.clone()),
                started_at_ms: meta.started_ms.or(parsed.started_ms).or(parsed.first_ms),
                last_activity_ms: parsed.last_ms,
            },
        );
    }
    out
}

// ── Subscription usage, from Codex's own record of it ───────────────────────

/// How many of the newest rollouts are searched for a snapshot. A turn that ran
/// at all writes one, so the newest rollout almost always answers; the rest cover
/// the case where the last thing the user opened was a session that never got a
/// reply (a `codex resume` they closed again).
const RATE_LIMIT_ROLLOUTS: usize = 5;

/// How much of a rollout's tail is read looking for its last `token_count`.
/// Snapshots are written every turn, so the last one is always near the end;
/// this only has to clear the largest single record that can sit after it.
const RATE_LIMIT_TAIL: u64 = 1024 * 1024;

/// The rate-limit snapshot Codex itself recorded on the most recent turn it ran.
///
/// This is the *only* source santree has for Codex subscription usage that needs
/// neither a control plane nor the vendor's credentials. Codex writes a
/// `token_count` event to its rollout after every turn, and that event carries
/// the rate-limit windows the API returned. Reading it back is the same
/// display-only transcript read `worktree_summaries` already does (COMPLIANCE.md,
/// "Transcript reads") — nothing here is ever fed to a session.
///
/// The honest limitation, which the UI must not dress up: it is as fresh as the
/// user's last Codex turn. The live answer lives behind the account API, and the
/// only keys to that are the ones Codex owns.
///
/// Empty when Codex has never run, or when the plan reports no windows at all —
/// a usage-based enterprise plan legitimately answers `primary: null`.
/// Blocking (disk) — call from `spawn_blocking`.
pub(crate) fn latest_rate_limits() -> CodexRateLimits {
    sessions_root()
        .map(|root| latest_rate_limits_in(&root))
        .unwrap_or_default()
}

/// [`latest_rate_limits`] over an explicit `sessions` root (tests pin it).
fn latest_rate_limits_in(root: &Path) -> CodexRateLimits {
    let mut paths = Vec::new();
    collect_rollouts(root, 0, &mut paths);
    // Newest first by mtime, not by the timestamp in the file name: a resumed
    // thread keeps its original name and is still where the fresh snapshot is.
    let mut dated: Vec<(std::time::SystemTime, PathBuf)> = paths
        .into_iter()
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    dated.sort_unstable_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    dated
        .iter()
        .take(RATE_LIMIT_ROLLOUTS)
        .find_map(|(_, path)| last_rate_limits(path))
        .unwrap_or_default()
}

/// How much of a rollout's tail [`last_activity_ms`] reads. Far smaller than
/// [`RATE_LIMIT_TAIL`]: the answer is the timestamp on the *last* parseable
/// record, so this only has to be wide enough to contain one whole record, and it
/// runs per unsettled session on a ~10s poll.
const ACTIVITY_TAIL: u64 = 64 * 1024;

/// Epoch ms of the newest activity in a Codex rollout — the direct analogue of
/// `hooks.rs`'s `main_activity_ms` for a Claude transcript, and the reason a
/// Codex session used to get no liveness reconciliation at all.
///
/// The two file formats have nothing in common: a Claude transcript's records are
/// `type: "assistant" | "user"`, while a rollout's are `session_meta` /
/// `event_msg` / `response_item` / `turn_context`. Reading a rollout with the
/// Claude parser matches nothing and returns `None`, which the reconciler takes
/// as "no evidence" — so every Codex session kept whatever state its last hook
/// wrote, indefinitely.
///
/// `session_meta` is excluded because it is the *first* record, written once at
/// thread start: counting it would make a thread that has done nothing since it
/// opened look freshly active. Everything else in a rollout is written as the
/// turn advances, so the newest of them is when the agent last did something.
///
/// The record's own `timestamp` is used, never the file's mtime — a rollout is
/// appended to by Codex alone, but mtime also moves for reasons that are not a
/// turn (a copy, a backup tool), and the in-file timestamp cannot lie about that.
pub(crate) fn last_activity_ms(path: &Path) -> Option<i64> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(std::io::SeekFrom::Start(len.saturating_sub(ACTIVITY_TAIL)))
        .ok()?;
    let mut tail = Vec::new();
    file.take(ACTIVITY_TAIL).read_to_end(&mut tail).ok()?;

    // Backwards, so the first hit is the newest. A partial first line (the seek
    // lands mid-record on any file longer than the tail) just fails to parse.
    tail.rsplit(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Record>(line).ok())
        .find_map(|record| {
            (record.kind.as_deref() != Some("session_meta"))
                .then(|| ts_ms(record.timestamp.as_deref()))
                .flatten()
        })
}

/// The last `token_count` snapshot in one rollout's tail, or `None` when it has
/// none. Only the tail is read: a long session's rollout runs to megabytes, and
/// this is on a polled query.
fn last_rate_limits(path: &Path) -> Option<CodexRateLimits> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(RATE_LIMIT_TAIL);
    file.seek(std::io::SeekFrom::Start(from)).ok()?;
    let mut tail = Vec::new();
    file.take(RATE_LIMIT_TAIL).read_to_end(&mut tail).ok()?;

    // Scanning backwards, the first hit is the newest. A partial first line
    // (the seek lands mid-record whenever the file is longer than the tail)
    // simply fails to parse, so it needs no special case.
    tail.rsplit(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<RateRecord>(line).ok())
        .find_map(|record| {
            let payload = record.payload?;
            if payload.kind.as_deref() != Some("token_count") {
                return None;
            }
            let limits = payload.rate_limits?;
            let snapshot = CodexRateLimits {
                plan: limits.plan_type,
                primary: limits.primary.map(Into::into),
                secondary: limits.secondary.map(Into::into),
            };
            // An event with the key present but nothing in it says nothing;
            // keep looking rather than reporting a blank as an answer.
            (snapshot != CodexRateLimits::default()).then_some(snapshot)
        })
}

#[derive(Deserialize)]
struct RateRecord {
    payload: Option<RatePayload>,
}

#[derive(Deserialize)]
struct RatePayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    rate_limits: Option<RateLimitsWire>,
}

#[derive(Deserialize)]
struct RateLimitsWire {
    #[serde(default, deserialize_with = "lenient_string")]
    plan_type: Option<String>,
    #[serde(default)]
    primary: Option<RateWindowWire>,
    #[serde(default)]
    secondary: Option<RateWindowWire>,
}

#[derive(Deserialize)]
struct RateWindowWire {
    #[serde(default)]
    used_percent: Option<f64>,
    #[serde(default)]
    window_minutes: Option<f64>,
    /// Epoch seconds on the wire today. Taken leniently because the same field
    /// has shipped as an RFC3339 string elsewhere in Codex's own payloads, and a
    /// stricter parse would drop the whole snapshot over the reset time.
    #[serde(default)]
    resets_at: Option<serde_json::Value>,
}

impl From<RateWindowWire> for CodexRateLimitWindow {
    fn from(window: RateWindowWire) -> Self {
        Self {
            used_percent: window.used_percent.unwrap_or_default(),
            window_minutes: window.window_minutes,
            resets_at: window.resets_at.as_ref().and_then(lenient_epoch),
        }
    }
}

/// A number as itself, an RFC3339 string as epoch milliseconds. The frontend
/// already tells seconds from milliseconds by scale, so both land correctly.
fn lenient_epoch(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| ts_ms(value.as_str()).map(|ms| ms as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta_line(id: &str, cwd: &str, ts: &str, subagent_of: Option<&str>) -> String {
        let source = match subagent_of {
            Some(parent) => format!(
                r#","parent_thread_id":"{parent}","thread_source":"subagent","agent_path":"/root/helper""#
            ),
            None => r#","thread_source":"cli""#.to_string(),
        };
        format!(
            r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{id}","session_id":"{id}","timestamp":"{ts}","cwd":"{cwd}","originator":"codex-tui","cli_version":"0.149.1"{source}}}}}"#
        )
    }

    fn event(ts: &str, kind: &str, message: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"{kind}","message":"{message}"}}}}"#
        )
    }

    #[test]
    fn rollout_summary_reads_prompts_replies_model_and_timestamps() {
        let dir =
            std::env::temp_dir().join(format!("santree-codex-rollouts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sessions = dir.join("sessions");
        let day = sessions.join("2026").join("08").join("27");
        std::fs::create_dir_all(&day).unwrap();
        let wt = dir
            .join("repo")
            .join(".santree")
            .join("worktrees")
            .join("AK-1");
        let wt_str = wt.to_string_lossy().into_owned();
        let long = "y".repeat(300);

        // The root thread: a developer prompt first (not a title), then the
        // user's prompt, replies, settings, a turn context whose model must not
        // win, inter-agent mail to one child, and a garbage line.
        let root = [
            meta_line("root-1", &wt_str, "2026-08-27T10:00:00.000Z", None),
            r#"{"timestamp":"2026-08-27T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are a careful engineer."}]}}"#.to_string(),
            r#"{"timestamp":"2026-08-27T10:00:01.500Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"AGENTS.md instructions"}]}}"#.to_string(),
            event(
                "2026-08-27T10:00:01.800Z",
                "user_message",
                "<environment_context>\\n  <cwd>/x</cwd>\\n</environment_context>",
            ),
            event("2026-08-27T10:00:02.000Z", "user_message", "  Fix the build \\nplease"),
            event("2026-08-27T10:00:03.000Z", "agent_message", "On it."),
            r#"{"timestamp":"2026-08-27T10:00:04.000Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"/x","model":"gpt-5"}}"#.to_string(),
            r#"{"timestamp":"2026-08-27T10:00:05.000Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.6-sol","approval_policy":"on-request"}}}"#.to_string(),
            r#"{"timestamp":"2026-08-27T10:00:06.000Z","type":"response_item","payload":{"type":"reasoning","encrypted_content":"opaque"}}"#.to_string(),
            r#"{"timestamp":"2026-08-27T10:00:07.000Z","type":"response_item","payload":{"type":"agent_message","author":"/root","recipient":"/root/helper","content":[{"type":"input_text","text":"go"}]}}"#.to_string(),
            r#"{"timestamp":"2026-08-27T10:00:08.000Z","type":"inter_agent_communication_metadata","payload":{"trigger_turn":true}}"#.to_string(),
            event("2026-08-27T10:00:09.000Z", "user_message", "thanks"),
            event("2026-08-27T10:01:00.000Z", "agent_message", &long),
            "not json".to_string(),
        ]
        .join("\n")
            + "\n";
        std::fs::write(day.join("rollout-2026-08-27T10-00-00-root-1.jsonl"), root).unwrap();
        // The child's own rollout: folded into the parent, never listed.
        std::fs::write(
            day.join("rollout-2026-08-27T10-00-07-child-1.jsonl"),
            meta_line(
                "child-1",
                &wt_str,
                "2026-08-27T10:00:07.000Z",
                Some("root-1"),
            ) + "\n",
        )
        .unwrap();
        // A thread from another directory: not ours.
        std::fs::write(
            day.join("rollout-2026-08-27T11-00-00-other-1.jsonl"),
            meta_line(
                "other-1",
                &format!("{wt_str}-old"),
                "2026-08-27T11:00:00.000Z",
                None,
            ) + "\n",
        )
        .unwrap();
        // A thread santree launched elsewhere but registered to this worktree.
        std::fs::write(
            day.join("rollout-2026-08-27T12-00-00-reg-1.jsonl"),
            meta_line("reg-1", "/elsewhere", "2026-08-27T12:00:00.000Z", None) + "\n",
        )
        .unwrap();

        let got = summaries_in(&sessions, &wt, &["reg-1".to_string()]);
        let mut ids: Vec<&str> = got.keys().map(String::as_str).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["reg-1", "root-1"]);

        let s = &got["root-1"];
        assert_eq!(s.title.as_deref(), Some("Fix the build"));
        let last = s.last_message.as_deref().unwrap();
        assert_eq!(last.chars().count(), 120);
        assert!(last.ends_with('…'));
        assert_eq!(s.last_message_from, Some(LastMessageFrom::Agent));
        assert_eq!(
            s.message_count, 4,
            "two prompts + two replies; the injected context block is neither"
        );
        assert_eq!(
            s.model.as_deref(),
            Some("gpt-5.6-sol"),
            "thread settings beat the turn context"
        );
        assert_eq!(s.subagent_count, 1, "the child's rollout");
        assert_eq!(
            s.started_at_ms,
            ts_ms(Some("2026-08-27T10:00:00.000Z")),
            "session_meta's own timestamp"
        );
        assert_eq!(s.last_activity_ms, ts_ms(Some("2026-08-27T10:01:00.000Z")));

        let r = &got["reg-1"];
        assert_eq!(r.title, None);
        assert_eq!(r.last_message_from, None, "no prose, no author");
        assert_eq!(r.message_count, 0);

        // A thread that ended on the user's prompt (event path): "You:".
        std::fs::write(
            day.join("rollout-2026-08-27T13-00-00-you-1.jsonl"),
            [
                meta_line("you-1", &wt_str, "2026-08-27T13:00:00.000Z", None),
                event("2026-08-27T13:00:01.000Z", "user_message", "first"),
                event("2026-08-27T13:00:02.000Z", "agent_message", "reply"),
                event("2026-08-27T13:00:03.000Z", "user_message", "and then this"),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        let got = summaries_in(&sessions, &wt, &[]);
        let y = &got["you-1"];
        assert_eq!(y.last_message.as_deref(), Some("and then this"));
        assert_eq!(y.last_message_from, Some(LastMessageFrom::You));
        assert_eq!(y.message_count, 3);
        assert_eq!(r.started_at_ms, ts_ms(Some("2026-08-27T12:00:00.000Z")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn item(ts: &str, role: &str, blocks: &[(&str, &str)]) -> String {
        let content: Vec<String> = blocks
            .iter()
            .map(|(kind, text)| format!(r#"{{"type":"{kind}","text":"{text}"}}"#))
            .collect();
        format!(
            r#"{{"timestamp":"{ts}","type":"response_item","payload":{{"type":"message","role":"{role}","content":[{}]}}}}"#,
            content.join(",")
        )
    }

    /// An App Server thread (what santree used to launch) records no `event_msg`
    /// prompts at all: the conversation is only in `response_item` messages,
    /// where Codex's own injected user text precedes the real prompt.
    #[test]
    fn rollout_summary_falls_back_to_response_items_and_skips_injected_text() {
        let dir = std::env::temp_dir().join(format!(
            "santree-codex-rollouts-items-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let sessions = dir.join("sessions");
        let day = sessions.join("2026").join("08").join("27");
        std::fs::create_dir_all(&day).unwrap();
        let wt = dir.join("wt");
        let wt_str = wt.to_string_lossy().into_owned();

        let lines = [
            meta_line("app-1", &wt_str, "2026-08-27T10:00:00.000Z", None),
            item(
                "2026-08-27T10:00:01.000Z",
                "developer",
                &[("input_text", "You are a careful engineer.")],
            ),
            // Codex's injection: AGENTS.md + environment context in one message.
            item(
                "2026-08-27T10:00:02.000Z",
                "user",
                &[
                    ("input_text", "# AGENTS.md instructions for /Users/me/repo\\n\\n<INSTRUCTIONS>\\nbe good\\n</INSTRUCTIONS>"),
                    ("input_text", "<environment_context>\\n  <cwd>/Users/me/repo</cwd>\\n</environment_context>"),
                ],
            ),
            item(
                "2026-08-27T10:00:03.000Z",
                "user",
                &[("input_text", "Collapse the seven tabs into one window")],
            ),
            item(
                "2026-08-27T10:00:04.000Z",
                "assistant",
                &[("output_text", "Starting with the shell.")],
            ),
            // A child's report to the root, then the root's own later reply.
            r#"{"timestamp":"2026-08-27T10:00:05.000Z","type":"response_item","payload":{"type":"agent_message","author":"/root/auditor","recipient":"/root","content":[{"type":"input_text","text":"Message Type: FINAL_ANSWER\nAll clear."}]}}"#.to_string(),
            // A re-sent context block on resume: injected, not a prompt.
            item(
                "2026-08-27T10:00:06.000Z",
                "user",
                &[("input_text", "<environment_context>\\n  <current_date>2026-08-27</current_date>\\n</environment_context>")],
            ),
            // A prompt sharing its message with an injected block still counts.
            item(
                "2026-08-27T10:00:07.000Z",
                "user",
                &[
                    ("input_text", "<task-notification>\\n<task-id>x</task-id>\\n</task-notification>"),
                    ("input_text", "and the status bar too"),
                ],
            ),
            item(
                "2026-08-27T10:00:08.000Z",
                "assistant",
                &[("output_text", "Done: one window, one status bar.")],
            ),
        ];
        std::fs::write(
            day.join("rollout-2026-08-27T10-00-00-app-1.jsonl"),
            lines.join(
                "
",
            ) + "
",
        )
        .unwrap();

        let got = summaries_in(&sessions, &wt, &[]);
        let s = &got["app-1"];
        assert_eq!(
            s.title.as_deref(),
            Some("Collapse the seven tabs into one window"),
            "the first prompt the user typed, not Codex's injection"
        );
        assert_eq!(
            s.last_message.as_deref(),
            Some("Done: one window, one status bar."),
            "the later assistant message beats the child's earlier report"
        );
        assert_eq!(
            s.message_count, 4,
            "two real prompts + two replies; developer and injected text excluded"
        );
        assert_eq!(s.last_message_from, Some(LastMessageFrom::Agent));

        // The same thread cut before the final reply ends on the user's prompt
        // (response_item path): "You:".
        let mut cut = lines[..8].to_vec();
        cut[0] = meta_line("app-3", &wt_str, "2026-08-27T10:00:00.000Z", None);
        std::fs::write(
            day.join("rollout-2026-08-27T10-00-00-app-3.jsonl"),
            cut.join("\n") + "\n",
        )
        .unwrap();
        let got = summaries_in(&sessions, &wt, &[]);
        let y = &got["app-3"];
        assert_eq!(y.last_message.as_deref(), Some("and the status bar too"));
        assert_eq!(y.last_message_from, Some(LastMessageFrom::You));

        // The tie-break is by timestamp: with no assistant reply after the
        // child's report, that report is the last message.
        let parsed = parse(&day.join("rollout-2026-08-27T10-00-00-app-1.jsonl")).unwrap();
        assert_eq!(
            parsed.items.last.as_ref().map(|(_, _, src)| *src),
            Some(LastSource::AssistantMessage)
        );
        let truncated: Vec<&String> = lines.iter().take(6).collect();
        let p = day.join("rollout-2026-08-27T10-00-00-app-2.jsonl");
        std::fs::write(
            &p,
            truncated
                .iter()
                .map(|l| l.as_str())
                .collect::<Vec<_>>()
                .join(
                    "
",
                )
                + "
",
        )
        .unwrap();
        let parsed = parse(&p).unwrap();
        assert_eq!(
            parsed
                .items
                .last
                .as_ref()
                .map(|(_, t, src)| (t.as_str(), *src)),
            Some(("Message Type: FINAL_ANSWER", LastSource::AgentMail))
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_drops_an_oversized_line_and_keeps_going() {
        let dir =
            std::env::temp_dir().join(format!("santree-codex-rollouts-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("rollout-big.jsonl");
        // A record past the cap (no newline within MAX_LINE bytes), between two
        // real ones — the reply after it must still be read.
        let huge = format!(
            r#"{{"timestamp":"2026-08-27T10:00:01.000Z","type":"response_item","payload":{{"type":"custom_tool_call_output","output":"{}"}}}}"#,
            "z".repeat(MAX_LINE as usize + 16)
        );
        let content = [
            meta_line("t", "/wt", "2026-08-27T10:00:00.000Z", None),
            event("2026-08-27T10:00:00.500Z", "user_message", "hi"),
            huge,
            event(
                "2026-08-27T10:00:02.000Z",
                "agent_message",
                "after the big one",
            ),
        ]
        .join("\n")
            + "\n";
        std::fs::write(&p, content).unwrap();
        let parsed = parse(&p).unwrap();
        assert_eq!(parsed.events.title.as_deref(), Some("hi"));
        assert_eq!(
            parsed.events.last.as_ref().map(|(_, t, _)| t.as_str()),
            Some("after the big one")
        );
        assert_eq!(parsed.last_ms, ts_ms(Some("2026-08-27T10:00:02.000Z")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn injected_text_is_the_agents_block_or_an_opening_tag() {
        assert!(is_injected(
            "# AGENTS.md instructions for /Users/me/repo\n\n<INSTRUCTIONS>"
        ));
        assert!(is_injected("<environment_context>\n  <cwd>/x</cwd>"));
        assert!(is_injected("  <user_instructions>\nhi"));
        assert!(is_injected(
            "<permissions instructions>\n</permissions instructions>"
        ));
        assert!(is_injected("<task-notification>\n<task-id>a</task-id>"));
        assert!(!is_injected("Fix the build"));
        assert!(!is_injected("<3 this feature, ship it"));
        assert!(!is_injected("< 5 lines please"));
        assert!(!is_injected("<unterminated tag"));
        assert!(!is_injected("# AGENTS.md is out of date, rewrite it"));
    }

    #[test]
    fn peek_ignores_a_half_written_first_line() {
        let dir = std::env::temp_dir().join(format!(
            "santree-codex-rollouts-peek-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("rollout-partial.jsonl");
        let line = meta_line("t", "/wt", "2026-08-27T10:00:00.000Z", None);
        std::fs::write(&p, &line[..line.len() / 2]).unwrap();
        assert!(read_meta(&p).is_none(), "no newline yet: nothing to trust");
        std::fs::write(&p, line + "\n").unwrap();
        let m = read_meta(&p).unwrap();
        assert_eq!((m.thread_id.as_str(), m.cwd.as_str()), ("t", "/wt"));
        assert!(m.parent.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The resume gate `session.rs` asks before offering a stored thread id. It
    /// answers from `session_meta.id`, so a rollout whose *file name* happens to
    /// carry another id still counts for the thread it actually holds — a name
    /// match that missed would silently start a replacement thread and strand the
    /// user's history.
    #[test]
    fn rollout_exists_answers_from_the_recorded_thread_id() {
        let dir = std::env::temp_dir().join(format!(
            "santree-codex-rollouts-exists-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let sessions = dir.join("sessions");
        let day = sessions.join("2026").join("08").join("28");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            // A renamed file: the id in the name is not the id in the record.
            day.join("rollout-2026-08-28T10-00-00-copied-name.jsonl"),
            meta_line("thread-live", "/wt", "2026-08-28T10:00:00.000Z", None) + "\n",
        )
        .unwrap();

        assert!(rollout_exists_in(&sessions, "thread-live"));
        assert!(!rollout_exists_in(&sessions, "copied-name"));
        assert!(!rollout_exists_in(&sessions, "thread-pruned"));
        // A root that was never created is simply "nothing resumable".
        assert!(!rollout_exists_in(&dir.join("missing"), "thread-live"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// santree's whole source for Codex subscription usage since the App Server
    /// was removed. Three properties, each of which was a real way to get it
    /// wrong: the *newest* rollout wins, the *last* snapshot inside it wins, and
    /// a `token_count` that carries an empty `rate_limits` is not an answer —
    /// reporting it would paint every meter 0% used.
    #[test]
    fn rate_limits_come_from_the_newest_snapshot_codex_actually_wrote() {
        let dir = std::env::temp_dir().join(format!(
            "santree-codex-rollouts-limits-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let sessions = dir.join("sessions");
        let day = sessions.join("2026").join("08").join("28");
        std::fs::create_dir_all(&day).unwrap();

        let snapshot = |used: f64, plan: &str| {
            format!(
                r#"{{"timestamp":"2026-08-28T10:00:00.000Z","type":"event_msg","payload":{{"type":"token_count","info":{{"model_context_window":258400}},"rate_limits":{{"limit_id":"codex","primary":{{"used_percent":{used},"window_minutes":300,"resets_at":1790000000}},"secondary":null,"plan_type":"{plan}"}}}}}}"#
            )
        };
        let older = [
            meta_line("older", "/wt", "2026-08-28T09:00:00.000Z", None),
            snapshot(99.0, "stale"),
        ]
        .join("\n")
            + "\n";
        std::fs::write(day.join("rollout-2026-08-28T09-00-00-older.jsonl"), older).unwrap();

        let newer = [
            meta_line("newer", "/wt", "2026-08-28T10:00:00.000Z", None),
            snapshot(12.5, "pro"),
            // A later turn: this is the one that must win.
            snapshot(41.0, "pro"),
            // …and a trailing event with nothing in it, which must not shadow it.
            r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":null,"secondary":null,"plan_type":null}}}"#.to_string(),
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}"#
                .to_string(),
        ]
        .join("\n")
            + "\n";
        let newer_path = day.join("rollout-2026-08-28T10-00-00-newer.jsonl");
        std::fs::write(&newer_path, newer).unwrap();
        // mtime, not file name, is what orders them — and the fixtures are
        // written milliseconds apart, so say it explicitly.
        let touch = |path: &Path, secs: u64| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs)),
                )
                .unwrap();
        };
        touch(&newer_path, 2_000_000);
        touch(
            &day.join("rollout-2026-08-28T09-00-00-older.jsonl"),
            1_000_000,
        );

        let limits = latest_rate_limits_in(&sessions);
        assert_eq!(limits.plan.as_deref(), Some("pro"));
        let primary = limits.primary.expect("the newest snapshot has a window");
        assert_eq!(primary.used_percent, 41.0);
        assert_eq!(primary.window_minutes, Some(300.0));
        assert_eq!(primary.resets_at, Some(1_790_000_000.0));
        assert!(limits.secondary.is_none());

        // A machine that has never run Codex answers empty, not an error.
        assert_eq!(
            latest_rate_limits_in(&dir.join("missing")),
            CodexRateLimits::default()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
