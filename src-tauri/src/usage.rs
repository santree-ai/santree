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

use santree_core::domain::{
    LastMessageFrom, ModelUsage, SessionDetail, SessionModelSpend, SessionSpend, SessionSubagent,
    SessionTurn, SessionUsage, SubagentStatus, UsageReport, UsageTotals,
};

use crate::pricing::PriceTable;
use crate::session::SessionSummary;

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
    /// Claude's own bookkeeping written as a `user` line (the local-command
    /// caveat, injected context) — not something the user typed.
    #[serde(rename = "isMeta", default)]
    is_meta: bool,
    message: Option<Msg>,
    /// A tool's structured result. Only a Task's is read, and only its
    /// `{agentId, status}` — see [`AgentResult`].
    #[serde(rename = "toolUseResult")]
    tool_use_result: Option<AgentResult>,
}

/// A `toolUseResult`'s subagent fields, when it has any.
///
/// Hand-deserialized for the same reason [`Blocks`] is: this key holds *every*
/// tool's result, and a Bash or Read result can be megabytes on a line whose
/// only interesting content is two short strings. It is also not always an
/// object (a bare string, an array), and a derived struct would fail the whole
/// line on those — costing that line its usage event. Every other shape is
/// consumed as "no agent fields".
#[derive(Default)]
struct AgentResult {
    agent_id: Option<String>,
    status: Option<String>,
}

impl<'de> Deserialize<'de> for AgentResult {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};

        #[derive(Deserialize)]
        #[serde(field_identifier)]
        enum Field {
            #[serde(rename = "agentId")]
            AgentId,
            #[serde(rename = "status")]
            Status,
            #[serde(other)]
            Other,
        }

        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = AgentResult;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a tool result")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<AgentResult, A::Error> {
                let mut out = AgentResult::default();
                while let Some(key) = map.next_key::<Field>()? {
                    match key {
                        Field::AgentId => {
                            out.agent_id = map
                                .next_value::<serde_json::Value>()?
                                .as_str()
                                .map(str::to_string)
                        }
                        Field::Status => {
                            out.status = map
                                .next_value::<serde_json::Value>()?
                                .as_str()
                                .map(str::to_string)
                        }
                        Field::Other => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(out)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<AgentResult, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(AgentResult::default())
            }

            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<AgentResult, E> {
                Ok(AgentResult::default())
            }

            fn visit_unit<E: serde::de::Error>(self) -> Result<AgentResult, E> {
                Ok(AgentResult::default())
            }

            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<AgentResult, E> {
                Ok(AgentResult::default())
            }

            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<AgentResult, E> {
                Ok(AgentResult::default())
            }

            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<AgentResult, E> {
                Ok(AgentResult::default())
            }

            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<AgentResult, E> {
                Ok(AgentResult::default())
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize)]
struct Msg {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
    content: Option<Blocks>,
}

/// The prose of a message's `content`, one entry per text block: a bare string
/// is one block; an array contributes its `text` / `input_text` / `output_text`
/// blocks (Claude's and Codex's names) and nothing from `tool_use` /
/// `tool_result` / `thinking` ones.
///
/// Deserialized by hand rather than through `serde_json::Value` or an untagged
/// enum: both would buffer the whole value, and a tool result's payload can be
/// megabytes on a line whose only text is one sentence. This visitor allocates
/// for the text blocks alone and lets serde skip the rest.
pub(crate) struct Blocks(pub Vec<String>);

impl<'de> Deserialize<'de> for Blocks {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::{IgnoredAny, SeqAccess, Visitor};

        /// One content element. Anything that isn't a `{type, text}` object — a
        /// bare string, a number, an object whose `text` isn't a string — is
        /// consumed as no prose rather than failing the line: a malformed element
        /// must not cost the line its usage event.
        struct Block {
            kind: Option<String>,
            text: Option<String>,
        }

        impl<'de> Deserialize<'de> for Block {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                #[derive(Deserialize)]
                #[serde(field_identifier, rename_all = "lowercase")]
                enum Field {
                    Type,
                    Text,
                    #[serde(other)]
                    Other,
                }

                struct BV;
                impl<'de> Visitor<'de> for BV {
                    type Value = Block;

                    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                        f.write_str("a content block")
                    }

                    fn visit_map<A: serde::de::MapAccess<'de>>(
                        self,
                        mut map: A,
                    ) -> Result<Block, A::Error> {
                        let mut block = Block {
                            kind: None,
                            text: None,
                        };
                        while let Some(key) = map.next_key::<Field>()? {
                            match key {
                                Field::Type => {
                                    block.kind = map
                                        .next_value::<serde_json::Value>()?
                                        .as_str()
                                        .map(str::to_string)
                                }
                                Field::Text => {
                                    block.text = map
                                        .next_value::<serde_json::Value>()?
                                        .as_str()
                                        .map(str::to_string)
                                }
                                Field::Other => {
                                    map.next_value::<IgnoredAny>()?;
                                }
                            }
                        }
                        Ok(block)
                    }

                    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Block, A::Error> {
                        while seq.next_element::<IgnoredAny>()?.is_some() {}
                        Ok(Block {
                            kind: None,
                            text: None,
                        })
                    }

                    fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Block, E> {
                        Ok(Block {
                            kind: None,
                            text: None,
                        })
                    }

                    fn visit_unit<E: serde::de::Error>(self) -> Result<Block, E> {
                        Ok(Block {
                            kind: None,
                            text: None,
                        })
                    }

                    fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Block, E> {
                        Ok(Block {
                            kind: None,
                            text: None,
                        })
                    }

                    fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Block, E> {
                        Ok(Block {
                            kind: None,
                            text: None,
                        })
                    }

                    fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Block, E> {
                        Ok(Block {
                            kind: None,
                            text: None,
                        })
                    }

