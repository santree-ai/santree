//! Claude Code token-usage aggregation.
//!
//! Claude Code append-writes every session to a JSON-Lines transcript under
//! `<config>/projects/<cwd-slug>/<sessionId>.jsonl` (subagent runs land in a
//! `<sessionId>/subagents/*.jsonl` subtree). Each `assistant` line carries a
//! `message.usage` block with the four token classes and a `message.model`, and
//! every line carries the session's real `cwd`. This module walks those files,
//! sums the tokens (deduping turns that recur across a resumed session), derives
//! an approximate cost from the static price table, and reports per-period /
//! per-model / per-session totals plus each session's current context-window fill
//! — the "how much before compaction" number.
//!
//! The parsing follows `ccusage`'s model (verified against it — matches to within
//! live-write noise): dedup on `(message.id, requestId)`, scan both the XDG and
//! `~/.claude` config roots, split 5-minute vs 1-hour cache-creation for pricing.
//! It's read-only apart from the live-refresh watcher at the bottom (which mirrors
//! `git_watch.rs`): a debounced recursive watch emits [`UsageChanged`] so the
//! frontend refetches without polling.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use santree_core::domain::{ModelUsage, SessionUsage, UsageReport, UsageTotals};

use crate::pricing::PriceTable;

/// Fallback context-window limits, used only for a model absent from the price
/// table: default to 200K, or 1M once the observed context has exceeded 200K
/// (proving the model runs a larger window). Known models get their real limit
/// from the price table's `context` (from LiteLLM `max_input_tokens`) instead.
const DEFAULT_CONTEXT_LIMIT: f64 = 200_000.0;
const LARGE_CONTEXT_LIMIT: f64 = 1_000_000.0;

/// 1-hour cache-creation is billed at 2× the model's base input rate (5-minute
/// cache-creation uses the model's stored `cache_write` rate, 1.25× input).
const CACHE_CREATE_1H_INPUT_MULTIPLIER: f64 = 2.0;

/// Cap on the number of session rows returned (newest first) — the panel shows a
/// recent-sessions list, not an unbounded history.
const MAX_SESSIONS: usize = 50;

/// The `projects` transcript roots to scan. Follows Claude Code / ccusage: the
/// `CLAUDE_CONFIG_DIR` override (comma-separated) wins outright; otherwise both
/// `$XDG_CONFIG_HOME/claude` (or `~/.config/claude`) and `~/.claude` are scanned.
/// Only existing dirs are returned, deduped.
fn projects_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(cfg) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        for part in cfg.to_string_lossy().split(',') {
            let p = part.trim();
            if !p.is_empty() {
                add_projects_dir(&mut roots, PathBuf::from(p));
            }
        }
        return roots; // env override is authoritative — no default fallback
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        add_projects_dir(&mut roots, PathBuf::from(xdg).join("claude"));
    } else if let Some(home) = std::env::var_os("HOME") {
        add_projects_dir(
            &mut roots,
            PathBuf::from(&home).join(".config").join("claude"),
        );
    }
    if let Some(home) = std::env::var_os("HOME") {
        add_projects_dir(&mut roots, PathBuf::from(home).join(".claude"));
    }
    roots
}

/// Push `<dir>/projects` (or `dir` itself when it already ends in `projects`) if
/// it's a real directory and not already present.
fn add_projects_dir(roots: &mut Vec<PathBuf>, dir: PathBuf) {
    let projects = if dir.file_name().and_then(|n| n.to_str()) == Some("projects") {
        dir
    } else {
        dir.join("projects")
    };
    if projects.is_dir() && !roots.contains(&projects) {
        roots.push(projects);
    }
}

// ── Transcript line shapes (parse only what we need) ────────────────────────

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    /// The session's working directory — the same on every line; the lossless
    /// source for the display project name (better than de-slugging the path).
    cwd: Option<String>,
    message: Option<Msg>,
}

#[derive(Deserialize)]
struct Msg {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    /// The 5m/1h split of `cache_creation_input_tokens`, when present. Absent on
    /// older transcripts — then all cache creation is treated as 5-minute.
    cache_creation: Option<CacheCreation>,
}

#[derive(Deserialize)]
struct CacheCreation {
    #[serde(default)]
    ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    ephemeral_1h_input_tokens: u64,
}

// ── Parsed, cached per-file data ────────────────────────────────────────────

/// The token classes for one turn — cache creation kept split by TTL because the
/// two are priced differently (1h at 2× input, 5m at the model's cache rate).
#[derive(Clone, Copy)]
struct Toks {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_5m: f64,
    cache_1h: f64,
}

impl Toks {
    /// All cache-creation tokens (both TTLs), for display totals.
    fn cache_write(&self) -> f64 {
        self.cache_5m + self.cache_1h
    }
}

/// One billable turn (an `assistant` line with a `usage`).
#[derive(Clone)]
struct Ev {
    /// `message.id` — the dedup anchor. Turns without one are never deduped.
    id: Option<String>,
    request_id: Option<String>,
    model: String,
    ts_ms: i64,
    toks: Toks,
}

/// The most recent turn's context size (only meaningful for a *main* transcript).
#[derive(Clone)]
struct Ctx {
    tokens: f64,
    ts_ms: i64,
    model: String,
}

/// Everything we need from one transcript file, cached keyed by byte length.
struct FileData {
    /// The cwd-slug directory the transcript lives under (the grouping key).
    project: String,
    /// The session's real working directory, from the transcript's `cwd` — the
    /// display name source. `None` only for transcripts predating the field.
    cwd: Option<String>,
    /// The owning session id — the file stem for a main transcript, or the parent
    /// session's id for a `subagents/` file (so subagent spend folds into it).
    session_id: String,
    events: Vec<Ev>,
    /// Present only for a main transcript: its last turn's context fill.
    context: Option<Ctx>,
}

/// Classify a transcript path into `(project-slug, owning-session-id, is_main)`,
/// anchored on the `projects` path component so it works for any config root.
/// `…/projects/<slug>/<sid>.jsonl` is a main session; `…/<sid>/subagents/…`
/// folds into `<sid>`.
fn classify(path: &Path) -> Option<(String, String, bool)> {
    let comps: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    let anchor = comps.iter().rposition(|c| *c == "projects")?;
    let rest = &comps[anchor + 1..];
    if rest.len() < 2 {
        return None;
    }
    let project = rest[0].to_string();
    if rest.len() == 2 {
        let sid = Path::new(rest[1]).file_stem()?.to_str()?.to_string();
        return Some((project, sid, true));
    }
    if let Some(pos) = rest.iter().position(|c| *c == "subagents") {
        if pos >= 1 {
            return Some((project, rest[pos - 1].to_string(), false));
        }
    }
    Some((project, rest[1].to_string(), false))
}

