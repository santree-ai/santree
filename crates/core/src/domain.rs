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

impl Default for AgentKind {
    /// Used only as a `#[serde(default)]` fallback inside `AgentSetting` (e.g. a
    /// future new field added to that struct) — never as a semantic "the" default
    /// agent, which is `Settings::default_agent`.
    fn default() -> Self {
        AgentKind::Claude
    }
}

impl AgentKind {
    /// Stable string form for persistence (matches the serde discriminant name).
    /// Exhaustive, so adding a variant forces this to be updated.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude",
            AgentKind::Codex => "Codex",
            AgentKind::Cursor => "Cursor",
            AgentKind::Opencode => "Opencode",
        }
    }
}

impl std::str::FromStr for AgentKind {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "Claude" => AgentKind::Claude,
            "Codex" => AgentKind::Codex,
            "Cursor" => AgentKind::Cursor,
            "Opencode" => AgentKind::Opencode,
            _ => return Err(()),
        })
    }
}

/// A selectable agent and the models it offers in the launch tray.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub key: AgentKind,
    pub label: String,
    pub short: String,
    pub models: Vec<String>,
    /// Whether this harness is actually wired up to launch today. WIP agents
    /// (Codex/Cursor/OpenCode) are shown but disabled everywhere they're
    /// offered — this is the single source of truth for that gate.
    pub available: bool,
}

/// An agent harness's authentication / subscription status, as shown in the
/// harness settings tab. Read from the agent CLI's own credentials (e.g.
/// `~/.claude.json`); the CLI owns auth.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
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

/// The `gh` CLI integration status, shown in Settings → Integrations. GitHub
/// powers PR creation and the Reviews dashboard and can't be turned off, so the
/// UI surfaces whether the CLI is installed and authenticated (and as whom)
/// rather than a toggle. Auth is borrowed from `gh`'s own session — the CLI owns
/// it — by reading `gh auth token` and the REST `/user` endpoint.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    /// Whether the `gh` CLI was found on the user's PATH (login-shell resolved).
    pub installed: bool,
    /// Absolute path to the resolved `gh` executable. Empty when not found.
    pub detected_exec: String,
    /// The `gh` version line, e.g. "gh version 2.62.0 (2024-11-14)". Empty when
    /// not found.
    pub version: String,
    /// Whether `gh` has a valid authenticated session.
    pub authenticated: bool,
    /// Signed-in account login, e.g. "octocat". Empty when not authenticated.
    pub account: String,
    /// The account's display name when set on the GitHub profile. Empty otherwise.
    pub name: String,
    /// The host the session authenticates against, e.g. "github.com".
    pub host: String,
}

/// A connected repository / task-tracker pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name: String,
    pub tracker: String,
    /// Number of agents currently active on this repo.
    pub agents: u32,
    /// Absolute path on disk of the repo's git checkout. Always set in
    /// practice — every repo is registered via `repo::add`, which validates a
    /// real local folder before inserting — but stays `Option` because the
    /// underlying `repos.path` column is nullable (a leftover from before
    /// migration `0002_repo_path` and the removed built-in seed repos).
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
}

/// A ticket in the dependency graph. `x`/`y` are its canvas position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub project: String,
    /// The project's color (hex) as configured in Linear, when it has one. Falls
    /// back to the frontend's per-name color map when absent.
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
    /// The assignee's display name, when the issue is assigned (shown in the
    /// inspector's dependency cards).
    pub assignee: Option<String>,
    /// The assignee's avatar URL, when present.
    pub assignee_avatar_url: Option<String>,
    pub x: i32,
    pub y: i32,
}

/// How a terminal that auto-launches `claude` should (re)launch it, resolved
/// against the persisted session registry + the on-disk transcript. The frontend
/// turns this into the shell seed: `--resume <id>` to continue, `--session-id
/// <id> '<prompt>'` to start fresh, or a plain shell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum AgentSession {
    /// A still-on-disk session to continue: `claude --resume <sessionId>`.
    Resume { session_id: String },
    /// A reserved id to start fresh with: `claude --session-id <sessionId> '<prompt>'`.
    Fresh { session_id: String },
    /// No agent session — just a login shell.
    Shell,
}