                    fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Block, E> {
                        Ok(Block {
                            kind: None,
                            text: None,
                        })
                    }
                }
                d.deserialize_any(BV)
            }
        }

        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Blocks;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a string or an array of content blocks")
            }

            fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<Blocks, E> {
                Ok(Blocks(vec![s.to_string()]))
            }

            fn visit_string<E: serde::de::Error>(self, s: String) -> Result<Blocks, E> {
                Ok(Blocks(vec![s]))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Blocks, A::Error> {
                let mut out = Vec::new();
                while let Some(block) = seq.next_element::<Block>()? {
                    let (Some("text" | "input_text" | "output_text"), Some(text)) =
                        (block.kind.as_deref(), block.text)
                    else {
                        continue;
                    };
                    out.push(text);
                }
                Ok(Blocks(out))
            }

            // Any other shape carries no prose — consume it rather than fail the
            // line, which would also drop its usage.
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Blocks, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Blocks(Vec::new()))
            }

            fn visit_unit<E: serde::de::Error>(self) -> Result<Blocks, E> {
                Ok(Blocks(Vec::new()))
            }

            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Blocks, E> {
                Ok(Blocks(Vec::new()))
            }

            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Blocks, E> {
                Ok(Blocks(Vec::new()))
            }

            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Blocks, E> {
                Ok(Blocks(Vec::new()))
            }

            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Blocks, E> {
                Ok(Blocks(Vec::new()))
            }
        }
        d.deserialize_any(V)
    }
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

    /// Field-wise max — how the rows sharing one dedup key are folded together
    /// (see [`aggregate`]).
    fn max_of(self, other: &Toks) -> Toks {
        Toks {
            input: self.input.max(other.input),
            output: self.output.max(other.output),
            cache_read: self.cache_read.max(other.cache_read),
            cache_5m: self.cache_5m.max(other.cache_5m),
            cache_1h: self.cache_1h.max(other.cache_1h),
        }
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

/// What identifies one billable turn across every file it appears in: its
/// `message.id`, plus the `requestId` (possibly absent) so genuinely distinct
/// turns sharing an id stay separate. `None` for a turn without an id — a
/// resumed session copies prior turns into a new file, and only an id lets those
/// be recognised as the same turn.
fn dedup_key(e: &Ev) -> Option<String> {
    let id = e.id.as_ref()?;
    Some(format!(
        "{id}\u{0}{}",
        e.request_id.as_deref().unwrap_or("")
    ))
}

/// The most recent turn's context size (only meaningful for a *main* transcript).
#[derive(Clone)]
struct Ctx {
    tokens: f64,
    ts_ms: i64,
    model: String,
}

/// The conversation's shape, for the Trees session history — folded in by the
/// same incremental parse as the usage events, so it costs no second read.
#[derive(Clone, Default)]
struct Summary {
    /// The first user prompt (one line, capped — see [`one_line`]).
    title: Option<String>,
    /// That same prompt in full, capped at [`FULL_PROMPT_CHARS`] — what the
    /// expanded row shows. Captured here rather than by a second read: the line
    /// it comes from is already in hand when `title` is set.
    first_prompt: Option<String>,
    /// Whether [`Self::first_prompt`] was cut at the cap.
    first_prompt_truncated: bool,
    /// The latest prose from either side, trimmed likewise, and whose it is.
    last_message: Option<String>,
    last_from: Option<LastMessageFrom>,
    /// The last [`RECENT_TURNS`] display lines with their authors, oldest first.
    recent: VecDeque<(LastMessageFrom, String)>,
    /// User + assistant lines carrying prose.
    message_count: u32,
    /// Timestamps of the first and last user/assistant lines.
    first_ts_ms: Option<i64>,
    last_ts_ms: Option<i64>,
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
    summary: Summary,
    /// The last status this transcript reported for each Task subagent it
    /// spawned, keyed by agent id — a subagent's own transcript never records
    /// how it ended, only its parent does. Raw CLI vocabulary; mapped at the
    /// edge by [`SubagentStatus::from_report`]. Empty for a subagent transcript.
    agent_status: HashMap<String, String>,
}

/// Cap on the summary's title / last message.
const SUMMARY_CHARS: usize = 120;

/// Cap on the *full* first prompt kept in [`Summary::first_prompt`]. Generous
/// enough that a real prompt survives whole, bounded because this rides in the
/// per-file cache: a pasted stack trace or a subagent brief runs to tens of KB,
/// and the cache holds one entry per transcript the user has ever run.
const FULL_PROMPT_CHARS: usize = 8_000;

/// How many trailing messages [`Summary::recent`] keeps.
const RECENT_TURNS: usize = 3;

/// Opening-tag names of the turns a *harness* writes into the transcript with
/// the `user` role — slash-command echoes, hook output, injected notifications.
/// Every entry was observed in a real transcript.
///
/// This is an observed-tag list on purpose, **not** a general "the line starts
/// with an XML tag" filter: a prompt that genuinely opens with `<my-element>`
/// is something a person typed, and a generic filter would silently swallow it
/// as the session's title. Widen the list when a new injected tag shows up;
/// don't replace it with a shape test.
const INJECTED_TAGS: &[&str] = &[
    "agent-message",
    "bash-input",
    "bash-stderr",
    "bash-stdout",
    "command-args",
    "command-message",
    "command-name",
    "cross-session-message",
    "fork-boilerplate",
    "system-reminder",
    "task-notification",
    "teammate-message",
    "user-memory-input",
    "user-prompt-submit-hook",
];

/// Injected-tag families matched by prefix, where the tail varies:
/// `local-command-stdout` / `-stderr` / `-caveat` are all one shape.
const INJECTED_TAG_PREFIXES: &[&str] = &["local-command-"];

/// Injected turns that open with prose rather than a tag — matched against the
/// start of the line, case-insensitively, for the same reason as
/// [`INJECTED_TAGS`]: an observed list, never a general shape.
const INJECTED_PREFIXES: &[&str] = &[
    "<channel source=",
    "[request interrupted",
    "a message arrived from ",
    "another claude session sent a message",
    "no response requested.",
    "caveat: the messages below",
    "this session is being continued from a previous conversation",
];

/// ASCII-case-insensitive `starts_with`, over bytes so a multi-byte boundary
/// can't panic the slice.
fn starts_with_ci(haystack: &str, needle: &str) -> bool {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    h.len() >= n.len() && h[..n.len()].eq_ignore_ascii_case(n)
}

/// [`starts_with_ci`]'s counterpart.
fn ends_with_ci(haystack: &str, needle: &str) -> bool {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    h.len() >= n.len() && h[h.len() - n.len()..].eq_ignore_ascii_case(n)
}

/// The name of the XML-ish tag a line opens with, if it opens with one:
/// everything between `<` and the first `>`, `/` or space.
fn opening_tag(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('<')?;
    let end = rest.find(|c: char| c == '>' || c == '/' || c.is_whitespace())?;
    Some(&rest[..end])
}

/// Whether a display line is harness bookkeeping rather than a typed prompt.
fn is_harness_injected(line: &str) -> bool {
    if INJECTED_PREFIXES.iter().any(|p| starts_with_ci(line, p)) {
        return true;
    }
    let Some(tag) = opening_tag(line) else {
        return false;
    };
    INJECTED_TAGS.iter().any(|t| tag.eq_ignore_ascii_case(t))
        || INJECTED_TAG_PREFIXES
            .iter()
            .any(|p| starts_with_ci(tag, p))
        // `mcp-<server>-update`: the server's name sits inside the tag, so the
        // length floor is what keeps `mcp--update` (no server) from matching.
        || (starts_with_ci(tag, "mcp-")
            && ends_with_ci(tag, "-update")
            && tag.len() > "mcp--update".len())
}

/// A message's prose as one display line: its first non-empty line, capped at
/// [`SUMMARY_CHARS`] chars (an ellipsis marks the cut — taken by `char`, so a
/// multi-byte boundary can't be split). `None` for text with no prose, and for
/// the turns a harness wrote as `user` lines — see [`INJECTED_TAGS`]. Those
/// carry `isMeta` only sometimes (`<task-notification>` and
/// `[Request interrupted…]` don't), so the caller's `isMeta` check can't be the
/// only gate.
pub(crate) fn one_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    if is_harness_injected(line) {
        return None;
    }
    let mut chars = line.chars();
    let mut out: String = chars.by_ref().take(SUMMARY_CHARS).collect();
    if chars.next().is_some() {
        out.pop();
        out.push('…');
    }
    Some(out)
}

/// `text` trimmed to at most `max` **chars** (never bytes — a byte cut can split
/// a multi-byte boundary), with a flag saying whether anything was dropped.
fn cap_chars(text: &str, max: usize) -> (String, bool) {
    let mut chars = text.chars();
    let out: String = chars.by_ref().take(max).collect();
    (out, chars.next().is_some())
}

