//! Tauri command layer — a *thin* adapter over `santree_core`.
//!
//! Every command forwards to the core mock data source and is recorded by
//! `tauri-specta` so the typed client in `src/bindings.ts` stays in sync. No
//! business logic lives here; that's `santree_core`'s job.

use tauri::State;

use santree_core::{
    domain::{
        AgentDef, AgentKind, ClaudeCommands, LinearOrg, LinearStatus, Repo, Settings, Stage, Task,
        Terminal, TriageDetail, TriageSchedule, TriageTicket, Worktree, WorktreeDiff,
    },
    mock,
};

use crate::db::Db;
use crate::linear;
use crate::notes;
use crate::repo;
use crate::settings;

/// Connected repositories.
#[tauri::command]
#[specta::specta]
pub async fn list_repos(db: State<'_, Db>) -> Result<Vec<Repo>, String> {
    repo::list(&db).await.map_err(|e| e.to_string())
}

/// Add a repository from a local folder, validating it is a git work tree.
#[tauri::command]
#[specta::specta]
pub async fn add_repo(path: String, db: State<'_, Db>) -> Result<Repo, String> {
    repo::add(&db, path).await.map_err(|e| e.to_string())
}

/// Available coding agents and their models.
#[tauri::command]
#[specta::specta]
pub fn list_agents() -> Vec<AgentDef> {
    mock::agents()
}

/// Active agent worktrees.
#[tauri::command]
#[specta::specta]
pub fn list_worktrees() -> Vec<Worktree> {
    mock::worktrees()
}

/// The working-tree diff for a worktree.
#[tauri::command]
#[specta::specta]
pub fn worktree_diff(worktree_id: String) -> WorktreeDiff {
    mock::worktree_diff(&worktree_id)
}

/// A worktree's seed terminal transcript and status.
#[tauri::command]
#[specta::specta]
pub fn worktree_terminal(worktree_id: String) -> Terminal {
    mock::terminal(&worktree_id)
}

/// A seed commit message suggestion for a worktree.
#[tauri::command]
#[specta::specta]
pub fn commit_suggestion(worktree_id: String) -> String {
    mock::commit_seed(&worktree_id)
}

/// The worktree file browser tree.
#[tauri::command]
#[specta::specta]
pub fn file_tree() -> Vec<santree_core::domain::FileEntry> {
    mock::file_tree()
}

/// Stages an agent run progresses through (for session progress UI).
#[tauri::command]
#[specta::specta]
pub fn stage_meta() -> Vec<Stage> {
    mock::stage_meta()
}

/// Tickets awaiting triage — live from Linear when connected, else the sample set.
#[tauri::command]
#[specta::specta]
pub async fn list_triage_tickets(
    repo: String,
    db: State<'_, Db>,
) -> Result<Vec<TriageTicket>, String> {
    linear::triage_tickets(&db, &repo)
        .await
        .map_err(|e| e.to_string())
        .map(|live| live.unwrap_or_else(mock::triage_tickets))
}

/// The full triage issue (description + comments) for the discussion pane.
#[tauri::command]
#[specta::specta]
pub async fn triage_detail(
    repo: String,
    ticket_id: String,
    db: State<'_, Db>,
) -> Result<TriageDetail, String> {
    linear::triage_detail(&db, &repo, &ticket_id)
        .await
        .map_err(|e| e.to_string())
        .map(|live| live.unwrap_or_else(|| mock::triage_detail(&ticket_id)))
}

/// The team triage rotations (who is on-call now), from Linear's responsibility
/// schedules — one per team the viewer is on. Empty when none are configured.
#[tauri::command]
#[specta::specta]
pub async fn triage_schedule(
    repo: String,
    db: State<'_, Db>,
) -> Result<Vec<TriageSchedule>, String> {
    linear::triage_schedule(&db, &repo)
        .await
        .map_err(|e| e.to_string())
        .map(|live| live.unwrap_or_else(|| vec![mock::triage_schedule()]))
}

/// Move a triage issue to a different workflow state (the status picker). Moving
/// it out of `triage` is how the UI promotes an item. Requires a connected,
/// write-scoped Linear org; a no-op error is returned in mock mode.
#[tauri::command]
#[specta::specta]
pub async fn triage_set_state(
    repo: String,
    ticket_id: String,
    state_id: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    match linear::set_issue_state(&db, &repo, &ticket_id, &state_id)
        .await
        .map_err(|e| e.to_string())?
    {
        Some(()) => Ok(()),
        None => {
            // No live backend: accept the change so the optimistic UI stays usable.
            tracing::info!(ticket = %ticket_id, state = %state_id, "mock: status change");
            Ok(())
        }
    }
}

/// User settings, persisted in the database (seeded from defaults on first run).
/// Each agent's `exec` is the user's *override* (empty by default); the executable
/// detected on PATH is reported separately via [`agent_auth`] and shown as the
/// grayed default.
#[tauri::command]
#[specta::specta]
pub async fn get_settings(db: State<'_, Db>) -> Result<Settings, String> {
    settings::get_settings(&db).await.map_err(|e| e.to_string())
}

