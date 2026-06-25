//! Tauri command layer — a *thin* adapter over `santree_core`.
//!
//! Every command forwards to the core mock data source and is recorded by
//! `tauri-specta` so the typed client in `src/bindings.ts` stays in sync. No
//! business logic lives here; that's `santree_core`'s job.

use tauri::State;

use santree_core::{
    domain::{
        AgentDef, LinearOrg, LinearStatus, Repo, Settings, Stage, Task, Terminal, TriageMessage,
        TriageTicket, Worktree, WorktreeDiff,
    },
    mock,
};

use crate::db::Db;
use crate::linear;

/// Connected repositories.
#[tauri::command]
#[specta::specta]
pub fn list_repos() -> Vec<Repo> {
    mock::repos()
}

/// Available coding agents and their models.
#[tauri::command]
#[specta::specta]
pub fn list_agents() -> Vec<AgentDef> {
    mock::agents()
}

/// All tickets, positioned for the dependency graph.
#[tauri::command]
#[specta::specta]
pub fn list_tasks() -> Vec<Task> {
    mock::tasks()
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

/// Tickets awaiting triage.
#[tauri::command]
#[specta::specta]
pub fn list_triage_tickets() -> Vec<TriageTicket> {
    mock::triage_tickets()
}

/// The seed investigation thread for a triage ticket.
#[tauri::command]
#[specta::specta]
pub fn triage_thread(ticket_id: String) -> Vec<TriageMessage> {
    mock::triage_thread(&ticket_id)
}

/// Investigate a free-text triage question; returns the agent's answer.
#[tauri::command]
#[specta::specta]
pub fn triage_ask(question: String) -> TriageMessage {
    tracing::info!(question = %question, "triage question asked");
    mock::triage_answer(&question)
}

/// User settings (the frontend owns live edits after seeding).
#[tauri::command]
#[specta::specta]
pub fn get_settings() -> Settings {
    mock::settings()
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

/// Fetch the repo's assigned Linear issues as a positioned dependency graph.
#[tauri::command]
#[specta::specta]
pub async fn linear_list_issues(repo: String, db: State<'_, Db>) -> Result<Vec<Task>, String> {
    let issues = linear::list_issues(&db, &repo)
        .await
        .map_err(|e| e.to_string());
    match &issues {
        Ok(tasks) => tracing::info!(repo = %repo, count = tasks.len(), "fetched Linear issues"),
        Err(e) => tracing::warn!(repo = %repo, error = %e, "Linear issue fetch failed"),
    }
    issues
}

/// Run the Linear OAuth flow; returns the updated org list.
#[tauri::command]
#[specta::specta]
pub async fn linear_connect(db: State<'_, Db>) -> Result<Vec<LinearOrg>, String> {
    linear::connect(&db).await.map_err(|e| e.to_string())
}