/// The single field of a `<task-notification>` block, e.g. `<status>` — the
/// shape a *background* Task's completion is reported in (a synchronous one
/// reports through `toolUseResult` instead). Plain slicing rather than a regex:
/// the workspace carries no regex dependency, and these tags never nest.
fn tag_value<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let rest = &text[text.find(&open)? + open.len()..];
    Some(&rest[..rest.find(&format!("</{tag}>"))?])
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

    let (mut events, mut context, mut cwd, mut summary, mut agent_status) = match base {
        Some(b) => (
            b.events.clone(),
            b.context.clone(),
            b.cwd.clone(),
            b.summary.clone(),
            b.agent_status.clone(),
        ),
        None => (Vec::new(), None, None, Summary::default(), HashMap::new()),
    };
    for line in text.lines() {
        let Ok(l) = serde_json::from_str::<Line>(line) else {
            continue; // partial/metadata line
        };
        if cwd.is_none() {
            cwd = l.cwd;
        }
        // A synchronous Task's verdict. Last-wins: a re-run under the same agent
        // id supersedes what the earlier one reported.
        if let Some(r) = &l.tool_use_result {
            if let (Some(id), Some(status)) = (&r.agent_id, &r.status) {
                agent_status.insert(id.clone(), status.clone());
            }
        }
        let is_user = l.kind.as_deref() == Some("user");
        let is_assistant = l.kind.as_deref() == Some("assistant");
        if is_user || is_assistant {
            if let Some(ts) = l.timestamp.as_deref().map(parse_ts).filter(|t| *t > 0) {
                summary.first_ts_ms.get_or_insert(ts);
                summary.last_ts_ms = Some(summary.last_ts_ms.map_or(ts, |cur| cur.max(ts)));
            }
            let blocks = l.message.as_ref().and_then(|m| m.content.as_ref());
            // A *background* Task reports through an injected `<task-notification>`
            // user turn, which `one_line` deliberately refuses as prose — so read
            // it off the raw blocks, before the prose filter.
            if is_user {
                for text in blocks.iter().flat_map(|c| c.0.iter()) {
                    if !text.trim_start().starts_with("<task-notification>") {
                        continue;
                    }
                    if let (Some(id), Some(status)) =
                        (tag_value(text, "task-id"), tag_value(text, "status"))
                    {
                        agent_status.insert(id.to_string(), status.to_string());
                    }
                }
            }
            // The block the display line came from, kept so the full prompt can
            // be taken from it without a second pass over the file.
            let prose = blocks
                .filter(|_| !l.is_meta)
                .and_then(|c| c.0.iter().find_map(|b| one_line(b).map(|line| (line, b))));
            if let Some((prose, block)) = prose {
                summary.message_count += 1;
                let from = if is_user {
                    LastMessageFrom::You
                } else {
                    LastMessageFrom::Agent
                };
                if is_user && summary.title.is_none() {
                    summary.title = Some(prose.clone());
                    let (full, cut) = cap_chars(block.trim(), FULL_PROMPT_CHARS);
                    summary.first_prompt = Some(full);
                    summary.first_prompt_truncated = cut;
                }
                summary.recent.push_back((from, prose.clone()));
                while summary.recent.len() > RECENT_TURNS {
                    summary.recent.pop_front();
                }
                // Lines are chronological: the latest prose wins, whoever's.
                summary.last_from = Some(from);
                summary.last_message = Some(prose);
            }
        }
        if !is_assistant {
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
            summary,
            agent_status,
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
    let recent: usize = fd.summary.recent.iter().map(|(_, t)| t.len()).sum();
    // Bounded per entry (one short id + one short word each), but a session can
    // spawn many subagents, so it is counted rather than assumed negligible.
    let statuses: usize = fd
        .agent_status
        .iter()
        .map(|(id, s)| id.len() + s.len() + std::mem::size_of::<(String, String)>())
        .sum();
    events
        + fd.project.len()
        + opt(&fd.cwd)
        + fd.session_id.len()
        + opt(&fd.summary.title)
        + opt(&fd.summary.first_prompt)
        + opt(&fd.summary.last_message)
        + recent
        + statuses
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

/// Parse every transcript in `paths` through the cache, then drop cache entries
/// for files that are no longer on disk. For a *full* scan only — `paths` must
/// be every transcript there is, or the prune evicts the rest. A targeted read
/// of a few files goes through [`load_files`].
fn load_cached(paths: &[PathBuf], on_progress: impl Fn(usize, usize)) -> Vec<Arc<FileData>> {
    let out = load_files(paths, on_progress);
    // `paths` is a fresh scan of every transcript on disk, so anything else still
    // in the cache is a file Claude has since pruned.
    let live: HashSet<&PathBuf> = paths.iter().collect();
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain_existing(&live);
    out
}

/// Parse the transcripts in `paths`, serving unchanged ones from the cache and
/// extending a grown one from its previous parse. Leaves the rest of the cache
/// alone.
fn load_files(paths: &[PathBuf], on_progress: impl Fn(usize, usize)) -> Vec<Arc<FileData>> {
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

    // Claude Code streams several assistant rows under one `message.id`, and a
    // later row can carry a fuller `usage` than the first — the earlier ones are
    // written mid-turn, before the totals are final. First-wins therefore
    // undercounts (output most of all), so fold every row sharing a key into a
    // field-wise max up front and let the first occurrence own the attribution
    // (its session, model and timestamp bucket).
    let mut folded: HashMap<String, Toks> = HashMap::new();
    for f in files {
        for e in &f.events {
            if let Some(key) = dedup_key(e) {
                folded
                    .entry(key)
                    .and_modify(|t| *t = t.max_of(&e.toks))
                    .or_insert(e.toks);
            }
        }
    }

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
            // A keyed turn is counted once — a resumed session copies prior
            // turns into a new file, and they'd otherwise double-count — with
            // the folded numbers, not this row's.
            let toks = match dedup_key(e) {
                Some(key) => {
                    let merged = folded.get(&key).copied().unwrap_or(e.toks);
                    if !seen.insert(key) {
                        continue;
                    }
                    merged
                }
                None => e.toks,
            };
            total.add(table, &e.model, &toks);
            if e.ts_ms >= today_start {
                today.add(table, &e.model, &toks);
            }
            if e.ts_ms >= week_start {
                week.add(table, &e.model, &toks);
            }
            if e.ts_ms >= month_start {
                month.add(table, &e.model, &toks);
            }
            by_model
                .entry(e.model.clone())
                .or_default()
                .add(table, &e.model, &toks);
            sess.acc.add(table, &e.model, &toks);
            sess.models
                .entry(e.model.clone())
                .or_default()
                .add(table, &e.model, &toks);
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

// ── Per-worktree session history ────────────────────────────────────────────

/// Whether a session's `cwd` belongs to the worktree at `root`: that directory
/// or one beneath it — except another santree worktree nested under it. The
/// repo root holds `.santree/worktrees/*`, and those sessions are their own
/// worktrees', not the base checkout's.
pub(crate) fn cwd_belongs_to(cwd: &str, root: &Path) -> bool {
    let Ok(rest) = Path::new(cwd).strip_prefix(root) else {
        return false;
    };
    // Lexical, so the remainder must be plain descent: a `..` in a recorded cwd
    // would otherwise "belong" here while pointing anywhere.
    rest.components()
        .all(|c| matches!(c, std::path::Component::Normal(name) if name != ".santree"))
}

/// Bytes of a transcript's head read to learn its `cwd` before committing to a
/// full parse. The first lines are the session's opening bookkeeping and prompt,
/// which carry it; a transcript whose head is one oversized line falls through to
/// the full parse (see [`worktree_summaries`]).
const PEEK_BYTES: u64 = 256 * 1024;

/// The `cwd` on the first line of the transcript that has one, from its head only.
fn peek_cwd(path: &Path) -> Option<String> {
    use std::io::Read;

    #[derive(Deserialize)]
    struct CwdLine {
        cwd: Option<String>,
    }

    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(PEEK_BYTES)
        .read_to_end(&mut buf)
        .ok()?;
    let complete = buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    String::from_utf8_lossy(&buf[..complete])
        .lines()
        .filter_map(|l| serde_json::from_str::<CwdLine>(l).ok())
        .find_map(|l| l.cwd)
}

/// The model that did most of a session's work — by tokens, the same "primary"
/// the Usage panel badges — so the two surfaces never disagree.
fn primary_model(events: &[Ev]) -> Option<String> {
    let mut by_model: HashMap<&str, f64> = HashMap::new();
    for e in events.iter().filter(|e| !e.model.is_empty()) {
        let t = &e.toks;
        *by_model.entry(&e.model).or_default() +=
            t.input + t.output + t.cache_read + t.cache_write();
    }
    by_model
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(m, _)| m.to_string())
}

/// How many subagent transcripts a main transcript has: the `agent-<id>.jsonl`
/// files directly under `<dir>/<session-id>/subagents/`, the tree `classify`
/// folds into the session.
///
/// Claude names every Task subagent transcript `agent-<id>.jsonl`, and the same
/// directory holds other things — `agent-<id>.meta.json` sidecars, a `workflows/`
/// subdirectory. Counting entries rather than transcripts would let the badge
/// disagree with the list it stands for, so match the name Claude actually
/// writes: direct children only, no recursion.
fn subagent_count(main: &Path) -> u32 {
    subagent_files(main).len() as u32
}

/// `<dir>/<session-id>/subagents/` for a main transcript at `<dir>/<sid>.jsonl`.
fn subagents_dir(main: &Path) -> Option<PathBuf> {
    main.parent()
        .zip(main.file_stem())
        .map(|(dir, stem)| dir.join(stem).join("subagents"))
}

/// The subagent transcripts of a main transcript, sorted by name so the listing
/// is stable across reads. **The one predicate**: [`subagent_count`] is its
/// length, so the badge and the expanded list can never disagree.
///
/// Containment is enforced at both levels, because `canonicalize` *resolves* a
/// symlink rather than refusing it:
///
/// * **The directory.** Its canonical form must still sit under the transcript's
///   own canonical project directory, so a `<sid>` or `<sid>/subagents` planted
///   as a link to somewhere else lists nothing. Canonicalizing first is what
///   makes this a containment test and not a textual one — `starts_with` alone
///   would pass `<dir>/../../etc`.
/// * **Each entry.** `DirEntry::file_type` does not follow links, so a symlinked
///   `agent-x.jsonl` is not a file and never lists; and each survivor is
///   canonicalized and required to still sit *directly* in that directory.
fn subagent_files(main: &Path) -> Vec<PathBuf> {
    let Some(project) = main.parent().and_then(|p| p.canonicalize().ok()) else {
        return Vec::new();
    };
    let Some(dir) = subagents_dir(main)
        .and_then(|d| d.canonicalize().ok())
        .filter(|d| d.starts_with(&project))
    else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with("agent-") && n.ends_with(".jsonl"))
        })
        .filter_map(|e| e.path().canonicalize().ok())
        .filter(|p| p.parent() == Some(dir.as_path()))
        .collect();
    out.sort();
    out
}

