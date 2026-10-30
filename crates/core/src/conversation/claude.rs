//! Claude Code's transcript (`<config>/projects/<cwd-slug>/<session>.jsonl`,
//! and a subagent's own `<session>/subagents/agent-<id>.jsonl`) as a journal.
//!
//! The record is JSON Lines, one record per line, appended as the session runs.
//! What this reads, as written by CLI 2.1.29x–2.1.311:
//!
//! * `user` — a prompt, or the results of tool calls. A prompt is classified by
//!   who sent it ([`UserOrigin`]): `promptSource` when the record has one, else
//!   its shape (a slash command's `<command-name>` echo, an injected
//!   `<task-notification>`, `isMeta` bookkeeping).
//! * `assistant` — one content block per line (`text`, `thinking`, `tool_use`),
//!   the lines of one API message sharing `message.id`. Up to 2.1.299 the lines
//!   were flushed block by block with placeholder usage, from 2.1.309 a message
//!   lands whole: usage is deduped by `message.id`, largest of each count.
//!   `<synthetic>` records are API errors the CLI wrote itself.
//! * `system` — `turn_duration` ends a turn, `compact_boundary` a compaction,
//!   `local_command` a slash command's output; a few others are notices.
//! * `attachment` / `queued_command` — a prompt typed while the agent was busy
//!   and absorbed into its turn, or a background task's notification.
//! * `queue-operation` — the prompt queue (CLI 2.1.312): `enqueue` at the
//!   Enter of a prompt typed while the agent works, `dequeue` when the front
//!   one is delivered as a turn of its own, `remove` when one is absorbed into
//!   the running turn (`reason: absorbed_mid_turn`), `popAll` when the user
//!   recalls them into the input to edit. None carries a uuid.
//! * `permission-mode`, `ai-title`, `custom-title` — the session's metadata.
//!
//! Everything else (file-history snapshots, cost state, request blobs, the
//! many attachment kinds) is skipped, and so is any record this does not know.
//! Lines a subagent wrote into the main file (`isSidechain`) belong to the
//! subagent's own transcript and are skipped here.
//!
//! A prompt typed while the agent works is drawn twice: as an
//! [`ItemBody::Queued`] item from its `enqueue` on, pending until the queue
//! gives it up (or its delivery reaches the record), and at its delivery — a
//! `user` record with `promptSource: queued` when it starts a turn, a
//! `queued_command` attachment when it is absorbed into one — as
//! [`UserOrigin::Queued`]. A background task's notification goes through the
//! same queue and is drawn only where it lands.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Map, Value};

use std::mem::size_of;

use super::journal::{
    bounded, bounded_marked, cut, label, string_bytes, Journal, MAX_INPUT, MAX_JSON, MAX_LABEL,
    MAX_OUTPUT, MAX_PATCH, MAX_TEXT, TABLE_SLOT,
};
use super::{
    AgentMessage, ContextUsage, ConversationMeta, FileChange, FileOp, ItemBody, Notice, NoticeTone,
    Question, QueueStatus, QueuedMessage, Reasoning, SubagentLink, TodoItem, TodoStatus,
    TokenUsage, ToolCall, ToolInput, ToolOutput, ToolStatus, TurnEnd, UserMessage, UserOrigin,
};
use crate::domain::SubagentStatus;

type Obj = Map<String, Value>;

/// A subagent id as Claude names them (`<session>/subagents/agent-<id>.jsonl`,
/// and the hooks' `agent_id`): a short token of letters, digits, `-` and `_`.
/// Nothing in that shape can reach a path as more than a name.
pub fn is_subagent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Which transcript a parser reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    /// `<session>.jsonl`, the main thread. A subagent's lines in it are skipped.
    Main,
    /// `<session>/subagents/agent-<id>.jsonl`, where every line is the
    /// subagent's own.
    Subagent,
}

/// Pending subagent links are bounded: a link is held until its tool call is
/// parsed, and a call outside the parsed part of the record never is.
const MAX_PENDING_LINKS: usize = 1024;

/// The most entries kept of a list drawn in full: todos, questions, options.
const MAX_LIST: usize = 256;

/// An incremental parse of one Claude transcript. Feed it complete lines in
/// file order with [`ClaudeTranscript::push_line`]; read the journal back.
#[derive(Debug)]
pub struct ClaudeTranscript {
    kind: TranscriptKind,
    journal: Journal,
    meta: ConversationMeta,
    /// Record uuids already applied: a record seen twice is applied once.
    seen: HashSet<String>,
    /// Tool call id → its item.
    tools: HashMap<String, usize>,
    /// The items of the calls with no result yet: what an interruption stops.
    running: HashSet<usize>,
    /// Tool call id → the API message that made the call.
    call_message: HashMap<String, String>,
    /// Calls refused as `user-rejected` since the last prompt, with their API
    /// message: what an interrupt marker naming that message turns out to
    /// have been (see [`ClaudeTranscript::interrupt`]).
    rejected: Vec<(String, usize)>,
    /// Agent calls with no subagent known yet.
    unlinked: HashSet<String>,
    /// Subagents whose sidecar named a call not parsed yet.
    pending_links: HashMap<String, SubagentLink>,
    /// The reasoning item still open to the next thinking block of the same
    /// API message: `(message id, item)`.
    reasoning: Option<(String, usize)>,
    /// Each API message's usage, largest of each count seen.
    messages: HashMap<String, TokenUsage>,
    /// The API messages of the turn in progress, for its [`TurnEnd`].
    turn_messages: Vec<String>,
    custom_title: Option<String>,
    ai_title: Option<String>,
    /// The last `permission-mode` record, to notice a change.
    mode: Option<String>,
    /// Ids handed to records that carry no uuid.
    unnamed: u32,
    /// Claude's prompt queue, as its `queue-operation` records keep it.
    queue: VecDeque<QueueEntry>,
}

/// One entry of Claude's prompt queue: its text, and the item drawn for it —
/// none for what the harness queues itself (a background task's notification).
#[derive(Debug)]
struct QueueEntry {
    text: String,
    item: Option<usize>,
}

impl ClaudeTranscript {
    pub fn new(kind: TranscriptKind) -> Self {
        Self {
            kind,
            journal: Journal::default(),
            meta: ConversationMeta::default(),
            seen: HashSet::new(),
            tools: HashMap::new(),
            running: HashSet::new(),
            call_message: HashMap::new(),
            rejected: Vec::new(),
            unlinked: HashSet::new(),
            pending_links: HashMap::new(),
            reasoning: None,
            messages: HashMap::new(),
            turn_messages: Vec::new(),
            custom_title: None,
            ai_title: None,
            mode: None,
            unnamed: 0,
            queue: VecDeque::new(),
        }
    }

    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    pub fn meta(&self) -> &ConversationMeta {
        &self.meta
    }

    /// Only the record's tail was parsed: its start is missing.
    pub fn mark_truncated(&mut self) {
        self.meta.truncated = true;
    }

    /// Rough heap footprint, for a cache's byte budget: the journal, and every
    /// index and set kept beside it, each entry at its real key length.
    pub fn approx_bytes(&self) -> usize {
        let keyed = |key: &str, value: usize| string_bytes(key) + value + TABLE_SLOT;
        let set = |set: &HashSet<String>| set.iter().map(|k| keyed(k, 0)).sum::<usize>();
        self.journal.approx_bytes()
            + set(&self.seen)
            + set(&self.unlinked)
            + self
                .tools
                .keys()
                .map(|k| keyed(k, size_of::<usize>()))
                .sum::<usize>()
            + self
                .call_message
                .iter()
                .map(|(k, v)| keyed(k, string_bytes(v)))
                .sum::<usize>()
            + self
                .messages
                .keys()
                .map(|k| keyed(k, size_of::<TokenUsage>()))
                .sum::<usize>()
            + self
                .pending_links
                .iter()
                .map(|(k, link)| {
                    let heap =
                        link.agent_id.len() + link.agent_type.as_ref().map_or(0, String::len);
                    keyed(k, size_of::<SubagentLink>() + heap)
                })
                .sum::<usize>()
            + self
                .turn_messages
                .iter()
                .map(|m| string_bytes(m))
                .sum::<usize>()
            + self
                .rejected
                .iter()
                .map(|(m, _)| string_bytes(m) + size_of::<usize>())
                .sum::<usize>()
            + self.running.len() * (size_of::<usize>() + TABLE_SLOT)
            + self
                .queue
                .iter()
                .map(|e| size_of::<QueueEntry>() + e.text.len())
                .sum::<usize>()
    }

    /// Whether an Agent call is still waiting to learn which subagent it
    /// started — the caller then offers what the sidecars say
    /// ([`ClaudeTranscript::link_subagent`]).
    pub fn wants_subagent_links(&self) -> bool {
        !self.unlinked.is_empty()
    }

    /// What a subagent's `agent-<id>.meta.json` sidecar says: it was started by
    /// the call `tool_use_id`. That is how a call learns its subagent while the
    /// subagent still runs — the call's own result names it only when the
    /// call returns.
    pub fn link_subagent(&mut self, tool_use_id: &str, agent_id: &str, agent_type: Option<&str>) {
        // The mapper's other input: a sidecar file, not a record line.
        let (tool_use_id, agent_id) = (clean(tool_use_id), clean(agent_id));
        let agent_type = agent_type.map(clean);
        let (tool_use_id, agent_id) = (tool_use_id.as_ref(), agent_id.as_ref());
        let agent_type = agent_type.as_deref();
        let Some(&idx) = self.tools.get(tool_use_id) else {
            if self.pending_links.len() < MAX_PENDING_LINKS && tool_use_id.len() <= MAX_LABEL {
                self.pending_links.insert(
                    tool_use_id.to_string(),
                    SubagentLink {
                        agent_id: label(agent_id),
                        agent_type: agent_type.map(label),
                        status: SubagentStatus::Running,
                    },
                );
            }
            return;
        };
        self.journal.update(idx, |body| {
            let ItemBody::Tool(call) = body else {
                return false;
            };
            if call.subagent.is_some() {
                return false;
            }
            let agent_type = agent_type.map(label).or_else(|| agent_type_of(&call.input));
            call.subagent = Some(SubagentLink {
                agent_id: label(agent_id),
                agent_type,
                status: subagent_status_of_call(call.status),
            });
            true
        });
        self.unlinked.remove(tool_use_id);
    }