/// Epoch ms from an RFC3339 timestamp; 0 when absent/unparseable.
fn parse_ts(ts: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

/// Parse one transcript file into its [`FileData`]. `None` if it can't be
/// classified or read.
fn parse_file(path: &Path) -> Option<Parsed> {
    parse_from(path, 0, None)
}

/// A parse of a transcript, plus the byte offset it consumed up to — the end of
/// the last *complete* line. A trailing partial line (Claude mid-write) is left
/// unconsumed so the next poll re-reads it whole.
struct Parsed {
    data: FileData,
    consumed: u64,
}

/// Read a transcript from byte offset `from` and fold what's there into `base`
/// (the parse of the first `from` bytes; `None` = parse the whole file).
///
/// Transcripts are append-only and the active one is re-read every poll (~2s
/// while the panel is open) as the agent writes to it — at tens to hundreds of
/// MB, re-reading and re-parsing the whole file each time is the single most
/// expensive thing this module does. Resuming from the previous parse's offset
/// means each poll only touches the bytes the agent actually appended.
///
/// Read as bytes, not `read_to_string`: resuming mid-file can land on a line
/// Claude is still writing, whose tail may be a truncated multi-byte char —
/// lossy decoding keeps that confined to the partial line we're discarding
/// anyway, where strict UTF-8 would fail the whole read.
fn parse_from(path: &Path, from: u64, base: Option<&FileData>) -> Option<Parsed> {
    use std::io::{Read, Seek, SeekFrom};

    let (project, session_id, is_main) = classify(path)?;
    let mut file = std::fs::File::open(path).ok()?;
    if from > 0 {
        file.seek(SeekFrom::Start(from)).ok()?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    // Only whole lines are parseable; anything after the final newline is a
    // half-written line, so leave it for the next poll.
    let complete = buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let consumed = from + complete as u64;
    let text = String::from_utf8_lossy(&buf[..complete]);

    let (mut events, mut context, mut cwd) = match base {
        Some(b) => (b.events.clone(), b.context.clone(), b.cwd.clone()),
        None => (Vec::new(), None, None),
    };
    for line in text.lines() {
        let Ok(l) = serde_json::from_str::<Line>(line) else {
            continue; // partial/metadata line
        };
        if cwd.is_none() {
            cwd = l.cwd;
        }
        if l.kind.as_deref() != Some("assistant") {
            continue;
        }
        let Some(msg) = l.message else { continue };
        let Some(u) = msg.usage else { continue };
        let model = msg.model.unwrap_or_default();
        // Claude's placeholder model for internally-generated turns — count nothing.
        if model == "<synthetic>" {
            continue;
        }
        let ts_ms = l.timestamp.as_deref().map(parse_ts).unwrap_or(0);
        // Split cache creation by TTL; fall back to "all 5-minute" when the
        // breakdown is absent (older transcripts).
        let (cache_5m, cache_1h) = match &u.cache_creation {
            Some(b) => (
                b.ephemeral_5m_input_tokens as f64,
                b.ephemeral_1h_input_tokens as f64,
            ),
            None => (u.cache_creation_input_tokens as f64, 0.0),
        };
        let toks = Toks {
            input: u.input_tokens as f64,
            output: u.output_tokens as f64,
            cache_read: u.cache_read_input_tokens as f64,
            cache_5m,
            cache_1h,
        };
        // The current context is what was sent on the *last* turn: prompt input
        // plus everything read from / written to cache. Overwritten each turn, so
        // it ends holding the final turn's fill.
        if is_main {
            context = Some(Ctx {
                tokens: toks.input + toks.cache_read + toks.cache_write(),
                ts_ms,
                model: model.clone(),
            });
        }
        events.push(Ev {
            id: msg.id,
            request_id: l.request_id,
            model,
            ts_ms,
            toks,
        });
    }
    Some(Parsed {
        data: FileData {
            project,
            cwd,
            session_id,
            events,
            context,
        },
        consumed,
    })
}

// ── Per-file cache (skip re-parsing unchanged transcripts) ──────────────────

/// Byte budget for the parsed-transcript cache. Bounded, because the alternative
/// grows with every session the user has ever run: a heavy month of transcripts
/// is hundreds of MB of parsed events. Same idiom as the Linear image cache — a
/// count cap wouldn't bound anything, since one file's events can be arbitrarily
/// many.
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;

/// Rough heap footprint of a parsed transcript. The event vector dominates (each
/// event carries a message id, a request id and a model name), and this only has
/// to keep the cache's budget honest — not be exact.
fn approx_bytes(fd: &FileData) -> usize {
    let opt = |s: &Option<String>| s.as_ref().map_or(0, String::len);
    let events: usize = fd
        .events
        .iter()
        .map(|e| std::mem::size_of::<Ev>() + opt(&e.id) + opt(&e.request_id) + e.model.len())
        .sum();
    events + fd.project.len() + opt(&fd.cwd) + fd.session_id.len()
}

struct Entry {
    /// The file's byte length when it was parsed.
    len: u64,
    /// How much of the file that parse actually consumed — `len` minus any
    /// half-written trailing line. The resume point for the next parse.
    consumed: u64,
    /// This entry's contribution to [`FileCache::bytes`].
    bytes: usize,
    data: Arc<FileData>,
}

/// Parsed transcripts keyed by path, tagged with the byte length they were parsed
/// at. Transcripts are append-only, so an unchanged length means unchanged content
/// — a live file write only re-parses that one growing file, not the whole tree —
/// and a *grown* file only needs the bytes past [`Entry::consumed`] (see
/// [`FileCache::resume`]). Bounded by [`MAX_CACHE_BYTES`] with FIFO eviction, and
/// pruned of transcripts that no longer exist (Claude deletes old sessions).
#[derive(Default)]
struct FileCache {
    map: HashMap<PathBuf, Entry>,
    order: VecDeque<PathBuf>,
    bytes: usize,
}

impl FileCache {
    /// The parse of `path`, if it was parsed at exactly `len` bytes.
    fn get(&self, path: &Path, len: u64) -> Option<Arc<FileData>> {
        self.map
            .get(path)
            .filter(|e| e.len == len)
            .map(|e| e.data.clone())
    }

    /// The resume point for a transcript that has only *grown* since it was
    /// parsed: `(offset, previous parse)`. `None` when it's uncached or shrank —
    /// a shorter file isn't the append-only tail of what we parsed, so the
    /// caller re-reads it whole.
    fn resume(&self, path: &Path, len: u64) -> Option<(u64, Arc<FileData>)> {
        self.map
            .get(path)
            .filter(|e| len > e.len)
            .map(|e| (e.consumed, e.data.clone()))
    }

    fn insert(&mut self, path: PathBuf, len: u64, consumed: u64, data: Arc<FileData>) {
        self.insert_bounded(path, len, consumed, data, MAX_CACHE_BYTES);
    }

    /// `insert` with the byte cap as a parameter, so the FIFO eviction is
    /// unit-testable without parsing real megabytes of transcript.
    fn insert_bounded(
        &mut self,
        path: PathBuf,
        len: u64,
        consumed: u64,
        data: Arc<FileData>,
        max_bytes: usize,
    ) {
        let bytes = approx_bytes(&data);
        let entry = Entry {
            len,
            consumed,
            bytes,
            data,
        };
        match self.map.insert(path.clone(), entry) {
            // A grown file replaces its own entry — it keeps its place in the queue.
            Some(old) => self.bytes -= old.bytes,
            None => self.order.push_back(path),
        }
        self.bytes += bytes;
        while self.bytes > max_bytes {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            if let Some(e) = self.map.remove(&evicted) {
                self.bytes -= e.bytes;
            }
        }
    }

    /// Drop every entry whose file isn't in `live` — i.e. was deleted on disk.
    fn retain_existing(&mut self, live: &HashSet<&PathBuf>) {
        let bytes = &mut self.bytes;
        self.map.retain(|p, e| {
            let keep = live.contains(p);
            if !keep {
                *bytes -= e.bytes;
            }
            keep
        });
        let map = &self.map;
        self.order.retain(|p| map.contains_key(p));
    }
}

static CACHE: LazyLock<Mutex<FileCache>> = LazyLock::new(Default::default);

/// What the cache can offer for one transcript at its current byte length.
enum Cached {
    /// Parsed at exactly this length — nothing to re-read.
    Fresh(Arc<FileData>),
    /// Appended to since: resume from this offset on top of the previous parse.
    Grown(u64, Arc<FileData>),
    /// Never parsed, or shrank (so not an append) — read it whole.
    Miss,
}

/// Cache a parse and hand it to the caller's output. A transcript that vanished
/// mid-scan, or that doesn't classify, is simply skipped.
fn store(path: &Path, len: u64, parsed: Option<Parsed>, out: &mut Vec<Arc<FileData>>) {
    let Some(Parsed { data, consumed }) = parsed else {
        return;
    };
    let arc = Arc::new(data);
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(
        path.to_path_buf(),
        len,
        consumed,
        arc.clone(),
    );
    out.push(arc);
}

fn load_cached(paths: &[PathBuf], on_progress: impl Fn(usize, usize)) -> Vec<Arc<FileData>> {
    let total = paths.len();
    // Emit at most ~40 updates so a cold parse of many files doesn't flood events.
    let step = (total / 40).max(1);
    if total > 0 {
        on_progress(0, total); // let the bar appear at 0 immediately
    }
    let mut out = Vec::with_capacity(total);
    for (i, p) in paths.iter().enumerate() {
        let len = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        // The lock is only ever held for a map lookup or an insert — never across
        // a parse, or a cold parse of the whole transcript tree would block every
        // other reader for its full duration.
        let cached = {
            let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            match cache.get(p, len) {
                Some(data) => Cached::Fresh(data),
                None => match cache.resume(p, len) {
                    Some((at, data)) => Cached::Grown(at, data),
                    None => Cached::Miss,
                },
            }
        };
        match cached {
            Cached::Fresh(data) => out.push(data),
            // The transcript the agent is actively writing: parse only the bytes
            // it appended since the last poll, not the whole file again.
            Cached::Grown(at, base) => store(p, len, parse_from(p, at, Some(&base)), &mut out),
            Cached::Miss => store(p, len, parse_file(p), &mut out),
        }
        let done = i + 1;
        if done == total || done % step == 0 {
            on_progress(done, total);
        }
    }
    // `paths` is a fresh scan of every transcript on disk, so anything else still
    // in the cache is a file Claude has since pruned.
    let live: HashSet<&PathBuf> = paths.iter().collect();
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain_existing(&live);
    out
}

/// Recursively collect every `*.jsonl` under `dir` (manual walk — the workspace
/// carries no `walkdir`/`glob`, matching `git_watch.rs`'s hand-rolled traversal).
fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(ft) if ft.is_dir() => collect_jsonl(&p, out),
            _ if p.extension().and_then(|x| x.to_str()) == Some("jsonl") => out.push(p),
            _ => {}
        }
    }
}