/// Summaries of the Claude sessions that ran in `worktree`, keyed by session id:
/// the `known` ones from the terminal registry (`(cwd, session_id)`, read from
/// wherever their `cwd` says they ran) plus every transcript on disk whose `cwd`
/// is the worktree or a directory under it. Blocking (disk + parse) — call from
/// `spawn_blocking`.
///
/// Only the project dirs whose slug is the worktree's, or extends it (a subdir
/// cwd), are looked at — never the whole transcript tree — and each candidate is
/// confirmed by its `cwd` before parsing, so a sibling checkout whose name merely
/// extends this one's isn't read. The parses go through the shared transcript
/// cache, so a session the Usage panel already read isn't parsed again.
pub(crate) fn worktree_summaries(
    worktree: &Path,
    known: &[(String, String)],
    table: &PriceTable,
) -> HashMap<String, SessionSummary> {
    summaries_in(&projects_roots(), worktree, known, table)
}

/// The main transcripts that could belong to `worktree`, and which of them the
/// terminal registry vouched for: `(paths, registered)`. Only the project dirs
/// whose slug is the worktree's, or extends it (a subdir cwd), are looked at,
/// and a candidate whose *head* names a foreign `cwd` is dropped before any full
/// parse. Belonging is still confirmed from the parse — a head with no `cwd`
/// survives to be decided there.
fn candidate_transcripts(
    roots: &[PathBuf],
    worktree: &Path,
    known: &[(String, String)],
) -> (Vec<PathBuf>, HashSet<PathBuf>) {
    let slug = crate::session::project_slug(&worktree.to_string_lossy());
    let subdir_prefix = format!("{slug}-");
    let mut paths: Vec<PathBuf> = Vec::new();
    // Registry sessions: listed on the registry's word, wherever they ran.
    let mut registered: HashSet<PathBuf> = HashSet::new();
    for root in roots {
        for (cwd, session_id) in known {
            let p = root
                .join(crate::session::project_slug(cwd))
                .join(format!("{session_id}.jsonl"));
            if p.is_file() && registered.insert(p.clone()) {
                paths.push(p);
            }
        }
        let Ok(dirs) = std::fs::read_dir(root) else {
            continue;
        };
        for dir in dirs.flatten() {
            let name = dir.file_name();
            let name = name.to_string_lossy();
            // A real directory only (no symlinks), as `collect_jsonl` walks.
            if (name != slug && !name.starts_with(&subdir_prefix))
                || !dir.file_type().is_ok_and(|t| t.is_dir())
            {
                continue;
            }
            let Ok(files) = std::fs::read_dir(dir.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                let is_main = f.file_type().is_ok_and(|t| t.is_file())
                    && p.extension().and_then(|x| x.to_str()) == Some("jsonl");
                if !is_main || registered.contains(&p) || paths.contains(&p) {
                    continue;
                }
                if peek_cwd(&p).is_some_and(|cwd| !cwd_belongs_to(&cwd, worktree)) {
                    continue;
                }
                paths.push(p);
            }
        }
    }
    (paths, registered)
}

/// [`worktree_summaries`] over explicit `projects` roots (tests pin them).
fn summaries_in(
    roots: &[PathBuf],
    worktree: &Path,
    known: &[(String, String)],
    table: &PriceTable,
) -> HashMap<String, SessionSummary> {
    let (paths, registered) = candidate_transcripts(roots, worktree, known);
    let mut out = HashMap::new();
    for p in &paths {
        // One file at a time: `load_files` skips what it can't parse, so a batch
        // result wouldn't line up with `paths`.
        let Some(fd) = load_files(std::slice::from_ref(p), |_, _| {}).pop() else {
            continue;
        };
        let belongs = registered.contains(p)
            || fd
                .cwd
                .as_deref()
                .is_some_and(|cwd| cwd_belongs_to(cwd, worktree));
        if !belongs {
            continue;
        }
        let s = &fd.summary;
        out.insert(
            fd.session_id.clone(),
            SessionSummary {
                title: s.title.clone(),
                last_message: s.last_message.clone(),
                last_message_from: s.last_from,
                message_count: s.message_count,
                subagent_count: subagent_count(p),
                model: primary_model(&fd.events),
                started_at_ms: s.first_ts_ms,
                last_activity_ms: s.last_ts_ms,
                spend: Some(session_spend(p, &fd, table)),
            },
        );
    }
    out
}