    /// Apply one complete line of the record. A line that is not a JSON object,
    /// or a record this does not know, changes nothing.
    pub fn push_line(&mut self, line: &[u8]) {
        let Ok(mut record) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        // Every text the journal and the meta carry comes out of the record,
        // so it is made safe to draw here, once, for all of them.
        clean_value(&mut record);
        let Value::Object(rec) = record else {
            return;
        };
        match str_of(&rec, "type") {
            Some(kind @ ("user" | "assistant" | "system" | "attachment")) => {
                if self.kind == TranscriptKind::Main && bool_of(&rec, "isSidechain") {
                    return;
                }
                // A uuid is 36 characters; anything far longer is not one.
                let id = match str_of(&rec, "uuid").filter(|u| u.len() <= 128) {
                    Some(uuid) => {
                        if !self.seen.insert(uuid.to_string()) {
                            return;
                        }
                        uuid.to_string()
                    }
                    None => self.unnamed_id(),
                };
                self.envelope(&rec);
                let at = timestamp_ms(&rec);
                match kind {
                    "user" => self.user(&rec, id, at),
                    "assistant" => self.assistant(&rec, id, at),
                    "system" => self.system(&rec, id, at),
                    _ => self.attachment(&rec, id, at),
                }
            }
            Some("permission-mode") => self.permission_mode(&rec),
            Some("queue-operation") => self.queue_operation(&rec),
            Some("custom-title") => {
                self.custom_title = nonempty(str_of(&rec, "customTitle"));
                self.retitle();
            }
            Some("ai-title") => {
                self.ai_title = nonempty(str_of(&rec, "aiTitle"));
                self.retitle();
            }
            _ => {}
        }
    }

    fn unnamed_id(&mut self) -> String {
        self.unnamed += 1;
        format!("#{}", self.unnamed)
    }

    /// The fields every conversation record repeats: where and on what.
    fn envelope(&mut self, rec: &Obj) {
        set_if_changed(&mut self.meta.cwd, str_of(rec, "cwd"));
        set_if_changed(&mut self.meta.git_branch, str_of(rec, "gitBranch"));
        set_if_changed(&mut self.meta.cli_version, str_of(rec, "version"));
    }

    fn retitle(&mut self) {
        self.meta.title = self.custom_title.clone().or_else(|| self.ai_title.clone());
    }

    fn permission_mode(&mut self, rec: &Obj) {
        let Some(mode) = str_of(rec, "permissionMode")
            .filter(|m| !m.is_empty())
            .map(label)
        else {
            return;
        };
        // The record is rewritten often with the same value; only a change is
        // something that happened in the conversation.
        if self.mode.as_ref().is_some_and(|prev| *prev != mode) {
            let id = self.unnamed_id();
            self.journal.push(
                id,
                None,
                ItemBody::Notice(Notice {
                    tone: NoticeTone::Info,
                    text: format!("Permission mode: {mode}"),
                }),
            );
        }
        set_if_changed(&mut self.meta.permission_mode, Some(&mode));
        self.mode = Some(mode);
    }

    // ── user ────────────────────────────────────────────────────────────────

    fn user(&mut self, rec: &Obj, id: String, at: Option<f64>) {
        set_if_changed(
            &mut self.meta.permission_mode,
            str_of(rec, "permissionMode"),
        );
        let content = rec.get("message").and_then(|m| m.get("content"));
        if let Some(blocks) = content.and_then(Value::as_array) {
            let results: Vec<&Value> = blocks
                .iter()
                .filter(|b| block_type(b) == Some("tool_result"))
                .collect();
            if !results.is_empty() {
                // The record-level `toolUseResult` describes its one result; a
                // record carrying several leaves each to its own content.
                let structured = match results.as_slice() {
                    [_] => rec.get("toolUseResult"),
                    _ => None,
                };
                for result in results {
                    self.tool_result(rec, result, structured, at);
                }
                // Text riding beside results is the harness's, never typed.
                let (text, images) = prose(blocks);
                if !text.trim().is_empty() {
                    self.push_user(format!("{id}:text"), at, text, images, UserOrigin::Injected);
                }
                return;
            }
        }
        let (text, images) = match content {
            Some(Value::String(text)) => (text.clone(), 0),
            Some(Value::Array(blocks)) => prose(blocks),
            _ => return,
        };
        if text.trim().is_empty() && images == 0 {
            return;
        }
        if let Some(marker) = interruption(&text) {
            self.interrupt(id, at, marker, str_of(rec, "interruptedMessageId"));
            return;
        }
        let origin = user_origin(rec, &text);
        if opening_tag(&text) == Some("task-notification") {
            self.task_notification(&text);
        }
        if origin == UserOrigin::Queued {
            self.delivered(&text);
        }
        let text = display_text(origin, text);
        if text.trim().is_empty() && images == 0 {
            return;
        }
        // Prompts queued together are delivered together, one record each,
        // and answered in one turn (captured): only the first starts it.
        let joins_delivery = origin == UserOrigin::Queued && self.follows_queued_prompt();
        if matches!(origin, UserOrigin::Typed | UserOrigin::Queued) && !joins_delivery {
            self.journal.begin_turn();
            self.turn_messages.clear();
            self.rejected.clear();
        }
        self.push_user(id, at, text, images, origin);
    }

    /// Whether the newest item is a queued prompt delivered as a turn's start.
    fn follows_queued_prompt(&self) -> bool {
        self.journal.last_index().is_some_and(|idx| {
            matches!(
                self.journal.body(idx),
                Some(ItemBody::User(UserMessage {
                    origin: UserOrigin::Queued,
                    ..
                }))
            )
        })
    }

    fn push_user(
        &mut self,
        id: String,
        at: Option<f64>,
        text: String,
        images: u32,
        origin: UserOrigin,
    ) {
        self.journal.push(
            id,
            at,
            ItemBody::User(UserMessage {
                text: bounded_marked(&text, MAX_TEXT),
                images,
                origin,
            }),
        );
    }

    /// The user stopped the agent: whatever was still running did not finish.
    ///
    /// A call that was running when the user pressed Esc gets a result first,
    /// and it reads exactly like a refusal at the permission prompt
    /// (`toolDenialKind: "user-rejected"`, the same text, CLI 2.1.312). What
    /// tells them apart is this marker: after an Esc mid-run it names the API
    /// message whose call it stopped (`interruptedMessageId`); after a refusal
    /// at the prompt it names none. So the refused calls of the message it
    /// names were interrupted, not denied.
    fn interrupt(
        &mut self,
        id: String,
        at: Option<f64>,
        marker: &str,
        interrupted_message: Option<&str>,
    ) {
        let mut stopped: Vec<usize> = self.running.drain().collect();
        let rejected = std::mem::take(&mut self.rejected);
        if let Some(message) = interrupted_message {
            stopped.extend(
                rejected
                    .into_iter()
                    .filter(|(of, _)| of == message)
                    .map(|(_, idx)| idx),
            );
        }
        for idx in stopped {
            self.journal.update(idx, |body| {
                let ItemBody::Tool(call) = body else {
                    return false;
                };
                if !matches!(call.status, ToolStatus::Running | ToolStatus::Denied) {
                    return false;
                }
                call.status = ToolStatus::Interrupted;
                if let Some(link) = call.subagent.as_mut() {
                    if link.status == SubagentStatus::Running {
                        link.status = SubagentStatus::Stopped;
                    }
                }
                true
            });
        }
        self.journal.push(
            id,
            at,
            ItemBody::Notice(Notice {
                tone: NoticeTone::Warning,
                text: marker.to_string(),
            }),
        );
    }

    /// A background task's `<task-notification>`: when it reports on a
    /// subagent this record started, the subagent's verdict and final report
    /// land on the call that started it.
    fn task_notification(&mut self, text: &str) {
        let tool_use_id = tag_value(text, "tool-use-id").map(str::trim);
        let task_id = tag_value(text, "task-id").map(str::trim);
        let status = tag_value(text, "status").map(str::trim);
        let report = tag_value(text, "result")
            .map(str::trim)
            .filter(|r| !r.is_empty());
        let idx = tool_use_id
            .and_then(|id| self.tools.get(id).copied())
            .or_else(|| {
                let task_id = task_id?;
                self.tools.values().copied().find(|&idx| {
                    matches!(
                        self.journal.body(idx),
                        Some(ItemBody::Tool(ToolCall { subagent: Some(link), .. })) if link.agent_id == task_id
                    )
                })
            });
        let Some(idx) = idx else {
            return;
        };
        let mut linked = None;
        self.journal.update(idx, |body| {
            let ItemBody::Tool(call) = body else {
                return false;
            };
            let before = (call.subagent.clone(), call.output.clone());
            if call.subagent.is_none() {
                let Some(task_id) = task_id.filter(|_| is_agent_tool(&call.name)) else {
                    return false;
                };
                call.subagent = Some(SubagentLink {
                    agent_id: label(task_id),
                    agent_type: agent_type_of(&call.input),
                    status: SubagentStatus::Running,
                });
                linked = Some(call.call_id.clone());
            }
            let Some(link) = call.subagent.as_mut() else {
                return false;
            };
            if let Some(status) = status.map(subagent_status) {
                link.status = status;
            }
            if let Some(report) = report {
                let (text, truncated) = bounded(report, MAX_OUTPUT);
                call.output = Some(ToolOutput {
                    text,
                    truncated,
                    is_error: link.status == SubagentStatus::Failed,
                    exit_code: None,
                });
            }
            before != (call.subagent.clone(), call.output.clone())
        });
        if let Some(call_id) = linked {
            self.unlinked.remove(&call_id);
        }
    }

