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
use tauri::{AppHandle, State};
use tauri_specta::Event;

use santree_core::{
    config,
    domain::{
        AgentAuth, AgentDef, AgentKind, AgentSession, ChangedFile, CheckLog, ClaudeCommandFile,
        ClaudeCommands, CommandSource, FileSource, GithubStatus, LinearOrg, LinearStatus,
        MergeQueue, NewPr, Opener, PrDetail, PrDraft, PrLabel, PromptInfo, PromptPreview, Repo,
        ReviewInbox, ReviewedFile, Reviewer, ScriptInfo, SessionState, SessionUsageLive, Settings,
        TabKind, Task, TriageDetail, TriageSchedule, TriageTicket, UsageReport, Worktree,
        WorktreePr, WorktreeTab,
    },
};

use crate::commit_draft;
use crate::db::Db;
use crate::error::CmdResult;
use crate::git_watch::WorktreeWatcher;
use crate::linear;
use crate::notes;
use crate::openers;
use crate::pr;
use crate::pricing;
use crate::repo;
use crate::reviewed;
use crate::reviews;
use crate::session;
use crate::settings;
use crate::tabs;
use crate::usage;
use crate::worktree;

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

/// Start a task: create a worktree for an issue (branching off `base`) and record
/// the issue ↔ worktree link. Running `.santree/init.sh` is a separate step —
/// see `run_worktree_setup_streamed` — so it isn't gated on this call.
#[tauri::command]
#[specta::specta]
pub async fn create_worktree(
    repo: String,
    issue_id: String,
    title: String,
    project: Option<String>,
    base: Option<String>,
    agent: AgentKind,
    db: State<'_, Db>,
) -> CmdResult<Worktree> {
    Ok(worktree::create(
        &db,
        &repo,
        &issue_id,
        &title,
        project.as_deref(),
        base.as_deref(),
        agent,
        None,
    )
    .await?)
}

/// Find-or-create a worktree for a pull request: reuse the one already tracked
/// under `issue_id` if present, else create one that **checks out the PR's head
/// branch** (`branch`) so commits made in it land on the PR. Used by the Reviews
/// "Fix CI with AI" flow. `base` is the PR's base branch (for the worktree's diff).
#[tauri::command]
#[specta::specta]
pub async fn create_worktree_for_pr(
    repo: String,
    issue_id: String,
    title: String,
    branch: String,
    base: Option<String>,
    agent: AgentKind,
    db: State<'_, Db>,
) -> CmdResult<Worktree> {
    Ok(worktree::create(
        &db,
        &repo,
        &issue_id,
        &title,
        None,
        base.as_deref(),
        agent,
        Some(&branch),
    )
    .await?)
}

/// Render the CI-fix opening prompt (the failing check `log` + guardrails) to a
/// per-worktree file and return its **path** — the "Fix CI" terminal seeds
/// `exec <agent> 'Read <path> …'` with it (the log is too large to type into the
/// PTY). Rewritten each launch so it reflects the latest failing run.
#[tauri::command]
#[specta::specta]
pub async fn fix_ci_prompt(
    app: AppHandle,
    repo: String,
    issue_id: String,
    log: String,
    db: State<'_, Db>,
) -> CmdResult<String> {
    let prompts = worktree::prompts_root(&app).ok_or("no writable data dir for prompt file")?;
    Ok(worktree::fix_ci_prompt(&db, &repo, &issue_id, &prompts, &log).await?)
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
    on_event: Channel<worktree::SetupEvent>,
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

/// Decide how a terminal that auto-launches `claude` should (re)launch it: resume
/// a still-on-disk session, start fresh with a reserved id, or a plain shell.
/// `term_key` is the logical terminal id (e.g. `tree:AK-1`, `triage:AK-1`); `cwd`
/// is where claude runs. `allow_fresh` mints a new session when none is resumable
/// (set on an explicit launch; false on a passive reopen).
#[tauri::command]
#[specta::specta]
pub async fn agent_session(
    repo: String,
    term_key: String,
    cwd: String,
    allow_fresh: bool,
    db: State<'_, Db>,
) -> CmdResult<AgentSession> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    Ok(session::resolve(&db, &repo, &term_key, &cwd, home.as_deref(), allow_fresh).await?)
}

