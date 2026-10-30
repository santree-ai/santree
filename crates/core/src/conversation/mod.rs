//! A coding agent's conversation, as the Conversation view draws it.
//!
//! One provider-neutral model for a Claude Code session and a Codex thread, built
//! from the agent's own record of the session — the transcript Claude Code writes
//! under `projects/`, the rollout Codex writes under `sessions/` — while the real
//! CLI keeps running in its terminal. Display-only (COMPLIANCE.md, "Transcript
//! reads"): nothing here reaches a model, a prompt, or a PTY.
//!
//! The model is a journal: an ordered list of [`ConversationItem`]s with stable
//! ids. A read returns what was created or changed after the reader's
//! [`ConversationCursor`], so a view appends and replaces by id instead of
//! re-reading the session — a tool call is recorded when it starts and replaced
//! when its result lands.
//!
//! Both records are internal to their CLI and change between versions, so the
//! mapping is tolerant by construction: a record it does not know is skipped,
//! and a tool it does not know is still drawn ([`ToolInput::Other`]).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::domain::{AgentKind, SubagentStatus};

pub mod claude;
mod journal;

pub use journal::Journal;

/// Which conversation a view reads. Never a path: the backend derives the file
/// from the tab's own `terminal_sessions` row, or from the worktree's validated
/// session listing exactly as Session history does.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConversationTarget {
    /// The session a tab's terminal is bound to now. It follows the row, so a
    /// `/clear` or a resume that rebinds the tab moves the view with it.
    Tab {
        repo: String,
        #[serde(rename = "termKey")]
        term_key: String,
    },
    /// A session from a worktree's history list.
    Session {
        repo: String,
        #[serde(rename = "issueId")]
        issue_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

/// Where a reader is in a conversation. Opaque to the frontend: it hands back
/// the cursor the last read returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCursor {
    /// Names the backend's parse of one record file. A different value — the
    /// app restarted, the parse was evicted, the tab now names another session,
    /// the file was replaced — makes the next read a reset.
    pub epoch: String,
    /// The last revision the reader holds.
    pub rev: u32,
}

/// Whether there is a conversation to draw. `NoSession` and `NotFound` are
/// states, not errors: the view says so in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum ConversationAvailability {
    Ready,
    /// The tab's agent has not started a session yet — a Codex tab before its
    /// first prompt has no thread, so there is nothing recorded to read.
    NoSession,
    /// The session's record is not on this Mac: purged, persistence turned off,
    /// or never written.
    NotFound,
    /// A Daedalus session: its record is on the home server, which is not read
    /// live.
    Remote,
}

/// One read of a conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRead {
    pub availability: ConversationAvailability,
    /// The agent whose record this is; `None` when nothing was found.
    pub agent: Option<AgentKind>,
    /// The Claude session id or Codex thread id that was read. A view keys its
    /// change subscription on it ([`ConversationChanged`] in the app crate).
    pub session_id: Option<String>,
    pub cursor: ConversationCursor,
    /// Drop everything held and take `items` as the whole conversation.
    pub reset: bool,
    /// What was created or changed after the reader's cursor, ordered by
    /// `seq`. An item replaces the held item with the same `id`.
    pub items: Vec<ConversationItem>,
    pub meta: ConversationMeta,
}

/// What the record says about the session as a whole, as of this read.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMeta {
    /// Claude's `custom-title`, else its `ai-title`; Codex's thread name.
    pub title: Option<String>,
    /// The model of the latest main-thread turn.
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    /// The CLI version that last wrote the record.
    pub cli_version: Option<String>,
    /// Claude's permission mode, or Codex's approval policy and sandbox, as
    /// last recorded.
    pub permission_mode: Option<String>,
    /// The context in use after the latest main-thread turn. Codex's
    /// `token_count` carries the window; Claude's transcript does not, so the
    /// view takes Claude's window from the status line.
    pub context: Option<ContextUsage>,
    /// Main-thread totals, each API message counted once.
    pub usage: Option<TokenUsage>,
    /// The record was larger than the read bound and only its tail was parsed:
    /// the conversation's start is missing, and the view says so.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: f64,
    pub window_tokens: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// Codex's reasoning output tokens; Claude's thinking tokens when recorded.
    pub reasoning: f64,
}

