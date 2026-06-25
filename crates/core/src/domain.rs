//! Domain types for santree — the AI-agent manager.
//!
//! These describe the *data* the UI renders: tickets, worktrees, diffs, triage
//! threads, settings. They carry no presentation concerns (colors, labels are
//! the frontend's job); enums are plain discriminants the UI maps to a theme.
//!
//! Every type derives `specta::Type`, so the exact shapes flow into
//! `src/bindings.ts` and the TypeScript side stays in lockstep automatically.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Which coding agent runs a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum AgentKind {
    Claude,
    Codex,
    Opencode,
}

/// A selectable agent and the models it offers in the launch tray.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub key: AgentKind,
    pub label: String,
    pub short: String,
    pub models: Vec<String>,
}

/// A connected repository / task-tracker pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name: String,
    pub tracker: String,
    /// Number of agents currently active on this repo.
    pub agents: u32,
}

/// Lifecycle status of a ticket / worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TaskStatus {
    InReview,
    InProgress,
    Todo,
    Backlog,
}

/// A ticket in the dependency graph. `x`/`y` are its canvas position; `addLines`
/// / `delLines` are the projected diff size once worked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub project: String,
    pub status: TaskStatus,
    pub ready: bool,
    pub blocked_by: Vec<String>,
    pub x: i32,
    pub y: i32,
    pub add_lines: u32,
    pub del_lines: u32,
}

/// CI state of a pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum CheckState {
    Running,
    Passing,
}

/// A pull request opened from a worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub checks: CheckState,
}

/// What an agent worktree is currently doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum Activity {
    Running,
    Idle,
    Awaiting,
}

/// A live git worktree with an agent attached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub add_lines: u32,
    pub del_lines: u32,
    pub dirty: bool,
    pub ahead: u32,
    pub agent: AgentKind,
    pub activity: Activity,
    pub pr: Option<PullRequest>,
}

/// Semantic color tone for a terminal/diff line. The frontend maps each tone to
/// a concrete theme color.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum Tone {
    Muted,
    Default,
    Accent,
    Green,
    Cyan,
    Amber,
    Red,
}

/// One line of streamed terminal output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLine {
    pub text: String,
    pub tone: Tone,
    pub indent: u32,
}

/// A worktree's terminal session: its seed transcript plus status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    pub worktree_id: String,
    pub lines: Vec<TerminalLine>,
    pub running: bool,
    pub awaiting: bool,
    pub status: String,
    pub status_tone: Tone,
    /// Working directory shown in the header, e.g. `.worktrees/ak-165`.
    pub cwd: String,
}

/// Whether a diffed file is newly added or modified in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum DiffTag {
    New,
    Modified,
}

/// The role of a single diff line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum DiffLineKind {
    Add,
    Del,
    Context,
}

/// One line inside a diff hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
}

/// A contiguous block of changes within a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// A changed file within a worktree's diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub add_lines: u32,
    pub del_lines: u32,
    pub tag: DiffTag,
    pub hunks: Vec<DiffHunk>,
}

/// The full diff for a worktree. When `clean`, there is nothing to commit and
/// `pr_note` describes the open PR instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub clean: bool,
    pub files: Vec<DiffFile>,
    pub pr_note: Option<String>,
}

/// An entry in the worktree file browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub icon: String,
    pub depth: u32,
    pub dir: bool,
    pub modified: bool,
}

/// Priority of a triage ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum Priority {
    Urgent,
    High,
    Medium,
    Low,
}

/// An untriaged ticket awaiting investigation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageTicket {
    pub id: String,
    pub title: String,
    pub priority: Priority,
    pub age: String,
    pub meta: String,
}

/// Who authored a triage message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum MessageRole {
    User,
    Agent,
}

/// A code location referenced by a triage answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeRef {
    pub path: String,
}

/// One message in a triage investigation thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageMessage {
    pub role: MessageRole,
    pub text: String,
    pub refs: Vec<CodeRef>,
}

/// A stage in an agent run, with its progress percentage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub label: String,
    pub pct: u32,
}

/// Per-agent configuration: which executable and default model to use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetting {
    pub key: AgentKind,
    pub exec: String,
    pub model: String,
}

/// Which trackers/services are connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Integrations {
    pub linear: bool,
    pub triage: bool,
    pub github: bool,
}

/// A connected Linear organization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearOrg {
    pub slug: String,
    pub name: String,
}

/// Linear connection status surfaced to the UI for a given repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearStatus {
    /// True when at least one org is connected.
    pub authenticated: bool,
    /// The slug of the org this repo uses (its own link, or the only/first org).
    pub org_slug: Option<String>,
    /// Display name of that org.
    pub org: Option<String>,
}

/// User settings seeded by the backend (the frontend then owns live edits).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_agent: AgentKind,
    pub integrations: Integrations,
    pub agents: Vec<AgentSetting>,
}