/// A proposed PR (title + body) for the create-PR dialog, before it's opened.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrDraft {
    pub title: String,
    pub body: String,
    /// The branch the PR would merge into (shown for confirmation).
    pub base_branch: String,
}

/// The result of creating a PR: its number and web URL (to open in the browser).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewPr {
    pub number: u32,
    pub url: String,
}

/// The merge state of a worktree's pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

/// Live status of the PR opened from a worktree's branch (fetched from GitHub,
/// separately from the worktree list so the list stays fast/offline-capable).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePr {
    /// The worktree this PR belongs to (its issue id).
    pub issue_id: String,
    pub number: u32,
    pub url: String,
    pub state: PrState,
}

// ── Reviews dashboard (org-scoped GitHub PR inbox) ──────────────────────────

/// GitHub's aggregate review decision for a PR.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    /// A review is required but none satisfying it has been given yet.
    ReviewRequired,
    /// No review has been requested/required (or GitHub returned null).
    None,
}

/// Rolled-up CI/status-check state for a PR's latest commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum CheckRollup {
    Success,
    Failure,
    Pending,
    /// No checks configured (GitHub returned null).
    None,
}

/// Whether a requested reviewer is an individual or a team.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum ReviewerKind {
    User,
    Team,
}

/// A reviewer requested on a PR — a person (with avatar) or a team (no avatar).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub kind: ReviewerKind,
    /// Login for a user, team name for a team.
    pub name: String,
    /// Avatar URL for users; empty for teams.
    pub avatar_url: String,
}

/// A pull request shown in the Reviews dashboard. Spans repos within one org, so
/// it carries its own `repo` (owner/name) rather than relying on a single active
/// checkout the way [`WorktreePr`] does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPr {
    /// GraphQL node id — stable selection key across refetches.
    pub id: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    /// "owner/name" the PR lives in (the grouping axis for "My PRs").
    pub repo: String,
    /// The PR's head branch name (shown in the header, click-to-copy).
    pub head_ref: String,
    pub author: String,
    pub author_avatar_url: String,
    pub state: PrState,
    pub is_draft: bool,
    pub review_decision: ReviewDecision,
    pub checks: CheckRollup,
    pub additions: u32,
    pub deletions: u32,
    pub comment_count: u32,
    /// Reviewers requested on the PR (people and teams).
    pub reviewers: Vec<Reviewer>,
    /// ISO-8601 timestamp of the last update.
    pub updated_at: String,
}

/// Review requests waiting on a specific team the viewer belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamReviews {
    pub slug: String,
    pub name: String,
    pub prs: Vec<ReviewPr>,
}

/// The categorized PR inbox for the Reviews tab, scoped to one org.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInbox {
    /// PRs the viewer authored (grouped by repo on the frontend).
    pub mine: Vec<ReviewPr>,
    /// PRs where the viewer is individually requested as a reviewer.
    pub requested: Vec<ReviewPr>,
    /// PRs requested via a team the viewer is on — one section per team.
    pub teams: Vec<TeamReviews>,
}

/// Where a PR comment originated, so the UI can label/anchor it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum CommentKind {
    /// A top-level conversation comment.
    Issue,
    /// A review summary (approve / request-changes / comment).
    Review,
    /// An inline comment anchored to a file in a review thread.
    ReviewThread,
}

/// One comment in a PR's conversation (issue comment, review, or inline thread).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub author: String,
    pub author_avatar_url: String,
    pub body: String,
    pub created_at: String,
    pub kind: CommentKind,
    /// File path for inline (`ReviewThread`) comments; `None` otherwise.
    pub path: Option<String>,
}