    // ── assistant ───────────────────────────────────────────────────────────

    fn assistant(&mut self, rec: &Obj, id: String, at: Option<f64>) {
        let Some(msg) = rec.get("message").and_then(Value::as_object) else {
            return;
        };
        let model = str_of(msg, "model").unwrap_or_default();
        let blocks = msg.get("content").and_then(Value::as_array);
        let api_error = bool_of(rec, "isApiErrorMessage");
        if api_error || model == "<synthetic>" {
            // Written by the CLI, not the model: an API error, or (older CLIs)
            // a placeholder reply. Neither is the agent's prose, and neither
            // cost tokens.
            let text = blocks.map(|b| prose(b).0).unwrap_or_default();
            let text = text.trim();
            if api_error
                || !(text.is_empty() || text.eq_ignore_ascii_case("No response requested."))
            {
                self.journal.push(
                    id,
                    at,
                    ItemBody::Notice(Notice {
                        tone: if api_error {
                            NoticeTone::Error
                        } else {
                            NoticeTone::Info
                        },
                        text: if text.is_empty() {
                            "API error".to_string()
                        } else {
                            bounded_marked(text, MAX_TEXT)
                        },
                    }),
                );
            }
            return;
        }
        set_if_changed(&mut self.meta.model, Some(model));
        // An API message id is a short token; anything else keys nothing.
        let message_id = str_of(msg, "id")
            .filter(|id| id.len() <= MAX_LABEL)
            .unwrap_or_default();
        if let Some(usage) = msg.get("usage").filter(|_| !message_id.is_empty()) {
            self.count_usage(message_id, usage);
        }
        let Some(blocks) = blocks else {
            return;
        };
        let thought_ms = num_of(rec, "thinkingDurationMs");
        for (i, block) in blocks.iter().enumerate() {
            let block_id = if i == 0 {
                id.clone()
            } else {
                format!("{id}:{i}")
            };
            match block_type(block) {
                Some("text") => {
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    self.journal.push(
                        block_id,
                        at,
                        ItemBody::Agent(AgentMessage {
                            text: bounded_marked(text, MAX_TEXT),
                        }),
                    );
                }
                Some("thinking") => {
                    let text = block
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    self.reasoning(message_id, block_id, at, text, thought_ms);
                }
                Some("redacted_thinking") => {
                    self.reasoning(message_id, block_id, at, "", thought_ms);
                }
                Some("tool_use") => self.tool_use(block, at, message_id),
                _ => {}
            }
        }
    }

    /// One thinking block. Claude records thinking as an empty block carrying
    /// the time it took, then short "update" summaries: the blocks of one API
    /// message that follow one another are one reasoning item.
    fn reasoning(
        &mut self,
        message_id: &str,
        id: String,
        at: Option<f64>,
        text: &str,
        duration_ms: Option<f64>,
    ) {
        let text = text.trim();
        if let Some((open, idx)) = &self.reasoning {
            if !message_id.is_empty()
                && open == message_id
                && self.journal.last_index() == Some(*idx)
            {
                let idx = *idx;
                self.journal.update(idx, |body| {
                    let ItemBody::Reasoning(r) = body else {
                        return false;
                    };
                    let mut changed = false;
                    if !text.is_empty() && r.text.len() <= MAX_TEXT {
                        if !r.text.is_empty() {
                            r.text.push_str("\n\n");
                        }
                        r.text.push_str(text);
                        if r.text.len() > MAX_TEXT {
                            r.text = bounded_marked(&r.text, MAX_TEXT);
                        }
                        changed = true;
                    }
                    if let Some(ms) = duration_ms {
                        r.duration_ms = Some(r.duration_ms.unwrap_or(0.0) + ms);
                        changed = true;
                    }
                    changed
                });
                return;
            }
        }
        let idx = self.journal.push(
            id,
            at,
            ItemBody::Reasoning(Reasoning {
                text: bounded_marked(text, MAX_TEXT),
                duration_ms,
            }),
        );
        self.reasoning = Some((message_id.to_string(), idx));
    }