// ── Cost ────────────────────────────────────────────────────────────────────

/// Approximate USD cost of one turn against a resolved price table. 1-hour cache
/// creation is billed at 2× the model's base input rate; everything else at its
/// own rate. A model absent from the table contributes 0 (tokens still counted).
fn cost_for(table: &PriceTable, model: &str, t: &Toks) -> f64 {
    let Some(p) = table.lookup(model) else {
        return 0.0;
    };
    (t.input * p.input
        + t.output * p.output
        + t.cache_5m * p.cache_write
        + t.cache_1h * (p.input * CACHE_CREATE_1H_INPUT_MULTIPLIER)
        + t.cache_read * p.cache_read)
        / 1_000_000.0
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/// A running token+cost accumulator for one bucket.
#[derive(Default, Clone, Copy)]
struct Acc {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost: f64,
}

impl Acc {
    fn add(&mut self, table: &PriceTable, model: &str, t: &Toks) {
        self.input += t.input;
        self.output += t.output;
        self.cache_read += t.cache_read;
        self.cache_write += t.cache_write();
        self.cost += cost_for(table, model, t);
    }
    fn total_tokens(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
    fn into_totals(self) -> UsageTotals {
        UsageTotals {
            input_tokens: self.input,
            output_tokens: self.output,
            cache_read_tokens: self.cache_read,
            cache_write_tokens: self.cache_write,
            cost_usd: self.cost,
        }
    }
}

#[derive(Default)]
struct SessionAgg {
    session_id: String,
    project: String,
    cwd: Option<String>,
    model: String,
    acc: Acc,
    /// Per-model token/cost within this session — captures mid-session switches.
    models: HashMap<String, Acc>,
    context: f64,
    last_ms: i64,
    has_main: bool,
}

/// A registered repo `(name, absolute path)` — used to resolve a session's
/// owning repo from its `cwd`, even when the agent ran in a subdirectory.
pub type Repo = (String, String);

/// The path segment santree worktrees live under: `<repo>/.santree/worktrees/<id>`.
const WORKTREES_MARKER: &str = "/.santree/worktrees/";

/// Resolve a session's `cwd` into `(repo, worktree)` for grouping. The repo is the
/// longest registered repo path that prefixes the cwd (so a subdir cwd still maps
/// to its repo); the worktree is the id under `.santree/worktrees/`, or `None` for
/// a main checkout. Falls back to pure path parsing when no registered repo matches.
fn resolve_location(cwd: Option<&str>, slug: &str, repos: &[Repo]) -> (String, Option<String>) {
    let Some(cwd) = cwd else {
        return (slug.trim_start_matches('-').to_string(), None);
    };
    let worktree = cwd
        .split_once(WORKTREES_MARKER)
        .map(|(_, rest)| rest.split('/').next().unwrap_or(rest).to_string());

    let repo = repos
        .iter()
        .filter(|(_, path)| cwd == path || cwd.starts_with(&format!("{path}/")))
        .max_by_key(|(_, path)| path.len())
        .map(|(name, _)| name.clone())
        .or_else(|| {
            // No registered repo: the dir before the worktrees marker, else the
            // cwd's own last component.
            let base = cwd
                .split_once(WORKTREES_MARKER)
                .map_or(cwd, |(before, _)| before);
            Path::new(base)
                .file_name()
                .and_then(|n| n.to_str())
                .map(String::from)
        })
        .unwrap_or_else(|| slug.trim_start_matches('-').to_string());
    (repo, worktree)
}

/// Local-midnight (epoch ms) of the day containing `now_ms` — the "today" cutoff.
fn start_of_local_day(now_ms: i64) -> i64 {
    use chrono::{Local, TimeZone};
    let Some(dt) = Local.timestamp_millis_opt(now_ms).single() else {
        return now_ms;
    };
    let midnight = dt
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("valid midnight");
    Local
        .from_local_datetime(&midnight)
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or(now_ms)
}

/// Total tokens across all classes in a `UsageTotals`.
fn total_tokens(t: &UsageTotals) -> f64 {
    t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens
}

/// The session meter's denominator: the model's real context window from the price
/// table (Sonnet 5 / Opus 4.5+ / Fable 5 = 1M, Haiku 4.5 = 200K), inferring from the
/// observed fill only when the model is unknown. Never below the observed context,
/// so the bar can't read over 100%. `model` is the last-turn model (the one whose
/// window the current context actually sits in).
fn context_window(table: &PriceTable, model: &str, observed: f64) -> f64 {
    let known = table.lookup(model).map(|r| r.context).filter(|c| *c > 0.0);
    let limit = known.unwrap_or(if observed > DEFAULT_CONTEXT_LIMIT {
        LARGE_CONTEXT_LIMIT
    } else {
        DEFAULT_CONTEXT_LIMIT
    });
    limit.max(observed)
}

/// Reduce parsed transcripts into the report. Pure over its inputs (clock, prices,
/// and registered repos are injected so tests can pin them).
fn aggregate(
    files: &[Arc<FileData>],
    now_ms: i64,
    table: &PriceTable,
    repos: &[Repo],
) -> UsageReport {
    const DAY: i64 = 86_400_000;
    let today_start = start_of_local_day(now_ms);
    let week_start = now_ms - 7 * DAY;
    let month_start = now_ms - 30 * DAY;

    let mut seen: HashSet<String> = HashSet::new();
    let mut total = Acc::default();
    let mut today = Acc::default();
    let mut week = Acc::default();
    let mut month = Acc::default();
    let mut by_model: HashMap<String, Acc> = HashMap::new();
    let mut sessions: HashMap<String, SessionAgg> = HashMap::new();

    for f in files {
        let key = format!("{}\u{0}{}", f.project, f.session_id);
        let sess = sessions.entry(key).or_default();
        sess.project.clone_from(&f.project);
        sess.session_id.clone_from(&f.session_id);
        if sess.cwd.is_none() {
            sess.cwd.clone_from(&f.cwd);
        }
        for e in &f.events {
            // Dedup whenever the turn has a message.id: a resumed session copies
            // prior turns into a new file, and they'd otherwise double-count. The
            // requestId (possibly absent) is folded into the key so genuinely
            // distinct turns sharing an id stay separate.
            if let Some(id) = &e.id {
                let dedup_key = format!("{id}\u{0}{}", e.request_id.as_deref().unwrap_or(""));
                if !seen.insert(dedup_key) {
                    continue;
                }
            }
            total.add(table, &e.model, &e.toks);
            if e.ts_ms >= today_start {
                today.add(table, &e.model, &e.toks);
            }
            if e.ts_ms >= week_start {
                week.add(table, &e.model, &e.toks);
            }
            if e.ts_ms >= month_start {
                month.add(table, &e.model, &e.toks);
            }
            by_model
                .entry(e.model.clone())
                .or_default()
                .add(table, &e.model, &e.toks);
            sess.acc.add(table, &e.model, &e.toks);
            sess.models
                .entry(e.model.clone())
                .or_default()
                .add(table, &e.model, &e.toks);
            sess.last_ms = sess.last_ms.max(e.ts_ms);
        }
        // The main transcript owns the session's live context + display model.
        if let Some(c) = &f.context {
            sess.context = c.tokens;
            sess.model.clone_from(&c.model);
            sess.last_ms = sess.last_ms.max(c.ts_ms);
            sess.has_main = true;
        }
    }

    let mut by_model: Vec<ModelUsage> = by_model
        .into_iter()
        .map(|(model, acc)| ModelUsage {
            model,
            totals: acc.into_totals(),
        })
        .collect();
    by_model.sort_by(|a, b| {
        (b.totals.input_tokens + b.totals.output_tokens)
            .partial_cmp(&(a.totals.input_tokens + a.totals.output_tokens))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut sessions: Vec<SessionUsage> = sessions
        .into_values()
        .filter(|s| s.has_main || s.acc.total_tokens() > 0.0)
        .map(|s| {
            let (repo, worktree) = resolve_location(s.cwd.as_deref(), &s.project, repos);
            // Per-model breakdown, most-used first; the primary (badge) model is
            // the biggest of these, falling back to the last-turn model.
            let mut models: Vec<ModelUsage> = s
                .models
                .into_iter()
                .map(|(model, acc)| ModelUsage {
                    model,
                    totals: acc.into_totals(),
                })
                .collect();
            models.sort_by(|a, b| {
                total_tokens(&b.totals)
                    .partial_cmp(&total_tokens(&a.totals))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let primary = models
                .first()
                .map(|m| m.model.clone())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| {
                    if s.model.is_empty() {
                        "unknown".into()
                    } else {
                        s.model.clone()
                    }
                });
            SessionUsage {
                session_id: s.session_id,
                repo,
                worktree,
                model: primary,
                models,
                totals: s.acc.into_totals(),
                context_tokens: s.context,
                context_limit: context_window(table, &s.model, s.context),
                last_activity_ms: s.last_ms as f64,
            }
        })
        .collect();
    sessions.sort_by(|a, b| {
        b.last_activity_ms
            .partial_cmp(&a.last_activity_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    sessions.truncate(MAX_SESSIONS);

    UsageReport {
        total: total.into_totals(),
        today: today.into_totals(),
        week: week.into_totals(),
        month: month.into_totals(),
        by_model,
        sessions,
    }
}

/// Build the usage report from all local Claude transcripts. Blocking (disk +
/// parse) — call from a blocking context. Returns an empty report when there are
/// no transcripts.
pub fn report(
    table: &PriceTable,
    repos: &[Repo],
    on_progress: impl Fn(usize, usize),
) -> Result<UsageReport> {
    let now = chrono::Local::now().timestamp_millis();
    let mut paths = Vec::new();
    for root in projects_roots() {
        collect_jsonl(&root, &mut paths);
    }
    let files = load_cached(&paths, on_progress);
    Ok(aggregate(&files, now, table, repos))
}

// ── Live-refresh watcher (mirrors git_watch.rs) ─────────────────────────────

type FullDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Debounced "a Claude transcript changed on disk" signal. The frontend reacts by
/// invalidating the usage query so the panel refetches without polling.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct UsageChanged {}

/// Progress of the (cold) transcript parse in file counts, so the panel can show a
/// determinate progress bar on the first load. Only fires while the per-file cache
/// is cold — a warm reload returns instantly and emits nothing meaningful.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct UsageProgress {
    pub done: u32,
    pub total: u32,
}

/// Debounce window. Usage isn't latency-sensitive and Claude writes a line per
/// turn during an active session, so collapse a burst into one signal — longer
/// than the worktree watcher's 400ms.
const DEBOUNCE: Duration = Duration::from_secs(2);

/// Owns the transcript watcher(s) for the app's lifetime. Held in Tauri managed
/// state so the debouncer OS threads stay alive (dropping them stops watching).
#[derive(Default)]
pub struct UsageWatcher(Mutex<Vec<FullDebouncer>>);

impl UsageWatcher {
    /// Start watching every `projects` root recursively, emitting [`UsageChanged`]
    /// on any `*.jsonl` change. Best-effort: a missing dir or an OS registration
    /// failure just disables live refresh for that root (the query's on-mount
    /// fetch + a later change still work), same degradation as the worktree watcher.
    pub fn start(&self, app: &AppHandle) {
        let roots = projects_roots();
        if roots.is_empty() {
            log::warn!("no Claude projects dir found; usage live-refresh disabled");
            return;
        }
        let mut debouncers = Vec::new();
        for root in roots {
            let app = app.clone();
            let debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
                let Some(events) = crate::git_watch::batch("transcript", res) else {
                    return;
                };
                let touched_transcript = events
                    .iter()
                    .flat_map(|ev| ev.paths.iter())
                    .any(|p| p.extension().and_then(|x| x.to_str()) == Some("jsonl"));
                if touched_transcript {
                    let _ = UsageChanged {}.emit(&app);
                }
            });
            let mut debouncer = match debouncer {
                Ok(d) => d,
                Err(e) => {
                    log::warn!(
                        "usage watcher init failed: {e}; live refresh disabled for {root:?}"
                    );
                    continue;
                }
            };
            match debouncer.watch(&root, RecursiveMode::Recursive) {
                Ok(()) => debouncers.push(debouncer),
                Err(e) => log::warn!("usage watch failed for {root:?}: {e}; live refresh disabled"),
            }
        }
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = debouncers;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A turn with all-5-minute cache creation, unless `cache_1h` is set below.
    fn ev(id: &str, model: &str, ts_ms: i64, input: f64, output: f64, cr: f64, c5m: f64) -> Ev {
        Ev {
            id: Some(id.into()),
            request_id: Some(format!("req-{id}")),
            model: model.into(),
            ts_ms,
            toks: Toks {
                input,
                output,
                cache_read: cr,
                cache_5m: c5m,
                cache_1h: 0.0,
            },
        }
    }

    fn file(project: &str, sid: &str, events: Vec<Ev>, context: Option<Ctx>) -> Arc<FileData> {
        Arc::new(FileData {
            project: project.into(),
            cwd: None,
            session_id: sid.into(),
            events,
            context,
        })
    }

    const NOW: i64 = 1_700_000_000_000; // fixed clock for period tests

    // ---- the parsed-transcript cache ----

    fn cached(sid: &str) -> Arc<FileData> {
        file(
            "-r",
            sid,
            vec![ev("a", "claude-opus-4-8", NOW, 1.0, 1.0, 0.0, 0.0)],
            None,
        )
    }

    #[test]
    fn file_cache_evicts_oldest_past_its_byte_budget() {
        let mut c = FileCache::default();
        let one = approx_bytes(&cached("s1"));
        for (i, sid) in ["s1", "s2", "s3"].iter().enumerate() {
            let p = PathBuf::from(format!("/t/{sid}.jsonl"));
            let len = i as u64;
            c.insert_bounded(p, len, len, cached(sid), one * 2);
        }
        assert!(
            c.get(Path::new("/t/s1.jsonl"), 0).is_none(),
            "the oldest entry is evicted once the budget is exceeded"
        );
        assert!(c.get(Path::new("/t/s3.jsonl"), 2).is_some());
        assert!(c.bytes <= one * 2);
    }

    #[test]
    fn file_cache_re_reads_grown_files_and_drops_deleted_ones() {
        let mut c = FileCache::default();
        let p = PathBuf::from("/t/s1.jsonl");
        c.insert(p.clone(), 10, 10, cached("s1"));
        assert!(c.get(&p, 10).is_some());
        assert!(
            c.get(&p, 20).is_none(),
            "an appended-to transcript must be re-parsed, not served stale"
        );

        // Re-parsing it replaces the entry rather than double-counting its bytes.
        c.insert(p.clone(), 20, 20, cached("s1"));
        assert!(c.get(&p, 20).is_some());
        assert_eq!(c.order.len(), 1);
        assert_eq!(c.bytes, approx_bytes(&cached("s1")));

        // Claude pruned the transcript: the entry goes with it.
        c.retain_existing(&HashSet::new());
        assert!(c.get(&p, 20).is_none());
        assert!(c.order.is_empty());
        assert_eq!(c.bytes, 0);
    }

    #[test]
    fn file_cache_offers_a_resume_point_only_for_grown_files() {
        let mut c = FileCache::default();
        let p = PathBuf::from("/t/s1.jsonl");
        // Parsed at 100 bytes, of which 90 were complete lines (a partial tail).
        c.insert(p.clone(), 100, 90, cached("s1"));

        let (at, _) = c.resume(&p, 150).expect("a grown transcript resumes");
        assert_eq!(
            at, 90,
            "resume at the end of the last complete line, not len"
        );
        assert!(
            c.resume(&p, 100).is_none(),
            "an unchanged file is a Fresh hit, not a resume"
        );
        assert!(
            c.resume(&p, 50).is_none(),
            "a shrunk file isn't an append — it must be re-read whole"
        );
        assert!(c.resume(Path::new("/t/other.jsonl"), 10).is_none());
    }

    /// The static built-in price table (deterministic; no network) for cost tests.
    fn tbl() -> PriceTable {
        PriceTable::builtin()
    }

    #[test]
    fn real_input_sums_all_token_classes_and_costs_opus_4_8() {
        let f = file(
            "-repo",
            "s1",
            vec![ev("a", "claude-opus-4-8", NOW, 100.0, 200.0, 1000.0, 500.0)],
            None,
        );
        let r = aggregate(&[f], NOW, &tbl(), &[]);
        assert_eq!(r.total.input_tokens, 100.0);
        assert_eq!(r.total.output_tokens, 200.0);
        assert_eq!(r.total.cache_read_tokens, 1000.0);
        assert_eq!(r.total.cache_write_tokens, 500.0);
        // opus-4-8: $5/$25, 5m cache $6.25, read $0.50 per MTok.
        let want = (100.0 * 5.0 + 200.0 * 25.0 + 500.0 * 6.25 + 1000.0 * 0.5) / 1_000_000.0;
        assert!(
            (r.total.cost_usd - want).abs() < 1e-12,
            "got {}",
            r.total.cost_usd
        );
    }

    #[test]
    fn opus_4_8_is_a_third_of_older_opus() {
        let new = file(
            "-r",
            "s1",
            vec![ev("a", "claude-opus-4-8", NOW, 1000.0, 0.0, 0.0, 0.0)],
            None,
        );
        let old = file(
            "-r",
            "s2",
            vec![ev("b", "claude-opus-4-1", NOW, 1000.0, 0.0, 0.0, 0.0)],
            None,
        );
        let rn = aggregate(&[new], NOW, &tbl(), &[]).total.cost_usd;
        let ro = aggregate(&[old], NOW, &tbl(), &[]).total.cost_usd;
        assert!((ro / rn - 3.0).abs() < 1e-9, "old/new = {}", ro / rn);
    }

    #[test]
    fn one_hour_cache_is_billed_at_twice_input() {
        // opus-4-8 base input $5 → 1h cache creation is $10/MTok.
        let f = file(
            "-r",
            "s1",
            vec![Ev {
                id: Some("h".into()),
                request_id: None,
                model: "claude-opus-4-8".into(),
                ts_ms: NOW,
                toks: Toks {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_5m: 0.0,
                    cache_1h: 1000.0,
                },
            }],
            None,
        );
        let r = aggregate(&[f], NOW, &tbl(), &[]);
        assert_eq!(r.total.cache_write_tokens, 1000.0);
        assert!((r.total.cost_usd - (1000.0 * 10.0 / 1_000_000.0)).abs() < 1e-12);
    }

    #[test]
    fn dedups_repeated_request_ids() {
        let a = file(
            "-repo",
            "s1",
            vec![ev("dup", "claude-sonnet-4-5", NOW, 10.0, 0.0, 0.0, 0.0)],
            None,
        );
        let b = file(
            "-repo",
            "s2",
            vec![ev("dup", "claude-sonnet-4-5", NOW, 10.0, 0.0, 0.0, 0.0)],
            None,
        );
        let r = aggregate(&[a, b], NOW, &tbl(), &[]);
        assert_eq!(r.total.input_tokens, 10.0);
    }

    #[test]
    fn buckets_by_period() {
        let day = 86_400_000;
        let f = file(
            "-repo",
            "s1",
            vec![
                ev("recent", "claude-opus-4-8", NOW, 1.0, 0.0, 0.0, 0.0),
                ev(
                    "last-week",
                    "claude-opus-4-8",
                    NOW - 10 * day,
                    100.0,
                    0.0,
                    0.0,
                    0.0,
                ),
            ],
            None,
        );
        let r = aggregate(&[f], NOW, &tbl(), &[]);
        assert_eq!(r.total.input_tokens, 101.0);
        assert_eq!(r.today.input_tokens, 1.0, "10-day-old turn is not today");
        assert_eq!(
            r.week.input_tokens, 1.0,
            "10-day-old turn is outside the week"
        );
        assert_eq!(r.month.input_tokens, 101.0, "both turns are within 30 days");
    }

    #[test]
    fn context_limit_comes_from_the_model_window() {
        // opus-4-8 is a 1M-context model even at low fill (the old heuristic wrongly
        // showed 200K); haiku is 200K; an unknown model infers from the fill.
        let opus = file(
            "-r",
            "s1",
            vec![],
            Some(Ctx {
                tokens: 51_000.0,
                ts_ms: NOW,
                model: "claude-opus-4-8".into(),
            }),
        );
        let haiku = file(
            "-r",
            "s2",
            vec![],
            Some(Ctx {
                tokens: 60_000.0,
                ts_ms: NOW,
                model: "claude-haiku-4-5-20251001".into(),
            }),
        );
        let unknown = file(
            "-r",
            "s3",
            vec![],
            Some(Ctx {
                tokens: 350_000.0,
                ts_ms: NOW,
                model: "mystery-model".into(),
            }),
        );
        let r = aggregate(&[opus, haiku, unknown], NOW, &tbl(), &[]);
        let g = |id: &str| r.sessions.iter().find(|s| s.session_id == id).unwrap();
        assert_eq!(g("s1").context_tokens, 51_000.0);
        assert_eq!(g("s1").context_limit, 1_000_000.0, "opus-4-8 window is 1M");
        assert_eq!(g("s2").context_limit, 200_000.0, "haiku window is 200K");
        assert_eq!(
            g("s3").context_limit,
            1_000_000.0,
            "unknown model >200K → 1M"
        );
    }

    #[test]
    fn claude_5_family_prices_beat_the_family_fallback() {
        // sonnet-5 ($2) must win the longest-key match over "sonnet" ($3), and
        // fable-5 ($10) must be priced (not zero).
        let s5 = cost_for(
            &tbl(),
            "claude-sonnet-5",
            &Toks {
                input: 1_000_000.0,
                output: 0.0,
                cache_read: 0.0,
                cache_5m: 0.0,
                cache_1h: 0.0,
            },
        );
        let s46 = cost_for(
            &tbl(),
            "claude-sonnet-4-6",
            &Toks {
                input: 1_000_000.0,
                output: 0.0,
                cache_read: 0.0,
                cache_5m: 0.0,
                cache_1h: 0.0,
            },
        );
        let fable = cost_for(
            &tbl(),
            "claude-fable-5",
            &Toks {
                input: 1_000_000.0,
                output: 0.0,
                cache_read: 0.0,
                cache_5m: 0.0,
                cache_1h: 0.0,
            },
        );
        assert!((s5 - 2.0).abs() < 1e-9, "sonnet-5 = ${s5}");
        assert!((s46 - 3.0).abs() < 1e-9, "sonnet-4-6 = ${s46}");
        assert!((fable - 10.0).abs() < 1e-9, "fable-5 = ${fable}");
    }

    #[test]
    fn unknown_model_counts_tokens_but_zero_cost() {
        let f = file(
            "-repo",
            "s1",
            vec![ev("a", "gpt-5", NOW, 100.0, 100.0, 0.0, 0.0)],
            None,
        );
        let r = aggregate(&[f], NOW, &tbl(), &[]);
        assert_eq!(r.total.input_tokens, 100.0);
        assert_eq!(r.total.output_tokens, 100.0);
        assert_eq!(r.total.cost_usd, 0.0);
    }

    #[test]
    fn subagent_tokens_fold_into_parent_session() {
        let main = file(
            "-repo",
            "s1",
            vec![ev("m", "claude-opus-4-8", NOW, 10.0, 0.0, 0.0, 0.0)],
            Some(Ctx {
                tokens: 10.0,
                ts_ms: NOW,
                model: "claude-opus-4-8".into(),
            }),
        );
        let sub = file(
            "-repo",
            "s1",
            vec![ev("sub", "claude-opus-4-8", NOW, 5.0, 0.0, 0.0, 0.0)],
            None,
        );
        let r = aggregate(&[main, sub], NOW, &tbl(), &[]);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].totals.input_tokens, 15.0);
    }

    #[test]
    fn session_captures_mid_session_model_switch() {
        // Session used Opus then switched to Sonnet, doing more work on Sonnet.
        // The last-turn (context) model is Opus, but the primary should be the
        // most-used model, and both must appear in the breakdown.
        let f = file(
            "-r",
            "s1",
            vec![
                ev("a", "claude-opus-4-8", NOW, 10.0, 0.0, 0.0, 0.0),
                ev("b", "claude-sonnet-5", NOW, 100.0, 0.0, 0.0, 0.0),
            ],
            Some(Ctx {
                tokens: 5.0,
                ts_ms: NOW,
                model: "claude-opus-4-8".into(),
            }),
        );
        let r = aggregate(&[f], NOW, &tbl(), &[]);
        let s = &r.sessions[0];
        assert_eq!(s.models.len(), 2, "both models captured");
        assert_eq!(s.models[0].model, "claude-sonnet-5", "most-used first");
        assert_eq!(
            s.model, "claude-sonnet-5",
            "primary is most-used, not last-turn"
        );
    }

    #[test]
    fn classify_distinguishes_main_and_subagent() {
        let main = Path::new("/home/u/.claude/projects/-repo/abc.jsonl");
        let sub = Path::new("/home/u/.config/claude/projects/-repo/abc/subagents/agent-1.jsonl");
        assert_eq!(classify(main), Some(("-repo".into(), "abc".into(), true)));
        assert_eq!(classify(sub), Some(("-repo".into(), "abc".into(), false)));
    }

    #[test]
    fn resolve_location_groups_worktrees_under_their_repo() {
        let repos = vec![("canary".to_string(), "/Users/me/dev/canary".to_string())];
        // Main checkout of a registered repo.
        assert_eq!(
            resolve_location(Some("/Users/me/dev/canary"), "-slug", &repos),
            ("canary".into(), None)
        );
        // A subdir of the repo still resolves to the repo (not the subdir name).
        assert_eq!(
            resolve_location(Some("/Users/me/dev/canary/backend/api"), "-slug", &repos),
            ("canary".into(), None)
        );
        // A worktree: repo = canary, worktree = the issue id (even from a subdir).
        assert_eq!(
            resolve_location(
                Some("/Users/me/dev/canary/.santree/worktrees/AK-182"),
                "-slug",
                &repos
            ),
            ("canary".into(), Some("AK-182".into()))
        );
        assert_eq!(
            resolve_location(
                Some("/Users/me/dev/canary/.santree/worktrees/AK-63/backend"),
                "-slug",
                &repos
            ),
            ("canary".into(), Some("AK-63".into()))
        );
        // Unregistered repo: fall back to the cwd's own last component.
        assert_eq!(
            resolve_location(Some("/Users/me/dev/gpu-rig"), "-slug", &[]),
            ("gpu-rig".into(), None)
        );
        // Unregistered repo with a worktree: repo from the path before the marker.
        assert_eq!(
            resolve_location(Some("/other/thing/.santree/worktrees/X-1"), "-slug", &[]),
            ("thing".into(), Some("X-1".into()))
        );
    }

    #[test]
    fn parse_file_reads_usage_cwd_and_splits_cache() {
        let dir = std::env::temp_dir().join(format!("santree-usage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let proj = dir.join("projects").join("-repo");
        std::fs::create_dir_all(&proj).unwrap();
        let file_path = proj.join("sess.jsonl");
        let content = concat!(
            r#"{"type":"user","cwd":"/Users/me/dev/repo","message":{"role":"user"}}"#,
            "\n",
            r#"{"type":"assistant","timestamp":"2026-07-05T10:00:00.000Z","requestId":"r1","cwd":"/Users/me/dev/repo","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":7,"cache_creation_input_tokens":9,"cache_read_input_tokens":11,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":7}}}}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"m2","model":"<synthetic>","usage":{"input_tokens":999}}}"#,
            "\n",
            "not json at all\n",
        );
        std::fs::write(&file_path, content).unwrap();
        let fd = parse_file(&file_path).unwrap().data;
        assert_eq!(fd.session_id, "sess");
        assert_eq!(fd.cwd.as_deref(), Some("/Users/me/dev/repo"));
        assert_eq!(fd.events.len(), 1, "synthetic + non-json lines skipped");
        let t = &fd.events[0].toks;
        assert_eq!((t.input, t.output, t.cache_read), (5.0, 7.0, 11.0));
        assert_eq!(
            (t.cache_5m, t.cache_1h),
            (2.0, 7.0),
            "cache split from breakdown"
        );
        // context = input + cache_read + (5m + 1h)
        assert_eq!(fd.context.as_ref().unwrap().tokens, 5.0 + 11.0 + 2.0 + 7.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- incremental parse of the growing transcript ----

    /// An `assistant` line with `input_tokens: n`, as Claude writes it.
    fn turn(id: &str, input: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-07-05T10:00:00.000Z","requestId":"r-{id}","cwd":"/repo","message":{{"id":"{id}","model":"claude-opus-4-8","usage":{{"input_tokens":{input},"output_tokens":0}}}}}}"#
        )
    }

    /// A transcript file path under a `projects/<slug>/` root, so `classify` sees it.
    fn transcript(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("santree-usage-inc-{}-{name}", std::process::id()))
            .join("projects")
            .join("-repo");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("sess.jsonl")
    }

    #[test]
    fn parse_from_stops_at_the_last_complete_line_and_resumes_there() {
        let path = transcript("partial");
        let (a, b) = (turn("m1", 10), turn("m2", 20));

        // Claude is mid-write: the second line has no terminating newline yet.
        let partial = &b[..30];
        std::fs::write(&path, format!("{a}\n{partial}")).unwrap();
        let first = parse_from(&path, 0, None).unwrap();
        assert_eq!(
            first.data.events.len(),
            1,
            "the half-written line is skipped"
        );
        assert_eq!(
            first.consumed,
            a.len() as u64 + 1,
            "consume up to the last newline — not to EOF, or the partial line's \
             remaining bytes would be lost on the next poll"
        );

        // The write completes; resuming re-reads that line whole.
        std::fs::write(&path, format!("{a}\n{b}\n")).unwrap();
        let second = parse_from(&path, first.consumed, Some(&first.data)).unwrap();
        assert_eq!(
            second
                .data
                .events
                .iter()
                .map(|e| e.id.clone().unwrap())
                .collect::<Vec<_>>(),
            ["m1", "m2"]
        );
        assert_eq!(second.consumed, (a.len() + b.len() + 2) as u64);
        // The main transcript's context follows the *last* turn.
        assert_eq!(second.data.context.unwrap().tokens, 20.0);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn parse_from_folds_appended_turns_in_without_re_reading_the_prefix() {
        let path = transcript("append");
        let (a, b) = (turn("m1", 10), turn("m2", 20));
        std::fs::write(&path, format!("{a}\n")).unwrap();
        let first = parse_from(&path, 0, None).unwrap();

        // Overwrite the already-parsed prefix with same-length garbage, then append
        // the next turn. Anything the incremental parse re-read would now be
        // unparseable — so `m1` surviving proves only the appended bytes were read.
        let garbage = "x".repeat(a.len());
        std::fs::write(&path, format!("{garbage}\n{b}\n")).unwrap();

        let second = parse_from(&path, first.consumed, Some(&first.data)).unwrap();
        assert_eq!(
            second
                .data
                .events
                .iter()
                .map(|e| e.id.clone().unwrap())
                .collect::<Vec<_>>(),
            ["m1", "m2"],
            "m1 came from the cached parse, m2 from the appended tail"
        );
        assert_eq!(second.data.cwd.as_deref(), Some("/repo"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The same proof through the real entry point (and the process-wide cache):
    /// the growing transcript — the one file that misses the byte-length cache on
    /// every refetch — must be extended from its cached parse, not re-read whole.
    #[test]
    fn load_cached_extends_the_growing_transcript_instead_of_re_reading_it() {
        let path = transcript("load");
        let (a, b) = (turn("m1", 10), turn("m2", 20));
        std::fs::write(&path, format!("{a}\n")).unwrap();

        let paths = vec![path.clone()];
        let first = load_cached(&paths, |_, _| {});
        assert_eq!(first[0].events.len(), 1);

        // Poison the prefix (same byte length) and append the next turn, exactly as
        // above: a full re-read would drop `m1`, an incremental one keeps it.
        std::fs::write(&path, format!("{}\n{b}\n", "x".repeat(a.len()))).unwrap();
        let second = load_cached(&paths, |_, _| {});
        assert_eq!(
            second[0]
                .events
                .iter()
                .map(|e| e.id.clone().unwrap())
                .collect::<Vec<_>>(),
            ["m1", "m2"],
            "load_cached re-read the whole file instead of just the appended bytes"
        );

        // A file that shrank isn't an append: it's re-read whole (so the poisoned
        // prefix is all that's left, and no event survives).
        std::fs::write(&path, format!("{}\n", "x".repeat(a.len()))).unwrap();
        let third = load_cached(&paths, |_, _| {});
        assert!(third[0].events.is_empty(), "a shrunk file is re-read whole");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
