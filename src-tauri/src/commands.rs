//! Tauri command layer — a *thin* adapter over the backends.
//!
//! Each command forwards to a live backend (`linear`/`db`/`repo`/`settings`/
//! `worktree`/`git`/`terminal`); when nothing is connected it returns real-but-
//! empty results (no sample data). Static config (agent catalog, stage metadata,
//! default settings) comes from `santree_core::config`. Every command is recorded
//! by `tauri-specta` so the typed client in `src/bindings.ts` stays in sync.
//! Business logic lives in those backends, not here.

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use santree_core::{
    domain::{
        AgentDef, AgentKind, ChangedFile, ClaudeCommands, FileSource, LinearOrg, LinearStatus,
        NewPr, Opener, PrDetail, PrDraft, Repo, ReviewInbox, ScriptInfo, Settings, Task,
        TriageDetail, TriageSchedule, TriageTicket, Worktree, WorktreePr,
    },
    config,
};

use crate::commit_draft;
use crate::db::Db;
use crate::git_watch::WorktreeWatcher;
use crate::linear;
use crate::notes;
use crate::openers;
use crate::pr;
use crate::repo;
use crate::reviews;
use crate::settings;
use crate::worktree;

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
    config::agents()
}

// ── Real worktrees (Trees view) ────────────────────────────────────────────

/// The repo's live agent worktrees (DB-tracked, with live git stats). Empty when
/// the repo has no local path.
#[tauri::command]
#[specta::specta]
pub async fn worktrees(repo: String, db: State<'_, Db>) -> Result<Vec<Worktree>, String> {
    worktree::list(&db, &repo).await.map_err(|e| e.to_string())
}

/// The repo's base branch as a worktree-like entry (repo root on main/master),
/// for the Trees "main" entry. `None` when the repo has no local path.
#[tauri::command]
#[specta::specta]
pub async fn base_worktree(repo: String, db: State<'_, Db>) -> Result<Option<Worktree>, String> {
    worktree::base_worktree(&db, &repo)
        .await
        .map_err(|e| e.to_string())
}

