//! A Daedalus project's session history, read from the box (docs/remote.md,
//! "Session history on the box"): the agents there wrote their records in
//! the box's home — Claude's transcripts under `~/.claude/projects`, Codex's
//! rollouts under `~/.codex/sessions` — so the History pane reads them there,
//! through the worktree's [`Checkout`], and summarises them with the same
//! parsers a local project's go through (`usage::RemoteTranscript`,
//! `codex_rollouts::remote_summary`).
//!
//! - **Listing**: one `exec.run` of a plain POSIX `find … -exec wc -c {} +`
//!   names the candidate files with their sizes — Claude's transcripts in the
//!   project dirs whose name is the worktree's slug (or extends it, a subdir's)
//!   or a registered session's cwd's, and their `subagents/` files; Codex's
//!   rollouts by the registered thread ids alone. Every line is checked against
//!   the shape it must have (a session id's file in a slug's dir) before it is
//!   used, and nothing found by scanning is listed unless its transcript says it
//!   ran in the worktree, as locally.
//! - **Reading**: `fs.read` with `within` = the records' root on the box, so a
//!   symlink out of it is refused there. A record up to [`WHOLE_MAX`] is read
//!   whole, in [`PAGE`]s, and kept parsed by its size; one that grew is read
//!   only from where the last parse stopped. A bigger one is read from its
//!   first [`HEAD`] and last [`TAIL`] bytes only — summarised from those, its
//!   counts a lower bound and its spend unknown (`sampled`) — so a 100 MB
//!   transcript costs a few MB, never the whole file over the link.
//!
//! Blocking, like the git it sits beside: callers run it on the blocking pool.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use anyhow::{anyhow, Result};

use santree_core::domain::{AgentKind, SessionDetail, SessionSubagent};

use crate::git::{Checkout, FsKind};
use crate::pricing::PriceTable;
use crate::session::{self, RecordPresence, SessionSummary};
use crate::usage::{cwd_belongs_to, RemoteTranscript};

/// One `fs.read`: well under the host's 8 MiB cap, so a page's frame stays
/// a few MB.
pub const PAGE: u64 = 4 * 1024 * 1024;
/// Records up to this size are read whole (two pages).
pub const WHOLE_MAX: u64 = 2 * PAGE;
/// A bigger record's first bytes read: its opening turns, title and `cwd`.
pub const HEAD: u64 = 1024 * 1024;
/// …and its last: the latest turns, model and activity.
pub const TAIL: u64 = PAGE;
/// The bytes of an unregistered transcript's head read to learn its `cwd`
/// before anything more of it is (as `usage::PEEK_BYTES` locally).
const PEEK: u64 = 256 * 1024;
/// A subagent's `.meta.json` sidecar is a few hundred bytes.
const META_MAX: u64 = 64 * 1024;
/// Parsed records kept, oldest dropped first.
const CACHE_MAX: usize = 256;

/// The records of a worktree's sessions on the box.
pub(crate) struct BoxRecords {
    /// The worktree's checkout on the box: where `find` runs and what reads.
    at: Checkout,
    /// The worktree's path there, as the transcripts' `cwd` names it.
    worktree: PathBuf,
    /// `<home>/.claude/projects` and `<home>/.codex/sessions` on the box.
    projects: PathBuf,
    rollouts: PathBuf,
}

/// A main transcript found on the box.
struct Main {
    path: PathBuf,
    size: u64,
    /// The registry vouched for it (a row's `(cwd, session id)` names it).
    registered: bool,
    /// Found in a dir whose name merely extends the worktree's slug: likely a
    /// sibling checkout's, so its `cwd` is peeked before it is read.
    sibling: bool,
    /// Its `subagents/agent-*.jsonl`, with their sizes, by name.
    subagents: Vec<(PathBuf, u64)>,
}

impl BoxRecords {
    /// The records of the worktree checked out at `at` on the box, whose
    /// operator's home is `home` (`hello`'s).
    pub(crate) fn new(at: Checkout, home: &Path) -> Self {
        Self {
            worktree: at.path().to_path_buf(),
            at,
            projects: home.join(".claude/projects"),
            rollouts: home.join(".codex/sessions"),
        }
    }