    /// One API message's usage, deduped by its id: the same message is
    /// recorded once per content block, and on CLIs up to 2.1.299 the early
    /// lines carry placeholder counts — the largest of each is the final one.
    fn count_usage(&mut self, message_id: &str, usage: &Value) {
        let Some(u) = usage.as_object() else {
            return;
        };
        let count = |key: &str| num_of(u, key).unwrap_or(0.0);
        let seen = TokenUsage {
            input: count("input_tokens"),
            output: count("output_tokens"),
            cache_read: count("cache_read_input_tokens"),
            cache_write: count("cache_creation_input_tokens"),
            reasoning: u
                .get("output_tokens_details")
                .and_then(|d| d.get("thinking_tokens"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        };
        let (merged, delta) = match self.messages.get(message_id) {
            Some(held) => {
                let merged = held.max_of(&seen);
                let delta = merged.minus(held);
                (merged, delta)
            }
            None => {
                self.turn_messages.push(message_id.to_string());
                (seen.clone(), seen)
            }
        };
        self.meta
            .usage
            .get_or_insert_with(TokenUsage::default)
            .add(&delta);
        self.meta.context = Some(ContextUsage {
            used_tokens: merged.input + merged.cache_read + merged.cache_write,
            window_tokens: None,
        });
        self.messages.insert(message_id.to_string(), merged);
    }

    fn tool_use(&mut self, block: &Value, at: Option<f64>, message_id: &str) {
        // A call id is a short token (`toolu_…`); anything else is no call.
        let Some(call_id) = block
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| id.len() <= MAX_LABEL)
        else {
            return;
        };
        if self.tools.contains_key(call_id) {
            return;
        }
        let name = label(block.get("name").and_then(Value::as_str).unwrap_or("tool"));
        let input = tool_input(&name, block.get("input").unwrap_or(&Value::Null));
        let subagent = self.pending_links.remove(call_id);
        if is_agent_tool(&name) && subagent.is_none() {
            self.unlinked.insert(call_id.to_string());
        }
        let idx = self.journal.push(
            format!("tool:{call_id}"),
            at,
            ItemBody::Tool(ToolCall {
                call_id: call_id.to_string(),
                name,
                input,
                status: ToolStatus::Running,
                output: None,
                duration_ms: None,
                subagent,
            }),
        );
        self.tools.insert(call_id.to_string(), idx);
        self.running.insert(idx);
        if !message_id.is_empty() {
            self.call_message
                .insert(call_id.to_string(), message_id.to_string());
        }
    }

    /// A `tool_result` block, and the record's structured `toolUseResult`
    /// when it describes this result alone.
    fn tool_result(
        &mut self,
        rec: &Obj,
        block: &Value,
        structured: Option<&Value>,
        at: Option<f64>,
    ) {
        let Some(call_id) = block.get("tool_use_id").and_then(Value::as_str) else {
            return;
        };
        // A result whose call is not in the parsed part of the record (the
        // record was read from its tail) has nothing to land on.
        let Some(&idx) = self.tools.get(call_id) else {
            return;
        };
        let is_error = block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let text = result_text(block.get("content"));
        let status = result_status(rec, is_error, &text);
        let duration_ms = match (self.journal.at_ms(idx), at) {
            (Some(start), Some(end)) if end >= start => Some(end - start),
            _ => None,
        };
        let structured = structured.and_then(Value::as_object);
        let mut linked = false;
        let mut landed = status;
        self.journal.update(idx, |body| {
            let ItemBody::Tool(call) = body else {
                return false;
            };
            apply_result(call, structured, &text, status, is_error);
            call.duration_ms = duration_ms;
            linked = call.subagent.is_some();
            landed = call.status;
            true
        });
        if landed != ToolStatus::Running {
            self.running.remove(&idx);
        }
        if landed == ToolStatus::Denied && str_of(rec, "toolDenialKind") == Some("user-rejected") {
            if let Some(message) = self.call_message.get(call_id) {
                self.rejected.push((message.clone(), idx));
            }
        }
        if linked {
            self.unlinked.remove(call_id);
        }
    }

    // ── system ──────────────────────────────────────────────────────────────

    fn system(&mut self, rec: &Obj, id: String, at: Option<f64>) {
        match str_of(rec, "subtype") {
            Some("turn_duration") => {
                let mut usage: Option<TokenUsage> = None;
                for message_id in self.turn_messages.drain(..) {
                    if let Some(u) = self.messages.get(&message_id) {
                        usage.get_or_insert_with(TokenUsage::default).add(u);
                    }
                }
                self.journal.push(
                    id,
                    at,
                    ItemBody::TurnEnd(TurnEnd {
                        duration_ms: num_of(rec, "durationMs"),
                        usage,
                    }),
                );
            }
            Some("compact_boundary") => self.compacted(rec, id, at),
            Some("local_command") => {
                let content = str_of(rec, "content").unwrap_or_default();
                let text = command_text(content)
                    .or_else(|| {
                        let run = rec.get("commandRun")?.as_object()?;
                        let command = str_of(run, "command")?.trim();
                        let args = str_of(run, "args").unwrap_or_default().trim();
                        Some(slash_command(command, args))
                    })
                    .unwrap_or_else(|| content.trim().to_string());
                if !text.trim().is_empty() {
                    self.push_user(id, at, text, 0, UserOrigin::Command);
                }
            }
            Some("informational") => {
                let tone = match str_of(rec, "level") {
                    Some("warning") => NoticeTone::Warning,
                    Some("error") => NoticeTone::Error,
                    _ => NoticeTone::Info,
                };
                self.notice(id, at, tone, str_of(rec, "content"));
            }
            Some("model_refusal_fallback") => {
                self.notice(id, at, NoticeTone::Warning, str_of(rec, "content"));
            }
            Some("api_error") => {
                let text = str_of(rec, "content")
                    .or_else(|| rec.get("error")?.get("message")?.as_str())
                    .unwrap_or("API error");
                self.notice(id, at, NoticeTone::Error, Some(text));
            }
            _ => {}
        }
    }

    fn notice(&mut self, id: String, at: Option<f64>, tone: NoticeTone, text: Option<&str>) {
        let Some(text) = text.map(str::trim).filter(|t| !t.is_empty()) else {
            return;
        };
        self.journal.push(
            id,
            at,
            ItemBody::Notice(Notice {
                tone,
                text: bounded_marked(text, MAX_TEXT),
            }),
        );
    }

    /// The context was compacted: the meter starts again from what is left.
    fn compacted(&mut self, rec: &Obj, id: String, at: Option<f64>) {
        let meta = rec.get("compactMetadata").and_then(Value::as_object);
        let mut text = match meta.and_then(|m| str_of(m, "trigger")) {
            Some("manual") => "Conversation compacted (/compact)".to_string(),
            Some("auto") => "Conversation compacted automatically".to_string(),
            _ => "Conversation compacted".to_string(),
        };
        let pre = meta.and_then(|m| num_of(m, "preTokens"));
        let post = meta.and_then(|m| num_of(m, "postTokens"));
        if let (Some(pre), Some(post)) = (pre, post) {
            text.push_str(&format!(" ({pre:.0} → {post:.0} tokens)"));
        }
        if let Some(post) = post {
            self.meta.context = Some(ContextUsage {
                used_tokens: post,
                window_tokens: None,
            });
        }
        self.journal.push(
            id,
            at,
            ItemBody::Notice(Notice {
                tone: NoticeTone::Info,
                text,
            }),
        );
    }

    // ── attachment ──────────────────────────────────────────────────────────

    fn attachment(&mut self, rec: &Obj, id: String, at: Option<f64>) {
        let Some(attachment) = rec.get("attachment").and_then(Value::as_object) else {
            return;
        };
        if str_of(attachment, "type") != Some("queued_command") {
            return;
        }
        let (text, images) = match attachment.get("prompt") {
            Some(Value::String(text)) => (text.clone(), 0),
            Some(Value::Array(blocks)) => prose(blocks),
            _ => return,
        };
        if text.trim().is_empty() && images == 0 {
            return;
        }
        let origin_kind = attachment
            .get("origin")
            .and_then(|o| o.get("kind"))
            .and_then(Value::as_str);
        // A prompt the user typed while the agent worked, absorbed into the
        // turn in progress: queued, but it starts no turn of its own.
        let origin = match (str_of(attachment, "commandMode"), origin_kind) {
            (Some("prompt"), None | Some("human")) => UserOrigin::Queued,
            _ => UserOrigin::Injected,
        };
        if opening_tag(&text) == Some("task-notification") {
            self.task_notification(&text);
        }
        if origin == UserOrigin::Queued {
            self.delivered(&text);
        }
        let text = display_text(origin, text);
        self.push_user(id, at, text, images, origin);
    }
}

impl ClaudeTranscript {
    /// One `queue-operation` record. `dequeue` names nothing: it is the front
    /// entry, so what the harness queued (a task notification) is kept in the
    /// queue too, undrawn, or a dequeue would deliver the wrong prompt.
    fn queue_operation(&mut self, rec: &Obj) {
        match str_of(rec, "operation") {
            Some("enqueue") => {
                let text = str_of(rec, "content").unwrap_or_default();
                let lead = text.trim_start();
                let harness = opening_tag(lead)
                    .is_some_and(|tag| INJECTED_TAGS.iter().any(|t| tag.eq_ignore_ascii_case(t)));
                let item = (!harness && !text.trim().is_empty()).then(|| {
                    let id = self.unnamed_id();
                    self.journal.push(
                        id,
                        timestamp_ms(rec),
                        ItemBody::Queued(QueuedMessage {
                            text: bounded_marked(text, MAX_TEXT),
                            status: QueueStatus::Pending,
                        }),
                    )
                });
                if self.queue.len() >= MAX_LIST {
                    self.queue.pop_front();
                }
                self.queue.push_back(QueueEntry {
                    text: text.to_string(),
                    item,
                });
            }
            Some("dequeue") => {
                if let Some(entry) = self.queue.pop_front() {
                    self.settle(entry.item, QueueStatus::Delivered);
                }
            }
            Some("remove") => {
                let text = str_of(rec, "content").unwrap_or_default();
                let status = match str_of(rec, "reason") {
                    Some("absorbed_mid_turn") => QueueStatus::Delivered,
                    _ => QueueStatus::Withdrawn,
                };
                if let Some(entry) = self.take_queued(text) {
                    self.settle(entry.item, status);
                }
            }
            Some("popAll") => {
                for entry in std::mem::take(&mut self.queue) {
                    self.settle(entry.item, QueueStatus::Withdrawn);
                }
            }
            _ => {}
        }
    }

    /// A queued prompt reached the record as a delivery: its entry is
    /// delivered, whatever the queue's own records said (they may lie before
    /// the parsed tail, or never have been written).
    fn delivered(&mut self, text: &str) {
        if let Some(entry) = self.take_queued(text) {
            self.settle(entry.item, QueueStatus::Delivered);
        }
    }

    fn take_queued(&mut self, text: &str) -> Option<QueueEntry> {
        let at = self.queue.iter().position(|e| e.text == text)?;
        self.queue.remove(at)
    }