/// One changed file in a PR, with its unified diff hunk (from the REST files API).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    /// GitHub's status string: "added" | "modified" | "removed" | "renamed".
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    /// Unified diff for the file; `None` for binary files (no textual patch).
    pub patch: Option<String>,
}

/// Normalized status of a single CI check (a check run or a status context).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum CheckStatus {
    Success,
    Failure,
    /// Queued / in-progress / expected.
    Pending,
    Skipped,
    /// Neutral / cancelled / action-required — finished without pass/fail.
    Neutral,
}

/// One CI check on a PR's head commit (a GitHub check run or a status context).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    pub status: CheckStatus,
    /// The app/workflow that produced it (e.g. "GitHub Actions"), or the status
    /// context's description — shown as a subtitle.
    pub description: Option<String>,
    /// Link to the check's details (the run/build page).
    pub url: Option<String>,
}

/// The detail panel payload for a selected PR: body, conversation, diff, checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub body: String,
    pub comments: Vec<PrComment>,
    pub files: Vec<PrFile>,
    pub checks: Vec<PrCheck>,
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
    /// The issue identifier this worktree was created for (e.g. "AK-165").
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub add_lines: u32,
    pub del_lines: u32,
    pub dirty: bool,
    /// Commits this branch is ahead of its base.
    pub ahead: u32,
    /// Commits this branch is behind its base (origin/<base>).
    pub behind: u32,
    /// Commits on this branch not yet pushed to its remote (what `git push` would
    /// upload); 0 when the remote is up to date.
    pub unpushed: u32,
    pub agent: AgentKind,
    pub activity: Activity,
    /// Git branch checked out in the worktree (e.g. "feature/ak-165-…").
    pub branch: String,
    /// Absolute filesystem path of the worktree directory.
    pub path: String,
    /// Linear project the issue belongs to, used to group the Trees tabs.
    pub project: Option<String>,
    /// Branch this worktree was created from.
    pub base_branch: String,
    /// Whether `.santree/init.sh` has been run for this worktree.
    pub setup_ran: bool,
    /// True only for the optimistic frontend placeholder shown while a worktree
    /// is still being created (it has no branch/path yet). The backend always
    /// sets this to `false` — the `true` case exists only in the frontend's own
    /// placeholder object (`AppContext.pendingLaunches`), built in JS and never
    /// deserialized from this type (`Worktree` only derives `Serialize`).
    pub pending: bool,
}

/// Whether a changed file was added, modified, deleted, renamed, or is untracked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

/// One entry in a worktree's working-tree status — a file with uncommitted
/// changes, as shown in the commit box. `staged` reflects whether the index
/// holds changes for the file (the commit box stages whole files).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Original path for renames.
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub staged: bool,
    pub add_lines: u32,
    pub del_lines: u32,
    /// Binary / non-text content — the diff viewer skips rendering these.
    pub binary: bool,
}

/// The old (HEAD) and new (working-tree) full contents of a file, used by the
/// diff viewer to expand unchanged context above/below a hunk (GitHub-style).
/// Either side is empty when it doesn't exist (added vs. deleted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    pub old_text: String,
    pub new_text: String,
}

/// The repo's `.santree/init.sh` setup script, surfaced to the Settings editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    pub path: String,
    pub exists: bool,
    /// Whether the file has its executable bit set (required to run on create).
    pub executable: bool,
    pub content: String,
}

/// An external app/location a worktree can be opened in (Conductor-style menu).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Opener {
    /// Stable key passed back to `open_in_app` (e.g. "finder", "cursor").
    pub key: String,
    pub label: String,
    /// Whether the app was found installed on this machine.
    pub available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum Priority {
    Urgent,
    High,
    Medium,
    Low,
    /// Linear's "no priority" (numeric 0). Distinct from `Low` so unprioritized
    /// issues don't masquerade as low-priority; the UI shows no priority pill.
    None,
}

