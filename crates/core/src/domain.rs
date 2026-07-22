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

/// A persisted agent name that matched no `AgentKind`. Carries the offending
/// string so a caller that hits stale or hand-edited data can say *what* it found
/// instead of only that something failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownAgentKind(pub String);

impl std::fmt::Display for UnknownAgentKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown agent kind {:?}", self.0)
    }
}

impl std::error::Error for UnknownAgentKind {}

impl std::str::FromStr for AgentKind {
    type Err = UnknownAgentKind;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "Claude" => AgentKind::Claude,
            "Codex" => AgentKind::Codex,
            "Cursor" => AgentKind::Cursor,
            "Opencode" => AgentKind::Opencode,
            _ => return Err(UnknownAgentKind(s.to_string())),
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

/// What a Claude session is doing right now, derived from its hook events by
/// `crates/hook` and reconciled against the transcript in `hooks.rs`.
///
/// This is the single definition shared by all three: the hook binary writes
/// `as_str()` into `session_state.state`, the app parses it back with
/// [`AgentState::parse`], and the frontend gets a real union type over the
/// bridge instead of `string`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    /// The model is working (a prompt was submitted, or the transcript is moving).
    Active,
    /// Working, but through a subagent — the main transcript is quiet while a
    /// sidechain advances.
    Delegating,
    /// Blocked on a permission prompt the user has to answer.
    Permission,
    /// Blocked on the user for some other reason (a Notification with no
    /// recognized subtype).
    Waiting,
    /// Alive but quiet — the turn ended and nothing is running.
    Idle,
    /// The session ended (SessionEnd).
    Exited,
}

impl AgentState {
    /// The wire form: what lands in the `session_state.state` TEXT column and
    /// what crosses the bridge (kept in lockstep with `serde(snake_case)`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Delegating => "delegating",
            Self::Permission => "permission",
            Self::Waiting => "waiting",
            Self::Idle => "idle",
            Self::Exited => "exited",
        }
    }

    /// Inverse of [`as_str`]. `None` for anything else — the hook binary is a
    /// separately-built executable, so a stale copy on disk can write a state
    /// this build doesn't know; callers drop those rows rather than guess.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "active" => Self::Active,
            "delegating" => Self::Delegating,
            "permission" => Self::Permission,
            "waiting" => Self::Waiting,
            "idle" => Self::Idle,
            "exited" => Self::Exited,
            _ => return None,
        })
    }

    /// Whether the session is blocked on the user (permission prompt or
    /// notification) — the states the transcript reconciler must not overrule
    /// without evidence, and the ones the UI badges as needing attention.
    pub fn is_blocked_on_user(self) -> bool {
        matches!(self, Self::Permission | Self::Waiting)
    }
}

/// The current state of one Claude session, captured live via the hooks santree
/// injects into its `claude` launches. One per session id (a current-state row,
/// not an event log). The frontend correlates a session back to a worktree later
/// via `cwd` / the `terminal_sessions` mapping.
/// Only `PartialEq` (not `Eq`) because of the `f64` timestamp below.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// Claude session id (the one santree minted via `--session-id`).
    pub session_id: String,
    /// Derived agent state.
    pub state: AgentState,
    /// Raw Claude hook event that last set `state` (e.g. "Stop"). Deliberately a
    /// free string, not an enum: it's Claude's vocabulary, not ours, and a new
    /// event name from a CLI upgrade must not fail to deserialize.
    pub event: String,
    /// Working directory the session ran in (the worktree path).
    pub cwd: String,
    /// Notification message, when the last event carried one.
    pub message: Option<String>,
    /// Transcript path on disk, when the payload carried one.
    pub transcript_path: Option<String>,
    /// Epoch ms the state was last updated — raw, formatted live by the frontend.
    pub updated_at_ms: f64,
}

