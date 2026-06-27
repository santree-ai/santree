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

/// Which coding agent ("harness") runs a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum AgentKind {
    Claude,
    Codex,
    Cursor,
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

/// An agent harness's authentication / subscription status, as shown in the
/// harness settings tab. Mocked today (the CLI owns real auth).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuth {
    /// Whether a CLI session is currently authenticated.
    pub connected: bool,
    /// How auth is established (only "CLI" today; API keys aren't supported yet).
    pub method: String,
    /// Billing provider, e.g. "Anthropic API".
    pub provider: String,
    /// Subscription plan, e.g. "Max".
    pub plan: String,
    /// Organization the account belongs to.
    pub org: String,
    /// Signed-in account label.
    pub account: String,
    /// Where the harness keeps its settings file (for the "Open" affordance).
    pub settings_path: String,
    /// Shell command that (re)authenticates this harness, e.g. "claude /login".
    pub login_cmd: String,
    /// The executable found on the user's PATH, shown as the grayed default when
    /// no custom path is set. Empty when nothing was found.
    pub detected_exec: String,
}

/// A connected repository / task-tracker pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name: String,
    pub tracker: String,
    /// Number of agents currently active on this repo.
    pub agents: u32,
    /// Absolute path on disk, for repos the user added from a local folder.
    /// `None` for the built-in seed repos.
    pub path: Option<String>,
}

/// Lifecycle status of a ticket / worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum TaskStatus {
    InReview,
    InProgress,
    Todo,
    Backlog,
    /// Completed or canceled. Only appears on non-actionable blocker context
    /// nodes — the viewer's own assigned issues never include done work.
    Done,
}

impl TaskStatus {
    /// Whether an agent can be *started* on a ticket in this state. Only
    /// not-yet-started work (Todo/Backlog) is "ready to start"; In Progress /
    /// In Review tickets are already being worked, so they're never RDY.
    pub fn is_startable(self) -> bool {
        matches!(self, TaskStatus::Todo | TaskStatus::Backlog)
    }

    /// Human workflow-state name for this status, matching what Linear shows and
    /// what the frontend's `statusLabel` map expects.
    pub fn display_name(self) -> &'static str {
        match self {
            TaskStatus::InReview => "In Review",
            TaskStatus::InProgress => "In Progress",
            TaskStatus::Todo => "Todo",
            TaskStatus::Backlog => "Backlog",
            TaskStatus::Done => "Done",
        }
    }

    /// State color (hex) for this status, matching the frontend's `statusColor`.
    pub fn color(self) -> &'static str {
        match self {
            TaskStatus::InReview => "#3fb950",
            TaskStatus::InProgress => "#d29922",
            TaskStatus::Todo => "#4493f8",
            TaskStatus::Backlog => "#6e7681",
            TaskStatus::Done => "#8957e5",
        }
    }
}

/// A ticket in the dependency graph. `x`/`y` are its canvas position; `addLines`
/// / `delLines` are the projected diff size once worked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub project: String,
    /// The project's color (hex) as configured in Linear, when it has one. Falls
    /// back to the frontend's per-name color map when absent (e.g. mock data).
    pub project_color: Option<String>,
    /// The project's icon — an emoji (rendered directly) or a Linear icon name
    /// (we don't ship that icon set, so it falls back to the colored dot).
    pub project_icon: Option<String>,
    pub status: TaskStatus,
    pub ready: bool,
    pub blocked_by: Vec<String>,
    /// Whether this ticket is directly actionable by the viewer: assigned to
    /// them and not yet done. Non-actionable tickets (someone else's, or
    /// already done) are pulled into the graph only as blocker context and are
    /// rendered grayed out.
    pub actionable: bool,
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