/// An untriaged ticket awaiting investigation (the queue row).
///
/// Only `PartialEq` (not `Eq`) because of the `f64` timestamp fields below —
/// nothing here needs `TriageTicket` as a map/set key.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageTicket {
    pub id: String,
    pub title: String,
    pub priority: Priority,
    /// Epoch ms the issue was created. Raw, not a pre-formatted "5m ago" label —
    /// with triage's multi-minute query staleTime, a label baked in at fetch
    /// time would freeze between refetches. The frontend formats (and ticks)
    /// it live; see `src/lib/relativeTime.ts`. `f64` (not `i64`) because Specta
    /// forbids exporting 64-bit ints to TypeScript; epoch-ms values are exact
    /// in an `f64` for millennia to come.
    pub created_at_ms: f64,
    pub meta: String,
    /// The team key (e.g. "MSG"), used to group the queue when the viewer is on
    /// more than one team.
    pub team: Option<String>,
    /// Absolute epoch ms the issue's SLA breaches, if it has one. `None` when
    /// the issue has no SLA. The frontend renders (and ticks) the countdown.
    pub sla_breach_ms: Option<f64>,
    /// Epoch ms the issue is snoozed until, if snoozed; the UI greys it out and
    /// sinks it to the bottom of the queue.
    pub snoozed_until_ms: Option<f64>,
    /// Whether the issue is assigned to the viewer. The queue defaults to the
    /// viewer's own issues; others' are shown only when "be a good citizen" is on.
    pub mine: bool,
}

/// A comment on a triage issue (markdown body), with threaded replies.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageComment {
    pub author: String,
    /// Public avatar URL of the author, when they have one.
    pub avatar_url: Option<String>,
    /// Epoch ms the comment was posted — raw, formatted live by the frontend.
    pub created_at_ms: f64,
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
    /// Linear state category: triage | backlog | unstarted | started | completed
    /// | canceled | duplicate.
    #[serde(rename = "type")]
    pub type_: String,
    /// State color (hex), as configured in Linear.
    pub color: String,
}

/// The full triage issue as rendered in the discussion pane: the Linear issue's
/// description, metadata, and comment thread.
///
/// Only `PartialEq` (not `Eq`) because of the `f64` timestamp fields below.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
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
    /// Epoch ms the issue was created — raw, formatted live by the frontend.
    pub created_at_ms: f64,
    pub labels: Vec<String>,
    pub project: Option<String>,
    /// Absolute epoch ms the issue's SLA breaches, if it has one.
    pub sla_breach_ms: Option<f64>,
    /// Epoch ms the issue is snoozed until, if snoozed.
    pub snoozed_until_ms: Option<f64>,
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

/// Per-agent configuration: which executable and default model to use.
///
/// `#[serde(default)]`: a future new field must not fail deserialization of
/// every settings blob written before that field existed — see `Settings`'s
/// doc comment for the failure mode this guards against.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSetting {
    pub key: AgentKind,
    pub exec: String,
    pub model: String,
}

/// Which trackers/services are connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Integrations {
    pub linear: bool,
    pub triage: bool,
}

impl Default for Integrations {
    /// Both default on, matching `config::default_settings()` — a missing field
    /// in an old stored blob should read as "still connected", not a silent opt-out.
    fn default() -> Self {
        Integrations {
            linear: true,
            triage: true,
        }
    }
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
///
/// `#[serde(default)]` at every level here (this struct + `Integrations` +
/// `AgentSetting`) matters more than it looks: without it, adding a single new
/// field in a future release makes every EXISTING stored blob fail to parse.
/// `get_settings` already falls back to `config::default_settings()` on a parse
/// error — silently wiping the user's real agent execs/models/integration
/// toggles — and the next `set_settings` call then *persists* that wipe. With
/// `#[serde(default)]`, a missing field falls back per-field (via `Default`,
/// seeded from `config::default_settings()`) instead of the whole blob being
/// discarded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub default_agent: AgentKind,
    pub integrations: Integrations,
    pub agents: Vec<AgentSetting>,
}

impl Default for Settings {
    fn default() -> Self {
        crate::config::default_settings()
    }
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