/// One session's tokens and cost: its main transcript plus the subagent
/// transcripts that fold into it, deduped by `(message.id, requestId)` with the
/// field-wise max — the same rule [`aggregate`] applies globally, so the two
/// surfaces report the same number for the same session.
///
/// A model absent from the price table contributes tokens but **no** cost, and
/// says so with `None` rather than a `0` the UI would render as "free".
fn session_spend(main: &Path, fd: &FileData, table: &PriceTable) -> SessionSpend {
    let subs = load_files(&subagent_files(main), |_, _| {});
    let files: Vec<&FileData> = std::iter::once(fd)
        .chain(subs.iter().map(|a| a.as_ref()))
        .collect();

    let mut folded: HashMap<String, Toks> = HashMap::new();
    for f in &files {
        for e in &f.events {
            if let Some(key) = dedup_key(e) {
                folded
                    .entry(key)
                    .and_modify(|t| *t = t.max_of(&e.toks))
                    .or_insert(e.toks);
            }
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    // `(tokens, cost)` per model; cost stays `None` until a priced turn adds to it.
    let mut by_model: HashMap<&str, (f64, Option<f64>)> = HashMap::new();
    for f in &files {
        for e in &f.events {
            let toks = match dedup_key(e) {
                Some(key) => {
                    let merged = folded.get(&key).copied().unwrap_or(e.toks);
                    if !seen.insert(key) {
                        continue;
                    }
                    merged
                }
                None => e.toks,
            };
            let entry = by_model.entry(&e.model).or_insert((0.0, None));
            entry.0 += toks.input + toks.output + toks.cache_read + toks.cache_write();
            if table.lookup(&e.model).is_some() {
                *entry.1.get_or_insert(0.0) += cost_for(table, &e.model, &toks);
            }
        }
    }

    let mut models: Vec<SessionModelSpend> = by_model
        .into_iter()
        .map(|(model, (total_tokens, cost_usd))| SessionModelSpend {
            model: model.to_string(),
            total_tokens,
            cost_usd,
        })
        .collect();
    models.sort_by(|a, b| {
        b.total_tokens
            .partial_cmp(&a.total_tokens)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let total_tokens = models.iter().map(|m| m.total_tokens).sum();
    let cost_usd = models
        .iter()
        .filter_map(|m| m.cost_usd)
        .reduce(|a, b| a + b);
    SessionSpend {
        total_tokens,
        cost_usd,
        models,
    }
}

// ── Expanded session detail (Trees history row) ─────────────────────────────

/// The main transcript of `session_id` within `worktree`, or `None` when it has
/// none on disk.
///
/// `session_id` is only ever *compared* against a candidate's file stem — never
/// joined onto a path — so a caller cannot steer the read with it. The candidate
/// set is the same one the history listing is built from.
pub(crate) fn worktree_transcript(
    worktree: &Path,
    known: &[(String, String)],
    session_id: &str,
) -> Option<PathBuf> {
    transcript_in(&projects_roots(), worktree, known, session_id)
}

/// [`worktree_transcript`] over explicit `projects` roots (tests pin them).
fn transcript_in(
    roots: &[PathBuf],
    worktree: &Path,
    known: &[(String, String)],
    session_id: &str,
) -> Option<PathBuf> {
    let (paths, registered) = candidate_transcripts(roots, worktree, known);
    paths.into_iter().find(|p| {
        if p.file_stem().and_then(|s| s.to_str()) != Some(session_id) {
            return false;
        }
        // Registry rows are vouched for; anything found by scanning has to say
        // it ran here, exactly as `summaries_in` decides.
        registered.contains(p)
            || load_files(std::slice::from_ref(p), |_, _| {})
                .pop()
                .and_then(|fd| fd.cwd.clone())
                .is_some_and(|cwd| cwd_belongs_to(&cwd, worktree))
    })
}

/// What the expanded history row shows for one session, from the same cached
/// parse the list already paid for. Blocking (disk) — call from `spawn_blocking`.
pub(crate) fn session_detail(main: &Path) -> SessionDetail {
    let Some(fd) = load_files(std::slice::from_ref(&main.to_path_buf()), |_, _| {}).pop() else {
        return SessionDetail::default();
    };
    let s = &fd.summary;
    SessionDetail {
        first_prompt: s.first_prompt.clone(),
        first_prompt_truncated: s.first_prompt_truncated,
        recent_turns: s
            .recent
            .iter()
            .map(|(from, text)| SessionTurn {
                from: *from,
                text: text.clone(),
            })
            .collect(),
        cwd: fd.cwd.clone(),
    }
}

/// A transcript is treated as still running when it was written to within this
/// window and no terminal status was reported for it. Long enough to cover a
/// subagent thinking between tool calls, short enough that yesterday's crashed
/// run doesn't claim to be live.
const RUNNING_WINDOW_MS: i64 = 5 * 60 * 1000;

/// Map a CLI-reported status word onto the domain enum. `None` for anything
/// non-terminal (`async_launched`, which only says the Task started) or
/// unrecognised — the caller then falls back to the freshness window, and an
/// unknown status must never be guessed into a verdict.
fn terminal_status(reported: &str) -> Option<SubagentStatus> {
    match reported {
        "completed" => Some(SubagentStatus::Completed),
        "failed" => Some(SubagentStatus::Failed),
        // The CLI's two words for "it did not finish on its own".
        "killed" | "stopped" => Some(SubagentStatus::Stopped),
        _ => None,
    }
}

/// The `{agentType, description, parentAgentId, spawnDepth}` sidecar Claude
/// writes beside each subagent transcript. Every field is optional: a missing or
/// corrupt sidecar must cost the row its metadata, never its listing.
#[derive(Deserialize, Default)]
struct SubagentMeta {
    #[serde(rename = "agentType")]
    agent_type: Option<String>,
    description: Option<String>,
    #[serde(rename = "parentAgentId")]
    parent_agent_id: Option<String>,
    #[serde(rename = "spawnDepth")]
    spawn_depth: Option<u32>,
}

/// The Task subagents of one Claude session, with the spawn relationships the
/// sidecars record — `parentAgentId` and `spawnDepth`, which is what lets the
/// pane draw the real tree instead of a flat list.
///
/// Status comes from whichever transcript *spawned* the subagent, since that is
/// the only record of how it ended (see [`FileData::agent_status`]). That is the
/// main transcript for a depth-1 agent and a **sibling subagent's** transcript
/// for anything deeper, so every transcript in the session contributes its
/// reports — an agent id appears in exactly one of them. With no terminal report,
/// a transcript touched inside [`RUNNING_WINDOW_MS`] reads as running and
/// anything older stays `Unknown`.
///
/// Blocking (disk + parse) — call from `spawn_blocking`.
pub(crate) fn session_subagents(main: &Path, now_ms: i64) -> Vec<SessionSubagent> {
    let files = subagent_files(main);
    if files.is_empty() {
        return Vec::new();
    }
    // Every transcript in the session, parsed once through the shared cache; the
    // per-row reads below are then cache hits. Order doesn't matter here — an
    // agent id is reported by exactly one transcript.
    let mut reported: HashMap<String, String> = HashMap::new();
    for fd in load_files(std::slice::from_ref(&main.to_path_buf()), |_, _| {})
        .iter()
        .chain(load_files(&files, |_, _| {}).iter())
    {
        reported.extend(
            fd.agent_status
                .iter()
                .map(|(id, s)| (id.clone(), s.clone())),
        );
    }

    files
        .iter()
        .map(|path| {
            // `agent-<id>.jsonl` — the stem past the prefix is the agent id.
            let agent_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("agent-"))
                .unwrap_or_default()
                .to_string();
            let meta: SubagentMeta = std::fs::read_to_string(path.with_extension("meta.json"))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();
            let last_activity_ms = std::fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            let status = reported
                .get(&agent_id)
                .and_then(|s| terminal_status(s))
                .unwrap_or_else(|| match last_activity_ms {
                    Some(ms) if now_ms - ms < RUNNING_WINDOW_MS => SubagentStatus::Running,
                    _ => SubagentStatus::Unknown,
                });
            let message_count = load_files(std::slice::from_ref(path), |_, _| {})
                .pop()
                .map_or(0, |fd| fd.summary.message_count);
            SessionSubagent {
                agent_id,
                parent_agent_id: meta.parent_agent_id,
                // Claude's depth is 1-based; treat a missing one as top level
                // rather than inventing a `0` tier the tree would have to
                // special-case.
                depth: meta.spawn_depth.unwrap_or(1).max(1),
                agent_type: meta.agent_type,
                description: meta.description,
                message_count,
                status,
                last_activity_ms: last_activity_ms.map(|ms| ms as f64),
            }
        })
        .collect()
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
        file_in(project, sid, None, events, context)
    }

    /// Same, with the transcript's real `cwd` — the input `resolve_location`
    /// resolves a session's repo and worktree from.
    fn file_in(
        project: &str,
        sid: &str,
        cwd: Option<&str>,
        events: Vec<Ev>,
        context: Option<Ctx>,
    ) -> Arc<FileData> {
        Arc::new(FileData {
            project: project.into(),
            cwd: cwd.map(str::to_string),
            session_id: sid.into(),
            events,
            context,
            summary: Summary::default(),
            agent_status: HashMap::new(),
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

    /// Claude streams repeated rows for one turn and the later ones can carry a
    /// fuller `usage`, so the fold has to be a field-wise max — first-wins would
    /// bill the mid-turn snapshot.
    #[test]
    fn repeated_rows_for_one_turn_take_the_largest_of_each_field() {
        let partial = ev("dup", "claude-sonnet-4-5", NOW, 10.0, 4.0, 100.0, 7.0);
        let mut complete = ev("dup", "claude-sonnet-4-5", NOW, 10.0, 900.0, 80.0, 7.0);
        complete.toks.cache_1h = 5.0;
        let f = file("-repo", "s1", vec![partial, complete], None);

        let r = aggregate(&[f], NOW, &tbl(), &[]);
        assert_eq!(r.total.output_tokens, 900.0, "the fuller row's output wins");
        assert_eq!(r.total.input_tokens, 10.0, "counted once, not summed");
        assert_eq!(
            r.total.cache_read_tokens, 100.0,
            "a field that shrank keeps its larger value"
        );
        assert_eq!(r.total.cache_write_tokens, 12.0, "5m 7 + 1h 5, both maxed");
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].totals.output_tokens, 900.0);
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

    /// The wiring, not the helper. `resolve_location` is pinned directly above,
    /// but every other `aggregate` test passes `&[]` for `repos` and a transcript
    /// with no `cwd` — so nothing proved a session's own working directory and the
    /// registered repo list ever reach it. They are what turns a transcript into a
    /// row the Usage panel can group under a repo and a worktree.
    #[test]
    fn aggregate_resolves_each_sessions_repo_and_worktree_from_its_cwd() {
        // The registered *name* deliberately differs from the folder it points at:
        // falling back to the path would yield "canary-monorepo", so the repo list
        // has to actually reach the resolver for these assertions to hold.
        let repos = vec![(
            "canary".to_string(),
            "/Users/me/src/canary-monorepo".to_string(),
        )];
        // Claude's cwd-mangled project directory. Also deliberately unlike the repo
        // name: it is what the resolver falls back to when the `cwd` is missing.
        let slug = "-Users-me-src-canary-monorepo--santree-worktrees-AK-182";
        let in_worktree = file_in(
            slug,
            "s1",
            Some("/Users/me/src/canary-monorepo/.santree/worktrees/AK-182/backend"),
            vec![ev("a", "claude-opus-4-8", NOW, 10.0, 0.0, 0.0, 0.0)],
            None,
        );
        let in_main = file_in(
            "-Users-me-src-canary-monorepo",
            "s2",
            Some("/Users/me/src/canary-monorepo"),
            vec![ev("b", "claude-opus-4-8", NOW - 1_000, 10.0, 0.0, 0.0, 0.0)],
            None,
        );

        let r = aggregate(&[in_worktree, in_main], NOW, &tbl(), &repos);
        let session = |id: &str| {
            r.sessions
                .iter()
                .find(|s| s.session_id == id)
                .unwrap_or_else(|| panic!("no session {id} in the report"))
        };

        let wt = session("s1");
        assert_eq!(wt.repo, "canary", "the registered repo, not the path");
        assert_eq!(
            wt.worktree.as_deref(),
            Some("AK-182"),
            "the worktree id under .santree/worktrees, even from a subdir"
        );

        let main = session("s2");
        assert_eq!(main.repo, "canary");
        assert_eq!(
            main.worktree, None,
            "the repo's own checkout is not a worktree"
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

    // ---- the conversation summary (Trees session history) ----

    #[test]
    fn parse_file_summarises_the_conversation() {
        let dir =
            std::env::temp_dir().join(format!("santree-usage-summary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let proj = dir.join("projects").join("-repo");
        std::fs::create_dir_all(&proj).unwrap();
        let file_path = proj.join("sess.jsonl");
        let long = "x".repeat(200);
        let content = [
            // Claude's own bookkeeping: never the title, never counted.
            r#"{"type":"user","isMeta":true,"timestamp":"2026-07-05T09:59:00.000Z","cwd":"/repo","message":{"role":"user","content":"<local-command-caveat>Caveat: generated</local-command-caveat>"}}"#.to_string(),
            r#"{"type":"user","timestamp":"2026-07-05T09:59:30.000Z","cwd":"/repo","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>"}}"#.to_string(),
            // The real first prompt: multi-line, so the title is its first line.
            r#"{"type":"user","timestamp":"2026-07-05T10:00:00.000Z","cwd":"/repo","message":{"role":"user","content":"  Fix the flaky test  \nmore context here"}}"#.to_string(),
            // Assistant text + tool call in one line: only the text counts.
            r#"{"type":"assistant","timestamp":"2026-07-05T10:00:10.000Z","requestId":"r1","cwd":"/repo","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":7},"content":[{"type":"text","text":"Looking at it."},{"type":"tool_use","id":"t1","name":"Read","input":{"path":"big"}}]}}"#.to_string(),
            // A tool result: a user line with no prose — not a message.
            r#"{"type":"user","timestamp":"2026-07-05T10:00:11.000Z","cwd":"/repo","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"lots of output"}]}}"#.to_string(),
            r#"{"type":"user","timestamp":"2026-07-05T10:01:00.000Z","cwd":"/repo","message":{"role":"user","content":[{"type":"text","text":"thanks, now push"}]}}"#.to_string(),
            format!(
                r#"{{"type":"assistant","timestamp":"2026-07-05T10:02:00.000Z","requestId":"r2","cwd":"/repo","message":{{"id":"m2","model":"claude-sonnet-5","usage":{{"input_tokens":500,"output_tokens":1}},"content":[{{"type":"text","text":"{long}"}}]}}}}"#
            ),
            "not json at all".to_string(),
        ]
        .join("\n")
            + "\n";
        std::fs::write(&file_path, content).unwrap();

        let fd = parse_file(&file_path).unwrap().data;
        let s = &fd.summary;
        assert_eq!(s.title.as_deref(), Some("Fix the flaky test"));
        let last = s.last_message.as_deref().unwrap();
        assert_eq!(last.chars().count(), SUMMARY_CHARS, "capped by char");
        assert!(last.ends_with('…'), "the cut is marked");
        assert_eq!(s.last_from, Some(LastMessageFrom::Agent));
        assert_eq!(
            s.message_count, 4,
            "two prompts + two replies; meta, command echo and tool result excluded"
        );
        assert_eq!(s.first_ts_ms, Some(parse_ts("2026-07-05T09:59:00.000Z")));
        assert_eq!(s.last_ts_ms, Some(parse_ts("2026-07-05T10:02:00.000Z")));
        assert_eq!(
            primary_model(&fd.events).as_deref(),
            Some("claude-sonnet-5"),
            "most tokens wins, not the first turn"
        );
        // The usage side is untouched by the summary parse.
        assert_eq!(fd.events.len(), 2);
        assert_eq!(fd.cwd.as_deref(), Some("/repo"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn summary_ends_on_the_users_prompt_when_it_is_last() {
        let dir =
            std::env::temp_dir().join(format!("santree-usage-summary-you-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let proj = dir.join("projects").join("-repo");
        std::fs::create_dir_all(&proj).unwrap();
        let file_path = proj.join("sess.jsonl");
        let content = [
            r#"{"type":"user","timestamp":"2026-07-05T10:00:00.000Z","cwd":"/repo","message":{"role":"user","content":"Fix the flaky test"}}"#,
            r#"{"type":"assistant","timestamp":"2026-07-05T10:00:10.000Z","cwd":"/repo","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":7},"content":[{"type":"text","text":"Done."}]}}"#,
            // The user got the last word — the session is waiting on the agent.
            r#"{"type":"user","timestamp":"2026-07-05T10:01:00.000Z","cwd":"/repo","message":{"role":"user","content":"also update the docs"}}"#,
        ]
        .join("\n")
            + "\n";
        std::fs::write(&file_path, content).unwrap();

        let s = parse_file(&file_path).unwrap().data.summary;
        assert_eq!(s.title.as_deref(), Some("Fix the flaky test"));
        assert_eq!(s.last_message.as_deref(), Some("also update the docs"));
        assert_eq!(s.last_from, Some(LastMessageFrom::You));
        assert_eq!(s.message_count, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_line_keeps_the_first_prose_line_and_cuts_on_a_char_boundary() {
        assert_eq!(one_line("  \n\n hello \nworld"), Some("hello".into()));
        assert_eq!(one_line("   "), None);
        assert_eq!(one_line("<command-name>/clear</command-name>"), None);
        assert_eq!(
            one_line("<local-command-stdout>ok</local-command-stdout>"),
            None
        );
        // Multi-byte chars: the cap counts chars, and the ellipsis keeps it ≤ cap.
        let emoji = "é".repeat(SUMMARY_CHARS + 5);
        let cut = one_line(&emoji).unwrap();
        assert_eq!(cut.chars().count(), SUMMARY_CHARS);
        assert!(cut.ends_with('…'));
        let exact = "a".repeat(SUMMARY_CHARS);
        assert_eq!(
            one_line(&exact).as_deref(),
            Some(exact.as_str()),
            "no cut at the cap"
        );
    }

    /// Shapes taken from real transcripts in `~/.claude/projects`. The ones
    /// without `isMeta` are why this filter exists at all: they reach the
    /// summary looking exactly like a prompt someone typed.
    #[test]
    fn one_line_drops_harness_injected_turns() {
        for injected in [
            "<task-notification>\n<task-id>a4d4</task-id>",
            "<system-reminder>\nAs you answer the user's questions…",
            "<user-prompt-submit-hook>advice</user-prompt-submit-hook>",
            "<user-memory-input>remember this</user-memory-input>",
            "<agent-message from=\"explorer\">found it</agent-message>",
            "<teammate-message>ping</teammate-message>",
            "<cross-session-message>hi</cross-session-message>",
            "<fork-boilerplate>…</fork-boilerplate>",
            "<bash-input>ls</bash-input>",
            "<bash-stdout>a b c</bash-stdout>",
            "<bash-stderr>boom</bash-stderr>",
            "<command-name>/clear</command-name>",
            "<command-message>compact</command-message>",
            "<command-args>--hard</command-args>",
            "<local-command-stdout>ok</local-command-stdout>",
            "<local-command-caveat>Caveat: generated</local-command-caveat>",
            "<mcp-linear-update>3 issues</mcp-linear-update>",
            "<MCP-Memory-Update>recalled</MCP-Memory-Update>",
            "<SYSTEM-REMINDER>shouting is still injected</SYSTEM-REMINDER>",
            "<channel source=\"slack\">…",
            "[Request interrupted by user]",
            "[Request interrupted by user for tool use]",
            "A message arrived from santree-bot",
            "Another Claude session sent a message",
            "No response requested.",
            "Caveat: The messages below were generated by the user while…",
            "This session is being continued from a previous conversation…",
        ] {
            assert_eq!(one_line(injected), None, "injected: {injected}");
        }

        // The list is observed tags, not a shape test: a prompt that opens with
        // an unknown tag is still something a person typed.
        for typed in [
            "<my-element> should render inline, fix it",
            "<div class=\"x\"> is being escaped twice",
            "<3 this feature, ship it",
            "commandeer the release branch",
            "mcp-linear-update is the tag I mean",
            "[Requesting] a second look at the diff",
        ] {
            assert_eq!(
                one_line(typed).as_deref(),
                Some(typed),
                "not injected: {typed}"
            );
        }
    }

    #[test]
    fn cwd_belongs_to_excludes_nested_worktrees_from_the_base() {
        let root = Path::new("/Users/me/dev/repo");
        assert!(cwd_belongs_to("/Users/me/dev/repo", root));
        assert!(cwd_belongs_to("/Users/me/dev/repo/backend", root));
        assert!(!cwd_belongs_to("/Users/me/dev/repo-old", root));
        assert!(
            !cwd_belongs_to("/Users/me/dev/repo/.santree/worktrees/AK-1", root),
            "a worktree's sessions are its own, not the base checkout's"
        );
        let wt = Path::new("/Users/me/dev/repo/.santree/worktrees/AK-1");
        assert!(cwd_belongs_to(
            "/Users/me/dev/repo/.santree/worktrees/AK-1/sub",
            wt
        ));
        assert!(!cwd_belongs_to(
            "/Users/me/dev/repo/.santree/worktrees/AK-10",
            wt
        ));
        assert!(
            !cwd_belongs_to(
                "/Users/me/dev/repo/.santree/worktrees/AK-1/../../../../other",
                wt
            ),
            "a `..` below the root is not descent"
        );
        assert!(!cwd_belongs_to(
            "/Users/me/dev/repo/.santree/worktrees/AK-1/./x/..",
            wt
        ));
    }

    #[test]
    fn worktree_summaries_finds_registry_and_on_disk_sessions_for_the_worktree() {
        let dir =
            std::env::temp_dir().join(format!("santree-usage-wt-summaries-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let projects = dir.join("projects");
        let wt = dir
            .join("repo")
            .join(".santree")
            .join("worktrees")
            .join("AK-1");
        let wt_str = wt.to_string_lossy().into_owned();
        let slug = crate::session::project_slug(&wt_str);
        let line = |cwd: &str, text: &str| {
            format!(
                r#"{{"type":"user","timestamp":"2026-07-05T10:00:00.000Z","cwd":"{cwd}","message":{{"role":"user","content":"{text}"}}}}"#
            )
        };
        // The main terminal's session (registry), one launched by hand in a
        // subdir (no registry row), and a sibling checkout `AK-1-old` — whose
        // slug extends this one's exactly like a subdir's does, so only its
        // `cwd` can tell it apart.
        let main_dir = projects.join(&slug);
        let sub_dir = projects.join(format!("{slug}-backend"));
        let sibling_dir = projects.join(format!("{slug}-old"));
        for d in [&main_dir, &sub_dir, &sibling_dir] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(
            main_dir.join("reg.jsonl"),
            line(&wt_str, "registered") + "\n",
        )
        .unwrap();
        // Claude's real layout: one `agent-<id>.jsonl` transcript beside the
        // sidecar and directory that must not be counted with it.
        let subagents = main_dir.join("reg").join("subagents");
        std::fs::create_dir_all(subagents.join("workflows")).unwrap();
        std::fs::write(subagents.join("agent-a.jsonl"), "{}\n").unwrap();
        std::fs::write(subagents.join("agent-a.meta.json"), "{}\n").unwrap();
        std::fs::create_dir_all(subagents.join("x.jsonl")).unwrap();
        std::fs::write(
            sub_dir.join("hand.jsonl"),
            line(&format!("{wt_str}/backend"), "by hand") + "\n",
        )
        .unwrap();
        std::fs::write(
            sibling_dir.join("other.jsonl"),
            line(&format!("{wt_str}-old"), "sibling") + "\n",
        )
        .unwrap();

        let got = summaries_in(&[projects], &wt, &[(wt_str.clone(), "reg".into())], &tbl());

        let mut ids: Vec<&str> = got.keys().map(String::as_str).collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            ["hand", "reg"],
            "the sibling checkout's session is not ours"
        );
        assert_eq!(got["reg"].title.as_deref(), Some("registered"));
        assert_eq!(
            got["reg"].subagent_count, 1,
            "only the agent-*.jsonl transcript counts — not its .meta.json \
             sidecar, the workflows/ dir, or a directory named x.jsonl"
        );
        assert_eq!(got["hand"].title.as_deref(), Some("by hand"));
        assert_eq!(got["hand"].subagent_count, 0);

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
    // ---- the expanded history row ----

    /// A scratch `projects/<slug>/` root with one main transcript, returning
    /// `(root dir, projects dir, worktree dir, main transcript path)`.
    fn detail_fixture(tag: &str, lines: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("santree-usage-detail-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let projects = dir.join("projects");
        let wt = dir
            .join("repo")
            .join(".santree")
            .join("worktrees")
            .join("T-1");
        let slug = crate::session::project_slug(&wt.to_string_lossy());
        let project_dir = projects.join(slug);
        std::fs::create_dir_all(&project_dir).unwrap();
        let main = project_dir.join("sess.jsonl");
        std::fs::write(&main, lines).unwrap();
        (dir, projects, wt, main)
    }

    /// A `user`/`assistant` line carrying one text block.
    fn prose_line(kind: &str, cwd: &str, text: &str) -> String {
        let text = serde_json::to_string(text).unwrap();
        format!(
            r#"{{"type":"{kind}","timestamp":"2026-07-05T10:00:00.000Z","cwd":"{cwd}","message":{{"role":"{kind}","content":{text}}}}}"#
        )
    }

    #[test]
    fn the_detail_carries_the_whole_first_prompt_and_the_last_three_turns() {
        // Longer than the 120-char list cap, so "the row's title" and "the full
        // prompt" cannot accidentally be the same string.
        let long = "explain ".repeat(40);
        let (dir, _projects, wt, main) = detail_fixture("full", "");
        let cwd = wt.to_string_lossy().into_owned();
        let lines = [
            prose_line("user", &cwd, &long),
            prose_line("assistant", &cwd, "first answer"),
            prose_line("user", &cwd, "second question"),
            prose_line("assistant", &cwd, "second answer"),
            prose_line("user", &cwd, "third question"),
        ]
        .join("\n")
            + "\n";
        std::fs::write(&main, lines).unwrap();

        let got = session_detail(&main);
        assert_eq!(
            got.first_prompt.as_deref(),
            Some(long.trim()),
            "the expansion shows the prompt in full, not the list's one-liner"
        );
        assert!(!got.first_prompt_truncated);
        assert_eq!(got.cwd.as_deref(), Some(cwd.as_str()));
        assert_eq!(
            got.recent_turns
                .iter()
                .map(|t| (t.from, t.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (LastMessageFrom::You, "second question"),
                (LastMessageFrom::Agent, "second answer"),
                (LastMessageFrom::You, "third question"),
            ],
            "the last three turns, oldest first, each with its author"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversized_first_prompt_is_capped_and_says_so() {
        let huge = "x".repeat(FULL_PROMPT_CHARS + 10);
        let (dir, _projects, wt, main) = detail_fixture("cap", "");
        let cwd = wt.to_string_lossy().into_owned();
        std::fs::write(&main, prose_line("user", &cwd, &huge) + "\n").unwrap();

        let got = session_detail(&main);
        assert_eq!(
            got.first_prompt.map(|p| p.chars().count()),
            Some(FULL_PROMPT_CHARS)
        );
        assert!(
            got.first_prompt_truncated,
            "the cut is announced, not hidden"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_id_that_is_not_the_worktrees_does_not_resolve_to_a_transcript() {
        let (dir, projects, wt, main) = detail_fixture("lookup", "");
        let cwd = wt.to_string_lossy().into_owned();
        std::fs::write(&main, prose_line("user", &cwd, "hello") + "\n").unwrap();
        // A transcript from a different checkout, in its own project dir.
        let other = projects.join("-elsewhere");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(
            other.join("foreign.jsonl"),
            prose_line("user", "/elsewhere", "not yours") + "\n",
        )
        .unwrap();

        assert!(
            transcript_in(std::slice::from_ref(&projects), &wt, &[], "sess").is_some(),
            "the worktree's own session resolves"
        );
        assert!(
            transcript_in(std::slice::from_ref(&projects), &wt, &[], "foreign").is_none(),
            "a session id from another checkout resolves to nothing"
        );
        assert!(
            transcript_in(&[projects], &wt, &[], "../../etc/passwd").is_none(),
            "the id is compared against a file stem, never joined onto a path"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- the subagent tree ----

    /// Write `agent-<id>.jsonl` plus its sidecar under `main`'s subagents dir.
    fn write_subagent(main: &Path, id: &str, meta: &str, lines: &str) -> PathBuf {
        let dir = subagents_dir(main).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("agent-{id}.jsonl"));
        std::fs::write(&path, lines).unwrap();
        if !meta.is_empty() {
            std::fs::write(dir.join(format!("agent-{id}.meta.json")), meta).unwrap();
        }
        path
    }

    #[test]
    fn subagents_carry_their_sidecar_metadata_and_the_parents_verdict() {
        let (dir, _projects, wt, main) = detail_fixture("subagents", "");
        let cwd = wt.to_string_lossy().into_owned();
        // The parent reports one child through a background `<task-notification>`
        // and the other through a synchronous `toolUseResult`.
        let notification = prose_line(
            "user",
            &cwd,
            "<task-notification>\n<task-id>aaa</task-id>\n<status>completed</status>\n</task-notification>",
        );
        let sync = format!(
            r#"{{"type":"user","timestamp":"2026-07-05T10:00:00.000Z","cwd":"{cwd}","toolUseResult":{{"agentId":"bbb","status":"killed","prompt":"a very long brief"}},"message":{{"role":"user","content":"done"}}}}"#
        );
        // A `toolUseResult` that is a bare string must not fail its line.
        let string_result = format!(
            r#"{{"type":"user","timestamp":"2026-07-05T10:00:00.000Z","cwd":"{cwd}","toolUseResult":"plain text","message":{{"role":"user","content":"shell output"}}}}"#
        );
        std::fs::write(
            &main,
            [
                prose_line("user", &cwd, "kick it off"),
                notification,
                sync,
                string_result,
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();

        write_subagent(
            &main,
            "aaa",
            r#"{"agentType":"Explore","description":"Find the thing","spawnDepth":1}"#,
            &(prose_line("user", &cwd, "go") + "\n"),
        );
        write_subagent(
            &main,
            "bbb",
            r#"{"agentType":"session-learner","description":"Learn","parentAgentId":"aaa","spawnDepth":2}"#,
            "",
        );
        // No sidecar at all, and a corrupt one.
        write_subagent(&main, "ccc", "", "");
        write_subagent(&main, "ddd", "{not json", "");

        let got = session_subagents(&main, NOW);
        let by_id = |id: &str| {
            got.iter()
                .find(|s| s.agent_id == id)
                .unwrap_or_else(|| panic!("{id} missing"))
                .clone()
        };
        assert_eq!(got.len(), 4, "one row per agent-*.jsonl, sidecar or not");
        assert_eq!(subagent_count(&main), 4, "the badge counts the same set");

        let a = by_id("aaa");
        assert_eq!(a.agent_type.as_deref(), Some("Explore"));
        assert_eq!(a.description.as_deref(), Some("Find the thing"));
        assert_eq!(a.depth, 1);
        assert_eq!(a.parent_agent_id, None);
        assert_eq!(a.status, SubagentStatus::Completed);
        assert_eq!(a.message_count, 1);

        let b = by_id("bbb");
        assert_eq!(
            b.parent_agent_id.as_deref(),
            Some("aaa"),
            "the spawn edge survives"
        );
        assert_eq!(b.depth, 2);
        assert_eq!(
            b.status,
            SubagentStatus::Stopped,
            "the CLI's `killed` is the user's `stopped`"
        );

        let c = by_id("ccc");
        assert_eq!(
            c.agent_type, None,
            "a missing sidecar costs metadata, not the row"
        );
        assert_eq!(c.depth, 1, "no spawnDepth reads as top level");
        assert_eq!(by_id("ddd").agent_type, None, "a corrupt sidecar likewise");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreported_subagent_is_running_only_while_its_transcript_is_fresh() {
        let (dir, _projects, wt, main) = detail_fixture("fresh", "");
        let cwd = wt.to_string_lossy().into_owned();
        std::fs::write(&main, prose_line("user", &cwd, "go") + "\n").unwrap();
        let path = write_subagent(&main, "eee", "", "");
        let modified = std::fs::metadata(&path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let fresh = session_subagents(&main, modified + RUNNING_WINDOW_MS - 1);
        assert_eq!(fresh[0].status, SubagentStatus::Running);
        let stale = session_subagents(&main, modified + RUNNING_WINDOW_MS + 1);
        assert_eq!(
            stale[0].status,
            SubagentStatus::Unknown,
            "an old transcript with no verdict is unknown, never 'completed'"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A depth-2 agent is spawned by a depth-1 *subagent*, so its verdict is
    /// written into that subagent's transcript and never into the session's main
    /// one. Reading only the main transcript left every nested agent `Unknown`.
    #[test]
    fn a_nested_subagents_verdict_is_read_from_the_subagent_that_spawned_it() {
        let (dir, _projects, wt, main) = detail_fixture("nested", "");
        let cwd = wt.to_string_lossy().into_owned();
        // The main transcript reports only the depth-1 agent.
        std::fs::write(
            &main,
            prose_line(
                "user",
                &cwd,
                "<task-notification>\n<task-id>parent</task-id>\n<status>completed</status>\n</task-notification>",
            ) + "\n",
        )
        .unwrap();
        // The depth-1 agent's own transcript reports the one it spawned.
        write_subagent(
            &main,
            "parent",
            r#"{"agentType":"general-purpose","spawnDepth":1}"#,
            &(prose_line(
                "user",
                &cwd,
                "<task-notification>\n<task-id>child</task-id>\n<status>failed</status>\n</task-notification>",
            ) + "\n"),
        );
        write_subagent(
            &main,
            "child",
            r#"{"agentType":"Explore","parentAgentId":"parent","spawnDepth":2}"#,
            "",
        );

        let got = session_subagents(&main, NOW);
        let status = |id: &str| got.iter().find(|s| s.agent_id == id).unwrap().status;
        assert_eq!(status("parent"), SubagentStatus::Completed);
        assert_eq!(
            status("child"),
            SubagentStatus::Failed,
            "the nested verdict comes from the subagent that spawned it"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_subagent_transcript_pointing_outside_is_not_listed() {
        let (dir, _projects, wt, main) = detail_fixture("symlink", "");
        let cwd = wt.to_string_lossy().into_owned();
        std::fs::write(&main, prose_line("user", &cwd, "go") + "\n").unwrap();
        let subagents = subagents_dir(&main).unwrap();
        std::fs::create_dir_all(&subagents).unwrap();
        let outside = dir.join("secret.jsonl");
        std::fs::write(&outside, "{}\n").unwrap();
        std::os::unix::fs::symlink(&outside, subagents.join("agent-evil.jsonl")).unwrap();

        assert!(
            session_subagents(&main, NOW).is_empty(),
            "a link out of the directory is neither counted nor read"
        );
        assert_eq!(subagent_count(&main), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The entry-level check measures against the *resolved* directory, so a
    /// `subagents` planted as a link out of the project tree would have listed
    /// everything in its target — sidecars and all — as this session's agents.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_subagents_directory_lists_nothing() {
        let (dir, _projects, wt, main) = detail_fixture("dirlink", "");
        let cwd = wt.to_string_lossy().into_owned();
        std::fs::write(&main, prose_line("user", &cwd, "go") + "\n").unwrap();
        // A real directory of plausible-looking transcripts, outside the tree.
        let elsewhere = dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("agent-planted.jsonl"), "{}\n").unwrap();
        std::fs::write(elsewhere.join("agent-planted.meta.json"), "{}\n").unwrap();

        let subagents = subagents_dir(&main).unwrap();
        std::fs::create_dir_all(subagents.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &subagents).unwrap();

        assert!(
            subagent_files(&main).is_empty(),
            "the directory is resolved, then required to still be inside the project"
        );
        assert_eq!(subagent_count(&main), 0);
        assert!(session_subagents(&main, NOW).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- per-session spend ----

    #[test]
    fn spend_prices_known_models_and_leaves_an_unknown_one_costless() {
        let (dir, _projects, wt, main) = detail_fixture("spend", "");
        let cwd = wt.to_string_lossy().into_owned();
        let assistant = |id: &str, model: &str, input: u64| {
            format!(
                r#"{{"type":"assistant","timestamp":"2026-07-05T10:00:00.000Z","requestId":"r-{id}","cwd":"{cwd}","message":{{"id":"{id}","model":"{model}","usage":{{"input_tokens":{input},"output_tokens":0}}}}}}"#
            )
        };
        std::fs::write(
            &main,
            [
                assistant("m1", "claude-opus-4-8", 1_000_000),
                // The same turn twice, as a resumed session copies it — counted
                // once, at the fuller row's numbers.
                assistant("m1", "claude-opus-4-8", 2_000_000),
                assistant("m2", "some-unreleased-model", 500),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        let fd = load_files(std::slice::from_ref(&main), |_, _| {})
            .pop()
            .unwrap();

        let got = session_spend(&main, &fd, &tbl());
        assert_eq!(
            got.total_tokens, 2_000_500.0,
            "the duplicated turn is folded to its max, not summed"
        );
        let opus = got
            .models
            .iter()
            .find(|m| m.model == "claude-opus-4-8")
            .unwrap();
        assert_eq!(opus.cost_usd, Some(10.0), "2M input tokens at $5/M");
        let unknown = got
            .models
            .iter()
            .find(|m| m.model == "some-unreleased-model")
            .unwrap();
        assert_eq!(
            unknown.cost_usd, None,
            "an unpriced model reports no cost — a $0.00 would read as free"
        );
        assert_eq!(
            got.cost_usd,
            Some(10.0),
            "the total sums the priced models only"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_with_no_priced_model_reports_no_cost_at_all() {
        let (dir, _projects, wt, main) = detail_fixture("nocost", "");
        let cwd = wt.to_string_lossy().into_owned();
        std::fs::write(
            &main,
            format!(
                r#"{{"type":"assistant","timestamp":"2026-07-05T10:00:00.000Z","requestId":"r1","cwd":"{cwd}","message":{{"id":"m1","model":"mystery","usage":{{"input_tokens":10,"output_tokens":1}}}}}}"#
            ) + "\n",
        )
        .unwrap();
        let fd = load_files(std::slice::from_ref(&main), |_, _| {})
            .pop()
            .unwrap();

        let got = session_spend(&main, &fd, &tbl());
        assert_eq!(got.total_tokens, 11.0);
        assert_eq!(got.cost_usd, None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