/// An untriaged ticket awaiting investigation (the queue row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageTicket {
    pub id: String,
    pub title: String,
    pub priority: Priority,
    pub age: String,
    pub meta: String,
    /// The team key (e.g. "MSG"), used to group the queue when the viewer is on
    /// more than one team.
    pub team: Option<String>,
    /// Human SLA hint (e.g. "SLA in 3h", "SLA breached"), if the issue has one.
    pub sla: Option<String>,
    /// When set, the issue is snoozed until this human label; the UI greys it out
    /// and sinks it to the bottom of the queue.
    pub snoozed_until: Option<String>,
    /// Whether the issue is assigned to the viewer. The queue defaults to the
    /// viewer's own issues; others' are shown only when "be a good citizen" is on.
    pub mine: bool,
}

/// A comment on a triage issue (markdown body), with threaded replies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageComment {
    pub author: String,
    /// Public avatar URL of the author, when they have one.
    pub avatar_url: Option<String>,
    pub created: String,
    /// Markdown — may contain inline images.
    pub body: String,
    /// Threaded replies, in chronological order.
    pub children: Vec<TriageComment>,
}

/// A workflow state an issue can move to (one of its team's states). Moving an
/// issue out of the `triage` state — e.g. into `backlog`/`unstarted` — is how the
/// UI "promotes" a triage item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub id: String,
    pub name: String,
    /// Linear state category: triage | backlog | unstarted | started | completed | canceled.
    #[serde(rename = "type")]
    pub type_: String,
    /// State color (hex), as configured in Linear.
    pub color: String,
}

/// The full triage issue as rendered in the discussion pane: the Linear issue's
/// description, metadata, and comment thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageDetail {
    pub id: String,
    pub title: String,
    pub priority: Priority,
    /// Workflow state name (e.g. "Triage").
    pub state: String,
    /// Id of the current workflow state (for the status picker's selection).
    pub state_id: Option<String>,
    /// All workflow states the issue can move to, ordered as in Linear.
    pub states: Vec<WorkflowState>,
    /// Canonical Linear URL for the issue.
    pub url: String,
    pub author: String,
    /// Public avatar URL of the issue creator, when they have one.
    pub author_avatar_url: Option<String>,
    pub created: String,
    pub labels: Vec<String>,
    pub project: Option<String>,
    pub sla: Option<String>,
    pub snoozed_until: Option<String>,
    /// Markdown description — may contain inline images.
    pub description: String,
    pub comments: Vec<TriageComment>,
}

/// A single on-call slot in a triage rotation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageShift {
    pub name: String,
    /// Avatar of the person on this shift, when Linear exposes one.
    pub avatar_url: Option<String>,
    /// Human time range, e.g. "Mon–Wed".
    pub range: String,
    pub is_current: bool,
    pub is_me: bool,
}

/// The team triage rotation surfaced from Linear's triage responsibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageSchedule {
    pub team: String,
    pub schedule_name: String,
    pub current_name: Option<String>,
    /// Avatar of whoever is currently on triage, when available.
    pub current_avatar_url: Option<String>,
    /// True when the signed-in viewer is the one currently on triage.
    pub current_is_me: bool,
    pub shifts: Vec<TriageShift>,
}

/// A stage in an agent run, with its progress percentage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub label: String,
    pub pct: u32,
}

/// Per-agent configuration: which executable and default model to use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetting {
    pub key: AgentKind,
    pub exec: String,
    pub model: String,
}

/// Which trackers/services are connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
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

/// User settings, persisted as a JSON blob in the `settings` table. Seeded from
/// defaults on first run; edits are written back through `set_settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_agent: AgentKind,
    pub integrations: Integrations,
    pub agents: Vec<AgentSetting>,
}

/// A Claude slash-command discovered on disk under a `.claude/commands` folder.
/// Invoked as `/<name> <arg>` — the triage "Investigate" picker offers these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCommand {
    /// Invocation name (the file stem, without `.md`), e.g. `investigate-ticket`.
    pub name: String,
    /// The command's `description:` frontmatter, when present.
    pub description: Option<String>,
}

/// Claude commands available to the investigate picker, split by where they live
/// so the repo scope can distinguish its own commands from the global ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCommands {
    /// Commands from the user's `~/.claude/commands`.
    pub global: Vec<ClaudeCommand>,
    /// Commands from the repo's `.claude/commands` (empty for the app scope).
    pub repo: Vec<ClaudeCommand>,
}