/// Ticket ids of triage investigations that have a stored (resumable) session —
/// i.e. an investigation was started for them at some point. Drives the Triage
/// view's tab + resume affordance for past investigations (across app restarts).
#[tauri::command]
#[specta::specta]
pub async fn started_investigations(repo: String, db: State<'_, Db>) -> CmdResult<Vec<String>> {
    Ok(session::started_investigations(&db, &repo).await?)
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
#[tauri::command]
#[specta::specta]
pub async fn add_worktree_tab(
    repo: String,
    worktree_id: String,
    id: String,
    kind: TabKind,
    title: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(tabs::add(&db, &repo, &worktree_id, &id, kind, &title).await?)
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
/// raw template. Title defaults to the first commit's subject.
#[tauri::command]
#[specta::specta]
pub async fn pr_draft(
    repo: String,
    issue_id: String,
    fill: bool,
    db: State<'_, Db>,
) -> CmdResult<PrDraft> {
    Ok(pr::draft(&db, &repo, &issue_id, fill).await?)
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
    Ok(reviews::detail(&owner, &name, number).await?)
}

/// The repo's full label palette — the options offered by the PR label picker.
/// Empty when `gh` isn't authenticated.
#[tauri::command]
#[specta::specta]
pub async fn pr_repo_labels(owner: String, name: String) -> CmdResult<Vec<PrLabel>> {
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
    Ok(reviews::set_pr_labels(&owner, &name, number, labels).await?)
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
    path: String,
) -> CmdResult<FileSource> {
    Ok(reviews::file_source(&owner, &name, &base, &head, &path).await?)
}

/// The files a user has marked "Viewed" for a PR, each with the blob SHA it was
/// marked at. The frontend keeps a mark only while the file's current head SHA
/// still matches (a new commit changing the file drops the mark automatically).
#[tauri::command]
#[specta::specta]
pub async fn reviewed_files(
    pr_repo: String,
    pr_number: u32,
    db: State<'_, Db>,
) -> CmdResult<Vec<ReviewedFile>> {
    Ok(reviewed::list(&db, &pr_repo, pr_number).await?)
}

/// Mark a PR file reviewed (persisting its current blob `sha`) or clear the mark.
#[tauri::command]
#[specta::specta]
pub async fn set_file_reviewed(
    pr_repo: String,
    pr_number: u32,
    path: String,
    sha: String,
    reviewed: bool,
    db: State<'_, Db>,
) -> CmdResult<()> {
    Ok(reviewed::set(&db, &pr_repo, pr_number, &path, &sha, reviewed).await?)
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
#[tauri::command]
#[specta::specta]
pub async fn triage_detail(
    repo: String,
    ticket_id: String,
    db: State<'_, Db>,
) -> CmdResult<TriageDetail> {
    Ok(linear::triage_detail(&db, &repo, &ticket_id)
        .await?
        .ok_or_else(|| format!("triage issue {ticket_id} not found"))?)
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

/// The `gh` CLI integration status for Settings → Integrations: installed?
/// authenticated? as which account? Infallible — a missing or signed-out `gh`
/// is reported via the status flags rather than as an error, since GitHub can't
/// be turned off and the view always renders.
#[tauri::command]
#[specta::specta]
pub async fn github_status() -> GithubStatus {
    crate::github::status().await
}

/// Path to the settings file santree passes as `claude --settings <path>`,
/// carrying the session-state hooks and santree's own `statusLine` (which prints
/// the context-fill bar and captures live usage into the db). Both are always
/// present — capture is unconditional; whether the app *displays* the inline
/// usage bar is a runtime frontend decision. `None` when the hook binary/db can't
/// be resolved — the frontend then launches without the flag. The content is
/// setting-independent, so the frontend caches the path forever.
#[tauri::command]
#[specta::specta]
pub async fn claude_hook_settings(app: AppHandle) -> Option<String> {
    // Writes a settings JSON file. A non-async command runs on the *main thread*,
    // where a slow disk stalls the whole UI — everything else in this file that
    // touches the filesystem goes through spawn_blocking for exactly this reason.
    tokio::task::spawn_blocking(move || crate::hooks::claude_settings(&app))
        .await
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
    tokio::task::spawn_blocking(move || crate::hooks::claude_settings_no_git(&app))
        .await
        .ok()
        .flatten()
}

/// Every santree-launched session's live token/context usage, captured from the
/// status-line stdin. Newest first.
#[tauri::command]
#[specta::specta]
pub async fn session_usage_live(db: State<'_, Db>) -> CmdResult<Vec<SessionUsageLive>> {
    Ok(crate::hooks::session_usage_live(&db).await?)
}

/// The current state of every Claude session santree has launched, as recorded
/// live by the injected hooks. Most-recently-updated first.
#[tauri::command]
#[specta::specta]
pub async fn session_states(db: State<'_, Db>) -> CmdResult<Vec<SessionState>> {
    Ok(crate::hooks::session_states(&db).await?)
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

/// The Claude slash-commands offered by the triage "Investigate" picker. Always
/// includes the global `~/.claude/commands`; when a repo name is given, also its
/// own `.claude/commands` (so the repo scope can list both).
#[tauri::command]
#[specta::specta]
pub async fn list_claude_commands(
    repo: Option<String>,
    db: State<'_, Db>,
) -> CmdResult<ClaudeCommands> {
    let repo_path = match repo {
        Some(name) => repo::path(&db, &name).await?,
        None => None,
    };
    // `settings::commands` does sync `read_dir` + `read_to_string` per command
    // file — keep it off the async runtime (mirrors `agent_auth` below).
    Ok(tokio::task::spawn_blocking(move || settings::commands(repo_path.as_deref())).await?)
}

/// Read the effective backing file for a selected slash-command so the Triage
/// settings editor can edit the real skill in place. Resolves repo-over-global
/// (the repo's own copy wins), returning which file was loaded.
#[tauri::command]
#[specta::specta]
pub async fn read_claude_command(
    repo: Option<String>,
    name: String,
    db: State<'_, Db>,
) -> CmdResult<ClaudeCommandFile> {
    let repo_path = match repo {
        Some(name) => repo::path(&db, &name).await?,
        None => None,
    };
    Ok(
        tokio::task::spawn_blocking(move || settings::read_command(repo_path.as_deref(), &name))
            .await??,
    )
}

/// Overwrite a slash-command's backing file. `source` comes from the matching
/// [`read_claude_command`] so the edit lands on the exact file that was loaded
/// (global vs the repo's own copy).
#[tauri::command]
#[specta::specta]
pub async fn write_claude_command(
    repo: Option<String>,
    name: String,
    source: CommandSource,
    content: String,
    db: State<'_, Db>,
) -> CmdResult<()> {
    let repo_path = match repo {
        Some(name) => repo::path(&db, &name).await?,
        None => None,
    };
    Ok(tokio::task::spawn_blocking(move || {
        settings::write_command(repo_path.as_deref(), &name, source, &content)
    })
    .await??)
}

/// The variable names a user-referenced `.env` file defines, for the Environment
/// settings' "N variables loaded" readout. Reads exactly the absolute path the
/// user picked (a native file dialog) — no id is joined onto a base dir, so
/// there's no traversal surface — and returns an empty list if it's unreadable.
#[tauri::command]
#[specta::specta]
pub async fn env_file_vars(path: String) -> Vec<String> {
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
        Ok(Some(tasks)) => {
            log::info!("fetched {} Linear issues for {repo}", tasks.len());
            Ok(tasks)
        }
        Ok(None) => Ok(vec![]),
        Err(e) => {
            log::warn!("Linear issue fetch failed for {repo}: {e}");
            Err(e.into())
        }
    }
}

/// Run the Linear OAuth flow; returns the updated org list.
#[tauri::command]
#[specta::specta]
pub async fn linear_connect(db: State<'_, Db>) -> CmdResult<Vec<LinearOrg>> {
    Ok(linear::connect(&db).await?)
}