/// Live token/context usage for one Claude session, captured from Claude's own
/// status-line stdin (see crates/hook's `statusline` mode). This is Claude's
/// authoritative `used_percentage` + token counts — the faithful source for the
/// inline session status line, unlike the transcript-derived reconstruction in
/// `usage.rs`. One current-value row per session id.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageLive {
    /// Claude session id (matches [`SessionState::session_id`]).
    pub session_id: String,
    /// Claude's pre-calculated context-window fill, 0..100 (raw — the 1.2x
    /// display nudge is applied at render time, matching the terminal bar).
    pub used_pct: f64,
    /// Tokens currently in the context window (input + cache reads + writes).
    pub input_tokens: f64,
    /// The model's context window size in tokens (200k, or 1M for extended).
    pub context_size: f64,
    /// Model id, e.g. `claude-opus-4-8` — mapped to a family label by the frontend.
    pub model: String,
    /// Session cost so far in USD (Claude's own `cost.total_cost_usd`).
    pub cost_usd: f64,
    /// Epoch ms this row was last written — raw, formatted live by the frontend.
    pub updated_at_ms: f64,
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
    /// A custom "Blocked" workflow state (Linear has no native `blocked` type, so
    /// teams model it as an `unstarted`/`started` state named "Blocked"). Never
    /// startable — being in this state is itself a not-actionable signal,
    /// independent of any ticket-to-ticket blocker relations.
    Blocked,
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
            TaskStatus::Blocked => "Blocked",
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

/// What an extra Trees main-area tab hosts: a Claude agent session (resumable
/// across app restarts via its stored session id) or a plain login shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TabKind {
    Claude,
    Terminal,
    /// A Claude session dedicated to fixing a PR's failing CI: seeded with the
    /// failed log + guardrails, launched with a commit/push-denying settings file.
    /// Persisted like a Claude tab (resumable), but its pane always applies the
    /// no-git guardrail — even on resume after a restart.
    FixCi,
}

impl TabKind {
    /// The value stored in the `worktree_tabs.kind` column.
    pub fn as_db_str(self) -> &'static str {
        match self {
            TabKind::Claude => "claude",
            TabKind::Terminal => "terminal",
            TabKind::FixCi => "fixci",
        }
    }

    /// Parse the `worktree_tabs.kind` column back into a variant (unknown →
    /// `Terminal`, the safe default).
    pub fn from_db_str(s: &str) -> Self {
        match s {
            "claude" => TabKind::Claude,
            "fixci" => TabKind::FixCi,
            _ => TabKind::Terminal,
        }
    }
}

/// An extra main-area tab in Trees (opened via the "+" menu), persisted so it
/// survives an app restart. Claude tabs re-resolve their stored session on open
/// (`terminal_sessions`, term_key `tree:<worktree_id>:tab:<id>`); terminal tabs
/// just reopen a fresh shell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeTab {
    pub id: String,
    pub worktree_id: String,
    pub kind: TabKind,
    pub title: String,
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
    /// True when the PR is sitting in the repo's merge queue (GitHub's "Queued"
    /// badge). The exact queue position isn't carried — it's shown in the
    /// merge-queue bot comment rendered in the PR conversation.
    pub is_in_merge_queue: bool,
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

/// A merge-queue entry's state (GitHub's `MergeQueueEntryState`). Drives the
/// per-row status dot in the merge-queue panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum MergeQueueState {
    /// Waiting its turn (or for the entries ahead to merge).
    Queued,
    /// Required checks are still running against the merge-queue branch.
    AwaitingChecks,
    /// Checks passed; ready to merge when it reaches the front.
    Mergeable,
    /// Cannot merge (failing checks / conflicts) — will be dropped from the queue.
    Unmergeable,
    /// Locked by the queue (a solo/jump entry is being processed).
    Locked,
    /// Any state GitHub adds later that we don't map yet.
    Unknown,
}

/// One pull request sitting in a repo's merge queue, in queue order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeQueueEntry {
    /// 1-indexed rank in the queue (front of the line = 1), derived from queue
    /// order rather than GitHub's raw `position` so it's display-ready.
    pub position: u32,
    pub state: MergeQueueState,
    pub pr_number: u32,
    pub pr_title: String,
    pub pr_url: String,
    pub author: String,
    pub author_avatar_url: String,
    /// True when the viewer authored this PR — highlighted in the panel so they
    /// can spot their own place in line.
    pub is_mine: bool,
}

/// The merge queue for a repo's target branch — the ordered list of PRs waiting
/// to merge, for the Reviews tab's merge-queue panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeQueue {
    /// "owner/name" of the repo whose queue this is.
    pub repo: String,
    /// The branch the queue merges into (its default branch).
    pub branch: String,
    pub entries: Vec<MergeQueueEntry>,
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
    /// GitHub's status string: "added" | "removed" | "modified" | "renamed" |
    /// "copied" | "changed" | "unchanged". Kept as a string, not an enum: it's
    /// display-only, and an unrecognised value should tint like a modification
    /// rather than fail the whole PR's file list to deserialize.
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    /// Unified diff for the file; `None` for binary files (no textual patch).
    pub patch: Option<String>,
    /// Blob SHA of the file at the PR's head. It changes only when the file's
    /// *content* changes, so the "Viewed" feature keys its persisted mark on it:
    /// a mark stored against this SHA survives commits that don't touch the file,
    /// and auto-clears the moment a new commit changes the file (SHA differs).
    pub sha: String,
}

