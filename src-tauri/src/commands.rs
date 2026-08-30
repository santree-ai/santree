//! Tauri command layer — a *thin* adapter over the backends.
//!
//! Each command forwards to a live backend (`linear`/`db`/`repo`/`settings`/
//! `worktree`/`git`/`terminal`); when nothing is connected it returns real-but-
//! empty results (no sample data). Static config (agent catalog, stage metadata,
//! default settings) comes from `santree_core::config`. Every command is recorded
//! by `tauri-specta` so the typed client in `src/bindings.ts` stays in sync.
//! Business logic lives in those backends, not here.
//!
//! Fallible commands return [`CmdResult`] and use `?`; the backend error is
//! flattened to the `string` the frontend expects (see [`crate::error`]).

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

use santree_core::{
    config,
    domain::{
        AgentAuth, AgentDef, AgentKind, AgentProcess, AgentSession, AgentVersionStatus,
        AiReviewLaunch, AnalysisScope, BinaryStatus, ChangedFile, CheckLog, ClaudeGlobalCapture,
        ClaudeRateLimitWindow, CodexAccount, CodexHealth, CodexModel, CodexRateLimits,
        EnglishAnalysis, EnglishLog, FileSource, GithubApiBudget, GithubStatus, LegacyCliMigration,
        LinearApiBudget, LinearOrg, LinearStatus, MergeQueue, NewInlineComment, NewPr,
        NewReviewWorkItem, Opener, PrDetail, PrDraft, PrLabel, PromptInfo, PromptPreview, Repo,
        RepoBranch, ResourceUsage, ReviewBrief, ReviewDraft, ReviewEvent, ReviewInbox, ReviewPr,
        ReviewPublishOutcome, ReviewTarget, ReviewWorkItem, Reviewer, ScriptInfo, SessionDetail,
        SessionState, SessionSubagent, SessionUsageLive, Settings, TabKind, TabLaunch, TabPr, Task,
        TicketRef, TriageDetail, TriageSchedule, TriageSession, TriageTicket, UsageReport,
        ViewedMarks, Worktree, WorktreeLaunch, WorktreePr, WorktreeSession, WorktreeTab,
    },
};

use crate::awake::{self, KeepAwake, KeepAwakeStatus};
use crate::codex_cli;
use crate::codex_rollouts;
use crate::commit_draft;
use crate::db::Db;
use crate::english_tutor;
use crate::error::CmdResult;
use crate::git_watch::WorktreeWatcher;
use crate::github;
use crate::legacy;
use crate::linear;
use crate::notes;
use crate::openers;
use crate::pr;
use crate::pricing;
use crate::provider::{self, SessionRequest, SessionSurface};
use crate::repo;
use crate::review_ai;
use crate::review_drafts;
use crate::review_work_items;
use crate::reviewed;
use crate::reviews;
use crate::session;
use crate::settings;
use crate::tabs;
use crate::usage;
use crate::worktree;
use santree_pty::PtyManager;

/// Connected repositories.
#[tauri::command]
#[specta::specta]
pub async fn list_repos(db: State<'_, Db>) -> CmdResult<Vec<Repo>> {
    Ok(repo::list(&db).await?)
}

/// Add a repository from a local folder, validating it is a git work tree.
#[tauri::command]
#[specta::specta]
pub async fn add_repo(path: String, db: State<'_, Db>) -> CmdResult<Repo> {
    Ok(repo::add(&db, path).await?)
}

/// Available coding agents and their models.
#[tauri::command]
#[specta::specta]
pub fn list_agents() -> Vec<AgentDef> {
    config::agents()
}

/// Whether the installed `codex` is one santree can launch. Never an error: an
/// unset path, a missing binary and an old version are all things the Settings
/// panel has to render, not things a caller can fail on.
#[tauri::command]
#[specta::specta]
pub async fn codex_health(db: State<'_, Db>) -> CmdResult<CodexHealth> {
    Ok(codex_cli::health(settings::agent_executable(&db, AgentKind::Codex).await.ok()).await)
}