    /// A queued message left the queue: its item says how, once.
    fn settle(&mut self, item: Option<usize>, status: QueueStatus) {
        let Some(idx) = item else {
            return;
        };
        self.journal.update(idx, |body| match body {
            ItemBody::Queued(q) if q.status == QueueStatus::Pending => {
                q.status = status;
                true
            }
            _ => false,
        });
    }
}

// ── Classifying what the user side sent ─────────────────────────────────────

/// Tags the CLI writes as the user for a slash command, a shell escape, and
/// their output.
const COMMAND_TAGS: &[&str] = &[
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "local-command-stderr",
    "bash-input",
    "bash-stdout",
    "bash-stderr",
];

/// Tags of text the harness writes as the user — for records that predate
/// `promptSource`. Every entry was observed in a real transcript (the same
/// observed list `usage.rs` keeps for a session's title); a prompt that opens
/// with a tag of its own is still the user's.
const INJECTED_TAGS: &[&str] = &[
    "agent-message",
    "cross-session-message",
    "fork-boilerplate",
    "local-command-caveat",
    "system-reminder",
    "task-notification",
    "teammate-message",
    "user-memory-input",
    "user-prompt-submit-hook",
];

/// Injected text that opens with prose, matched case-insensitively.
const INJECTED_PREFIXES: &[&str] = &[
    "<channel source=",
    "a message arrived from ",
    "another claude session sent a message",
    "caveat: the messages below",
    "this session is being continued from a previous conversation",
];

fn user_origin(rec: &Obj, text: &str) -> UserOrigin {
    if bool_of(rec, "isCompactSummary") || bool_of(rec, "isMeta") {
        return UserOrigin::Injected;
    }
    if opening_tag(text).is_some_and(|tag| COMMAND_TAGS.contains(&tag)) {
        return UserOrigin::Command;
    }
    match str_of(rec, "promptSource") {
        Some("queued") => return UserOrigin::Queued,
        Some("typed") => return UserOrigin::Typed,
        Some("system") => return UserOrigin::Injected,
        _ => {}
    }
    // `sdk` and newer sources: a person sent it when its origin says so.
    match rec
        .get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(Value::as_str)
    {
        Some("human") => return UserOrigin::Typed,
        Some(_) => return UserOrigin::Injected,
        None => {}
    }
    let lead = text.trim_start();
    if opening_tag(lead)
        .is_some_and(|tag| INJECTED_TAGS.iter().any(|t| tag.eq_ignore_ascii_case(t)))
        || INJECTED_PREFIXES.iter().any(|p| starts_with_ci(lead, p))
    {
        return UserOrigin::Injected;
    }
    UserOrigin::Typed
}

/// The marker Claude writes when the user stops it, without its brackets.
fn interruption(text: &str) -> Option<&str> {
    let t = text.trim();
    t.starts_with("[Request interrupted by user")
        .then(|| t.trim_start_matches('[').trim_end_matches(']').trim())
}

/// What a user item shows: a slash command as typed, a command's output
/// without its tags, a task notification by its summary.
fn display_text(origin: UserOrigin, text: String) -> String {
    match origin {
        UserOrigin::Command => command_text(&text).unwrap_or(text),
        UserOrigin::Injected if opening_tag(&text) == Some("task-notification") => {
            tag_value(&text, "summary")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or(text)
        }
        _ => text,
    }
}

/// A slash command's or shell escape's echo as the user typed it, or its
/// output as text.
fn command_text(text: &str) -> Option<String> {
    match opening_tag(text)? {
        "command-name" | "command-message" | "command-args" => {
            let name = tag_value(text, "command-name")
                .or_else(|| tag_value(text, "command-message"))?
                .trim();
            let args = tag_value(text, "command-args").unwrap_or_default().trim();
            Some(slash_command(name, args))
        }
        "bash-input" => Some(format!("!{}", tag_value(text, "bash-input")?.trim())),
        "bash-stdout" | "bash-stderr" => {
            let out: Vec<&str> = [
                tag_value(text, "bash-stdout"),
                tag_value(text, "bash-stderr"),
            ]
            .into_iter()
            .flatten()
            .map(str::trim_end)
            .filter(|s| !s.is_empty())
            .collect();
            Some(out.join("\n"))
        }
        tag if tag.starts_with("local-command-") => Some(tag_value(text, tag)?.trim().to_string()),
        _ => None,
    }
}

fn slash_command(name: &str, args: &str) -> String {
    let name = if name.starts_with('/') {
        name.to_string()
    } else {
        format!("/{name}")
    };
    if args.is_empty() {
        name
    } else {
        format!("{name} {args}")
    }
}

// ── Tool calls ──────────────────────────────────────────────────────────────

fn is_agent_tool(name: &str) -> bool {
    matches!(name, "Agent" | "Task")
}

fn agent_type_of(input: &ToolInput) -> Option<String> {
    match input {
        ToolInput::Agent { agent_type, .. } => agent_type.clone(),
        _ => None,
    }
}

/// A call's arguments, as the view draws that kind of tool.
fn tool_input(name: &str, input: &Value) -> ToolInput {
    let text = |key: &str| input.get(key).and_then(Value::as_str);
    let owned = |key: &str, max: usize| text(key).map(|v| bounded_marked(v, max));
    match name {
        "Bash" | "bash" => match text("command") {
            Some(command) => ToolInput::Command {
                command: bounded_marked(command, MAX_INPUT),
                description: owned("description", MAX_INPUT),
            },
            None => other_input(input),
        },
        "Edit" => match text("file_path") {
            Some(path) => ToolInput::Edit {
                files: vec![replacement(
                    path,
                    &[(
                        text("old_string").unwrap_or_default(),
                        text("new_string").unwrap_or_default(),
                    )],
                )],
            },
            None => other_input(input),
        },
        "MultiEdit" => match (
            text("file_path"),
            input.get("edits").and_then(Value::as_array),
        ) {
            (Some(path), Some(edits)) => {
                let pairs: Vec<(&str, &str)> = edits
                    .iter()
                    .map(|e| {
                        (
                            e.get("old_string")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            e.get("new_string")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                        )
                    })
                    .collect();
                ToolInput::Edit {
                    files: vec![replacement(path, &pairs)],
                }
            }
            _ => other_input(input),
        },
        "Write" => match text("file_path") {
            Some(path) => ToolInput::Edit {
                files: vec![creation(path, text("content").unwrap_or_default())],
            },
            None => other_input(input),
        },
        "NotebookEdit" => match text("notebook_path") {
            Some(path) => ToolInput::Edit {
                files: vec![FileChange {
                    path: label(path),
                    op: FileOp::Update,
                    patch: None,
                    added: text("new_source").map_or(0, |s| s.lines().count() as u32),
                    removed: 0,
                    truncated: false,
                }],
            },
            None => other_input(input),
        },
        "Read" => match text("file_path") {
            Some(path) => ToolInput::Read {
                path: label(path),
                lines: line_range(input),
            },
            None => other_input(input),
        },
        "Grep" => match text("pattern") {
            Some(pattern) => ToolInput::Search {
                pattern: bounded_marked(pattern, MAX_INPUT),
                scope: text("path").or_else(|| text("glob")).map(label),
            },
            None => other_input(input),
        },
        "Glob" => match text("pattern") {
            Some(pattern) => ToolInput::Search {
                pattern: bounded_marked(pattern, MAX_INPUT),
                scope: text("path").map(label),
            },
            None => other_input(input),
        },
        "WebFetch" => match text("url") {
            Some(url) => ToolInput::Fetch {
                url: bounded_marked(url, MAX_INPUT),
                prompt: owned("prompt", MAX_INPUT),
            },
            None => other_input(input),
        },
        "WebSearch" => match text("query") {
            Some(query) => ToolInput::WebSearch {
                query: bounded_marked(query, MAX_INPUT),
            },
            None => other_input(input),
        },
        "Agent" | "Task" => ToolInput::Agent {
            description: owned("description", MAX_INPUT),
            agent_type: text("subagent_type").map(label),
            prompt: bounded_marked(text("prompt").unwrap_or_default(), MAX_INPUT),
        },
        "ExitPlanMode" => match text("plan") {
            Some(plan) => ToolInput::Plan {
                markdown: bounded_marked(plan, MAX_TEXT),
            },
            None => other_input(input),
        },
        "TodoWrite" => match input.get("todos").and_then(Value::as_array) {
            Some(todos) => ToolInput::Todos {
                items: todos.iter().filter_map(todo_item).take(MAX_LIST).collect(),
            },
            None => other_input(input),
        },
        "AskUserQuestion" => match input.get("questions").and_then(Value::as_array) {
            Some(questions) => ToolInput::Questions {
                questions: questions
                    .iter()
                    .filter_map(question)
                    .take(MAX_LIST)
                    .collect(),
            },
            None => other_input(input),
        },
        _ => other_input(input),
    }
}

/// An MCP tool, or one this does not know: its arguments as JSON.
fn other_input(input: &Value) -> ToolInput {
    let json = serde_json::to_string_pretty(input).unwrap_or_default();
    ToolInput::Other {
        json: bounded_marked(&json, MAX_JSON),
    }
}

/// `Read`'s `offset`/`limit` as a human range ("lines 40–120").
fn line_range(input: &Value) -> Option<String> {
    let offset = input.get("offset").and_then(lenient_u64);
    let limit = input.get("limit").and_then(lenient_u64).filter(|l| *l > 0);
    match (offset, limit) {
        (Some(from), Some(n)) => Some(format!("lines {from}–{}", from.saturating_add(n - 1))),
        (Some(from), None) => Some(format!("from line {from}")),
        (None, Some(n)) => Some(format!("lines 1–{n}")),
        (None, None) => None,
    }
}

fn todo_item(v: &Value) -> Option<TodoItem> {
    let text = v.get("content").and_then(Value::as_str)?;
    Some(TodoItem {
        text: bounded_marked(text, MAX_INPUT),
        status: match v.get("status").and_then(Value::as_str) {
            Some("in_progress") => TodoStatus::InProgress,
            Some("completed") => TodoStatus::Completed,
            _ => TodoStatus::Pending,
        },
    })
}

fn question(v: &Value) -> Option<Question> {
    let text = v.get("question").and_then(Value::as_str)?;
    let options = v
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|o| {
                    o.get("label")
                        .and_then(Value::as_str)
                        .or_else(|| o.as_str())
                })
                .take(MAX_LIST)
                .map(label)
                .collect()
        })
        .unwrap_or_default();
    Some(Question {
        header: v.get("header").and_then(Value::as_str).map(label),
        // Unmarked: the result's answers are keyed by this text.
        question: bounded(text, MAX_INPUT).0,
        options,
        answer: None,
    })
}

/// How a tool call ended, from its result record.
fn result_status(rec: &Obj, is_error: bool, text: &str) -> ToolStatus {
    match str_of(rec, "toolDenialKind") {
        // Not run, or stopped while it ran, without anyone refusing it: the
        // turn was stopped, cut short to deliver a message, moved to the
        // background, or ended with the session.
        Some("cancelled" | "interrupted") => return ToolStatus::Interrupted,
        // `user-rejected` (until an interrupt marker says otherwise, see
        // `ClaudeTranscript::interrupt`), `permission-rule`, `automode-*`.
        Some(_) => return ToolStatus::Denied,
        None => {}
    }
    let decision = rec
        .get("permissionDecision")
        .and_then(|p| p.get("decision"))
        .and_then(Value::as_str);
    if decision == Some("reject") {
        return ToolStatus::Denied;
    }
    if !is_error {
        return ToolStatus::Done;
    }
    // CLIs that predate `toolDenialKind` say so in the result's text.
    let lead = text.trim_start();
    if lead.starts_with("The user doesn't want to") {
        ToolStatus::Denied
    } else if lead.starts_with("[Request interrupted") {
        ToolStatus::Interrupted
    } else {
        ToolStatus::Failed
    }
}