    /// Every session's summary that ran in the worktree, by session id: the
    /// registered ones (`known_claude` as `(cwd, id)`, `known_codex` thread
    /// ids) and the Claude transcripts on the box that say they ran there.
    pub(crate) fn summaries(
        &self,
        known_claude: &[(String, String)],
        known_codex: &[String],
        table: &PriceTable,
    ) -> Result<HashMap<String, (AgentKind, SessionSummary)>> {
        let mut out = HashMap::new();
        for main in self.transcripts(known_claude)? {
            let Some(transcript) = self.belonging(&main)? else {
                continue;
            };
            let subagents: Vec<RemoteTranscript> = main
                .subagents
                .iter()
                .filter_map(|(path, size)| self.load(path, *size).transcript)
                .collect();
            let id = stem(&main.path).to_string();
            let summary = transcript.summary(main.subagents.len() as u32, &subagents, table);
            out.insert(id, (AgentKind::Claude, summary));
        }
        for (id, summary) in self.rollouts(known_codex)? {
            out.insert(id, (AgentKind::Codex, summary));
        }
        Ok(out)
    }

    /// What the expanded row shows for Claude session `session_id` — one the
    /// caller found in this worktree's listing. Empty when it has no
    /// transcript on the box.
    pub(crate) fn detail(
        &self,
        known_claude: &[(String, String)],
        session_id: &str,
    ) -> Result<SessionDetail> {
        Ok(self
            .session(known_claude, session_id)?
            .map(|(_, transcript)| transcript.detail())
            .unwrap_or_default())
    }

    /// The Task subagents of Claude session `session_id`, as the local pane
    /// reads them: the sidecar's type, description and place in the tree, and
    /// a status from the spawner's report or the transcript's last write.
    pub(crate) fn subagents(
        &self,
        known_claude: &[(String, String)],
        session_id: &str,
        now_ms: i64,
    ) -> Result<Vec<SessionSubagent>> {
        let Some((main, transcript)) = self.session(known_claude, session_id)? else {
            return Ok(Vec::new());
        };
        let mut reported = transcript.reported().clone();
        let mut rows = Vec::new();
        for (path, size) in &main.subagents {
            let loaded = self.load(path, *size);
            let Some(sub) = loaded.transcript else {
                continue;
            };
            reported.extend(sub.reported().clone());
            let mtime = self
                .at
                .metadata(path)?
                .filter(|m| m.kind == FsKind::File)
                .map(|m| m.mtime_ms);
            let meta = self
                .at
                .read_at(
                    &path.with_extension("meta.json"),
                    0,
                    META_MAX,
                    &self.projects,
                )
                .ok();
            rows.push((path.clone(), sub, meta, mtime));
        }
        Ok(rows
            .into_iter()
            .map(|(path, sub, meta, mtime)| {
                sub.subagent_row(&path, meta.as_deref(), mtime, &reported, now_ms)
            })
            .collect())
    }

    /// The main transcript of Claude session `session_id` in this worktree,
    /// found by comparing file stems — the id is never joined onto a path.
    fn session(
        &self,
        known_claude: &[(String, String)],
        session_id: &str,
    ) -> Result<Option<(Main, RemoteTranscript)>> {
        for main in self.transcripts(known_claude)? {
            if stem(&main.path) != session_id {
                continue;
            }
            if let Some(transcript) = self.belonging(&main)? {
                return Ok(Some((main, transcript)));
            }
        }
        Ok(None)
    }