/// One inline review-comment thread on a PR, anchored to a file (and usually a
/// line). Its comments are rendered together, and resolved threads collapse in the
/// UI (GitHub-style). Distinct from the top-level `PrComment`s in [`PrDetail`],
/// which are the issue-level conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrThread {
    pub path: String,
    /// Line the thread is anchored to (in the file named by `path`). `None` when
    /// GitHub can't place it anymore (outdated threads on since-changed lines).
    pub line: Option<u32>,
    /// Which side of the diff the anchor line lives on: `true` = the new/right
    /// side (an added/context line), `false` = the old/left side (a removed line).
    pub on_right: bool,
    pub is_resolved: bool,
    /// The thread's anchor line no longer matches the current diff (the code moved
    /// or changed under it). Such threads can't be shown inline in the diff.
    pub is_outdated: bool,
    pub comments: Vec<PrComment>,
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

/// One step of a GitHub Actions check run (e.g. "Run tests"). Only populated for
/// failed check runs — the expandable detail shows which step broke.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckStep {
    pub number: u32,
    pub name: String,
    pub status: CheckStatus,
}

/// A single annotation a check run emitted (compiler/lint/test error) — the
/// actionable "what failed" content GitHub shows inline on the Checks tab. Only
/// populated for failed check runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckAnnotation {
    /// `error` | `warning` | `notice` (GitHub's `annotationLevel`, lowercased).
    pub level: String,
    pub message: String,
    /// File the annotation is anchored to, when any.
    pub path: Option<String>,
    /// Start line in `path`, when any.
    pub start_line: Option<u32>,
    pub title: Option<String>,
    /// Raw log excerpt GitHub attaches (often the full error block), when any.
    pub raw_details: Option<String>,
}

/// One CI check on a PR's head commit (a GitHub check run or a status context).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    pub status: CheckStatus,
    /// The app/workflow that produced it (e.g. "GitHub Actions"), or the status
    /// context's description — shown as a subtitle.
    pub description: Option<String>,
    /// Link to the check's details (the run/build page).
    pub url: Option<String>,
    /// The run's steps — populated only for failed check runs (empty otherwise).
    pub steps: Vec<CheckStep>,
    /// Error/warning annotations — populated only for failed check runs.
    pub annotations: Vec<CheckAnnotation>,
    /// The GitHub Actions job id (parsed from `detailsUrl`), when this is an
    /// Actions check run — lets the UI lazily fetch the job's raw log on expand.
    /// `None` for status contexts / any check whose URL isn't an Actions job.
    /// `f64` because Specta forbids 64-bit ints; job ids are exact in an `f64`.
    pub job_id: Option<f64>,
}

/// How one raw-log line is classified — drives its tint and whether it stays
/// expanded by default. Mirrors the `##[error]` / `##[warning]` / `##[group]`
/// markers GitHub's Actions runner writes into the log stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum CheckLogLevel {
    Error,
    Warning,
    /// A `##[group]` / `##[section]` / `##[command]` header — a section title.
    Command,
    Normal,
}

/// One line of a check run's raw job log, with its timestamp stripped and its
/// runner marker (`##[error]` etc.) parsed off into `level`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckLogLine {
    pub text: String,
    pub level: CheckLogLevel,
}

/// One rendered block of a check run's log, mirroring how GitHub's Actions UI
/// shows an expanded step: loose output is always visible; each `##[group]`
/// section collapses behind its title. A discriminated union (`kind`) so the
/// frontend can render + collapse it directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckLogBlock {
    /// A standalone line — loose step output or a top-level error/warning. Always
    /// visible.
    Line { text: String, level: CheckLogLevel },
    /// A `##[group]` section — collapsed behind its `title` by default. Nested
    /// sub-groups are flattened into `lines` as plain command lines.
    Group {
        title: String,
        lines: Vec<CheckLogLine>,
    },
}

/// A failed check run's job log, sliced to the failing step and split into
/// visible lines + collapsible groups. `truncated` is set when the step's log
/// exceeded the line cap and only its tail (where the error is) was kept — the UI
/// notes that earlier lines live on GitHub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckLog {
    pub blocks: Vec<CheckLogBlock>,
    pub truncated: bool,
}