/// A call's result landed: its status, output, and what the structured
/// result adds for its kind of tool.
fn apply_result(
    call: &mut ToolCall,
    structured: Option<&Obj>,
    text: &str,
    mut status: ToolStatus,
    is_error: bool,
) {
    let mut out = text.to_string();
    let mut exit_code = None;
    match call.name.as_str() {
        "Bash" | "bash" => {
            if let Some(r) = structured {
                let (stdout, stderr) = (str_of(r, "stdout"), str_of(r, "stderr"));
                if stdout.is_some() || stderr.is_some() {
                    out = [stdout, stderr]
                        .into_iter()
                        .flatten()
                        .map(str::trim_end)
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                if bool_of(r, "interrupted") && status == ToolStatus::Done {
                    status = ToolStatus::Interrupted;
                }
            }
            // A failed command's result opens with its exit code; a successful
            // one's records none.
            if status == ToolStatus::Failed {
                if let Some((code, rest)) = exit_code_line(text) {
                    exit_code = Some(code);
                    out = rest.to_string();
                }
            }
        }
        "Edit" | "MultiEdit" | "Write" => {
            if let (Some(r), ToolInput::Edit { files }) = (structured, &mut call.input) {
                if let Some(file) = files.first_mut() {
                    apply_file_result(file, r);
                }
            }
        }
        "Read" => {
            if let Some(file) = structured
                .and_then(|r| r.get("file"))
                .and_then(Value::as_object)
            {
                if let Some(content) = str_of(file, "content") {
                    out = content.to_string();
                } else if file.contains_key("base64") {
                    out = "[image]".to_string();
                }
            }
        }
        "WebFetch" => {
            if let Some(result) = structured.and_then(|r| str_of(r, "result")) {
                out = result.to_string();
            }
        }
        "Agent" | "Task" => {
            if let Some(r) = structured {
                let reported = str_of(r, "status");
                if let Some(agent_id) = str_of(r, "agentId").filter(|id| !id.is_empty()) {
                    let status = reported.map_or(SubagentStatus::Unknown, subagent_status);
                    match call.subagent.as_mut() {
                        Some(link) => {
                            link.agent_id = label(agent_id);
                            link.status = status;
                        }
                        None => {
                            call.subagent = Some(SubagentLink {
                                agent_id: label(agent_id),
                                agent_type: agent_type_of(&call.input),
                                status,
                            })
                        }
                    }
                }
                // A subagent that ran in the foreground returns its report.
                if reported == Some("completed") {
                    if let Some(report) = r.get("content").and_then(Value::as_array) {
                        let report = prose(report).0;
                        if !report.trim().is_empty() {
                            out = report;
                        }
                    }
                }
            }
        }
        "AskUserQuestion" => {
            let answers = structured
                .and_then(|r| r.get("answers"))
                .and_then(Value::as_object);
            if let (Some(answers), ToolInput::Questions { questions }) = (answers, &mut call.input)
            {
                for q in questions.iter_mut() {
                    if let Some(answer) = answers.get(&q.question) {
                        q.answer = Some(answer_text(answer));
                    }
                }
            }
        }
        _ => {}
    }
    if let Some(link) = call.subagent.as_mut() {
        if link.status == SubagentStatus::Running {
            match status {
                ToolStatus::Interrupted | ToolStatus::Denied => {
                    link.status = SubagentStatus::Stopped
                }
                ToolStatus::Failed => link.status = SubagentStatus::Failed,
                ToolStatus::Running | ToolStatus::Done => {}
            }
        }
    }
    let (text, truncated) = bounded(&out, MAX_OUTPUT);
    call.status = status;
    call.output = Some(ToolOutput {
        text,
        truncated,
        is_error: is_error || matches!(status, ToolStatus::Denied | ToolStatus::Failed),
        exit_code,
    });
}

/// What a file write's structured result adds: the real hunks, and whether
/// `Write` created the file or replaced it.
fn apply_file_result(file: &mut FileChange, r: &Obj) {
    if let Some(path) = str_of(r, "filePath").filter(|p| !p.is_empty()) {
        if file.path != path {
            file.path = label(path);
        }
    }
    let hunks: Vec<Hunk> = r
        .get("structuredPatch")
        .and_then(Value::as_array)
        .map(|patch| patch.iter().filter_map(structured_hunk).collect())
        .unwrap_or_default();
    match str_of(r, "type") {
        Some("create") => file.op = FileOp::Add,
        // `Write` over an existing file: its hunks, never the "all added"
        // patch drawn while it ran.
        Some("update") => *file = file_change(&file.path, FileOp::Update, &hunks),
        _ if !hunks.is_empty() => *file = file_change(&file.path, FileOp::Update, &hunks),
        _ => {}
    }
}

fn answer_text(answer: &Value) -> String {
    let text = match answer {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .take(MAX_LIST)
            .map(|i| i.as_str().map_or_else(|| i.to_string(), str::to_string))
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    };
    bounded_marked(&text, MAX_INPUT)
}

/// `Exit code <n>` opening a failed command's result, and the rest of it.
fn exit_code_line(text: &str) -> Option<(i32, &str)> {
    let rest = text.trim_start().strip_prefix("Exit code ")?;
    let (code, rest) = rest.split_once('\n').unwrap_or((rest, ""));
    Some((code.trim().parse().ok()?, rest))
}

/// A `tool_result`'s content as text: a string, or its text blocks.
fn result_text(content: Option<&Value>) -> String {
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| match block_type(b) {
                Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
                Some("image") => Some("[image]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    // A refused call's reason comes wrapped for the model.
    match text
        .trim()
        .strip_prefix("<tool_use_error>")
        .and_then(|t| t.strip_suffix("</tool_use_error>"))
    {
        Some(inner) => inner.trim().to_string(),
        None => text,
    }
}

/// A subagent's status word, as its parent recorded it.
fn subagent_status(reported: &str) -> SubagentStatus {
    match reported {
        "async_launched" | "remote_launched" | "running" => SubagentStatus::Running,
        "completed" => SubagentStatus::Completed,
        "failed" | "error" => SubagentStatus::Failed,
        "killed" | "stopped" | "cancelled" => SubagentStatus::Stopped,
        _ => SubagentStatus::Unknown,
    }
}

/// What a sidecar-linked subagent's status is, from its call's.
fn subagent_status_of_call(status: ToolStatus) -> SubagentStatus {
    match status {
        ToolStatus::Running => SubagentStatus::Running,
        ToolStatus::Done => SubagentStatus::Unknown,
        ToolStatus::Failed => SubagentStatus::Failed,
        ToolStatus::Denied | ToolStatus::Interrupted => SubagentStatus::Stopped,
    }
}

// ── Diffs ───────────────────────────────────────────────────────────────────

/// One hunk, its lines carrying their ` `/`+`/`-` prefix.
struct Hunk {
    old_start: u64,
    new_start: u64,
    lines: Vec<String>,
}

/// A hunk of the `structuredPatch` an edit's result carries.
fn structured_hunk(v: &Value) -> Option<Hunk> {
    Some(Hunk {
        old_start: v.get("oldStart").and_then(lenient_u64)?,
        new_start: v.get("newStart").and_then(lenient_u64)?,
        lines: v
            .get("lines")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    })
}

/// An edit drawn from its arguments, before (or without) its result: the
/// replaced text removed, the new text added. The record says where in the
/// file only once the result lands, so these hunks start at line 1.
fn replacement(path: &str, edits: &[(&str, &str)]) -> FileChange {
    let hunks: Vec<Hunk> = edits
        .iter()
        .map(|(old, new)| {
            let lines: Vec<String> = old
                .lines()
                .map(|l| format!("-{l}"))
                .chain(new.lines().map(|l| format!("+{l}")))
                .collect();
            Hunk {
                old_start: 1,
                new_start: 1,
                lines,
            }
        })
        .collect();
    file_change(path, FileOp::Update, &hunks)
}

/// A whole file written: every line added.
fn creation(path: &str, content: &str) -> FileChange {
    let hunk = Hunk {
        old_start: 0,
        new_start: 1,
        lines: content.lines().map(|l| format!("+{l}")).collect(),
    };
    file_change(path, FileOp::Add, &[hunk])
}

/// A file's change with its hunks rendered as unified-diff text, bounded at
/// [`MAX_PATCH`]. Whole hunks are kept while they fit; the one that does not
/// is cut at a line, its header recounted to the lines it keeps, so what is
/// drawn is always a well-formed diff. The counts are the whole change's.
fn file_change(path: &str, op: FileOp, hunks: &[Hunk]) -> FileChange {
    let (mut added, mut removed) = (0u32, 0u32);
    for line in hunks.iter().flat_map(|h| &h.lines) {
        match line.as_bytes().first() {
            Some(b'+') => added += 1,
            Some(b'-') => removed += 1,
            _ => {}
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut size = 0usize;
    let mut truncated = false;
    for hunk in hunks.iter().filter(|h| !h.lines.is_empty()) {
        let whole: usize = hunk.lines.iter().map(|l| l.len() + 1).sum::<usize>() + 48;
        let kept: Vec<String> = if size + whole <= MAX_PATCH {
            hunk.lines.clone()
        } else {
            truncated = true;
            let mut kept = Vec::new();
            let mut room = MAX_PATCH.saturating_sub(size + 48);
            for line in &hunk.lines {
                if line.len() + 1 > room {
                    // A single line longer than all the room left: keep its
                    // start rather than draw nothing at all.
                    if kept.is_empty() && room > 1 {
                        kept.push(bounded(line, room - 1).0);
                    }
                    break;
                }
                room -= line.len() + 1;
                kept.push(line.clone());
            }
            kept
        };
        if kept.is_empty() {
            break;
        }
        let header = hunk_header(hunk, &kept);
        size += header.len() + 1 + kept.iter().map(|l| l.len() + 1).sum::<usize>();
        out.push(header);
        out.extend(kept);
        if truncated {
            break;
        }
    }
    FileChange {
        path: label(path),
        op,
        patch: (!out.is_empty()).then(|| out.join("\n")),
        added,
        removed,
        truncated,
    }
}

/// `@@ -a,b +c,d @@`, counting the lines the hunk keeps.
fn hunk_header(hunk: &Hunk, lines: &[String]) -> String {
    let old = lines
        .iter()
        .filter(|l| matches!(l.as_bytes().first(), Some(b' ' | b'-')))
        .count();
    let new = lines
        .iter()
        .filter(|l| matches!(l.as_bytes().first(), Some(b' ' | b'+')))
        .count();
    // An empty side starts at the line before it, as `diff -u` writes it.
    let old_start = if old == 0 {
        hunk.old_start.saturating_sub(1)
    } else {
        hunk.old_start.max(1)
    };
    let new_start = if new == 0 {
        hunk.new_start.saturating_sub(1)
    } else {
        hunk.new_start.max(1)
    };
    format!("@@ -{old_start},{old} +{new_start},{new} @@")
}

// ── Small readers ───────────────────────────────────────────────────────────

fn str_of<'a>(o: &'a Obj, key: &str) -> Option<&'a str> {
    o.get(key)?.as_str()
}

fn num_of(o: &Obj, key: &str) -> Option<f64> {
    o.get(key)?.as_f64()
}

fn bool_of(o: &Obj, key: &str) -> bool {
    o.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// A count the CLI may write as a number or a numeric string.
fn lenient_u64(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.trim().parse().ok())
}

fn block_type(block: &Value) -> Option<&str> {
    block.get("type")?.as_str()
}

fn nonempty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(label)
}

/// Overwrite `slot` with a non-empty `value` that differs from it, without
/// allocating when it doesn't. Every field it sets is a one-line label.
fn set_if_changed(slot: &mut Option<String>, value: Option<&str>) {
    if let Some(value) = value.filter(|v| !v.is_empty()).map(|v| cut(v, MAX_LABEL)) {
        if slot.as_deref() != Some(value) {
            *slot = Some(value.to_string());
        }
    }
}

fn timestamp_ms(rec: &Obj) -> Option<f64> {
    let ts = str_of(rec, "timestamp")?;
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|t| t.timestamp_millis() as f64)
}

/// A message's prose — its text blocks, a blank line apart — and how many
/// images it carries.
fn prose(blocks: &[Value]) -> (String, u32) {
    let mut text = String::new();
    let mut images = 0;
    for block in blocks {
        match block_type(block) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(t);
                }
            }
            Some("image") => images += 1,
            _ => {}
        }
    }
    (text, images)
}