    /// `main` parsed, when it is the worktree's: registered, or its transcript
    /// says it ran there (as `usage::summaries_in` decides it locally).
    fn belonging(&self, main: &Main) -> Result<Option<RemoteTranscript>> {
        if !main.registered && main.sibling {
            if let Some(cwd) = self.peek_cwd(&main.path)? {
                if !cwd_belongs_to(&cwd, &self.worktree) {
                    return Ok(None);
                }
            }
        }
        let loaded = self.load(&main.path, main.size);
        if let Some(e) = loaded.error {
            log::warn!(
                "daedalus: reading the transcript {} failed: {e:#}",
                main.path.display()
            );
        }
        Ok(loaded.transcript.filter(|t| {
            main.registered
                || t.cwd()
                    .is_some_and(|cwd| cwd_belongs_to(cwd, &self.worktree))
        }))
    }

    /// The Claude transcripts on the box that may be this worktree's, by path,
    /// each with its subagents. One `exec.run`.
    fn transcripts(&self, known_claude: &[(String, String)]) -> Result<Vec<Main>> {
        if self
            .at
            .metadata(&self.projects)?
            .is_none_or(|m| m.kind != FsKind::Dir)
        {
            return Ok(Vec::new());
        }
        let slug = session::project_slug(&self.worktree.to_string_lossy());
        let registered: HashSet<PathBuf> = known_claude
            .iter()
            .filter(|(_, id)| session::is_session_id(id))
            .map(|(cwd, id)| {
                self.projects
                    .join(session::project_slug(cwd))
                    .join(format!("{id}.jsonl"))
            })
            .collect();
        let mut dirs: Vec<String> = vec![slug.clone(), format!("{slug}-*")];
        for path in &registered {
            if let Some(dir) = path.parent().and_then(Path::file_name) {
                let dir = dir.to_string_lossy().into_owned();
                if !dirs.contains(&dir) {
                    dirs.push(dir);
                }
            }
        }
        let root = glob_escape(&self.projects.to_string_lossy());
        let mut argv: Vec<String> = [
            "find",
            &self.projects.to_string_lossy(),
            "-mindepth",
            "2",
            "-maxdepth",
            "4",
            "-type",
            "f",
            "-name",
            "*.jsonl",
            "(",
        ]
        .map(str::to_string)
        .to_vec();
        for (i, dir) in dirs.iter().enumerate() {
            if i > 0 {
                argv.push("-o".into());
            }
            argv.push("-path".into());
            // A slug is letters, digits and dashes alone; the `*` of `<slug>-*`
            // is the one wildcard meant.
            argv.push(format!("{root}/{dir}/*"));
        }
        argv.extend([")", "-exec", "wc", "-c", "{}", "+"].map(str::to_string));
        let sizes = self.sizes(&argv)?;

        let mut mains: Vec<Main> = Vec::new();
        let mut subagents: HashMap<PathBuf, Vec<(PathBuf, u64)>> = HashMap::new();
        for (path, size) in sizes {
            let Ok(rest) = path.strip_prefix(&self.projects) else {
                continue;
            };
            let parts: Vec<&str> = rest.iter().filter_map(|c| c.to_str()).collect();
            match parts.as_slice() {
                [dir, file] if is_slug(dir) => {
                    let Some(id) = file.strip_suffix(".jsonl") else {
                        continue;
                    };
                    if !session::is_session_id(id) {
                        continue;
                    }
                    mains.push(Main {
                        registered: registered.contains(&path),
                        sibling: *dir != slug,
                        path,
                        size,
                        subagents: Vec::new(),
                    });
                }
                [dir, id, "subagents", file]
                    if is_slug(dir)
                        && session::is_session_id(id)
                        && file.starts_with("agent-")
                        && file.ends_with(".jsonl") =>
                {
                    let main = self.projects.join(dir).join(format!("{id}.jsonl"));
                    subagents.entry(main).or_default().push((path, size));
                }
                _ => {}
            }
        }
        for main in &mut mains {
            let mut subs = subagents.remove(&main.path).unwrap_or_default();
            subs.sort();
            main.subagents = subs;
        }
        mains.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(mains)
    }