/// A GitHub label ("tag") — its name plus 6-hex color (no leading `#`, as GitHub
/// returns it; the frontend prepends it). Used both for a PR's own labels and for
/// the repo's full label palette in the picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
    pub name: String,
    /// 6-hex color without a leading `#`.
    pub color: String,
    /// The label's description, when set (shown in the picker).
    pub description: Option<String>,
}

/// The detail panel payload for a selected PR: body, conversation, diff, checks.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub body: String,
    /// The labels ("tags") currently assigned to the PR.
    pub labels: Vec<PrLabel>,
    /// Top-level conversation: issue comments and review summaries, chronological.
    /// Inline review-thread comments live in `threads`, not here.
    pub comments: Vec<PrComment>,
    /// Inline review-comment threads, anchored to files/lines (shown in the diff).
    pub threads: Vec<PrThread>,
    pub files: Vec<PrFile>,
    /// True when the PR has more changed files than we fetched (GitHub allows up
    /// to 3000; `github.rs` stops at `PR_FILES_CAP`). The UI must say so — a
    /// reviewer who marks every listed file "Viewed" on a truncated list has
    /// approved a diff they never saw.
    pub files_truncated: bool,
    pub checks: Vec<PrCheck>,
    /// Commit OID of the PR's base (old side) — used to fetch full file content
    /// on demand so the diff can expand unchanged context (GitHub-style). Empty
    /// when `gh` isn't authenticated.
    pub base_sha: String,
    /// Commit OID of the PR's head (new side) — the other end of the expand fetch.
    pub head_sha: String,
}

/// A file's persisted "Viewed" mark in the Reviews tab: the file path plus the
/// blob SHA it was marked at. The UI treats a file as reviewed only while its
/// current [`PrFile::sha`] still equals this `sha` — so a new commit that changes
/// the file (new SHA) automatically drops it back to unreviewed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedFile {
    pub path: String,
    pub sha: String,
}

/// What an agent worktree is currently doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum Activity {
    Running,
    Idle,
}

/// A live git worktree with an agent attached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// The issue identifier this worktree was created for (e.g. "AK-165").
    pub id: String,
    pub title: String,
    /// The ticket's status, when the issue is one santree knows about. `None`
    /// when there's nothing to know (the base worktree, or a worktree whose
    /// issue we can't resolve) — the UI renders no chip rather than a made-up one.
    pub status: Option<TaskStatus>,
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
    /// Commits on this branch's remote tracking ref not yet local (what `git pull`
    /// would download — PR-UI suggestions, "Update branch", a teammate's push);
    /// 0 when local is up to date or the branch has no remote.
    pub remote_behind: u32,
    /// When `remote_behind > 0`, whether pulling origin/<branch> would conflict
    /// with local commits (from a virtual merge). Disables the Pull button — a
    /// conflicting pull can't be applied automatically and must be resolved in the
    /// worktree. Always false when nothing is pending (`remote_behind == 0`).
    pub pull_conflict: bool,
    /// The agent attached to this worktree, once one has actually been launched
    /// in it. `None` for the base worktree (no agent concept) and for worktrees
    /// with no session yet.
    pub agent: Option<AgentKind>,
    /// Derived from the worktree's live agent session. `None` when there is no
    /// session to derive it from — the backend does not guess.
    pub activity: Option<Activity>,
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

/// One documented variable a prompt template receives, shown in the editor's
/// variable palette so users know what they can reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptVar {
    /// The reference name, e.g. `ticket_id` (used as `{{ ticket_id }}`).
    pub name: String,
    pub description: String,
}

/// Whether an editable prompt runs a flow or is a reusable partial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    /// A prompt that drives a flow: Work, Commit, PR, Fix-CI.
    Flow,
    /// A reusable partial embedded by flows via `{% include %}` — the built-in
    /// `issue` context or a user-created block.
    Block,
}

/// An editable AI prompt for the Settings → Prompts composer: its identity, the
/// default source, the user's override for the queried scope (if any), the
/// variable catalog, and the live composition links (what it includes / is
/// included by).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptInfo {
    /// Stable template name, e.g. `work` (also the `{% include %}` target).
    pub name: String,
    /// Human label for the editor list, e.g. "Work / start task".
    pub label: String,
    pub description: String,
    pub kind: PromptKind,
    /// False for user-created blocks — they have no embedded default and can be
    /// deleted (their content lives entirely in the DB).
    pub builtin: bool,
    /// The default template source (the reset target). Empty for custom blocks.
    pub default: String,
    /// The user's stored override for the queried scope, or `None` when the
    /// scope inherits (app default or built-in).
    pub override_source: Option<String>,
    pub variables: Vec<PromptVar>,
    /// Names of prompts this one currently `{% include %}`s (scanned from its
    /// effective source at the queried scope).
    pub includes: Vec<String>,
    /// Names of prompts that currently include this one (reverse of `includes`).
    pub used_by: Vec<String>,
}