/// Start a task: create a worktree for an issue (branching off `base`), optionally
/// running `.santree/init.sh`, and record the issue ↔ worktree link.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn create_worktree(
    repo: String,
    issue_id: String,
    title: String,
    project: Option<String>,
    base: Option<String>,
    run_setup: bool,
    agent: AgentKind,
    db: State<'_, Db>,
) -> Result<Worktree, String> {
    worktree::create(
        &db,
        &repo,
        &issue_id,
        &title,
        project.as_deref(),
        base.as_deref(),
        run_setup,
        agent,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Remove a worktree (and its branch) and drop the issue link.
#[tauri::command]
#[specta::specta]
pub async fn remove_worktree(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::remove(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Merge the base branch into the worktree (the "pull from main/master" button).
/// Errors on a conflicting merge; returns the base ref that was merged on success.
#[tauri::command]
#[specta::specta]
pub async fn pull_worktree(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<String, String> {
    worktree::pull(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Run a worktree's setup script, streaming each output line over `on_event` for
/// the Trees "Setup" tab; records it as run on success.
#[tauri::command]
#[specta::specta]
pub async fn run_worktree_setup_streamed(
    repo: String,
    issue_id: String,
    on_event: Channel<worktree::SetupEvent>,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::run_setup_streamed(&db, &repo, &issue_id, on_event)
        .await
        .map_err(|e| e.to_string())
}

/// Fast-forward the repo's local base branch (main/master) to origin — the
/// "update master" action. Returns the base branch that was updated.
#[tauri::command]
#[specta::specta]
pub async fn update_base_branch(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<String, String> {
    worktree::update_base(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Start (or re-point) the filesystem watcher at the given repo's worktrees, so
/// the Trees views refresh live when files change on disk (e.g. an agent editing
/// in the terminal). A no-op for repos without a local path; idempotent, so the
/// frontend can call it on every Trees mount / repo change.
#[tauri::command]
#[specta::specta]
pub async fn watch_worktrees(
    repo: String,
    app: AppHandle,
    watcher: State<'_, WorktreeWatcher>,
    db: State<'_, Db>,
) -> Result<(), String> {
    if let Some(root) = repo::path(&db, &repo).await.map_err(|e| e.to_string())? {
        watcher
            .watch(&app, std::path::Path::new(&root))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The worktree's working-tree status (changed files) for the commit box.
#[tauri::command]
#[specta::specta]
pub async fn worktree_status(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<Vec<ChangedFile>, String> {
    worktree::status(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// A unified diff for one changed file (staged + unstaged vs HEAD).
#[tauri::command]
#[specta::specta]
pub async fn worktree_file_diff(
    repo: String,
    issue_id: String,
    path: String,
    untracked: bool,
    db: State<'_, Db>,
) -> Result<String, String> {
    worktree::file_diff(&db, &repo, &issue_id, &path, untracked)
        .await
        .map_err(|e| e.to_string())
}

/// The old/new full file contents, for the diff viewer's context expansion.
#[tauri::command]
#[specta::specta]
pub async fn worktree_file_source(
    repo: String,
    issue_id: String,
    path: String,
    db: State<'_, Db>,
) -> Result<FileSource, String> {
    worktree::file_source(&db, &repo, &issue_id, &path)
        .await
        .map_err(|e| e.to_string())
}

/// Every browsable file in the worktree (tracked + untracked, gitignore-aware).
#[tauri::command]
#[specta::specta]
pub async fn worktree_files(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<Vec<String>, String> {
    worktree::files(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Stage a single file.
#[tauri::command]
#[specta::specta]
pub async fn stage_path(
    repo: String,
    issue_id: String,
    path: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::stage(&db, &repo, &issue_id, &path)
        .await
        .map_err(|e| e.to_string())
}

/// Unstage a single file.
#[tauri::command]
#[specta::specta]
pub async fn unstage_path(
    repo: String,
    issue_id: String,
    path: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::unstage(&db, &repo, &issue_id, &path)
        .await
        .map_err(|e| e.to_string())
}

/// Discard a file's uncommitted changes (delete if untracked, else restore HEAD).
#[tauri::command]
#[specta::specta]
pub async fn discard_path(
    repo: String,
    issue_id: String,
    path: String,
    untracked: bool,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::discard(&db, &repo, &issue_id, &path, untracked)
        .await
        .map_err(|e| e.to_string())
}

/// Stage every change in the worktree.
#[tauri::command]
#[specta::specta]
pub async fn stage_all_paths(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::stage_all(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Unstage everything in the worktree.
#[tauri::command]
#[specta::specta]
pub async fn unstage_all_paths(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::unstage_all(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Commit the worktree (optionally staging everything first).
#[tauri::command]
#[specta::specta]
pub async fn commit_worktree(
    repo: String,
    issue_id: String,
    message: String,
    stage_all: bool,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::commit(&db, &repo, &issue_id, &message, stage_all)
        .await
        .map_err(|e| e.to_string())
}

/// Draft a commit message from the staged diff via a headless `claude -p` call.
#[tauri::command]
#[specta::specta]
pub async fn commit_message(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<String, String> {
    worktree::commit_message(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Refresh a worktree's stored Linear title (the Issue tab calls this when the
/// live title differs, keeping the sidebar accurate without the list hitting Linear).
#[tauri::command]
#[specta::specta]
pub async fn set_worktree_title(
    repo: String,
    issue_id: String,
    title: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::set_title(&db, &repo, &issue_id, &title)
        .await
        .map_err(|e| e.to_string())
}

/// The saved commit-message draft for a worktree, or `None`. Survives tab
/// switches / restarts until the worktree commits (which clears it).
#[tauri::command]
#[specta::specta]
pub async fn commit_draft(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<Option<String>, String> {
    commit_draft::get(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Save (or clear, when blank) a worktree's commit-message draft.
#[tauri::command]
#[specta::specta]
pub async fn set_commit_draft(
    repo: String,
    issue_id: String,
    message: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    commit_draft::set(&db, &repo, &issue_id, &message)
        .await
        .map_err(|e| e.to_string())
}

/// The agent's opening prompt for a freshly-started worktree (the `work`
/// template). The terminal seeds `exec <agent> '<prompt>'` with this.
#[tauri::command]
#[specta::specta]
pub async fn work_prompt(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> Result<String, String> {
    worktree::work_prompt(&db, &repo, &issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Draft a PR title + body for the create-PR dialog. With `fill`, the body is
/// AI-generated from the repo's PR template + the branch diff; otherwise it's the
/// raw template. Title defaults to the first commit's subject.
#[tauri::command]
#[specta::specta]
pub async fn pr_draft(
    repo: String,
    issue_id: String,
    fill: bool,
    db: State<'_, Db>,
) -> Result<PrDraft, String> {
    pr::draft(&db, &repo, &issue_id, fill)
        .await
        .map_err(|e| e.to_string())
}

/// Live PR status (number, URL, merge state) for each tracked worktree, from
/// GitHub. Empty when `gh` isn't authenticated; worktrees without a PR are omitted.
#[tauri::command]
#[specta::specta]
pub async fn worktree_prs(repo: String, db: State<'_, Db>) -> Result<Vec<WorktreePr>, String> {
    pr::statuses(&db, &repo).await.map_err(|e| e.to_string())
}

/// The Reviews dashboard inbox for the org the active `repo` belongs to: the
/// viewer's open PRs, PRs individually requesting their review, and one section
/// per team that has open requests. Empty when `gh` isn't authenticated.
#[tauri::command]
#[specta::specta]
pub async fn reviews(repo: String, db: State<'_, Db>) -> Result<ReviewInbox, String> {
    reviews::inbox(&db, &repo).await.map_err(|e| e.to_string())
}

/// Full detail for one PR — body, conversation (comments + reviews + inline
/// threads), and changed files with diffs. Empty when `gh` isn't authenticated.
#[tauri::command]
#[specta::specta]
pub async fn pr_detail(owner: String, name: String, number: u32) -> Result<PrDetail, String> {
    reviews::detail(&owner, &name, number)
        .await
        .map_err(|e| e.to_string())
}

/// Push the worktree branch and open a pull request via the GitHub API. Returns
/// the new PR's number and URL (the frontend opens it in the browser).
#[tauri::command]
#[specta::specta]
pub async fn create_pull_request(
    repo: String,
    issue_id: String,
    title: String,
    body: String,
    db: State<'_, Db>,
) -> Result<NewPr, String> {
    pr::create(&db, &repo, &issue_id, &title, &body)
        .await
        .map_err(|e| e.to_string())
}

/// The repo's `.santree/init.sh` setup script (for the Settings editor).
#[tauri::command]
#[specta::specta]
pub async fn worktree_init_script(
    repo: String,
    db: State<'_, Db>,
) -> Result<ScriptInfo, String> {
    worktree::init_script(&db, &repo)
        .await
        .map_err(|e| e.to_string())
}

/// Write the repo's `.santree/init.sh` setup script.
#[tauri::command]
#[specta::specta]
pub async fn set_worktree_init_script(
    repo: String,
    content: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::set_init_script(&db, &repo, &content)
        .await
        .map_err(|e| e.to_string())
}

/// Mark `.santree/init.sh` executable so it runs on worktree creation.
#[tauri::command]
#[specta::specta]
pub async fn make_init_script_executable(
    repo: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    worktree::make_init_executable(&db, &repo)
        .await
        .map_err(|e| e.to_string())
}

/// The "open in app" targets (Finder, editors, terminals) for a worktree.
/// Detection shells out (`open -Ra` per candidate), so it runs on the blocking
/// pool rather than freezing the UI thread; the result is memoised.
#[tauri::command]
#[specta::specta]
pub async fn list_openers() -> Vec<Opener> {
    tokio::task::spawn_blocking(openers::detect)
        .await
        .unwrap_or_default()
}

/// Open a path in the chosen app (by opener key).
#[tauri::command]
#[specta::specta]
pub fn open_in_app(path: String, opener: String) -> Result<(), String> {
    openers::open(&path, &opener).map_err(|e| e.to_string())
}

/// Tickets awaiting triage — live from Linear when connected, else empty.
#[tauri::command]
#[specta::specta]
pub async fn list_triage_tickets(
    repo: String,
    db: State<'_, Db>,
) -> Result<Vec<TriageTicket>, String> {
    linear::triage_tickets(&db, &repo)
        .await
        .map_err(|e| e.to_string())
        .map(|live| live.unwrap_or_default())
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
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("triage issue {ticket_id} not found"))
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
        .map(|live| live.unwrap_or_default())
}

/// Move a triage issue to a different workflow state (the status picker). Moving
/// it out of `triage` is how the UI promotes an item. Requires a connected,
/// write-scoped Linear org; errors when no org is connected.
#[tauri::command]
#[specta::specta]
pub async fn triage_set_state(
    repo: String,
    ticket_id: String,
    state_id: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    linear::set_issue_state(&db, &repo, &ticket_id, &state_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no Linear org connected".to_string())
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
pub async fn agent_auth(kind: AgentKind) -> santree_core::domain::AgentAuth {
    // Reads `~/.claude.json` and spawns a login shell (binary discovery), so keep
    // it off the UI thread.
    tokio::task::spawn_blocking(move || settings::agent_auth(kind))
        .await
        .expect("agent_auth task panicked")
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
/// an org is connected, else empty.
#[tauri::command]
#[specta::specta]
pub async fn linear_list_issues(repo: String, db: State<'_, Db>) -> Result<Vec<Task>, String> {
    match linear::list_issues(&db, &repo).await {
        Ok(Some(tasks)) => {
            tracing::info!(repo = %repo, count = tasks.len(), "fetched Linear issues");
            Ok(tasks)
        }
        Ok(None) => Ok(vec![]),
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