    /// The Codex rollouts of the registered threads `known`, summarised. A
    /// rollout's name ends in its thread id; its `session_meta` must agree.
    fn rollouts(&self, known: &[String]) -> Result<Vec<(String, SessionSummary)>> {
        let ids: Vec<&String> = known
            .iter()
            .filter(|id| session::is_session_id(id))
            .collect();
        if ids.is_empty()
            || self
                .at
                .metadata(&self.rollouts)?
                .is_none_or(|m| m.kind != FsKind::Dir)
        {
            return Ok(Vec::new());
        }
        let mut argv: Vec<String> = ["find", &self.rollouts.to_string_lossy(), "-type", "f", "("]
            .map(str::to_string)
            .to_vec();
        for (i, id) in ids.iter().enumerate() {
            if i > 0 {
                argv.push("-o".into());
            }
            argv.push("-name".into());
            argv.push(format!("rollout-*-{id}.jsonl"));
        }
        argv.extend([")", "-exec", "wc", "-c", "{}", "+"].map(str::to_string));
        let mut out = Vec::new();
        for (path, size) in self.sizes(&argv)? {
            if !path.starts_with(&self.rollouts) {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(id) = ids
                .iter()
                .find(|id| name.ends_with(&format!("-{id}.jsonl")))
            else {
                continue;
            };
            match self.rollout(&path, size) {
                Ok(Some((thread, summary))) if thread == **id => out.push((thread, summary)),
                Ok(_) => {}
                Err(e) => log::warn!(
                    "daedalus: reading the rollout {} failed: {e:#}",
                    path.display()
                ),
            }
        }
        Ok(out)
    }

    /// One rollout's thread id and summary: whole, or its head and tail.
    fn rollout(&self, path: &Path, size: u64) -> Result<Option<(String, SessionSummary)>> {
        let key = path.to_string_lossy().into_owned();
        if let Some(hit) = lock(&ROLLOUTS).get(&key).filter(|(at, _)| *at == size) {
            return Ok(hit.1.clone());
        }
        let summary = if size <= WHOLE_MAX {
            crate::codex_rollouts::remote_summary(&self.range(path, 0, size, &self.rollouts)?, None)
        } else {
            let head = self.range(path, 0, HEAD, &self.rollouts)?;
            let tail = self.range(path, size - TAIL, size, &self.rollouts)?;
            crate::codex_rollouts::remote_summary(&head, Some(&tail))
        };
        let mut cache = lock(&ROLLOUTS);
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
        cache.insert(key, (size, summary.clone()));
        Ok(summary)
    }

    /// `argv` (a `find … -exec wc -c {} +`) run in the worktree: each file it
    /// names with its size. A line that isn't `<size> <absolute path>` — `wc`'s
    /// own totals — is skipped.
    fn sizes(&self, argv: &[String]) -> Result<Vec<(PathBuf, u64)>> {
        let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
        let out = self.at.run(&argv)?;
        // `find` exits non-zero when one directory couldn't be read; what it
        // did list still stands.
        if !out.ok && out.stdout.is_empty() {
            return Err(anyhow!(
                "listing agent sessions on Daedalus: {}",
                out.stderr.trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| {
                let (size, path) = line.trim_start().split_once(' ')?;
                let path = PathBuf::from(path.trim_start());
                let size = size.parse().ok()?;
                path.is_absolute().then_some((path, size))
            })
            .collect())
    }

    /// The `cwd` an unregistered transcript's head records, read once: it never
    /// changes. `None` when the head names none.
    fn peek_cwd(&self, path: &Path) -> Result<Option<String>> {
        let key = path.to_string_lossy().into_owned();
        if let Some(cwd) = lock(&CWDS).get(&key) {
            return Ok(cwd.clone());
        }
        let head = self.at.read_at(path, 0, PEEK, &self.projects)?;
        let cwd = crate::usage::cwd_of_head(&head);
        let mut cwds = lock(&CWDS);
        if cwds.len() >= CACHE_MAX * 4 {
            cwds.clear();
        }
        cwds.insert(key, cwd.clone());
        Ok(cwd)
    }

    /// The transcript at `path`, `size` bytes now, parsed — from the cache when
    /// it hasn't changed, extended when it grew, sampled when too big to read.
    fn load(&self, path: &Path, size: u64) -> Loaded {
        match self.parse(path, size) {
            Ok(transcript) => Loaded {
                transcript,
                error: None,
            },
            Err(e) => Loaded {
                transcript: None,
                error: Some(e),
            },
        }
    }

    fn parse(&self, path: &Path, size: u64) -> Result<Option<RemoteTranscript>> {
        let key = path.to_string_lossy().into_owned();
        let cached = lock(&TRANSCRIPTS).get(&key);
        if let Some((at, t)) = &cached {
            if *at == size {
                return Ok(Some(t.clone()));
            }
        }
        let parsed = match cached {
            // Appended to since (records are append-only): only the new bytes.
            Some((at, t)) if !t.is_sampled() && size > at && size - t.consumed() <= WHOLE_MAX => {
                t.extended(path, &self.range(path, t.consumed(), size, &self.projects)?)
            }
            _ if size <= WHOLE_MAX => {
                RemoteTranscript::whole(path, &self.range(path, 0, size, &self.projects)?)
            }
            _ => RemoteTranscript::sampled(
                path,
                &self.range(path, 0, HEAD, &self.projects)?,
                &self.range(path, size - TAIL, size, &self.projects)?,
            ),
        };
        if let Some(t) = &parsed {
            lock(&TRANSCRIPTS).insert(key, size, t.clone());
        }
        Ok(parsed)
    }

    /// Bytes `[from, to)` of the file at `path`, in pages, refused outside
    /// `within`. Shorter when the file is.
    fn range(&self, path: &Path, from: u64, to: u64, within: &Path) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(to.saturating_sub(from).min(WHOLE_MAX) as usize);
        let mut at = from;
        while at < to {
            let read = self.at.read_at(path, at, (to - at).min(PAGE), within)?;
            if read.is_empty() {
                break;
            }
            at += read.len() as u64;
            out.extend_from_slice(&read);
        }
        Ok(out)
    }
}

/// Whether Claude's transcript of session `id`, run in `cwd`, is on the box —
/// what resuming it from the History pane needs (`session::adopt_with`).
pub(crate) fn transcript_present(
    at: &Checkout,
    home: &Path,
    cwd: &str,
    id: &str,
) -> RecordPresence {
    super::agents::transcript_on_box(at, home, cwd, id)
}

/// Whether Codex's rollout of thread `id` is on the box.
pub(crate) fn rollout_present(at: &Checkout, home: &Path, id: &str) -> RecordPresence {
    super::agents::rollout_on_box(at, home, id)
}

/// A parse, or why there is none (logged by the caller that lists it).
struct Loaded {
    transcript: Option<RemoteTranscript>,
    error: Option<anyhow::Error>,
}

/// A file's stem as a `&str` (the session id, for a main transcript).
fn stem(path: &Path) -> &str {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
}

/// A project dir's name as Claude makes one: letters, digits and dashes.
fn is_slug(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `s` with `find -path`'s wildcards escaped, so it matches only itself.
fn glob_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Parsed transcripts by box path, with the size each was parsed at.
#[derive(Default)]
struct Transcripts {
    map: HashMap<String, (u64, RemoteTranscript)>,
    order: VecDeque<String>,
}

impl Transcripts {
    fn get(&self, key: &str) -> Option<(u64, RemoteTranscript)> {
        self.map.get(key).cloned()
    }

    fn insert(&mut self, key: String, size: u64, t: RemoteTranscript) {
        if self.map.insert(key.clone(), (size, t)).is_none() {
            self.order.push_back(key);
        }
        while self.map.len() > CACHE_MAX {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.map.remove(&oldest);
        }
    }
}

static TRANSCRIPTS: LazyLock<Mutex<Transcripts>> = LazyLock::new(Default::default);
type RolloutSummary = Option<(String, SessionSummary)>;
static ROLLOUTS: LazyLock<Mutex<HashMap<String, (u64, RolloutSummary)>>> =
    LazyLock::new(Default::default);
static CWDS: LazyLock<Mutex<HashMap<String, Option<String>>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