/// Persist the full settings blob. The frontend applies edits optimistically and
/// calls this to make them durable across restarts.
#[tauri::command]
#[specta::specta]
pub async fn set_settings(settings: Settings, db: State<'_, Db>) -> Result<(), String> {
    crate::settings::set_settings(&db, &settings)
        .await
        .map_err(|e| e.to_string())
}

/// An agent harness's authentication / subscription status. Live for Claude
/// (read from `~/.claude.json`), placeholders for the work-in-progress harnesses.
#[tauri::command]
#[specta::specta]
pub fn agent_auth(kind: AgentKind) -> santree_core::domain::AgentAuth {
    settings::agent_auth(kind)
}

/// The user's local note for a task — extra context stored only on this machine
/// (never synced to Linear). `None` when the task has no note.
#[tauri::command]
#[specta::specta]
pub async fn task_note(
    repo: String,
    task_id: String,
    db: State<'_, Db>,
) -> Result<Option<String>, String> {
    notes::get(&db, &repo, &task_id)
        .await
        .map_err(|e| e.to_string())
}

/// Save (or clear, when blank) the user's local note for a task.
#[tauri::command]
#[specta::specta]
pub async fn set_task_note(
    repo: String,
    task_id: String,
    body: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    notes::set(&db, &repo, &task_id, &body)
        .await
        .map_err(|e| e.to_string())
}

// ── App/per-repo settings + Claude command discovery ───────────────────────

/// The Claude slash-commands offered by the triage "Investigate" picker. Always
/// includes the global `~/.claude/commands`; when a repo name is given, also its
/// own `.claude/commands` (so the repo scope can list both).
#[tauri::command]
#[specta::specta]
pub async fn list_claude_commands(
    repo: Option<String>,
    db: State<'_, Db>,
) -> Result<ClaudeCommands, String> {
    let repo_path = match repo {
        Some(name) => repo::path(&db, &name).await.map_err(|e| e.to_string())?,
        None => None,
    };
    Ok(settings::commands(repo_path.as_deref()))
}

/// Read a setting for an exact scope (`"app"` or `"repo:<name>"`).
#[tauri::command]
#[specta::specta]
pub async fn get_setting(
    scope: String,
    key: String,
    db: State<'_, Db>,
) -> Result<Option<String>, String> {
    settings::get(&db, &scope, &key)
        .await
        .map_err(|e| e.to_string())
}

/// Write (or clear, when `value` is null) a setting for a scope.
#[tauri::command]
#[specta::specta]
pub async fn set_setting(
    scope: String,
    key: String,
    value: Option<String>,
    db: State<'_, Db>,
) -> Result<(), String> {
    settings::set(&db, &scope, &key, value)
        .await
        .map_err(|e| e.to_string())
}

/// Resolve a repo-scoped setting: the repo's override, else the app value.
#[tauri::command]
#[specta::specta]
pub async fn resolve_setting(
    repo: String,
    key: String,
    db: State<'_, Db>,
) -> Result<Option<String>, String> {
    settings::resolve(&db, &repo, &key)
        .await
        .map_err(|e| e.to_string())
}

// ── Linear integration ───────────────────────────────────────────────────

/// Connection status for a repo: whether any org is connected, and which one it uses.
#[tauri::command]
#[specta::specta]
pub async fn linear_auth_status(repo: String, db: State<'_, Db>) -> Result<LinearStatus, String> {
    linear::auth_status(&db, &repo)
        .await
        .map_err(|e| e.to_string())
}

/// Every connected Linear organization.
#[tauri::command]
#[specta::specta]
pub async fn linear_orgs(db: State<'_, Db>) -> Result<Vec<LinearOrg>, String> {
    linear::list_orgs(&db).await.map_err(|e| e.to_string())
}

/// Bind (or clear) the Linear org a repo uses.
#[tauri::command]
#[specta::specta]
pub async fn set_repo_linear_org(
    repo: String,
    slug: Option<String>,
    db: State<'_, Db>,
) -> Result<(), String> {
    linear::set_repo_org(&db, &repo, slug)
        .await
        .map_err(|e| e.to_string())
}

/// The repo's assigned Linear issues as a positioned dependency graph — live when
/// an org is connected, else the built-in sample graph (so the view is never
/// empty and the frontend needs no separate "is connected?" round-trip).
#[tauri::command]
#[specta::specta]
pub async fn linear_list_issues(repo: String, db: State<'_, Db>) -> Result<Vec<Task>, String> {
    match linear::list_issues(&db, &repo).await {
        Ok(Some(tasks)) => {
            tracing::info!(repo = %repo, count = tasks.len(), "fetched Linear issues");
            Ok(tasks)
        }
        Ok(None) => Ok(mock::tasks()),
        Err(e) => {
            tracing::warn!(repo = %repo, error = %e, "Linear issue fetch failed");
            Err(e.to_string())
        }
    }
}

/// Run the Linear OAuth flow; returns the updated org list.
#[tauri::command]
#[specta::specta]
pub async fn linear_connect(db: State<'_, Db>) -> Result<Vec<LinearOrg>, String> {
    linear::connect(&db).await.map_err(|e| e.to_string())
}