#[tauri::command]
#[specta::specta]
pub async fn codex_account(db: State<'_, Db>) -> CmdResult<CodexAccount> {
    let executable = settings::agent_executable(&db, AgentKind::Codex).await?;
    Ok(codex_cli::account(&executable).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn codex_models(db: State<'_, Db>) -> CmdResult<Vec<CodexModel>> {
    let executable = settings::agent_executable(&db, AgentKind::Codex).await?;
    Ok(codex_cli::models(&executable).await?)
}

/// Codex subscription usage, as of the last turn Codex actually ran — read back
/// from its own rollout transcript, the only source that needs neither a control
/// plane nor the vendor's credentials. Empty when Codex has never run here, or
/// when the plan reports no windows.
#[tauri::command]
#[specta::specta]
pub async fn codex_rate_limits() -> CmdResult<CodexRateLimits> {
    Ok(tokio::task::spawn_blocking(codex_rollouts::latest_rate_limits).await?)
}

/// Hand `codex logout` on, on a click. santree asks; Codex owns what happens to
/// the credentials. There is deliberately no matching login command — see
/// [`crate::codex_cli`].
#[tauri::command]
#[specta::specta]
pub async fn codex_logout(db: State<'_, Db>) -> CmdResult<()> {
    let executable = settings::agent_executable(&db, AgentKind::Codex).await?;
    Ok(codex_cli::logout(&executable).await?)
}

/// Aggregated Claude Code token usage across all local session transcripts
/// (`~/.claude/projects/**/*.jsonl`) — period/model/session totals + context fill.
/// Empty when there are no transcripts. Resolves the price table first (a daily
/// background refresh from LiteLLM, cached in SQLite, over the static fallback),
/// then runs the cold parse on the blocking pool (cached per-file afterwards).
#[tauri::command]
#[specta::specta]
pub async fn claude_usage(app: AppHandle, db: State<'_, Db>) -> CmdResult<UsageReport> {
    let table = pricing::ensure_fresh(&db).await;
    // Registered repos let a session's cwd resolve to its repo (and worktree),
    // so the panel can group sessions by repo folder.
    let repos: Vec<usage::Repo> = repo::list(&db)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| r.path.map(|p| (r.name, p)))
        .collect();
    // Emit parse progress so the panel can show a bar on the (slow) cold load.
    let on_progress = move |done: usize, total: usize| {
        let _ = usage::UsageProgress {
            done: done as u32,
            total: total as u32,
        }
        .emit(&app);
    };
    Ok(tokio::task::spawn_blocking(move || usage::report(&table, &repos, on_progress)).await??)
}

// ── Real worktrees (Trees view) ────────────────────────────────────────────

/// The repo's live agent worktrees (DB-tracked, with live git stats). Empty when
/// the repo has no local path.
#[tauri::command]
#[specta::specta]
pub async fn worktrees(repo: String, db: State<'_, Db>) -> CmdResult<Vec<Worktree>> {
    Ok(worktree::list(&db, &repo).await?)
}

/// The repo's base branch as a worktree-like entry (repo root on main/master),
/// for the Trees "main" entry. `None` when the repo has no local path.
#[tauri::command]
#[specta::specta]
pub async fn base_worktree(repo: String, db: State<'_, Db>) -> CmdResult<Option<Worktree>> {
    Ok(worktree::base_worktree(&db, &repo).await?)
}

/// Find-or-create a worktree and record the issue ↔ worktree link. `launch` says
/// where the work came from — a Linear ticket, a branch picked or named in the
/// "Create worktree" dialog, or someone else's pull request — and that origin is
/// the only thing the three paths differ on: what the branch is, and whether
/// there is a Linear project to file the tree under. `base` is the parent
/// worktree's branch when one was picked (a *stacked* worktree), else `None` for
/// the repo's default branch.
///
/// Idempotent (see `worktree::create`): an already-tracked id, or a tree already
/// holding the requested branch, is returned rather than re-created. Running
/// `.santree/init.sh` is a separate step — see `run_worktree_setup_streamed` —
/// so it isn't gated on this call.
#[tauri::command]
#[specta::specta]
pub async fn create_worktree(
    repo: String,
    issue_id: String,
    title: String,
    launch: WorktreeLaunch,
    base: Option<String>,
    agent: Option<AgentKind>,
    db: State<'_, Db>,
) -> CmdResult<Worktree> {
    Ok(create_from_launch(
        &db,
        &repo,
        &issue_id,
        &title,
        &launch,
        base.as_deref(),
        agent,
    )
    .await?)
}

/// [`create_worktree`] minus Tauri, so the origin → (project, branch plan)
/// resolution is testable without a `State`.
async fn create_from_launch(
    db: &Db,
    repo: &str,
    issue_id: &str,
    title: &str,
    launch: &WorktreeLaunch,
    base: Option<&str>,
    agent: Option<AgentKind>,
) -> anyhow::Result<Worktree> {
    // A PR's repo is checked against the registered checkout's own origin before
    // anything else — it decides whether this create may happen at all, not just
    // what it creates. Every branch name below is re-validated inside
    // `worktree::create` (`git::safe_branch`) before it can reach a `git` argv.
    if let WorktreeLaunch::Pr { pr_repo, .. } = launch {
        let (local_owner, local_name) = reviews::origin(db, repo).await?;
        validate_pr_repo(pr_repo, &local_owner, &local_name)?;
    }
    // Only a ticket has a project. The other origins record none rather than a
    // stand-in: `worktree_links.project` is read straight back as a Linear
    // project band, so any constant put here renders as a project that isn't one.
    let (project, plan) = match launch {
        WorktreeLaunch::Ticket { project } => (project.as_deref(), worktree::BranchPlan::Derived),
        WorktreeLaunch::ExistingBranch { branch } => (None, worktree::BranchPlan::Existing(branch)),
        WorktreeLaunch::NewBranch { branch } => (None, worktree::BranchPlan::New(branch)),
        WorktreeLaunch::Pr { branch, .. } => (None, worktree::BranchPlan::Existing(branch)),
    };
    worktree::create(db, repo, issue_id, title, project, base, agent, plan).await
}

/// The repo's branches (local, plus `origin`-only ones), each flagged with
/// whether it is already checked out somewhere — the Create-worktree dialog's
/// Branch source. Empty when the repo has no local path.
#[tauri::command]
#[specta::specta]
pub async fn repo_branches(repo: String, db: State<'_, Db>) -> CmdResult<Vec<RepoBranch>> {
    Ok(worktree::branches(&db, &repo).await?)
}

fn validate_pr_repo(pr_repo: &str, local_owner: &str, local_name: &str) -> anyhow::Result<()> {
    let (pr_owner, pr_name) = crate::github::split_slug(pr_repo)?;
    if pr_owner.eq_ignore_ascii_case(local_owner) && pr_name.eq_ignore_ascii_case(local_name) {
        return Ok(());
    }
    anyhow::bail!(
        "pull request repo {pr_repo:?} does not match local repo {local_owner}/{local_name}"
    )
}

/// Remove a worktree (and its branch), drop the issue link, and delete its
/// on-disk work prompt.
#[tauri::command]
#[specta::specta]
pub async fn remove_worktree(
    app: AppHandle,
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    let prompts = worktree::prompts_root(&app);
    Ok(worktree::remove(&db, &repo, &issue_id, prompts.as_deref()).await?)
}

/// Merge the base branch into the worktree (the "pull from main/master" button).
/// Errors on a conflicting merge; returns the base ref that was merged on success.
#[tauri::command]
#[specta::specta]
pub async fn pull_worktree(repo: String, issue_id: String, db: State<'_, Db>) -> CmdResult<String> {
    Ok(worktree::pull(&db, &repo, &issue_id).await?)
}

/// Push the worktree's branch to origin (the Trees "Push" button / post-commit
/// auto-push). Network op — may fail (no auth, rejected non-fast-forward, …).
#[tauri::command]
#[specta::specta]
pub async fn push_worktree(repo: String, issue_id: String, db: State<'_, Db>) -> CmdResult<()> {
    Ok(worktree::push(&db, &repo, &issue_id).await?)
}

/// Integrate origin/<branch> into the worktree's own branch — the Trees "Pull"
/// button, for commits added to the branch remotely (PR-UI suggestions, "Update
/// branch", a teammate's push). Fast-forwards when possible, else merges; refuses
/// up front (nothing touched) when the merge would conflict.
#[tauri::command]
#[specta::specta]
pub async fn pull_remote_worktree(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(worktree::pull_remote(&db, &repo, &issue_id).await?)
}

/// Run a worktree's setup script, streaming each output line over `on_event` for
/// the Trees "Setup" tab; records it as run on success.
#[tauri::command]
#[specta::specta]
pub async fn run_worktree_setup_streamed(
    repo: String,
    issue_id: String,
    on_event: Channel<crate::stream::StreamEvent>,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(worktree::run_setup_streamed(&db, &repo, &issue_id, on_event).await?)
}

/// Stop a running setup script (the Setup tab's Stop button). Killing the child
/// ends the stream, so the run reports `Done { ok: false }` and the tab closes like
/// any other failed setup. Returns whether a run was actually stopped.
#[tauri::command]
#[specta::specta]
pub async fn cancel_worktree_setup(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<bool> {
    Ok(worktree::cancel_setup(&db, &repo, &issue_id).await?)
}

/// Re-grid a running setup script's PTY to the pane showing it — the Setup tab
/// reports its terminal size on mount and whenever it's resized, so the script's
/// output wraps to the pane instead of to a fixed starting width. Returns whether a
/// run was there to re-grid.
#[tauri::command]
#[specta::specta]
pub async fn resize_worktree_setup(
    repo: String,
    issue_id: String,
    cols: u16,
    rows: u16,
    db: State<'_, Db>,
) -> CmdResult<bool> {
    Ok(worktree::resize_setup(&db, &repo, &issue_id, cols, rows).await?)
}

/// Fast-forward the repo's local base branch (main/master) to origin — the
/// "update master" action. Returns the base branch that was updated.
#[tauri::command]
#[specta::specta]
pub async fn update_base_branch(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<String> {
    Ok(worktree::update_base(&db, &repo, &issue_id).await?)
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
) -> CmdResult<()> {
    if let Some(root) = repo::path(&db, &repo).await? {
        watcher.watch(&app, std::path::Path::new(&root)).await?;
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
) -> CmdResult<Vec<ChangedFile>> {
    Ok(worktree::status(&db, &repo, &issue_id).await?)
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
) -> CmdResult<String> {
    Ok(worktree::file_diff(&db, &repo, &issue_id, &path, untracked).await?)
}

/// The old/new full file contents, for the diff viewer's context expansion.
#[tauri::command]
#[specta::specta]
pub async fn worktree_file_source(
    repo: String,
    issue_id: String,
    path: String,
    db: State<'_, Db>,
) -> CmdResult<FileSource> {
    Ok(worktree::file_source(&db, &repo, &issue_id, &path).await?)
}

/// The files the branch has committed relative to its base (merge-base diff),
/// for the Trees right panel. Nothing about the working tree — see
/// `worktree_status` for that.
#[tauri::command]
#[specta::specta]
pub async fn worktree_branch_changes(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<Vec<ChangedFile>> {
    Ok(worktree::branch_changes(&db, &repo, &issue_id).await?)
}

/// One file's committed diff on the branch (`<base>...HEAD -- <path>`). Empty
/// when the branch didn't touch it.
#[tauri::command]
#[specta::specta]
pub async fn worktree_branch_file_diff(
    repo: String,
    issue_id: String,
    path: String,
    db: State<'_, Db>,
) -> CmdResult<String> {
    Ok(worktree::branch_file_diff(&db, &repo, &issue_id, &path).await?)
}

/// The agent sessions that have run in the worktree, newest first — registry
/// rows plus Claude transcripts found on disk for its directory.
#[tauri::command]
#[specta::specta]
pub async fn worktree_sessions(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<Vec<WorktreeSession>> {
    Ok(worktree::sessions(&db, &repo, &issue_id).await?)
}

/// What one of those sessions shows when its history row is expanded: the full
/// first prompt (which the list deliberately doesn't carry — it would bloat
/// every scan) and the tail of the conversation.
///
/// Same validation posture as [`resume_worktree_session`]: `issue_id` is gated
/// by naming a worktree the repo tracks, and the IPC-supplied `session_id` is
/// never looked up directly — the candidate set is re-derived from
/// [`worktree_sessions`] and the id must be in it. Display-only, and nothing
/// read here reaches a model or a terminal (COMPLIANCE.md, "Transcript reads").
#[tauri::command]
#[specta::specta]
pub async fn worktree_session_detail(
    repo: String,
    issue_id: String,
    session_id: String,
    db: State<'_, Db>,
) -> CmdResult<SessionDetail> {
    Ok(worktree::session_detail(&db, &repo, &issue_id, &session_id).await?)
}

/// The Task subagents of one of those sessions — one row per `agent-*.jsonl`
/// under the transcript's `subagents/` directory, carrying the `parentAgentId`
/// and `spawnDepth` its sidecar records so the pane can nest them.
///
/// View-only: a subagent shares its parent's session id, so there is nothing
/// here to resume. Arguments are validated exactly as
/// [`worktree_session_detail`]'s are; the directory is derived server-side from
/// the located transcript and never accepted from IPC.
#[tauri::command]
#[specta::specta]
pub async fn worktree_session_subagents(
    repo: String,
    issue_id: String,
    session_id: String,
    db: State<'_, Db>,
) -> CmdResult<Vec<SessionSubagent>> {
    Ok(worktree::session_subagents(&db, &repo, &issue_id, &session_id).await?)
}

/// Reveal one of those sessions' transcripts in the OS file browser. The path is
/// derived in Rust from the validated listing — the webview names a session, not
/// a file.
#[tauri::command]
#[specta::specta]
pub async fn reveal_worktree_session_transcript(
    repo: String,
    issue_id: String,
    session_id: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(worktree::reveal_session_transcript(&db, &repo, &issue_id, &session_id).await?)
}

/// Point a freshly-opened agent tab at one of the worktree's past sessions, so
/// its launch resumes that conversation instead of starting a new one — the
/// Session history pane's click.
///
/// Nothing about the launch is re-implemented here: this writes the same
/// `terminal_sessions` row a reopened tab already reads, and `agent_session`
/// then resolves the tab to `Resume` unchanged. The click that opens the tab is
/// the whole of the trigger, and no byte reaches a terminal from here
/// (COMPLIANCE.md, "a `--resume` seed is built only when a human opens the tab").
///
/// `session_id` is IPC-supplied and therefore never looked up directly: the
/// candidate set is re-derived from [`worktree_sessions`] itself, and the id must
/// be in it. The surface is derived here too — a caller passes the tab id it
/// minted, never a whole terminal key, so it cannot name `triage:…` or another
/// worktree's tab as the row to repoint.
#[tauri::command]
#[specta::specta]
pub async fn resume_worktree_session(
    repo: String,
    issue_id: String,
    tab_id: String,
    session_id: String,
    agent_kind: AgentKind,
    db: State<'_, Db>,
) -> CmdResult<()> {
    validate_tab_id(&tab_id)?;
    // Also the `issue_id` gate: this errors unless the id names a worktree the
    // repo actually tracks, so nothing unvouched-for reaches the key below.
    let listed = worktree::sessions(&db, &repo, &issue_id).await?;
    let term_key = format!("tree:{issue_id}:tab:{tab_id}");
    validate_term_key(&term_key)?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let sessions_root = codex_rollouts::sessions_root();
    let worktree_dir = worktree::coords(&db, &repo, &issue_id).await?.path;
    Ok(session::adopt(
        &db,
        &listed,
        session::ResumeRequest {
            repo: &repo,
            term_key: &term_key,
            session_id: &session_id,
            agent_kind,
            worktree: &worktree_dir,
            home: home.as_deref(),
            sessions_root: sessions_root.as_deref(),
        },
    )
    .await?)
}

/// A worktree tab's id, as the Trees model mints it (a UUID). Validated because
/// it is half of the terminal key [`resume_worktree_session`] derives: a `:` in
/// it would name a different surface, and a separator or `..` would ride that
/// key into everything derived from it.
fn validate_tab_id(tab_id: &str) -> Result<(), String> {
    if tab_id.is_empty()
        || tab_id.len() > 64
        || !tab_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("invalid tab id".into());
    }
    Ok(())
}

/// Every browsable file in the worktree (tracked + untracked, gitignore-aware).
#[tauri::command]
#[specta::specta]
pub async fn worktree_files(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<Vec<String>> {
    Ok(worktree::files(&db, &repo, &issue_id).await?)
}

/// Stage a single file.
#[tauri::command]
#[specta::specta]
pub async fn stage_path(
    repo: String,
    issue_id: String,
    path: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(worktree::stage(&db, &repo, &issue_id, &path).await?)
}

/// Unstage a single file.
#[tauri::command]
#[specta::specta]
pub async fn unstage_path(
    repo: String,
    issue_id: String,
    path: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(worktree::unstage(&db, &repo, &issue_id, &path).await?)
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
) -> CmdResult<()> {
    Ok(worktree::discard(&db, &repo, &issue_id, &path, untracked).await?)
}

/// Stage every change in the worktree.
#[tauri::command]
#[specta::specta]
pub async fn stage_all_paths(repo: String, issue_id: String, db: State<'_, Db>) -> CmdResult<()> {
    Ok(worktree::stage_all(&db, &repo, &issue_id).await?)
}

/// Unstage everything in the worktree.
#[tauri::command]
#[specta::specta]
pub async fn unstage_all_paths(repo: String, issue_id: String, db: State<'_, Db>) -> CmdResult<()> {
    Ok(worktree::unstage_all(&db, &repo, &issue_id).await?)
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
) -> CmdResult<()> {
    Ok(worktree::commit(&db, &repo, &issue_id, &message, stage_all).await?)
}

/// Draft a commit message from the staged diff via a headless `claude -p` call.
#[tauri::command]
#[specta::specta]
pub async fn commit_message(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<String> {
    Ok(worktree::commit_message(&db, &repo, &issue_id).await?)
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
) -> CmdResult<()> {
    Ok(worktree::set_title(&db, &repo, &issue_id, &title).await?)
}

/// The saved commit-message draft for a worktree, or `None`. Survives tab
/// switches / restarts until the worktree commits (which clears it).
#[tauri::command]
#[specta::specta]
pub async fn commit_draft(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<Option<String>> {
    Ok(commit_draft::get(&db, &repo, &issue_id).await?)
}

/// Save (or clear, when blank) a worktree's commit-message draft.
#[tauri::command]
#[specta::specta]
pub async fn set_commit_draft(
    repo: String,
    issue_id: String,
    message: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(commit_draft::set(&db, &repo, &issue_id, &message).await?)
}

/// Render the agent's opening prompt for a freshly-started worktree (the `work`
/// template, from live ticket data), write it to a stable on-disk file, and
/// return that file's **path** — not the text. The terminal seeds
/// `exec <agent> 'Read <path> and follow the instructions inside.'`, so a long
/// prompt can't overflow the interactive-shell line or be mangled by the PTY line
/// editor. Regenerated on every launch (re-fetches the live ticket), so it always
/// reflects the latest Linear state; deleted with the worktree.
#[tauri::command]
#[specta::specta]
pub async fn work_prompt(
    app: AppHandle,
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<String> {
    let prompts = worktree::prompts_root(&app).ok_or("no writable data dir for prompt file")?;
    Ok(worktree::work_prompt(&db, &repo, &issue_id, &prompts).await?)
}

/// Render the Triage-investigation opening prompt for a ticket (the `triage`
/// template around the live ticket), extract its screenshots to files the agent
/// can `Read`, write the prompt to a stable on-disk file, and return that file's
/// **path** — the terminal seeds `exec <agent> 'Read <path> …'` with it. The
/// investigation analog of [`work_prompt`]; regenerated on every launch.
#[tauri::command]
#[specta::specta]
pub async fn investigate_prompt(
    app: AppHandle,
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<String> {
    let prompts = worktree::prompts_root(&app).ok_or("no writable data dir for prompt file")?;
    Ok(worktree::investigate_prompt(&db, &repo, &issue_id, &prompts).await?)
}

/// Resolve an interactive provider session: resume its durable id, start fresh,
/// or leave the terminal as a plain shell.
/// `term_key` is the logical terminal id (e.g. `tree:AK-1`, `triage:AK-1`); `cwd`
/// is where the provider runs. `allow_fresh` mints a session when none is resumable
/// (set on an explicit launch; false on a passive reopen).
fn validate_term_key(term_key: &str) -> Result<(), String> {
    if term_key.is_empty()
        || term_key.len() > 240
        || !term_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '/' | '#' | '.'))
    {
        return Err("invalid terminal key".into());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn agent_session(
    app: AppHandle,
    repo: String,
    term_key: String,
    cwd: String,
    allow_fresh: bool,
    agent: AgentKind,
    db: State<'_, Db>,
) -> CmdResult<AgentSession> {
    validate_term_key(&term_key)?;
    let cwd_path = std::fs::canonicalize(&cwd)?;
    let repo_db_path = agent_repo_path(&db, &repo).await?;
    let repo_root = std::fs::canonicalize(&repo_db_path)?;
    // Provider selection and id creation form one reservation. Serializing this
    // small launch-only section prevents simultaneous first launches from
    // adopting the other provider's id.
    static RESOLVE_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _resolve_guard = RESOLVE_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let context = session_context(&db, &repo, &repo_db_path, &term_key).await?;
    validate_agent_cwd(&db, &repo, &term_key, &cwd_path, &repo_root, &repo_db_path).await?;
    if let Some(authoritative) = context.agent {
        if agent != authoritative {
            return Err("terminal provider does not match the persisted surface".into());
        }
    }
    let agent = context.agent.unwrap_or(agent);
    let surface = context.surface;
    // Codex takes santree's review tools as launch configuration, so the path is
    // resolved here — from the session's own row, never from IPC (COMPLIANCE.md,
    // "santree derives its own paths"). Claude's frontend still passes
    // `--mcp-config` from the launch hand-off, so this is Codex-only.
    let review_mcp_config = match (agent, &context.review_pr) {
        (AgentKind::Codex, Some(pr)) => Some(review_mcp_config(&app, pr)?),
        _ => None,
    };
    let (model_key, effort_key) = surface.setting_keys();
    let resolved_model =
        settings::resolve_provider(&db, &repo, model_key, surface.agent_key(), agent).await?;
    let effort =
        settings::resolve_provider(&db, &repo, effort_key, surface.agent_key(), agent).await?;
    let app_settings = settings::get_settings(&db).await?;
    let configured_model = app_settings
        .agents
        .iter()
        .find(|setting| setting.key == agent)
        .map(|setting| setting.model.as_str());
    let model = resolved_model.as_deref().or(configured_model);
    let executable = settings::agent_executable(&db, agent).await?;
    let provider = provider::provider(agent, executable)?;
    debug_assert_eq!(provider.kind(), agent);
    Ok(provider
        .resolve_session(SessionRequest {
            db: &db,
            repo: &repo,
            term_key: &term_key,
            cwd: &cwd_path,
            model,
            effort: effort.as_deref(),
            surface,
            allow_fresh,
            review_mcp_config: review_mcp_config.as_deref(),
        })
        .await?)
}

/// Where this session's review tools are described, re-derived from the PR its
/// own row names and proved to be an app-owned regular file inside santree's
/// `mcp` directory.
///
/// A path never crosses IPC for this: the webview may say *which* PR a review
/// belongs to, and `session_context` checks that claim against the registered
/// origin or the persisted tab, but the file is santree's answer to it. An `Err`
/// stops the launch — a Codex review runs `--ask-for-approval never`, so a tool
/// it cannot reach is rejected silently rather than prompted for, and a review
/// with no way to record a finding must fail loudly instead.
fn review_mcp_config(
    app: &AppHandle,
    (owner, name, number): &(String, String, u32),
) -> Result<std::path::PathBuf, String> {
    let stem = crate::hooks::mcp_stem(owner, name, *number).map_err(|error| error.to_string())?;
    let expected_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "app data directory is unavailable".to_string())?
        .join("mcp");
    let path = expected_dir.join(stem);
    let missing = || {
        format!(
            "santree's review tools for {owner}/{name}#{number} are no longer on disk. \
             Start the review again from the pull request."
        )
    };
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| missing())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("review configuration must be an app-owned file".into());
    }
    let expected_dir = std::fs::canonicalize(expected_dir).map_err(|_| missing())?;
    let actual = std::fs::canonicalize(path).map_err(|_| missing())?;
    if actual.parent() != Some(expected_dir.as_path()) {
        return Err("review configuration is outside santree's app data".into());
    }
    Ok(actual)
}

/// The registered local path of the repo a session is being launched for. Every
/// later check (`validate_agent_cwd`, the review/triage guards) measures against
/// this, so a repo with no path on disk has to fail here rather than downstream.
async fn agent_repo_path(db: &Db, repo: &str) -> Result<String, String> {
    repo::path(db, repo)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "repository has no local path".into())
}

fn review_identity(term_key: &str) -> Result<(&str, &str, u32), String> {
    let identity = term_key
        .strip_prefix("review:")
        .or_else(|| term_key.strip_prefix("ai-review:"))
        .ok_or_else(|| "invalid review terminal key".to_string())?;
    let (slug, number) = identity
        .rsplit_once('#')
        .ok_or_else(|| "invalid review terminal key".to_string())?;
    let (owner, name) = slug
        .split_once('/')
        .ok_or_else(|| "invalid review repository identity".to_string())?;
    let number = number
        .parse::<u32>()
        .map_err(|_| "invalid review repository identity".to_string())?;
    if owner.is_empty()
        || name.is_empty()
        || owner.contains(['/', '\\'])
        || name.contains(['/', '\\'])
    {
        return Err("invalid review repository identity".into());
    }
    Ok((owner, name, number))
}

struct SessionContext {
    surface: SessionSurface,
    agent: Option<AgentKind>,
    /// The pull request whose review tools this session launches with, as
    /// `(owner, name, number)`. Only the two review-scoped surfaces have one, and
    /// it comes from the terminal key (checked against the registered origin by
    /// [`validate_agent_cwd`]) or from the tab's own persisted row — never from a
    /// path the webview supplied.
    review_pr: Option<(String, String, u32)>,
}

impl SessionContext {
    fn new(surface: SessionSurface, agent: Option<AgentKind>) -> Self {
        Self {
            surface,
            agent,
            review_pr: None,
        }
    }
}

async fn session_context(
    db: &Db,
    repo: &str,
    repo_db_path: &str,
    term_key: &str,
) -> Result<SessionContext, String> {
    if term_key.starts_with("triage:") {
        return Ok(SessionContext::new(SessionSurface::Investigate, None));
    }
    if term_key.starts_with("review:") {
        return Ok(SessionContext::new(SessionSurface::AskAi, None));
    }
    if term_key.starts_with("ai-review:") {
        let (owner, name, number) = review_identity(term_key)?;
        return Ok(SessionContext {
            review_pr: Some((owner.to_string(), name.to_string(), number)),
            ..SessionContext::new(SessionSurface::Review, None)
        });
    }
    let tree = term_key
        .strip_prefix("tree:")
        .ok_or_else(|| "unknown terminal surface".to_string())?;
    if let Some((worktree_id, tab_id)) = tree.split_once(":tab:") {
        if worktree_id.is_empty() || tab_id.is_empty() || tab_id.contains(':') {
            return Err("invalid worktree tab terminal key".into());
        }
        /// `(kind, agent_kind, pr_repo, pr_number)` as `worktree_tabs` stores it —
        /// every column but `kind` is nullable, because a plain terminal tab has
        /// no agent and only a review tab carries a PR.
        type TabRow = (String, Option<String>, Option<String>, Option<u32>);
        let row: Option<TabRow> = sqlx::query_as(
            "SELECT kind, agent_kind, pr_repo, pr_number FROM worktree_tabs
             WHERE repo = ? AND worktree_id = ? AND id = ?",
        )
        .bind(repo)
        .bind(worktree_id)
        .bind(tab_id)
        .fetch_optional(db)
        .await
        .map_err(|error| error.to_string())?;
        let (kind, agent, pr_repo, pr_number) =
            row.ok_or_else(|| "worktree tab does not exist".to_string())?;
        if kind == "terminal" {
            return Err("plain terminal tabs cannot start an agent session".into());
        }
        let agent = agent
            .ok_or_else(|| "agent tab has no persisted provider".to_string())?
            .parse::<AgentKind>()
            .map_err(|error| error.to_string())?;
        // The two review kinds are the ones that launch with the review deny list
        // and santree's review tools, and `TabKind` is where that is decided —
        // reading the column through it keeps this from drifting the way it did
        // when `ai_review` was added and only `fixci` was matched here.
        let kind = TabKind::from_db_str(&kind);
        let review_pr = kind
            .is_review()
            .then(|| pr_repo.zip(pr_number))
            .flatten()
            .map(|(slug, number)| {
                crate::github::split_slug(&slug)
                    .map(|(owner, name)| (owner.to_string(), name.to_string(), number))
                    .map_err(|error| error.to_string())
            })
            .transpose()?;
        return Ok(SessionContext {
            surface: match kind {
                TabKind::FixCi => SessionSurface::FixCi,
                TabKind::AiReview => SessionSurface::Review,
                TabKind::Agent | TabKind::Terminal => SessionSurface::Work,
            },
            agent: Some(agent),
            review_pr,
        });
    }
    if tree.is_empty() || tree.contains(':') {
        return Err("invalid worktree terminal key".into());
    }
    let agent: Option<Option<String>> =
        sqlx::query_scalar("SELECT agent FROM worktree_links WHERE repo_path = ? AND issue_id = ?")
            .bind(repo_db_path)
            .bind(tree)
            .fetch_optional(db)
            .await
            .map_err(|error| error.to_string())?;
    let agent = agent
        .ok_or_else(|| "worktree does not exist".to_string())?
        .map(|agent| {
            agent
                .parse::<AgentKind>()
                .map_err(|error| error.to_string())
        })
        .transpose()?;
    Ok(SessionContext::new(SessionSurface::Work, agent))
}

async fn validate_agent_cwd(
    db: &Db,
    repo: &str,
    term_key: &str,
    cwd: &std::path::Path,
    repo_root: &std::path::Path,
    repo_db_path: &str,
) -> Result<(), String> {
    if term_key.starts_with("triage:") {
        return (cwd == repo_root)
            .then_some(())
            .ok_or_else(|| "triage sessions must use the registered repository root".into());
    }
    if term_key.starts_with("review:") || term_key.starts_with("ai-review:") {
        let (requested_owner, requested_name, number) = review_identity(term_key)?;
        let (owner, name) = crate::reviews::origin(db, repo)
            .await
            .map_err(|_| "registered repository origin is unavailable".to_string())?;
        if !requested_owner.eq_ignore_ascii_case(&owner)
            || !requested_name.eq_ignore_ascii_case(&name)
        {
            return Err("review terminal repository does not match the registered origin".into());
        }
        let santree_dir = repo_root.join(".santree");
        let reviews_dir = santree_dir.join(crate::reviews::REVIEWS_DIR);
        let dir = crate::reviews::review_dir_name(&owner, &name, number)
            .map_err(|error| error.to_string())?;
        let expected = reviews_dir.join(dir);
        for path in [&santree_dir, &reviews_dir, &expected] {
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|_| "review checkout is not available".to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("review checkout path cannot contain symlinks".into());
            }
        }
        let reviews_dir = std::fs::canonicalize(&reviews_dir)
            .map_err(|_| "review checkout is not available".to_string())?;
        if !reviews_dir.starts_with(repo_root) {
            return Err("review checkout directory escapes the repository".into());
        }
        let expected = std::fs::canonicalize(&expected)
            .map_err(|_| "review checkout is not available".to_string())?;
        let git = expected.join(".git");
        let git_is_file =
            std::fs::symlink_metadata(&git).is_ok_and(|metadata| metadata.file_type().is_file());
        return (expected.parent() == Some(reviews_dir.as_path())
            && cwd == expected
            && git_is_file)
            .then_some(())
            .ok_or_else(|| "review session cwd does not match the requested pull request".into());
    }
    let issue_id = term_key
        .strip_prefix("tree:")
        .and_then(|rest| rest.split(':').next())
        .ok_or_else(|| "unknown terminal surface".to_string())?;
    // The base entry is the repo root itself, not a tracked row: `worktree::BASE_ID`
    // is a sentinel the helpers map to the registered path, so its tabs have no
    // `worktree_links` path to match. The registered root is what the cwd must equal.
    if issue_id == worktree::BASE_ID {
        return (cwd == repo_root)
            .then_some(())
            .ok_or_else(|| "terminal cwd is not the repository root".into());
    }
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT worktree_path FROM worktree_links WHERE repo_path = ? AND issue_id = ?",
    )
    .bind(repo_db_path)
    .bind(issue_id)
    .fetch_optional(db)
    .await
    .map_err(|error| error.to_string())?;
    stored
        .and_then(|path| std::fs::canonicalize(path).ok())
        .is_some_and(|path| path == cwd)
        .then_some(())
        .ok_or_else(|| "terminal cwd is not the registered worktree".into())
}

/// Stored Triage surfaces and their sticky providers. Drives resume affordances
/// and provider-correct branding across app restarts.
#[tauri::command]
#[specta::specta]
pub async fn started_investigations(
    repo: String,
    db: State<'_, Db>,
) -> CmdResult<Vec<TriageSession>> {
    Ok(session::started_investigations(&db, &repo).await?)
}

/// Provider tabs persisted for one logical agent surface.
#[tauri::command]
#[specta::specta]
pub async fn session_providers(
    repo: String,
    term_key: String,
    db: State<'_, Db>,
) -> CmdResult<Vec<AgentKind>> {
    validate_term_key(&term_key)?;
    Ok(session::providers(&db, &repo, &term_key).await?)
}

/// All persisted extra tabs (Claude / terminal) for the repo's worktrees, in
/// open order — loaded on Trees mount so tabs survive app restarts.
#[tauri::command]
#[specta::specta]
pub async fn list_worktree_tabs(repo: String, db: State<'_, Db>) -> CmdResult<Vec<WorktreeTab>> {
    Ok(tabs::list(&db, &repo).await?)
}

/// Persist a new extra tab. The frontend mints `id` (a UUID) so it can patch
/// its cache and focus the tab without waiting on the round-trip.
///
/// `pr` is required for (and only for) the review kinds: it is what
/// [`worktree_tab_launch`] re-derives the tab's `--settings` and `--mcp-config`
/// from after a restart.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // Typed IPC fields stay explicit at this security boundary.
pub async fn add_worktree_tab(
    repo: String,
    worktree_id: String,
    id: String,
    kind: TabKind,
    agent_kind: Option<AgentKind>,
    title: String,
    pr: Option<TabPr>,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(tabs::add(
        &db,
        &repo,
        tabs::NewTab {
            worktree_id: &worktree_id,
            id: &id,
            kind,
            agent_kind,
            title: &title,
            pr,
        },
    )
    .await?)
}

/// What a persisted review tab must relaunch with — the review deny list, and
/// santree's review MCP server scoped to its PR.
///
/// The in-memory hand-off that carries those on a first launch does not survive an
/// app restart, and the fallback it left behind was the plain no-git settings: no
/// `gh` deny rules and no MCP server, with no error. Both are re-derived here from
/// the row's own `(kind, pr)`, never from a stored path. `None` for a tab that
/// isn't review-scoped, and for one that no longer exists.
#[tauri::command]
#[specta::specta]
pub async fn worktree_tab_launch(
    app: AppHandle,
    repo: String,
    id: String,
    db: State<'_, Db>,
) -> CmdResult<Option<TabLaunch>> {
    let Some(tab) = tabs::get(&db, &repo, &id).await? else {
        return Ok(None);
    };
    let tutor = tutor_instruction(&app).await;
    // Writes the settings file and stats the MCP config — filesystem work, so it
    // stays off the thread the UI runs on.
    Ok(
        tokio::task::spawn_blocking(move || review_ai::tab_launch(&app, &tab, tutor.as_deref()))
            .await
            .map_err(|e| anyhow::anyhow!("resolving the review tab's launch panicked: {e}"))??,
    )
}

/// Rename an extra tab (blank titles are rejected).
#[tauri::command]
#[specta::specta]
pub async fn rename_worktree_tab(
    repo: String,
    id: String,
    title: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(tabs::rename(&db, &repo, &id, &title).await?)
}

/// Remove an extra tab; a Claude tab's stored session is forgotten with it.
#[tauri::command]
#[specta::specta]
pub async fn remove_worktree_tab(repo: String, id: String, db: State<'_, Db>) -> CmdResult<()> {
    Ok(tabs::remove(&db, &repo, &id).await?)
}

/// Draft a PR title + body for the create-PR dialog. With `fill`, the body is
/// AI-generated from the repo's PR template + the branch diff; otherwise it's the
/// raw template. Title defaults to the first commit's subject. When
/// `send_transcripts` is set (only meaningful with `fill`), the worktree's Claude
/// session transcript(s) are mined for extra context (decisions, rationale).
#[tauri::command]
#[specta::specta]
pub async fn pr_draft(
    repo: String,
    issue_id: String,
    fill: bool,
    send_transcripts: bool,
    db: State<'_, Db>,
) -> CmdResult<PrDraft> {
    Ok(pr::draft(&db, &repo, &issue_id, fill, send_transcripts).await?)
}

/// Whether the worktree has any Claude session transcript on disk — gates the PR
/// dialog's "use transcripts" checkbox so it only shows when there's history to send.
#[tauri::command]
#[specta::specta]
pub async fn worktree_has_transcripts(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<bool> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    Ok(session::worktree_has_transcripts(&db, &repo, &issue_id, home.as_deref()).await?)
}

/// Live PR status (number, URL, merge state) for each tracked worktree, from
/// GitHub. Empty when `gh` isn't authenticated; worktrees without a PR are omitted.
#[tauri::command]
#[specta::specta]
pub async fn worktree_prs(repo: String, db: State<'_, Db>) -> CmdResult<Vec<WorktreePr>> {
    Ok(pr::statuses(&db, &repo).await?)
}

/// The Reviews dashboard inbox for the org the active `repo` belongs to: the
/// viewer's open PRs, PRs individually requesting their review, and one section
/// per team that has open requests. Empty when `gh` isn't authenticated.
#[tauri::command]
#[specta::specta]
pub async fn reviews(repo: String, db: State<'_, Db>) -> CmdResult<ReviewInbox> {
    Ok(reviews::inbox(&db, &repo).await?)
}

/// Resolve Linear identifiers to `(project, title)` so the Reviews sidebar can
/// group PRs by project. Empty when no Linear org is connected — the sidebar then
/// simply offers no project grouping.
#[tauri::command]
#[specta::specta]
pub async fn pr_tickets(
    repo: String,
    ids: Vec<String>,
    db: State<'_, Db>,
) -> CmdResult<Vec<TicketRef>> {
    Ok(linear::tickets_by_identifier(&db, &repo, &ids)
        .await?
        .unwrap_or_default())
}

/// Find-or-create the read-only checkout of a PR's head for an AI review session
/// to read real code in — a detached worktree under `.santree/reviews/`, pruned to
/// the few most recent. `None` when the PR lives in a repo the active santree repo
/// isn't a clone of; the session then runs diff-only.
#[tauri::command]
#[specta::specta]
pub async fn review_workspace(
    repo: String,
    target: ReviewTarget,
    db: State<'_, Db>,
) -> CmdResult<Option<String>> {
    Ok(reviews::review_workspace(&db, &repo, &target).await?)
}

/// Delete a PR's review checkout. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn remove_review_workspace(
    repo: String,
    number: u32,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(reviews::remove_review_workspace(&db, &repo, number).await?)
}

/// The cached AI review brief for a PR (summary, reading order, watch-outs), or
/// `None` when none has been generated. A single row read — the panel renders its
/// "generate" state off this without waiting on any model.
#[tauri::command]
#[specta::specta]
pub async fn pr_review_brief(
    pr_repo: String,
    number: u32,
    db: State<'_, Db>,
) -> CmdResult<Option<ReviewBrief>> {
    Ok(review_ai::cached_brief(&db, &pr_repo, number).await?)
}

/// Resolve everything an **AI review** session launches with: its rendered prompt,
/// its `--settings` file, and the `--mcp-config` registering santree's review
/// tools for this PR. One command for all three — the terminal seed is built once,
/// so a flag that resolves late is silently dropped (see [`review_ai::launch`]).
#[tauri::command]
#[specta::specta]
pub async fn ai_review_launch(
    app: AppHandle,
    repo: String,
    target: ReviewTarget,
    db: State<'_, Db>,
) -> CmdResult<AiReviewLaunch> {
    let tutor = tutor_instruction(&app).await;
    Ok(review_ai::launch(&app, &db, &repo, &target, tutor.as_deref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn review_fix_launch(
    app: AppHandle,
    repo: String,
    target: ReviewTarget,
    db: State<'_, Db>,
) -> CmdResult<AiReviewLaunch> {
    let tutor = tutor_instruction(&app).await;
    Ok(review_ai::fix_launch(&app, &db, &repo, &target, tutor.as_deref()).await?)
}

/// The AI review's draft comments for a PR — written by its MCP tools, held in
/// santree until the user publishes them. Empty until an AI review has run.
#[tauri::command]
#[specta::specta]
pub async fn review_drafts(
    pr_repo: String,
    number: u32,
    db: State<'_, Db>,
) -> CmdResult<Vec<ReviewDraft>> {
    Ok(review_drafts::list(&db, &pr_repo, number).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn review_work_items(
    pr_repo: String,
    number: u32,
    db: State<'_, Db>,
) -> CmdResult<Vec<ReviewWorkItem>> {
    Ok(review_work_items::list(&db, &pr_repo, number).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn add_review_work_item(
    pr_repo: String,
    number: u32,
    mut item: NewReviewWorkItem,
    db: State<'_, Db>,
) -> CmdResult<ReviewWorkItem> {
    match item.source {
        santree_core::domain::ReviewWorkItemSource::Manual => {
            item.source_id = None;
            // A manual item may carry the diff anchor the user selected when they
            // queued it from a line, which is what makes it clickable and tells
            // the fixing agent where to look. Unlike the source-backed kinds there
            // is no GitHub object to derive it from, so the anchor is kept as the
            // caller sent it, guarded only against a shape that could not be a
            // repo-relative file. That guard is sufficient because the value never
            // reaches a filesystem call or a git argv: santree renders it as text
            // and hands it to the agent inside the untrusted-data fence.
            //
            // Note the body is *not* necessarily the user's own words — queueing a
            // PR comment files whoever wrote it, bots included. It is bounded in
            // `review_work_items::add` for that reason, and it reaches the agent
            // through the same fence as every other source.
            if let Some(path) = item.path.as_deref() {
                if !is_repo_relative_path(path) {
                    return Err("a work item's file must be a repo-relative path".into());
                }
            } else {
                item.line = None;
                item.start_line = None;
                item.on_right = None;
            }
        }
        santree_core::domain::ReviewWorkItemSource::GithubThread => {
            let source_id = item
                .source_id
                .as_deref()
                .ok_or_else(|| "a GitHub work item needs a source thread".to_string())?;
            let (owner, name) = github::split_slug(&pr_repo)?;
            let detail = reviews::detail(owner, name, number).await?;
            let thread = detail
                .threads
                .into_iter()
                .find(|thread| thread.reply_to_id == source_id)
                .ok_or_else(|| {
                    "that GitHub thread does not belong to this pull request".to_string()
                })?;
            item.body = thread
                .comments
                .first()
                .map(|comment| comment.body.clone())
                .unwrap_or_else(|| format!("Review comment on {}", thread.path));
            item.path = Some(thread.path);
            item.line = thread.line;
            item.start_line = thread.start_line;
            item.on_right = Some(thread.on_right);
        }
        santree_core::domain::ReviewWorkItemSource::AiDraft => {
            let source_id = item
                .source_id
                .as_deref()
                .ok_or_else(|| "an AI work item needs a source draft".to_string())?;
            let draft = review_drafts::list(&db, &pr_repo, number)
                .await?
                .into_iter()
                .find(|draft| draft.id == source_id)
                .ok_or_else(|| "that AI draft does not belong to this pull request".to_string())?;
            item.body = review_drafts::compose_body(&draft.body, draft.suggestion.as_deref());
            item.path = Some(draft.path);
            item.line = Some(draft.line);
            item.start_line = draft.start_line;
            item.on_right = Some(draft.on_right);
        }
        santree_core::domain::ReviewWorkItemSource::Check => {
            let source_id = item
                .source_id
                .as_deref()
                .ok_or_else(|| "a check work item needs a check name".to_string())?;
            let (owner, name) = github::split_slug(&pr_repo)?;
            let detail = reviews::detail(owner, name, number).await?;
            let check = detail
                .checks
                .into_iter()
                .find(|check| check.name == source_id)
                .ok_or_else(|| "that check is not on this pull request".to_string())?;
            // Server-authored, like the other source-backed kinds: the caller
            // names *which* check, never what the queue row says about it.
            item.body = check_work_item_body(&check);
            // A check is a job on the head commit, not a line in a file. Leaving
            // these empty keeps the queue from claiming an anchor GitHub never
            // gave; the failing steps and annotations reach the fixing agent live
            // from `review_ai::fix_launch` instead of being frozen here.
            item.path = None;
            item.line = None;
            item.start_line = None;
            item.on_right = None;
        }
    }
    Ok(review_work_items::add(
        &db,
        &pr_repo,
        number,
        &item.id,
        &item.body,
        item.source,
        item.source_id.as_deref(),
        item.path.as_deref(),
        item.line,
        item.start_line,
        item.on_right,
    )
    .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn update_review_work_item(
    pr_repo: String,
    number: u32,
    id: String,
    body: String,
    done: bool,
    db: State<'_, Db>,
) -> CmdResult<ReviewWorkItem> {
    Ok(review_work_items::update(&db, &pr_repo, number, &id, &body, done).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_review_work_item(
    pr_repo: String,
    number: u32,
    id: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(review_work_items::delete(&db, &pr_repo, number, &id).await?)
}

/// Rewrite a draft the user edited before sending it. Local only — nothing has
/// reached GitHub at this point.
#[tauri::command]
#[specta::specta]
pub async fn update_review_draft(
    id: String,
    body: String,
    suggestion: Option<String>,
    db: State<'_, Db>,
) -> CmdResult<ReviewDraft> {
    Ok(review_drafts::update(&db, &id, &body, suggestion.as_deref()).await?)
}

/// Drop one draft the user doesn't want to send.
#[tauri::command]
#[specta::specta]
pub async fn delete_review_draft(id: String, db: State<'_, Db>) -> CmdResult<()> {
    Ok(review_drafts::delete(&db, &id).await?)
}

/// Drop every draft on a PR — "I've read these and none are worth sending", which
/// is a real outcome of an AI review.
#[tauri::command]
#[specta::specta]
pub async fn clear_review_drafts(
    pr_repo: String,
    number: u32,
    db: State<'_, Db>,
) -> CmdResult<u32> {
    Ok(review_drafts::clear(&db, &pr_repo, number).await?)
}

/// Send the named drafts to GitHub as comments in the user's pending review,
/// deleting each one that lands. **This is the user acting** — the only step in the
/// whole AI-review flow that leaves the machine, and it happens on a click.
///
/// Takes only the PR: the commit the comments anchor to and the review they join
/// are read from GitHub inside, so neither can be handed in. Reports how many
/// actually went — it stops at the first failure, and whatever didn't go is still a
/// draft (see [`review_drafts::publish`]).
#[tauri::command]
#[specta::specta]
pub async fn publish_review_drafts(
    pr_repo: String,
    number: u32,
    ids: Vec<String>,
    db: State<'_, Db>,
) -> CmdResult<ReviewPublishOutcome> {
    Ok(review_drafts::publish(&db, &pr_repo, number, &ids).await?)
}

/// The merge queue for the active `repo`'s default branch — the ordered list of
/// PRs waiting to merge, so the user can see where their own PRs sit. `None` when
/// `gh` isn't authenticated or the repo has no merge queue enabled.
#[tauri::command]
#[specta::specta]
pub async fn merge_queue(repo: String, db: State<'_, Db>) -> CmdResult<Option<MergeQueue>> {
    Ok(reviews::merge_queue(&db, &repo).await?)
}

/// Full detail for one PR — body, conversation (comments + reviews + inline
/// threads), and changed files with diffs. Empty when `gh` isn't authenticated.
#[tauri::command]
#[specta::specta]
pub async fn pr_detail(owner: String, name: String, number: u32) -> CmdResult<PrDetail> {
    validate_pr_identity(&owner, &name, number)?;
    Ok(reviews::detail(&owner, &name, number).await?)
}

/// The inbox's summary row for one PR by number — title, state, checks rollup,
/// review decision — which is what the Trees right panel renders for a worktree's
/// own pull request. `None` when `gh` isn't authenticated or the PR is gone.
///
/// Read-only: one GraphQL query, no writes and no filesystem. The pair with
/// [`pr_detail`] is deliberate — this is the cheap row, that is the full payload.
#[tauri::command]
#[specta::specta]
pub async fn pr_summary(
    owner: String,
    name: String,
    number: u32,
    db: State<'_, Db>,
) -> CmdResult<Option<ReviewPr>> {
    validate_pr_identity(&owner, &name, number)?;
    Ok(reviews::pull_request(&db, &owner, &name, number).await?)
}

/// Whether a string could be a repo-relative file path: not absolute, no `..`,
/// no empty or current-dir components. Deliberately lexical — it guards the
/// *shape* of a display anchor, and is not a substitute for `git.rs`'s
/// `safe_path` at any call that actually touches the filesystem.
fn is_repo_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        // A Windows drive prefix ("C:…") is absolute too, and `Path` on unix
        // would read it as a plain relative name.
        && !path.contains(':')
        && path
            .split(['/', '\\'])
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// The queue row's text for a failing check. Short and stable — the dedupe upsert
/// rewrites it on every re-add — because the actionable detail (failing steps,
/// annotations, the job log) is resolved live at fix time rather than frozen here,
/// where it would go stale the moment CI runs again.
fn check_work_item_body(check: &santree_core::domain::PrCheck) -> String {
    match check
        .description
        .as_deref()
        .map(str::trim)
        .filter(|app| !app.is_empty())
    {
        Some(app) => format!("Fix failing check: {} ({app})", check.name),
        None => format!("Fix failing check: {}", check.name),
    }
}

/// A PR identity arriving over IPC.
///
/// On these paths the three values only ever become GraphQL *variables* — never
/// interpolated into a query, never a path, never a git argv — so this is not the
/// guard that stops an injection. It is here so a malformed identity fails in
/// santree instead of costing a round-trip, and so the shape stays the one
/// `reviews::review_dir_name` will accept if the PR later becomes a review target.
fn validate_pr_identity(owner: &str, name: &str, number: u32) -> anyhow::Result<()> {
    if !repo::valid_github_component(owner) || !repo::valid_github_component(name) {
        anyhow::bail!("invalid repository identity: {owner:?}/{name:?}");
    }
    if number == 0 {
        anyhow::bail!("pull request number must be greater than zero");
    }
    Ok(())
}

/// The repo's full label palette — the options offered by the PR label picker.
/// Empty when `gh` isn't authenticated.
#[tauri::command]
#[specta::specta]
pub async fn pr_repo_labels(owner: String, name: String) -> CmdResult<Vec<PrLabel>> {
    validate_pr_identity(&owner, &name, 1)?;
    Ok(reviews::repo_labels(&owner, &name).await?)
}

/// Replace a PR's labels with exactly `labels` (GitHub PUT semantics — the set is
/// overwritten, so an empty list clears them), returning the resulting labels.
#[tauri::command]
#[specta::specta]
pub async fn set_pr_labels(
    owner: String,
    name: String,
    number: u32,
    labels: Vec<String>,
) -> CmdResult<Vec<PrLabel>> {
    validate_pr_identity(&owner, &name, number)?;
    Ok(reviews::set_pr_labels(&owner, &name, number, labels).await?)
}

/// Leave an inline review comment on a PR line — GitHub's `+` button on a diff
/// row. Posted immediately, or held in the viewer's pending review when
/// `pending` is set ("Start a review" / "Add to review").
///
/// Every write path here is the **user** acting. The AI review session cannot post
/// anything: it writes drafts into santree's own table through its MCP tools, and
/// the user publishes the ones they keep (`publish_review_drafts`). Comments,
/// approvals and change-requests go out under the user's name, so the user decides
/// what they say.
#[tauri::command]
#[specta::specta]
pub async fn add_pr_inline_comment(comment: NewInlineComment) -> CmdResult<()> {
    // The new review's id (when this opened one) matters only to a batch publish;
    // a single comment from the composer refetches the PR anyway.
    reviews::add_inline_comment(comment).await?;
    Ok(())
}

/// The signed-in GitHub user's login, for the review composer's header avatar.
/// `None` when `gh` isn't authenticated.
#[tauri::command]
#[specta::specta]
pub async fn github_viewer_login() -> CmdResult<Option<String>> {
    Ok(reviews::viewer_login().await?)
}

/// Reply under an existing inline review thread. `reply_to_id` is the thread's
/// [`PrThread::reply_to_id`] — GitHub threads replies off the root comment.
#[tauri::command]
#[specta::specta]
pub async fn reply_to_pr_thread(
    pr_repo: String,
    number: u32,
    reply_to_id: String,
    body: String,
) -> CmdResult<()> {
    Ok(reviews::reply_to_thread(&pr_repo, number, &reply_to_id, &body).await?)
}

/// Mark an inline review thread resolved, or reopen it.
#[tauri::command]
#[specta::specta]
pub async fn set_pr_thread_resolved(thread_id: String, resolved: bool) -> CmdResult<()> {
    Ok(reviews::set_thread_resolved(&thread_id, resolved).await?)
}

/// Submit the viewer's pending review — its draft comments become visible and the
/// verdict lands on the PR.
#[tauri::command]
#[specta::specta]
pub async fn submit_pr_review(
    review_id: String,
    event: ReviewEvent,
    body: String,
) -> CmdResult<()> {
    Ok(reviews::submit_review(&review_id, event, &body).await?)
}

/// Discard the viewer's pending review and every draft comment in it.
#[tauri::command]
#[specta::specta]
pub async fn discard_pr_review(review_id: String) -> CmdResult<()> {
    Ok(reviews::discard_review(&review_id).await?)
}

/// Post a top-level comment on a PR's conversation (not anchored to a diff line).
#[tauri::command]
#[specta::specta]
pub async fn add_pr_comment(pr_repo: String, number: u32, body: String) -> CmdResult<()> {
    Ok(reviews::add_conversation_comment(&pr_repo, number, &body).await?)
}

/// The raw job log for a failed GitHub Actions check, fetched on demand when the
/// user expands the check — sliced to the failing step and classified so the UI
/// can tint errors/warnings and collapse the quiet runs between them. `job_id`
/// comes from [`PrCheck::job_id`]; empty when `gh` isn't authenticated.
///
/// `job_id` crosses the bridge as `f64` because that's what a JS number *is* —
/// specta has no 64-bit integer that TypeScript can represent losslessly. GitHub job
/// ids are far below 2^53, so the cast back is exact; anything that isn't a
/// non-negative whole number never came from a real `PrCheck` and is rejected rather
/// than silently truncated by `as`.
#[tauri::command]
#[specta::specta]
pub async fn pr_check_log(owner: String, name: String, job_id: f64) -> CmdResult<CheckLog> {
    if !job_id.is_finite() || job_id < 0.0 || job_id.fract() != 0.0 {
        return Err(anyhow::anyhow!("invalid job id {job_id}").into());
    }
    validate_pr_identity(&owner, &name, 1)?;
    Ok(reviews::check_log(&owner, &name, job_id as u64).await?)
}

/// The old (base) + new (head) full contents of one PR file, fetched on demand so
/// the diff can expand unchanged context beyond the patch hunks (GitHub-style).
/// `base`/`head` are the commit OIDs from [`PrDetail`]. Empty when GitHub isn't
/// connected or the file doesn't exist on that side (added/deleted).
#[tauri::command]
#[specta::specta]
pub async fn pr_file_source(
    owner: String,
    name: String,
    base: String,
    head: String,
    old_path: String,
    new_path: String,
) -> CmdResult<FileSource> {
    validate_pr_identity(&owner, &name, 1)?;
    Ok(reviews::file_source(&owner, &name, &base, &head, &old_path, &new_path).await?)
}

/// The files a user has marked "Viewed" for a PR, tagged with which store they came
/// from — this machine's table (marks carry the blob SHA they were made at, and go
/// stale when the file changes) or GitHub's own per-viewer state (paths only, since
/// GitHub resolves staleness itself). The `reviews_sync_viewed` setting picks.
#[tauri::command]
#[specta::specta]
pub async fn reviewed_files(
    pr_repo: String,
    pr_number: u32,
    db: State<'_, Db>,
) -> CmdResult<ViewedMarks> {
    Ok(reviewed::marks(&db, &pr_repo, pr_number).await?)
}

/// Mark a PR file reviewed or clear the mark, in whichever store is live. `sha` is
/// used by the local store (it's what makes the mark expire when the file changes);
/// `pr_id` — the PR's GraphQL node id — by the synced one.
#[tauri::command]
#[specta::specta]
pub async fn set_file_reviewed(
    pr_repo: String,
    pr_number: u32,
    pr_id: String,
    path: String,
    sha: String,
    reviewed: bool,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(reviewed::set_mark(&db, &pr_repo, pr_number, &pr_id, &path, &sha, reviewed).await?)
}

/// Push the worktree branch and open a pull request via the GitHub API (optionally
/// as a draft, requesting `reviewers` by login). Returns the new PR's number and
/// URL (the frontend opens it in the browser).
#[tauri::command]
#[specta::specta]
pub async fn create_pull_request(
    repo: String,
    issue_id: String,
    title: String,
    body: String,
    draft: bool,
    reviewers: Vec<String>,
    db: State<'_, Db>,
) -> CmdResult<NewPr> {
    Ok(pr::create(&db, &repo, &issue_id, &title, &body, draft, &reviewers).await?)
}

/// Candidate reviewers (repo collaborators) for the create-PR dialog's picker.
/// Empty when GitHub isn't connected.
#[tauri::command]
#[specta::specta]
pub async fn pr_reviewers(
    repo: String,
    issue_id: String,
    db: State<'_, Db>,
) -> CmdResult<Vec<Reviewer>> {
    Ok(pr::reviewers(&db, &repo, &issue_id).await?)
}

/// The repo's `.santree/init.sh` setup script (for the Settings editor).
#[tauri::command]
#[specta::specta]
pub async fn worktree_init_script(repo: String, db: State<'_, Db>) -> CmdResult<ScriptInfo> {
    Ok(worktree::init_script(&db, &repo).await?)
}

/// Write the repo's `.santree/init.sh` setup script.
#[tauri::command]
#[specta::specta]
pub async fn set_worktree_init_script(
    repo: String,
    content: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(worktree::set_init_script(&db, &repo, &content).await?)
}

/// Mark `.santree/init.sh` executable so it runs on worktree creation.
#[tauri::command]
#[specta::specta]
pub async fn make_init_script_executable(repo: String, db: State<'_, Db>) -> CmdResult<()> {
    Ok(worktree::make_init_executable(&db, &repo).await?)
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

/// Open a path in the chosen app (by opener key). Launching shells out and waits
/// on the child, so it runs on the blocking pool rather than the UI thread.
#[tauri::command]
#[specta::specta]
pub async fn open_in_app(path: String, opener: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || openers::open(&path, &opener)).await??;
    Ok(())
}

/// Tickets awaiting triage — live from Linear when connected, else empty.
#[tauri::command]
#[specta::specta]
pub async fn list_triage_tickets(repo: String, db: State<'_, Db>) -> CmdResult<Vec<TriageTicket>> {
    Ok(linear::triage_tickets(&db, &repo)
        .await?
        .unwrap_or_default())
}

/// The full triage issue (description + comments) for the discussion pane.
///
/// `null` means there is no ticket to show — no Linear org is connected, or Linear
/// answered that this id names no issue (a worktree cut from a plain branch carries a
/// branch slug where a ticket id would be). That is a state the UI renders, not a
/// failure: it hides the Issue pane rather than raising a toast. Anything Linear
/// *couldn't* answer — an expired token, a rate limit, a dead network — still errors.
#[tauri::command]
#[specta::specta]
pub async fn triage_detail(
    repo: String,
    ticket_id: String,
    db: State<'_, Db>,
) -> CmdResult<Option<TriageDetail>> {
    Ok(linear::triage_detail(&db, &repo, &ticket_id).await?)
}

/// The team triage rotations (who is on-call now), from Linear's responsibility
/// schedules — one per team the viewer is on. Empty when none are configured.
#[tauri::command]
#[specta::specta]
pub async fn triage_schedule(repo: String, db: State<'_, Db>) -> CmdResult<Vec<TriageSchedule>> {
    Ok(linear::triage_schedule(&db, &repo)
        .await?
        .unwrap_or_default())
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
) -> CmdResult<()> {
    linear::set_issue_state(&db, &repo, &ticket_id, &state_id)
        .await?
        .ok_or("no Linear org connected")?;
    Ok(())
}

/// Update a triage issue's canonical Linear manual rank. The sink verifies the
/// issue still belongs to this repo's triage scope before sending the mutation.
#[tauri::command]
#[specta::specta]
pub async fn triage_set_sort_order(
    repo: String,
    ticket_id: String,
    sort_order: f64,
    db: State<'_, Db>,
) -> CmdResult<()> {
    linear::set_issue_sort_order(&db, &repo, &ticket_id, sort_order)
        .await?
        .ok_or("no Linear org connected")?;
    Ok(())
}

/// Post a comment on an issue — a top-level comment, or a reply when `parent_id`
/// is the id of the comment being replied to. `ticket_id`/`parent_id` are used
/// only as GraphQL variables (never as a path or git arg). Requires a
/// write-scoped Linear org.
#[tauri::command]
#[specta::specta]
pub async fn triage_add_comment(
    repo: String,
    ticket_id: String,
    parent_id: Option<String>,
    body: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    let body = body.trim();
    if body.is_empty() {
        return Err("comment body is empty".into());
    }
    linear::create_comment(&db, &repo, &ticket_id, parent_id.as_deref(), body)
        .await?
        .ok_or("no Linear org connected")?;
    Ok(())
}

/// Exit the app. Called from the quit-confirmation dialog once the user confirms a
/// ⌘Q / menu quit. By the time this runs the quit is already confirmed, so the
/// run-loop's `ExitRequested` handler doesn't gate on anything — it just reaps the
/// terminal children (see `run` in lib.rs).
#[tauri::command]
#[specta::specta]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// The keep-awake hold's current state. `supported` is false off-macOS — the
/// chrome uses it to not render the toggle at all.
#[tauri::command]
#[specta::specta]
pub fn keep_awake_status(awake: State<'_, KeepAwake>) -> KeepAwakeStatus {
    awake.status()
}

/// Toggle the keep-awake hold (macOS `caffeinate` tied to our pid) and remember
/// it, so the hold survives a relaunch and stays on until it is turned off.
/// Returns the *resulting* state, not the requested one — the spawn can fail,
/// and unsupported platforms always stay off.
#[tauri::command]
#[specta::specta]
pub async fn set_keep_awake(
    on: bool,
    awake: State<'_, KeepAwake>,
    db: State<'_, Db>,
) -> CmdResult<KeepAwakeStatus> {
    Ok(awake::set(&db, &awake, on).await?)
}

/// User settings, persisted in the database (seeded from defaults on first run).
/// Each agent's `exec` is the user's *override* (empty by default); the executable
/// detected on PATH is reported separately via [`agent_auth`] and shown as the
/// grayed default.
#[tauri::command]
#[specta::specta]
pub async fn get_settings(db: State<'_, Db>) -> CmdResult<Settings> {
    Ok(settings::get_settings(&db).await?)
}

/// Persist the full settings blob. The frontend applies edits optimistically and
/// calls this to make them durable across restarts.
#[tauri::command]
#[specta::specta]
pub async fn set_settings(settings: Settings, db: State<'_, Db>) -> CmdResult<()> {
    Ok(settings::set_settings(&db, &settings).await?)
}

/// An agent harness's authentication / subscription status. Live for Claude
/// (read from `~/.claude.json`), placeholders for the work-in-progress harnesses.
#[tauri::command]
#[specta::specta]
pub async fn agent_auth(kind: AgentKind) -> AgentAuth {
    // Reads `~/.claude.json` and spawns a login shell (binary discovery), so keep
    // it off the UI thread.
    // A panicked detection task degrades to "not connected" rather than crashing
    // the command future.
    tokio::task::spawn_blocking(move || settings::agent_auth(kind))
        .await
        .unwrap_or_default()
}

/// Installed and latest published CLI versions for one provider. Registry
/// failures are represented as an absent latest version, not a failed Settings
/// screen or a misleading update prompt.
#[tauri::command]
#[specta::specta]
pub async fn agent_version_status(
    kind: AgentKind,
    db: State<'_, Db>,
) -> CmdResult<AgentVersionStatus> {
    Ok(crate::provider::version_status(&db, kind).await)
}

/// The `gh` CLI integration status for Settings → Integrations: installed?
/// authenticated? as which account? Infallible — a missing or signed-out `gh`
/// is reported via the status flags rather than as an error, since GitHub can't
/// be turned off and the view always renders.
#[tauri::command]
#[specta::specta]
pub async fn github_status() -> GithubStatus {
    crate::github::status().await
}

/// What is left of the GitHub API budget the `gh` session spends, straight from
/// GitHub's own `/rate_limit`. `None` when nothing is signed in — a budget we
/// can't read is not a budget of zero.
#[tauri::command]
#[specta::specta]
pub async fn github_api_budget() -> Option<GithubApiBudget> {
    crate::github::api_budget().await
}

/// What is left of each connected Linear workspace's hourly budget. Empty until
/// santree has made at least one call for that org — Linear reports the budget
/// only in a response, never on request (see `linear::api_budget`).
#[tauri::command]
#[specta::specta]
pub async fn linear_api_budget(db: State<'_, Db>) -> CmdResult<Vec<LinearApiBudget>> {
    Ok(linear::api_budget(&db).await?)
}

/// Where santree resolves `name` to, plus any user-set override and the binary's
/// own `--version`. Drives the "not found" panels and the manual-path field.
#[tauri::command]
#[specta::specta]
pub async fn binary_status(name: String) -> CmdResult<BinaryStatus> {
    // Discovery may spawn a login shell (and now a second, interactive one on a
    // miss), so keep it off the async runtime like the other probes do.
    Ok(
        tokio::task::spawn_blocking(move || settings::binary_status(&name))
            .await
            .map_err(anyhow::Error::from)?,
    )
}

/// Set (or clear, with `None`) the path santree uses for `name`. Validated before
/// it's stored — this value is later executed.
#[tauri::command]
#[specta::specta]
pub async fn set_binary_path(
    db: State<'_, Db>,
    name: String,
    path: Option<String>,
) -> CmdResult<BinaryStatus> {
    Ok(settings::set_binary_path(&db, &name, path).await?)
}

/// Path to the settings file santree passes as `claude --settings <path>`,
/// carrying the session-state hooks and santree's own `statusLine` (which prints
/// the context-fill bar and captures live usage into the db). Both are always
/// present — capture is unconditional; whether the app *displays* the inline
/// usage bar is a runtime frontend decision. `None` when the hook binary/db can't
/// be resolved — the frontend then launches without the flag. Its content depends
/// only on the English-tutor setting, so the frontend caches the path until that
/// one flips.
#[tauri::command]
#[specta::specta]
pub async fn claude_hook_settings(app: AppHandle) -> Option<String> {
    let tutor = tutor_instruction(&app).await;
    // Writes a settings JSON file. A non-async command runs on the *main thread*,
    // where a slow disk stalls the whole UI — everything else in this file that
    // touches the filesystem goes through spawn_blocking for exactly this reason.
    tokio::task::spawn_blocking(move || crate::hooks::claude_settings(&app, tutor.as_deref()))
        .await
        .ok()
        .flatten()
}

/// The `-c 'hooks.<Event>=[…]'` flags a santree `codex` launch carries, so the
/// bundled hook reports the thread id Codex mints and the state it moves
/// through. `None` when the hook binary or db don't resolve, in which case the
/// launch simply carries no hooks. **Must be paired with
/// `--dangerously-bypass-hook-trust`** — see `hooks::codex_hook_flags`.
#[tauri::command]
#[specta::specta]
pub async fn codex_hook_flags(app: AppHandle) -> Option<String> {
    // Resolves a resource path and the data dir; off the main thread for the
    // same reason `claude_hook_settings` is.
    tokio::task::spawn_blocking(move || crate::hooks::codex_hook_flags(&app))
        .await
        .ok()
        .flatten()
}

/// The English-tutor instruction to inject into a launch, or `None` when the tutor
/// is off. Resolved from the `AppHandle`'s db rather than a `State<'_, Db>` arg so
/// the three `claude_hook_settings*` commands keep returning a bare `Option<String>`
/// (a borrowed-state arg would force them all to `Result`, for a read whose only
/// failure mode is "no tutor").
///
/// A failure here is logged and treated as off: a session that launches without the
/// tutor is a missing nicety, one that fails to launch is a broken app.
async fn tutor_instruction(app: &AppHandle) -> Option<String> {
    let db = app.try_state::<Db>()?.inner().clone();
    english_tutor::instruction(&db)
        .await
        .inspect_err(|e| log::warn!("english tutor: rendering the instruction failed: {e}"))
        .ok()
        .flatten()
}

/// Like [`claude_hook_settings`] but with a `permissions.deny` block forbidding
/// git commit/push — the `--settings` file the "Fix CI" session launches with, so
/// the AI fixes + validates but never commits or pushes (the user does that from
/// Trees). `None` when the hook binary/db can't be resolved.
#[tauri::command]
#[specta::specta]
pub async fn claude_hook_settings_no_git(app: AppHandle) -> Option<String> {
    let tutor = tutor_instruction(&app).await;
    tokio::task::spawn_blocking(move || {
        crate::hooks::claude_settings_no_git(&app, tutor.as_deref())
    })
    .await
    .ok()
    .flatten()
}

/// The English tutor's practice log, read-only. Creates the file when it's missing,
/// so a fresh install shows an empty log rather than an error.
#[tauri::command]
#[specta::specta]
pub async fn english_log() -> CmdResult<EnglishLog> {
    Ok(tokio::task::spawn_blocking(english_tutor::read_log)
        .await
        .map_err(anyhow::Error::from)??)
}

/// The stored analysis of the practice log, or `None` if it's never been run.
#[tauri::command]
#[specta::specta]
pub async fn english_analysis(db: State<'_, Db>) -> CmdResult<Option<EnglishAnalysis>> {
    Ok(english_tutor::stored(&db).await?)
}

/// Analyze `scope` of the practice log and store the result, replacing any
/// previous one. Explicit and user-triggered — this is a paid model call, never
/// automatic.
#[tauri::command]
#[specta::specta]
pub async fn run_english_analysis(
    db: State<'_, Db>,
    scope: AnalysisScope,
) -> CmdResult<EnglishAnalysis> {
    Ok(english_tutor::analyze(&db, scope).await?)
}

/// Every santree-launched session's live token/context usage, captured from the
/// status-line stdin. Newest first.
#[tauri::command]
#[specta::specta]
pub async fn session_usage_live(db: State<'_, Db>) -> CmdResult<Vec<SessionUsageLive>> {
    Ok(crate::hooks::session_usage_live(&db).await?)
}

/// Claude's account-level subscription rate-limit windows (5-hour, 7-day, ...),
/// as its own status line last reported them — captured from the same stdin as
/// [`session_usage_live`], never from a credential. Empty until a subscriber
/// session has rendered a status line after its first API response. Display-only.
#[tauri::command]
#[specta::specta]
pub async fn claude_rate_limits(db: State<'_, Db>) -> CmdResult<Vec<ClaudeRateLimitWindow>> {
    Ok(crate::hooks::claude_rate_limits(&db).await?)
}

/// Ask Anthropic for the account's current subscription usage and record it.
///
/// The one command that reads Claude Code's own OAuth token — a deliberate,
/// documented exception (COMPLIANCE.md, "Claude subscription usage"):
/// read-only, sent to Anthropic's own endpoint and nowhere else, never logged
/// or stored, and what comes back only ever drives a meter. Input-free.
#[tauri::command]
#[specta::specta]
pub async fn claude_fetch_usage(
    app: AppHandle,
    db: State<'_, Db>,
) -> CmdResult<santree_core::domain::ClaudeUsageFetch> {
    let fetched = crate::claude_usage::fetch(&db).await?;
    // The same event the status-line capture raises, so every usage reader
    // refreshes from one signal however the numbers arrived.
    let _ = crate::session_signal::ClaudeRateLimitsChanged {}.emit(&app);
    Ok(fetched)
}

/// Whether the opt-in global status-line passthrough is on — read from the
/// user's own `~/.claude/settings.json`. Input-free: the path comes from the
/// environment, never from IPC.
#[tauri::command]
#[specta::specta]
pub async fn claude_global_capture_status() -> CmdResult<ClaudeGlobalCapture> {
    Ok(crate::global_capture::status()?)
}

/// Turn the global status-line passthrough on or off. The one IPC input is the
/// bool; the hook and db paths are the app's own, and the user's original
/// status-line command only ever moves between their settings file and the
/// wrapper written into that same file (see `global_capture.rs`).
#[tauri::command]
#[specta::specta]
pub async fn set_claude_global_capture(
    app: AppHandle,
    enabled: bool,
) -> CmdResult<ClaudeGlobalCapture> {
    Ok(crate::global_capture::set(&app, enabled)?)
}

/// CPU and memory of every process santree's terminals own, plus the app itself,
/// grouped repo → worktree → terminal from one host `ps` snapshot. Read-only and
/// input-free: no IPC value reaches a path, a pid or an argv.
#[tauri::command]
#[specta::specta]
pub async fn resource_usage(
    db: State<'_, Db>,
    manager: State<'_, santree_pty::PtyManager>,
) -> CmdResult<ResourceUsage> {
    Ok(crate::resources::resource_usage(&db, &manager).await?)
}

/// Which coding agent is running in each terminal pane right now, observed in
/// the host process table instead of remembered from the launch.
///
/// Identity only — the attention ladder is untouched by this (see
/// `agent_procs`). Read-only and input-free: no IPC value reaches the `ps` argv,
/// and a process table that cannot be read yields an empty list ("we don't
/// know") rather than an error, because a `ps` that is slow or killed must never
/// take a render down with it.
#[tauri::command]
#[specta::specta]
pub async fn agent_processes(
    manager: State<'_, santree_pty::PtyManager>,
) -> CmdResult<Vec<AgentProcess>> {
    Ok(crate::agent_procs::detect(&crate::terminal::pane_roots(&manager)).await)
}

/// The current state of every agent session santree has launched, as recorded
/// live by the injected hooks. Most-recently-updated first.
///
/// The PTY manager is read here, not in `hooks.rs`, so that module stays a pure
/// db + transcript reader: what it needs is the *set of terminals that are alive*,
/// and this is the one place that knows it. A session whose terminal is gone
/// cannot be running — see `hooks::session_states`.
#[tauri::command]
#[specta::specta]
pub async fn session_states(
    db: State<'_, Db>,
    manager: State<'_, PtyManager>,
) -> CmdResult<Vec<SessionState>> {
    Ok(crate::hooks::session_states(&db, crate::terminal::live_terminals(&manager)).await?)
}

/// The user's local note for a task — extra context stored only on this machine
/// (never synced to Linear). `None` when the task has no note.
#[tauri::command]
#[specta::specta]
pub async fn task_note(
    repo: String,
    task_id: String,
    db: State<'_, Db>,
) -> CmdResult<Option<String>> {
    Ok(notes::get(&db, &repo, &task_id).await?)
}

/// Save (or clear, when blank) the user's local note for a task.
#[tauri::command]
#[specta::specta]
pub async fn set_task_note(
    repo: String,
    task_id: String,
    body: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(notes::set(&db, &repo, &task_id, &body).await?)
}

// ── App/per-repo settings + Claude command discovery ───────────────────────

/// The current Claude models to suggest in the model pickers — derived live from
/// the fetched LiteLLM catalog (cached in SQLite, daily refresh, static fallback),
/// so it tracks Anthropic's releases instead of a hardcoded/stale list and includes
/// the latest of each family (Opus/Sonnet/Haiku/Fable). See
/// [`pricing::claude_models`].
#[tauri::command]
#[specta::specta]
pub async fn claude_models(db: State<'_, Db>) -> CmdResult<Vec<String>> {
    Ok(pricing::claude_models(&db).await)
}

/// The variable names a user-referenced `.env` file defines, for the Environment
/// settings' "N variables loaded" readout. Empty when the file is unreadable.
///
/// `path` is an arbitrary string from the webview, not a fact — trusting it made
/// this a "does this file exist, and what keys does it define?" oracle for *any*
/// path on the machine (`~/.aws/credentials`, `.ssh/config`, …). Its real domain
/// is the files the user added to Settings → Environment, which santree already
/// parses on every spawn, so that list is the allowlist: anything else reads as
/// empty. (`env::parse_env_file` separately refuses non-regular files, so neither
/// this nor a spawn can be parked on a fifo.)
/// Takes the pool off the `AppHandle` rather than as a `State<'_, Db>` argument:
/// an async command that borrows state must return a `Result`, and this one's
/// contract (a plain `string[]`, empty when there's nothing to show) is worth
/// keeping — an unreadable env file isn't an error the UI should toast.
#[tauri::command]
#[specta::specta]
pub async fn env_file_vars(path: String, app: AppHandle) -> Vec<String> {
    use tauri::Manager;

    let db = app.state::<Db>().inner().clone();
    if !crate::env::is_registered_env_file(&db, &path).await {
        log::warn!("refusing to read {path}: not a file added to Settings → Environment");
        return Vec::new();
    }
    tokio::task::spawn_blocking(move || crate::env::env_file_var_names(&path))
        .await
        .unwrap_or_default()
}

/// Read a setting for an exact scope (`"app"` or `"repo:<name>"`).
#[tauri::command]
#[specta::specta]
pub async fn get_setting(
    scope: String,
    key: String,
    db: State<'_, Db>,
) -> CmdResult<Option<String>> {
    settings::validate_user_scope(&scope, &key)?;
    Ok(settings::get(&db, &scope, &key).await?)
}

/// Write (or clear, when `value` is null) a setting for a scope.
#[tauri::command]
#[specta::specta]
pub async fn set_setting(
    scope: String,
    key: String,
    value: Option<String>,
    db: State<'_, Db>,
) -> CmdResult<()> {
    settings::validate_user_scope(&scope, &key)?;
    Ok(settings::set(&db, &scope, &key, value).await?)
}

/// Resolve a repo-scoped setting: the repo's override, else the app value.
#[tauri::command]
#[specta::specta]
pub async fn resolve_setting(
    repo: String,
    key: String,
    db: State<'_, Db>,
) -> CmdResult<Option<String>> {
    Ok(settings::resolve(&db, &repo, &key).await?)
}

// ── Editable AI prompts ──────────────────────────────────────────────────────

/// Every editable AI prompt with its default, the override stored at `scope`
/// (`"app"` / `"repo:<name>"`), and its variable/include catalog — for the
/// Settings → Prompts editor.
#[tauri::command]
#[specta::specta]
pub async fn list_prompts(scope: String, db: State<'_, Db>) -> CmdResult<Vec<PromptInfo>> {
    Ok(crate::prompts::list(&db, &scope).await?)
}

/// Store (or clear, when `content` is null) a prompt's override for `scope`.
/// Rejects a non-empty override that doesn't compile, so a broken template can
/// never be persisted or reach a real flow.
#[tauri::command]
#[specta::specta]
pub async fn set_prompt(
    scope: String,
    name: String,
    content: Option<String>,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(crate::prompts::set_prompt(&db, &scope, &name, content).await?)
}

/// Render a *draft* prompt for the live editor preview. With a `detail` (the issue
/// the editor already holds in cache) it renders against that real ticket;
/// otherwise a built-in sample. Rendering is pure — no fetch — so the editor can
/// re-render on every keystroke. Compile/render errors come back in
/// `PromptPreview.error`, not as a failure, so the editor can show them inline.
#[tauri::command]
#[specta::specta]
pub async fn preview_prompt(
    name: String,
    content: String,
    repo: Option<String>,
    detail: Option<TriageDetail>,
    db: State<'_, Db>,
) -> CmdResult<PromptPreview> {
    Ok(crate::prompts::preview(&db, &name, &content, repo.as_deref(), detail).await?)
}

/// Create a user-defined shared block (a reusable partial any prompt can
/// `{% include %}`). Validates the name and seeds a starter body.
#[tauri::command]
#[specta::specta]
pub async fn create_prompt_block(name: String, label: String, db: State<'_, Db>) -> CmdResult<()> {
    Ok(crate::prompts::create_block(&db, &name, &label).await?)
}

/// Delete a user-defined shared block, clearing its content across every scope.
#[tauri::command]
#[specta::specta]
pub async fn delete_prompt_block(name: String, db: State<'_, Db>) -> CmdResult<()> {
    Ok(crate::prompts::delete_block(&db, &name).await?)
}

// ── santree CLI adoption ─────────────────────────────────────────────────

/// santree-CLI configuration detected in a registered repo that the app could
/// adopt — `None` when there's nothing actionable. Detection only; tokens stay
/// on the Rust side.
#[tauri::command]
#[specta::specta]
pub async fn legacy_cli_probe(
    repo: String,
    db: State<'_, Db>,
) -> CmdResult<Option<LegacyCliMigration>> {
    Ok(legacy::probe(&db, &repo).await?)
}

/// Import the santree CLI's Linear credential for a repo's workspace (into the
/// OS keychain, via a validating token refresh) and link the repo to it.
#[tauri::command]
#[specta::specta]
pub async fn legacy_cli_migrate(repo: String, db: State<'_, Db>) -> CmdResult<LinearOrg> {
    Ok(legacy::migrate(&db, &repo).await?)
}

// ── Linear integration ───────────────────────────────────────────────────

/// Connection status for a repo: whether any org is connected, and which one it uses.
#[tauri::command]
#[specta::specta]
pub async fn linear_auth_status(repo: String, db: State<'_, Db>) -> CmdResult<LinearStatus> {
    Ok(linear::auth_status(&db, &repo).await?)
}

/// Every connected Linear organization.
#[tauri::command]
#[specta::specta]
pub async fn linear_orgs(db: State<'_, Db>) -> CmdResult<Vec<LinearOrg>> {
    Ok(linear::list_orgs(&db).await?)
}

/// Bind (or clear) the Linear org a repo uses.
#[tauri::command]
#[specta::specta]
pub async fn set_repo_linear_org(
    repo: String,
    slug: Option<String>,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(linear::set_repo_org(&db, &repo, slug).await?)
}

/// The repo's assigned Linear issues as a positioned dependency graph — live when
/// an org is connected, else empty.
#[tauri::command]
#[specta::specta]
pub async fn linear_list_issues(repo: String, db: State<'_, Db>) -> CmdResult<Vec<Task>> {
    match linear::list_issues(&db, &repo).await {
        Ok(Some(tasks)) => Ok(tasks),
        Ok(None) => Ok(vec![]),
        Err(e) => {
            log::warn!("Linear issue fetch failed for {repo}: {e}");
            Err(e.into())
        }
    }
}

/// Forget every Linear read cache, so the refetch the frontend issues right
/// after (⌘⇧R) actually reaches Linear instead of the 15s org cache.
#[tauri::command]
#[specta::specta]
pub fn linear_invalidate_caches() {
    linear::invalidate_all_caches();
}

/// Run the Linear OAuth flow; returns the updated org list.
#[tauri::command]
#[specta::specta]
pub async fn linear_connect(db: State<'_, Db>) -> CmdResult<Vec<LinearOrg>> {
    Ok(linear::connect(&db).await?)
}

// ── Updates ──────────────────────────────────────────────────────────────────

/// Ask the configured release channel whether a newer version exists. `None`
/// means this install is current *for its channel* — on beta that includes the
/// case where a newer stable exists but hasn't overtaken the running beta yet.
#[tauri::command]
#[specta::specta]
pub async fn check_for_update(
    app: AppHandle,
    db: State<'_, Db>,
) -> CmdResult<Option<crate::update::UpdateInfo>> {
    Ok(crate::update::check(&app, &db).await?)
}

/// Download and install the update the last check found, then relaunch. Never
/// returns on success — the process is replaced.
#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> CmdResult<()> {
    Ok(crate::update::install(&app).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db(label: &str) -> (std::path::PathBuf, Db) {
        let base =
            std::env::temp_dir().join(format!("santree-commands-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        (base, db)
    }

    async fn register_repo(db: &Db, name: &str, path: &std::path::Path, origin: &str) {
        let status = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(path)
            .status()
            .unwrap();
        assert!(status.success());
        let status = std::process::Command::new("git")
            .args(["remote", "add", "origin", origin])
            .current_dir(path)
            .status()
            .unwrap();
        assert!(status.success());
        sqlx::query("INSERT INTO repos (name, path) VALUES (?, ?)")
            .bind(name)
            .bind(path.to_str().unwrap())
            .execute(db)
            .await
            .unwrap();
    }

    /// `resume_worktree_session` builds a terminal key out of the tab id, so the
    /// id must not be able to *be* a key: a `:` would let a caller name
    /// `tree:AK-1:tab:x:tab:y` — or, with an empty id, the worktree's own main
    /// session — as the row to repoint at a session of their choosing.
    #[test]
    fn a_tab_id_cannot_smuggle_a_terminal_key_of_its_own() {
        assert!(validate_tab_id("0b9c4f2e-1a3d-4c5b-8e7f-0a1b2c3d4e5f").is_ok());
        assert!(validate_tab_id("fixci_2").is_ok());
        for bad in [
            "",
            "tab:other",
            "../../etc/passwd",
            "a/b",
            "id with spaces",
            "%_",
            "\u{1}",
            &"x".repeat(65),
        ] {
            assert!(validate_tab_id(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[tokio::test]
    async fn session_context_scopes_tabs_and_uses_persisted_provider() {
        let (base, db) = test_db("session-context").await;
        sqlx::query(
            "INSERT INTO worktree_tabs
             (id, repo, worktree_id, kind, agent_kind, title, position)
             VALUES ('shared', 'repo-a', 'AK-1', 'fixci', 'Codex', 'Fix', 0),
                    ('other', 'repo-b', 'AK-1', 'agent', 'Claude', 'Agent', 0)",
        )
        .execute(&db)
        .await
        .unwrap();

        let context = session_context(&db, "repo-a", "/repo/a", "tree:AK-1:tab:shared")
            .await
            .unwrap();
        assert_eq!(context.surface, SessionSurface::FixCi);
        assert_eq!(context.agent, Some(AgentKind::Codex));
        assert!(
            session_context(&db, "repo-b", "/repo/b", "tree:AK-1:tab:shared")
                .await
                .is_err()
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    /// The AI review tab is a *review* surface, and the PR it belongs to is what
    /// its review tools are scoped by.
    ///
    /// Both halves were wrong when `ai_review` was added as a tab kind and only
    /// `fixci` was matched here: the tab resolved the Work model and Work agent
    /// setting, and under Codex it would have launched unsandboxed with no tools
    /// at all — which looks exactly like a review that simply found nothing.
    #[tokio::test]
    async fn an_ai_review_tab_is_a_review_surface_scoped_to_its_pull_request() {
        let (base, db) = test_db("session-context-review").await;
        sqlx::query(
            "INSERT INTO worktree_tabs
             (id, repo, worktree_id, kind, agent_kind, title, pr_repo, pr_number, position)
             VALUES ('rev', 'repo-a', 'AK-1', 'ai_review', 'Codex', 'AI review', 'acme/web', 42, 0),
                    ('fix', 'repo-a', 'AK-1', 'fixci', 'Codex', 'Address', 'acme/web', 42, 1),
                    ('plain', 'repo-a', 'AK-1', 'agent', 'Codex', 'Agent', NULL, NULL, 2)",
        )
        .execute(&db)
        .await
        .unwrap();

        let review = session_context(&db, "repo-a", "/repo/a", "tree:AK-1:tab:rev")
            .await
            .unwrap();
        assert_eq!(review.surface, SessionSurface::Review);
        assert_eq!(
            review.review_pr,
            Some(("acme".into(), "web".into(), 42)),
            "a review's tools are scoped by the PR on its own row"
        );

        let fix = session_context(&db, "repo-a", "/repo/a", "tree:AK-1:tab:fix")
            .await
            .unwrap();
        assert_eq!(fix.surface, SessionSurface::FixCi);
        assert_eq!(fix.review_pr, Some(("acme".into(), "web".into(), 42)));

        // An ordinary agent tab has no review tools, and must not be given any.
        let plain = session_context(&db, "repo-a", "/repo/a", "tree:AK-1:tab:plain")
            .await
            .unwrap();
        assert_eq!(plain.surface, SessionSurface::Work);
        assert_eq!(plain.review_pr, None);

        std::fs::remove_dir_all(base).unwrap();
    }

    /// The other end of the same scoping: an `ai-review:` terminal names its PR
    /// in the key, and `validate_agent_cwd` is what checks that claim against the
    /// registered origin before it is used to find a config file.
    #[tokio::test]
    async fn a_review_terminal_key_scopes_the_tools_to_the_pr_it_names() {
        let (base, db) = test_db("session-context-key").await;

        let review = session_context(&db, "repo-a", "/repo/a", "ai-review:acme/web#42")
            .await
            .unwrap();
        assert_eq!(review.surface, SessionSurface::Review);
        assert_eq!(review.review_pr, Some(("acme".into(), "web".into(), 42)));

        // "Ask AI" is read-only and writes no drafts, so it gets no tools.
        let ask = session_context(&db, "repo-a", "/repo/a", "review:acme/web#42")
            .await
            .unwrap();
        assert_eq!(ask.surface, SessionSurface::AskAi);
        assert_eq!(ask.review_pr, None);

        // A malformed identity fails here rather than becoming a filename.
        assert!(
            session_context(&db, "repo-a", "/repo/a", "ai-review:acme/web/nested#42")
                .await
                .is_err()
        );

        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn review_cwd_rejects_a_symlinked_checkout() {
        let (base, db) = test_db("review-symlink").await;
        let repo = base.join("repo");
        let reviews = repo.join(".santree/reviews");
        let outside = base.join("outside");
        std::fs::create_dir_all(&reviews).unwrap();
        register_repo(
            &db,
            "registered",
            &repo,
            "https://github.com/acme/project.git",
        )
        .await;
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join(".git"), "gitdir: elsewhere").unwrap();
        std::os::unix::fs::symlink(
            &outside,
            reviews.join(crate::reviews::review_dir_name("acme", "project", 1).unwrap()),
        )
        .unwrap();
        let cwd = std::fs::canonicalize(&outside).unwrap();
        let repo_root = std::fs::canonicalize(&repo).unwrap();

        let result = validate_agent_cwd(
            &db,
            "registered",
            "review:acme/project#1",
            &cwd,
            &repo_root,
            repo.to_str().unwrap(),
        )
        .await;
        assert!(result.is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn review_cwd_rejects_a_delimiter_collision_with_the_registered_origin() {
        let (base, db) = test_db("review-origin-collision").await;
        let repo = base.join("repo");
        let checkout = repo
            .join(".santree/reviews")
            .join(crate::reviews::review_dir_name("a-b", "c", 7).unwrap());
        std::fs::create_dir_all(&checkout).unwrap();
        register_repo(&db, "registered", &repo, "https://github.com/a-b/c.git").await;
        std::fs::write(checkout.join(".git"), "gitdir: elsewhere").unwrap();
        let cwd = std::fs::canonicalize(&checkout).unwrap();
        let repo_root = std::fs::canonicalize(&repo).unwrap();

        assert_ne!(
            crate::reviews::review_dir_name("a-b", "c", 7).unwrap(),
            crate::reviews::review_dir_name("a", "b-c", 7).unwrap()
        );
        let result = validate_agent_cwd(
            &db,
            "registered",
            "ai-review:a/b-c#7",
            &cwd,
            &repo_root,
            repo.to_str().unwrap(),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "review terminal repository does not match the registered origin"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    /// The base entry has no `worktree_links` row by construction, so the row
    /// lookup can never accept it — the registered root has to be matched directly
    /// or every base tab launches a bare shell instead of its agent.
    #[tokio::test]
    async fn base_entry_cwd_must_be_the_registered_repository_root() {
        let (base, db) = test_db("base-entry-cwd").await;
        let repo = base.join("repo");
        let outside = base.join("outside");
        std::fs::create_dir(&repo).unwrap();
        std::fs::create_dir(&outside).unwrap();
        register_repo(
            &db,
            "registered",
            &repo,
            "https://github.com/acme/project.git",
        )
        .await;
        let repo_root = std::fs::canonicalize(&repo).unwrap();
        let key = format!("tree:{}:tab:abc", crate::worktree::BASE_ID);

        assert!(validate_agent_cwd(
            &db,
            "registered",
            &key,
            &repo_root,
            &repo_root,
            repo.to_str().unwrap(),
        )
        .await
        .is_ok());
        let result = validate_agent_cwd(
            &db,
            "registered",
            &key,
            &std::fs::canonicalize(&outside).unwrap(),
            &repo_root,
            repo.to_str().unwrap(),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "terminal cwd is not the repository root"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn review_identity_binds_provider_authority_to_one_pr() {
        assert_eq!(
            review_identity("ai-review:acme/project#42").unwrap(),
            ("acme", "project", 42)
        );
        assert!(review_identity("ai-review:acme/project/other#42").is_err());
        assert!(review_identity("ai-review:acme/project#not-a-number").is_err());
        assert!(review_identity("triage:AK-42").is_err());
    }

    #[test]
    fn pr_tree_creation_is_bound_to_the_registered_origin() {
        assert!(validate_pr_repo("Acme/Project", "acme", "project").is_ok());
        assert!(validate_pr_repo("acme/other", "acme", "project").is_err());
        assert!(validate_pr_repo("acme/project/extra", "acme", "project").is_err());
    }

    // ── Worktree origins ─────────────────────────────────────────────────────
    // One create command, one `WorktreeLaunch` per origin. Each case runs the
    // real thing — a real git repo, real SQLite — because what is being asserted
    // is the row that lands in `worktree_links`, not the match arm above it.

    fn run_git(dir: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// A registered repo with one commit on `main`, a GitHub-shaped `origin`
    /// (`acme/project` — what the PR guard matches against) and a
    /// `feature/pr-head` branch standing in for a pull request's head.
    ///
    /// Checking out an existing branch freshens it from `origin` first
    /// (`git::add_worktree_for_branch`), so both transports are pointed at
    /// nothing reachable: the fetch is best-effort and must fail in
    /// milliseconds here rather than dial github.com — or, worse, sit on a
    /// credential prompt — from a unit test.
    async fn repo_with_a_pr_branch(label: &str) -> (std::path::PathBuf, Db) {
        let (base, db) = test_db(label).await;
        let repo = base.join("repo");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init", "--quiet", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        run_git(&repo, &["config", "core.sshCommand", "false"]);
        run_git(&repo, &["config", "http.proxy", "http://127.0.0.1:1"]);
        run_git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/acme/project.git",
            ],
        );
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "--quiet", "-m", "init"]);
        run_git(&repo, &["branch", "feature/pr-head"]);
        sqlx::query("INSERT INTO repos (name, path) VALUES ('test', ?)")
            .bind(repo.to_str().unwrap())
            .execute(&db)
            .await
            .unwrap();
        (base, db)
    }

    async fn launch(
        db: &Db,
        issue_id: &str,
        title: &str,
        launch: WorktreeLaunch,
    ) -> anyhow::Result<Worktree> {
        create_from_launch(db, "test", issue_id, title, &launch, None, None).await
    }

    /// The ticket origin is the only one that names a project, and the only one
    /// whose branch santree derives rather than being told.
    #[tokio::test]
    async fn a_ticket_launch_derives_its_branch_and_files_the_tree_under_its_project() {
        let (base, db) = repo_with_a_pr_branch("launch-ticket").await;
        let wt = launch(
            &db,
            "AK-1",
            "Fix the login bug",
            WorktreeLaunch::Ticket {
                project: Some("Booking".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(wt.id, "AK-1");
        assert_eq!(wt.branch, "santree/ak-1-fix-the-login-bug");
        assert_eq!(wt.project.as_deref(), Some("Booking"));
        std::fs::remove_dir_all(base).unwrap();
    }

    /// A ticketless branch checkout has no project to record — and must not be
    /// given one.
    #[tokio::test]
    async fn an_existing_branch_launch_checks_that_branch_out_under_no_project() {
        let (base, db) = repo_with_a_pr_branch("launch-existing").await;
        let wt = launch(
            &db,
            "feature-pr-head",
            "feature/pr-head",
            WorktreeLaunch::ExistingBranch {
                branch: "feature/pr-head".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(wt.branch, "feature/pr-head");
        assert_eq!(wt.project, None);
        std::fs::remove_dir_all(base).unwrap();
    }

    /// A typed name is used verbatim — no `santree/` prefix, no slug — and still
    /// carries no project.
    #[tokio::test]
    async fn a_new_branch_launch_uses_exactly_the_typed_name_under_no_project() {
        let (base, db) = repo_with_a_pr_branch("launch-new").await;
        let wt = launch(
            &db,
            "feature-typed",
            "feature/typed",
            WorktreeLaunch::NewBranch {
                branch: "feature/typed".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(wt.branch, "feature/typed");
        assert_eq!(wt.project, None);
        assert_eq!(wt.base_branch, "main");
        std::fs::remove_dir_all(base).unwrap();
    }

    /// The bug this union was introduced to kill: the PR path used to hand
    /// `worktree::create` a literal `Some("Reviews")`, which the sidebar read
    /// straight back out of `worktree_links.project` and rendered as a Linear
    /// project band sitting beside the real ones. A pull request is an origin,
    /// not a project — so it stores none at all.
    #[tokio::test]
    async fn a_pr_launch_stores_no_project_at_all() {
        let (base, db) = repo_with_a_pr_branch("launch-pr").await;
        let wt = launch(
            &db,
            "review-4-acme-7-project-42",
            "Someone else's PR",
            WorktreeLaunch::Pr {
                pr_repo: "acme/project".into(),
                branch: "feature/pr-head".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(wt.branch, "feature/pr-head");
        assert_eq!(
            wt.project, None,
            "a PR tree must carry no project — a constant here renders as a Linear project band"
        );
        let stored: Option<String> = sqlx::query_scalar(
            "SELECT project FROM worktree_links WHERE issue_id = 'review-4-acme-7-project-42'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(stored, None, "and nothing was persisted for a later read");
        std::fs::remove_dir_all(base).unwrap();
    }

    /// The origin guard still runs from inside the union: a PR belonging to
    /// another repository must not be checked out into this one.
    #[tokio::test]
    async fn a_pr_launch_from_a_foreign_repo_is_refused_before_any_git_work() {
        let (base, db) = repo_with_a_pr_branch("launch-pr-foreign").await;
        let error = launch(
            &db,
            "review-4-acme-5-other-1",
            "Foreign PR",
            WorktreeLaunch::Pr {
                pr_repo: "acme/other".into(),
                branch: "feature/pr-head".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("does not match local repo"));
        assert!(
            !base.join("repo/.santree/worktrees").exists(),
            "refused before anything was created on disk"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pr_reads_reject_a_malformed_identity() {
        assert!(validate_pr_identity("acme", "project", 1).is_ok());
        assert!(validate_pr_identity("acme", "pro/ject", 1).is_err());
        assert!(validate_pr_identity("..", "project", 1).is_err());
        assert!(validate_pr_identity("acme", "", 1).is_err());
        assert!(validate_pr_identity("acme", "project", 0).is_err());
    }

    /// The anchor a queued diff selection carries is user-authored, so it is
    /// guarded on shape alone — but that guard has to actually exclude the shapes
    /// that aren't a repo-relative file.
    #[test]
    fn a_queued_anchor_must_look_like_a_repo_relative_file() {
        assert!(is_repo_relative_path("src/api.rs"));
        assert!(is_repo_relative_path("a/b/c/d.tsx"));
        assert!(!is_repo_relative_path(""));
        assert!(!is_repo_relative_path("/etc/passwd"));
        assert!(!is_repo_relative_path("../outside.rs"));
        assert!(!is_repo_relative_path("src/../../outside.rs"));
        assert!(!is_repo_relative_path("./src/api.rs"));
        assert!(!is_repo_relative_path("src//api.rs"));
        assert!(!is_repo_relative_path("C:\\windows\\system32"));
        assert!(!is_repo_relative_path("..\\outside.rs"));
    }

    #[test]
    fn check_work_item_body_names_the_check_and_its_app() {
        let check = |description: Option<&str>| santree_core::domain::PrCheck {
            name: "test (ubuntu-latest)".into(),
            status: santree_core::domain::CheckStatus::Failure,
            description: description.map(str::to_string),
            url: None,
            steps: vec![],
            annotations: vec![],
            job_id: None,
            run_id: None,
            started_at: None,
            completed_at: None,
        };
        assert_eq!(
            check_work_item_body(&check(None)),
            "Fix failing check: test (ubuntu-latest)"
        );
        assert_eq!(
            check_work_item_body(&check(Some("GitHub Actions"))),
            "Fix failing check: test (ubuntu-latest) (GitHub Actions)"
        );
        // A whitespace-only app name must not produce a dangling "()".
        assert_eq!(
            check_work_item_body(&check(Some("   "))),
            "Fix failing check: test (ubuntu-latest)"
        );
    }
}