/// One entry of the journal.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConversationItem {
    /// Stable for the life of the record: a later read that changes this item
    /// carries the same id.
    pub id: String,
    /// Order in the conversation, assigned when the item is first seen.
    pub seq: u32,
    /// The user turn it belongs to: 0 before the first typed prompt, then one
    /// more at each prompt the user typed.
    pub turn: u32,
    /// When the record says it happened, epoch ms.
    pub at_ms: Option<f64>,
    pub body: ItemBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemBody {
    /// Something sent to the agent as the user.
    User(UserMessage),
    /// The agent's prose, as markdown.
    Agent(AgentMessage),
    /// The agent's reasoning. Claude records thinking mostly empty — a short
    /// summary at most — so `text` may be blank and only the duration is known.
    Reasoning(Reasoning),
    /// A tool call and, once it lands, its result.
    Tool(ToolCall),
    /// Not a message: a compaction, an API error, an interruption, a mode or
    /// model change.
    Notice(Notice),
    /// The end of a user turn.
    TurnEnd(TurnEnd),
    /// A message typed while the agent worked, from the moment it entered the
    /// agent's queue (at the Enter) to the moment it left it. Its delivery is
    /// drawn where it landed, as a [`UserOrigin::Queued`] message; this item
    /// only says it is waiting, and then that it no longer is.
    Queued(QueuedMessage),
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub text: String,
    pub status: QueueStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum QueueStatus {
    /// In the queue: the agent hasn't taken it yet.
    Pending,
    /// Delivered: as a turn of its own after the one it waited on, or into
    /// that turn between two tool calls.
    Delivered,
    /// Taken out without a delivery the record shows: recalled into Claude's
    /// input to edit (Up at its prompt), or removed for a reason this build
    /// doesn't know.
    Withdrawn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub text: String,
    /// Images attached to it. Counted, not carried: the bytes stay in the
    /// record.
    pub images: u32,
    pub origin: UserOrigin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum UserOrigin {
    /// Typed at the prompt.
    Typed,
    /// Typed while the agent was busy and delivered when it was free.
    Queued,
    /// A slash command or shell escape the user ran.
    Command,
    /// Recorded as the user but not typed by them: a background task's
    /// completion, hook-provided context, a compaction summary.
    Injected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Reasoning {
    pub text: String,
    pub duration_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub tone: NoticeTone,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum NoticeTone {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnd {
    pub duration_ms: Option<f64>,
    /// What the turn's API messages cost in tokens, each counted once.
    pub usage: Option<TokenUsage>,
}

/// A tool call and its result.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// The agent's own id for the call (Claude's `tool_use.id`, Codex's
    /// `call_id`).
    pub call_id: String,
    /// The tool's name as the agent called it: `Bash`, `Edit`,
    /// `mcp__linear__get_issue`, `exec_command`, `apply_patch`.
    pub name: String,
    pub input: ToolInput,
    pub status: ToolStatus,
    pub output: Option<ToolOutput>,
    pub duration_ms: Option<f64>,
    /// The subagent this call started (Claude's Agent tool). Its own
    /// conversation is read with the same target and this `agent_id`.
    pub subagent: Option<SubagentLink>,
}

/// `Running` means only that no result is recorded yet; whether the session is
/// still live is the hooks' answer, not the record's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum ToolStatus {
    Running,
    Done,
    Failed,
    /// Refused — by the user at a permission prompt, or by policy.
    Denied,
    Interrupted,
}

/// A tool call's arguments, normalized to what the view draws for that kind of
/// tool.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolInput {
    /// A shell command.
    Command {
        command: String,
        description: Option<String>,
    },
    /// File writes: Edit, MultiEdit, Write, NotebookEdit, apply_patch.
    Edit {
        files: Vec<FileChange>,
    },
    /// A file read; `lines` is a human range ("lines 40–120") when one was
    /// asked for.
    Read {
        path: String,
        lines: Option<String>,
    },
    /// A content or file-name search.
    Search {
        pattern: String,
        scope: Option<String>,
    },
    /// A page fetch.
    Fetch {
        url: String,
        prompt: Option<String>,
    },
    WebSearch {
        query: String,
    },
    /// A subagent started with a brief.
    Agent {
        description: Option<String>,
        #[serde(rename = "agentType")]
        agent_type: Option<String>,
        prompt: String,
    },
    /// A plan put to the user for approval.
    Plan {
        markdown: String,
    },
    /// A todo list, as the agent last wrote it.
    Todos {
        items: Vec<TodoItem>,
    },
    /// Questions put to the user, with their answers once given.
    Questions {
        questions: Vec<Question>,
    },
    /// An MCP tool, or a tool this model does not know: its arguments as
    /// pretty-printed JSON, bounded.
    Other {
        json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub op: FileOp,
    /// Unified-diff hunks — `@@ -a,b +c,d @@` headers and ` `/`+`/`-` lines,
    /// the shape the PR diff renderer takes. `None` when only the fact of the
    /// change is known.
    pub patch: Option<String>,
    pub added: u32,
    pub removed: u32,
    /// `patch` was cut at the size bound.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum FileOp {
    Add,
    Update,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<String>,
    pub answer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    /// What the tool returned, as text: a command's output, a subagent's final
    /// report, a fetch's summary. Bounded.
    pub text: String,
    pub truncated: bool,
    /// The tool reported failure.
    pub is_error: bool,
    /// A failed command's exit code, when its result names one. Claude's Bash
    /// result has no field for it: it is read from the `Exit code N` line a
    /// failed call's result opens with, so a call that succeeded records none.
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubagentLink {
    pub agent_id: String,
    pub agent_type: Option<String>,
    pub status: SubagentStatus,
}