/// The result of rendering a draft prompt against representative sample data —
/// either the rendered text or the render/compile error, for the live preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptPreview {
    pub output: String,
    /// The minijinja error when the draft doesn't compile/render, else `None`.
    pub error: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageComment {
    /// Linear comment id — used as the `parentId` when posting a reply.
    pub id: String,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
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

/// santree-CLI configuration (`.santree/metadata.json` + the CLI's global auth
/// store) detected in a just-opened repo, offered for adoption. Only built when
/// something is actionable: the CLI's workspace is either already connected
/// (the repo just needs linking) or importable from the CLI's stored credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCliMigration {
    /// Linear workspace slug the CLI had this repo on.
    pub org_slug: String,
    /// Display name for that workspace (the CLI's stored name, else the slug).
    pub org_name: String,
    /// True when the app already has this workspace connected — no credential
    /// import needed, just the repo link.
    pub already_connected: bool,
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

/// Aggregated Claude token counts for a bucket (a period, a model, or a session).
/// Every count is a raw number the frontend formats; the four token classes are
/// kept apart because they're priced differently. `cost_usd` is *derived* from a
/// static price table and is approximate — the token counts themselves are exact.
/// Counts are `f64` (not `u64`) to match the domain's "numbers cross the bridge as
/// JS numbers" convention; token totals stay well within f64's exact-integer range.
#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    pub cost_usd: f64,
}

/// Token usage attributed to one model, summed across every session.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// Raw model id from the transcript, e.g. `claude-opus-4-8` — the frontend
    /// maps it to a family label + color.
    pub model: String,
    pub totals: UsageTotals,
}

/// Token usage for one Claude session (one main transcript), plus its current
/// context-window fill — the "how much before compaction" signal.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// The session id (the transcript file's stem, a UUID).
    pub session_id: String,
    /// The owning repository (folder) the session ran in — the grouping key in the
    /// Usage panel. Resolved from the transcript's `cwd` against santree's
    /// registered repos, falling back to the path.
    pub repo: String,
    /// The worktree label (the issue id under `.santree/worktrees/`) when the
    /// session ran in a santree worktree; `None` for the repo's main checkout.
    pub worktree: Option<String>,
    /// The session's primary (most-used by tokens) model id — the badge model.
    pub model: String,
    /// Every model used in the session with its own token split, most-used first.
    /// Surfaces mid-session model switches (a session isn't tied to one model).
    pub models: Vec<ModelUsage>,
    pub totals: UsageTotals,
    /// Tokens in the last turn's context (input + cache read + cache write) ≈ the
    /// current context size — what "fills up" before Claude compacts.
    pub context_tokens: f64,
    /// The model's context-window limit the fill is measured against (200k, or 1M
    /// when the observed context already exceeds 200k).
    pub context_limit: f64,
    /// Epoch ms of the session's most recent activity — formatted live by the frontend.
    pub last_activity_ms: f64,
}

/// The full Claude usage report: grand + period totals, the per-model split, and
/// the most recent sessions (newest first).
#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub total: UsageTotals,
    pub today: UsageTotals,
    pub week: UsageTotals,
    pub month: UsageTotals,
    pub by_model: Vec<ModelUsage>,
    pub sessions: Vec<SessionUsage>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// `as_str` is the persisted form, so it must round-trip back through
    /// `FromStr` — a drift between the two silently resets a worktree's agent.
    #[test]
    fn agent_kinds_round_trip_through_their_persisted_form() {
        for kind in [
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Cursor,
            AgentKind::Opencode,
        ] {
            assert_eq!(AgentKind::from_str(kind.as_str()), Ok(kind));
        }
    }

    /// The parse error names what it actually found, so a caller reading stale or
    /// hand-edited data can log it instead of just "failed".
    #[test]
    fn unknown_agent_kind_reports_the_offending_input() {
        let err = AgentKind::from_str("Aider").unwrap_err();
        assert_eq!(err, UnknownAgentKind("Aider".into()));
        assert!(err.to_string().contains("Aider"), "{err}");
        // Case-sensitive: the persisted form is exactly `as_str`.
        assert!(AgentKind::from_str("claude").is_err());
    }
}