/// The name of the XML-ish tag `text` opens with, if it opens with one.
fn opening_tag(text: &str) -> Option<&str> {
    let rest = text.trim_start().strip_prefix('<')?;
    let end = rest.find(|c: char| c == '>' || c == '/' || c.is_whitespace())?;
    Some(&rest[..end]).filter(|tag| !tag.is_empty())
}

/// The text between `<tag>` and `</tag>`. These tags never nest.
fn tag_value<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&format!("</{tag}>"))?;
    Some(&text[start..start + end])
}

fn starts_with_ci(haystack: &str, needle: &str) -> bool {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    h.len() >= n.len() && h[..n.len()].eq_ignore_ascii_case(n)
}

/// Every string of a record, keys included, made safe to draw ([`clean`]).
/// Keys too, because some are matched against values (a question's answers
/// are keyed by its text).
fn clean_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            if let Cow::Owned(cleaned) = clean(text) {
                *text = cleaned;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(clean_value),
        Value::Object(map) => {
            if map.keys().any(|key| key.chars().any(is_unsafe_char)) {
                for (key, mut item) in std::mem::take(map) {
                    clean_value(&mut item);
                    map.insert(clean(&key).into_owned(), item);
                }
            } else {
                map.values_mut().for_each(clean_value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// `text` as text and nothing a terminal would act on: no escape sequences
/// (CSI, OSC and the other string controls, two-character escapes, and their
/// 8-bit C1 forms), and no other C0 or C1 control, DEL included, but tab and
/// newline. A record's text is drawn by the view, never by a terminal: a
/// colour code there is noise, and a carriage return or an escape there would
/// let a tool's output or a fetched page restyle or overprint what the view
/// shows.
fn clean(text: &str) -> Cow<'_, str> {
    if !text.chars().any(is_unsafe_char) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => skip_csi(&mut chars),
                Some(']' | 'P' | 'X' | '^' | '_') => skip_string(&mut chars),
                // A two-character escape, or a lone ESC at the end.
                Some(_) | None => {}
            },
            '\u{9b}' => skip_csi(&mut chars),
            '\u{90}' | '\u{98}' | '\u{9d}' | '\u{9e}' | '\u{9f}' => skip_string(&mut chars),
            c if is_unsafe_char(c) => {}
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}

/// A control character other than tab and newline: C0, DEL and C1.
fn is_unsafe_char(c: char) -> bool {
    c.is_control() && c != '\t' && c != '\n'
}

/// The rest of a control sequence: parameters, then one final byte in
/// `@`..=`~`.
fn skip_csi(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    for c in chars.by_ref() {
        if ('@'..='~').contains(&c) {
            break;
        }
    }
}

/// The rest of a control string (OSC, DCS, SOS, PM, APC): up to BEL or ST,
/// `ESC \` or its 8-bit form.
fn skip_string(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(c) = chars.next() {
        match c {
            '\u{7}' | '\u{9c}' => break,
            '\u{1b}' if chars.peek() == Some(&'\\') => {
                chars.next();
                break;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::ConversationItem;

    /// A session's transcript as CLI 2.1.309 writes it — the records' shapes
    /// copied from real ones, every text, path and id a placeholder.
    const FIXTURE: &str = include_str!("testdata/claude-session.jsonl");

    fn describe(item: &ConversationItem) -> String {
        match &item.body {
            ItemBody::User(m) => format!("user {:?}: {}", m.origin, m.text),
            ItemBody::Agent(m) => format!("agent: {}", m.text),
            ItemBody::Reasoning(r) => format!("reasoning {:?}: {}", r.duration_ms, r.text),
            ItemBody::Tool(c) => format!("tool {} {:?}", c.name, c.status),
            ItemBody::Notice(n) => format!("notice {:?}: {}", n.tone, n.text),
            ItemBody::TurnEnd(t) => format!("turn end {:?}", t.duration_ms),
            ItemBody::Queued(q) => format!("queued {:?}: {}", q.status, q.text),
        }
    }

    fn call<'a>(items: &'a [ConversationItem], call_id: &str) -> &'a ToolCall {
        items
            .iter()
            .find_map(|i| match &i.body {
                ItemBody::Tool(c) if c.call_id == call_id => Some(c),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no call {call_id}"))
    }

    #[test]
    fn a_claude_transcript_reads_as_its_conversation() {
        let mut transcript = ClaudeTranscript::new(TranscriptKind::Main);
        for line in FIXTURE.lines() {
            transcript.push_line(line.as_bytes());
        }
        let items = transcript.journal().items();
        let got: Vec<(String, u32, String)> = items
            .iter()
            .map(|i| (i.id.clone(), i.turn, describe(i)))
            .collect();
        // Skipped, by design: the session's metadata records, hook attachments,
        // the file-history snapshot, a task notification's trip through the
        // prompt queue, a line that is not JSON, a subagent's line in the main
        // file, and a record seen twice.
        #[rustfmt::skip]
        let want: &[(&str, u32, &str)] = &[
            ("u-caveat", 0, "user Injected: <local-command-caveat>Caveat: placeholder caveat.</local-command-caveat>"),
            ("u-slash", 0, "user Command: /model sonnet"),
            ("u-localcmd", 0, "user Command: Set model to placeholder"),
            ("u-p1", 1, "user Typed: Placeholder prompt one"),
            // An empty block with the time it took, then a summary: one item.
            ("u-a1", 1, "reasoning Some(4201.0): A short placeholder summary."),
            ("u-a3", 1, "agent: Placeholder reply."),
            ("tool:toolu_bash", 1, "tool Bash Done"),
            ("tool:toolu_fail", 1, "tool Bash Failed"),
            ("tool:toolu_edit", 1, "tool Edit Done"),
            ("tool:toolu_write", 1, "tool Write Done"),
            ("tool:toolu_read", 1, "tool Read Done"),
            ("tool:toolu_agent", 1, "tool Agent Done"),
            ("tool:toolu_mcp", 1, "tool mcp__placeholder__get_item Done"),
            ("tool:toolu_denied", 1, "tool Edit Denied"),
            ("u-g1", 1, "reasoning Some(900.0): "),
            ("u-g2", 1, "agent: Turn one done."),
            ("u-td1", 1, "turn end Some(64000.0)"),
            ("u-tn", 1, "user Injected: Agent \"Placeholder task\" completed"),
            // Enqueued at the Enter, then delivered as a turn of its own.
            ("#1", 1, "queued Delivered: Placeholder queued prompt"),
            ("u-p2", 2, "user Queued: Placeholder queued prompt"),
            ("tool:toolu_ask", 2, "tool AskUserQuestion Done"),
            ("#2", 2, "queued Delivered: Placeholder absorbed prompt"),
            // Typed mid-turn and absorbed into it: queued, but no new turn.
            ("u-qc", 2, "user Queued: Placeholder absorbed prompt"),
            ("tool:toolu_plan", 2, "tool ExitPlanMode Done"),
            ("tool:toolu_slow", 2, "tool Bash Interrupted"),
            ("u-int", 2, "notice Warning: Request interrupted by user for tool use"),
            ("#3", 2, "notice Info: Permission mode: plan"),
            ("u-cb", 2, "notice Info: Conversation compacted automatically (180000 → 12000 tokens)"),
            ("u-sum", 2, "user Injected: Placeholder summary of the conversation."),
            ("u-err", 2, "notice Error: API Error: placeholder"),
            ("u-bang", 2, "user Command: !ls placeholder"),
            ("u-bango", 2, "user Command: placeholder listing"),
            // Esc while the call ran (CLI 2.1.312): its result reads like a
            // refusal, and the marker after it names the message it stopped.
            ("u-p3", 3, "user Typed: Placeholder prompt three"),
            ("tool:toolu_running", 3, "tool Bash Interrupted"),
            ("u-int2", 3, "notice Warning: Request interrupted by user for tool use"),
            // "No" at the prompt: the same result, a marker naming no message.
            ("u-p4", 4, "user Typed: Placeholder prompt four"),
            ("tool:toolu_refused", 4, "tool Bash Denied"),
            ("u-int3", 4, "notice Warning: Request interrupted by user for tool use"),
            // Cut short to deliver a message typed meanwhile: nobody refused it.
            ("u-p5", 5, "user Typed: Placeholder prompt five"),
            // Recalled into the input to edit (`popAll`): never delivered.
            ("#4", 5, "queued Withdrawn: Placeholder recalled prompt"),
            ("#5", 5, "queued Delivered: Placeholder queued prompt six"),
            ("#6", 5, "queued Delivered: Placeholder queued prompt seven"),
            ("tool:toolu_cut", 5, "tool Bash Interrupted"),
            // Queued together, delivered together, answered in one turn.
            ("u-q6", 6, "user Queued: Placeholder queued prompt six"),
            ("u-q7", 6, "user Queued: Placeholder queued prompt seven"),
        ];
        let want: Vec<(String, u32, String)> = want
            .iter()
            .map(|(id, turn, d)| (id.to_string(), *turn, d.to_string()))
            .collect();
        assert_eq!(got, want);
        for (seq, item) in items.iter().enumerate() {
            assert_eq!(item.seq, seq as u32);
        }
        // Until the queue gives it up, an enqueued prompt is pending.
        let mut queued = ClaudeTranscript::new(TranscriptKind::Main);
        let enqueue = FIXTURE
            .lines()
            .find(|l| l.contains("\"enqueue\"") && l.contains("Placeholder queued prompt\""))
            .unwrap();
        queued.push_line(enqueue.as_bytes());
        assert_eq!(
            queued
                .journal()
                .items()
                .iter()
                .map(describe)
                .collect::<Vec<_>>(),
            ["queued Pending: Placeholder queued prompt"]
        );

        let failed = call(&items, "toolu_fail").output.clone().unwrap();
        assert_eq!(
            (failed.exit_code, failed.text.as_str(), failed.is_error),
            (Some(2), "placeholder error", true)
        );

        let ToolInput::Edit { files } = &call(&items, "toolu_edit").input else {
            panic!("an Edit is drawn as a file change");
        };
        assert_eq!(
            (
                files[0].op,
                files[0].patch.as_deref(),
                files[0].added,
                files[0].removed
            ),
            (
                FileOp::Update,
                Some(
                    "@@ -10,3 +10,4 @@\n context a\n-old line\n+new line\n+second line\n context b"
                ),
                2,
                1
            ),
            "the result's real hunks replace the ones drawn from the arguments"
        );
        let ToolInput::Edit { files } = &call(&items, "toolu_write").input else {
            panic!("a Write is drawn as a file change");
        };
        assert_eq!(
            (files[0].op, files[0].patch.as_deref(), files[0].added),
            (FileOp::Add, Some("@@ -0,0 +1,2 @@\n+alpha\n+beta"), 2)
        );

        let read = call(&items, "toolu_read");
        assert_eq!(
            read.input,
            ToolInput::Read {
                path: "/placeholder/repo/README.md".into(),
                lines: Some("lines 40–120".into()),
            }
        );
        assert_eq!(read.output.as_ref().unwrap().text, "placeholder file text");

        // Launched in the background, then finished: its report lands on the
        // call that started it.
        let agent = call(&items, "toolu_agent");
        assert_eq!(
            agent.subagent,
            Some(SubagentLink {
                agent_id: "a0123456789abcdef".into(),
                agent_type: Some("Explore".into()),
                status: SubagentStatus::Completed,
            })
        );
        assert_eq!(agent.output.as_ref().unwrap().text, "Placeholder report.");

        assert_eq!(
            call(&items, "toolu_mcp").input,
            ToolInput::Other {
                json: "{\n  \"id\": \"X-1\"\n}".into()
            }
        );
        assert!(
            call(&items, "toolu_denied")
                .output
                .as_ref()
                .unwrap()
                .is_error
        );
        let ToolInput::Questions { questions } = &call(&items, "toolu_ask").input else {
            panic!("AskUserQuestion is drawn as questions");
        };
        assert_eq!(
            (questions[0].options.clone(), questions[0].answer.as_deref()),
            (vec!["A".to_string(), "B".to_string()], Some("B"))
        );

        // msg_G was recorded twice, first with placeholder output: counted once,
        // at its final size.
        let ItemBody::TurnEnd(end) = &items[16].body else {
            panic!("item 16 ends the turn");
        };
        assert_eq!(
            end.usage,
            Some(TokenUsage {
                input: 25.0,
                output: 420.0,
                cache_read: 4900.0,
                cache_write: 120.0,
                reasoning: 20.0,
            })
        );

        let meta = transcript.meta();
        assert_eq!(meta.title.as_deref(), Some("Placeholder custom title"));
        assert_eq!(meta.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(meta.cwd.as_deref(), Some("/placeholder/repo"));
        assert_eq!(meta.git_branch.as_deref(), Some("main"));
        assert_eq!(meta.cli_version.as_deref(), Some("2.1.309"));
        assert_eq!(meta.permission_mode.as_deref(), Some("plan"));
        // The compaction reset the meter; the API error after it cost nothing.
        assert_eq!(
            meta.context,
            Some(ContextUsage {
                used_tokens: 12000.0,
                window_tokens: None
            })
        );
        assert_eq!(
            meta.usage,
            Some(TokenUsage {
                input: 40.0,
                output: 570.0,
                cache_read: 9700.0,
                cache_write: 150.0,
                reasoning: 20.0,
            })
        );
        assert!(!meta.truncated);
    }

    /// Every text the view draws comes out of a record, and a record's text is
    /// whatever a command printed, a page said or a model wrote. Drawn as
    /// markdown or as text, an escape sequence, a carriage return or a C1
    /// control there would restyle, overprint or hide what the view shows, so
    /// none reaches an item or the meta, whichever field carries it: prose,
    /// reasoning, a read or a fetch's result, an MCP call's arguments and
    /// output, a tool input, a notice, the title, the envelope, a sidecar.
    #[test]
    fn no_control_character_reaches_what_the_view_draws() {
        // CSI colour, an OSC title, CR, NUL, DEL, an 8-bit CSI and NEL around
        // the text; tab and newline are text.
        const DIRTY: &str =
            "a\u{1b}[31mb\u{1b}[0m\u{1b}]0;title\u{7}c\rd\u{0}e\u{7f}f\u{9b}2Jg\u{85}h\ti\nj";
        const CLEAN: &str = "abcdefgh\ti\nj";
        let envelope = |uuid: &str, kind: &str, fields: Value| {
            let mut r = serde_json::json!({
                "uuid": uuid, "type": kind, "isSidechain": false,
                "cwd": DIRTY, "gitBranch": DIRTY, "version": DIRTY,
                "timestamp": "2026-10-27T10:00:00.000Z",
            });
            if let (Value::Object(r), Value::Object(fields)) = (&mut r, fields) {
                r.extend(fields);
            }
            r.to_string()
        };
        let call = |id: &str, name: &str, input: Value| serde_json::json!({ "type": "tool_use", "id": id, "name": name, "input": input });
        let result = |id: &str, content: &str| serde_json::json!({ "type": "tool_result", "tool_use_id": id, "content": content });
        let lines = [
            serde_json::json!({ "type": "custom-title", "customTitle": DIRTY }).to_string(),
            envelope(
                "u1",
                "user",
                serde_json::json!({
                    "promptSource": "typed",
                    "message": { "role": "user", "content": DIRTY },
                }),
            ),
            envelope(
                "a1",
                "assistant",
                serde_json::json!({ "message": {
                    "id": "m1", "model": DIRTY, "content": [
                        { "type": "thinking", "thinking": DIRTY },
                        { "type": "text", "text": DIRTY },
                        call("t-read", "Read", serde_json::json!({ "file_path": DIRTY })),
                        call("t-grep", "Grep", serde_json::json!({ "pattern": DIRTY, "path": DIRTY })),
                        call("t-fetch", "WebFetch", serde_json::json!({ "url": DIRTY, "prompt": DIRTY })),
                        call("t-mcp", "mcp__x__get", serde_json::json!({ DIRTY: DIRTY })),
                        call("t-agent", "Agent", serde_json::json!({ "description": DIRTY, "prompt": DIRTY })),
                    ],
                }}),
            ),
            envelope(
                "r1",
                "user",
                serde_json::json!({
                    "message": { "role": "user", "content": [result("t-read", "x")] },
                    "toolUseResult": { "file": { "content": DIRTY } },
                }),
            ),
            envelope(
                "r2",
                "user",
                serde_json::json!({
                    "message": { "role": "user", "content": [result("t-fetch", "x")] },
                    "toolUseResult": { "result": DIRTY },
                }),
            ),
            envelope(
                "r3",
                "user",
                serde_json::json!({
                    "message": { "role": "user", "content": [result("t-mcp", DIRTY)] },
                }),
            ),
            envelope(
                "n1",
                "system",
                serde_json::json!({
                    "subtype": "informational", "level": "warning", "content": DIRTY,
                }),
            ),
        ];
        let mut transcript = ClaudeTranscript::new(TranscriptKind::Main);
        for line in &lines {
            transcript.push_line(line.as_bytes());
        }
        transcript.link_subagent("t-agent", "a0123456789abcdef", Some(DIRTY));

        let items = transcript.journal().items();
        assert!(items.len() >= 9, "every record was read: {}", items.len());
        let ItemBody::User(prompt) = &items[0].body else {
            panic!("the prompt comes first");
        };
        assert_eq!(prompt.text, CLEAN, "what is cut and what is kept");

        fn strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
            match value {
                Value::String(s) => out.push(s),
                Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
                Value::Object(map) => map.iter().for_each(|(k, v)| {
                    out.push(k);
                    strings(v, out);
                }),
                _ => {}
            }
        }
        let drawn = serde_json::json!({
            "items": serde_json::to_value(&items).unwrap(),
            "meta": serde_json::to_value(transcript.meta()).unwrap(),
        });
        let mut texts = Vec::new();
        strings(&drawn, &mut texts);
        for text in texts {
            assert!(
                !text.chars().any(is_unsafe_char),
                "a control character reached the view: {text:?}"
            );
        }
    }
}
