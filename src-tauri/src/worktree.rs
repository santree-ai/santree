//! Worktree orchestration: the issue ↔ worktree lifecycle the Trees view drives.
//!
//! This is the live counterpart to the santree CLI's dashboard "start a task"
//! flow (create worktree → run `.santree/init.sh` via `run_setup_streamed` →
//! launch an agent), plus the commit-box operations. The issue ↔ worktree
//! relationship is stored in the `worktree_links` table (keyed by repo + issue
//! id) rather than inferred from the branch name. Git itself is driven through
//! [`crate::git`].

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;

use santree_core::domain::{AgentKind, ChangedFile, FileSource, ScriptInfo, Worktree};

/// How long a setup script may run before it's killed. Setup scripts run real build
/// tooling (nix, make, a cold `npm install`), so this is deliberately generous — it's
/// a backstop against a script that will *never* finish (waiting on stdin nobody can
/// answer, a wedged network mount), not a performance budget. The Stop button is the
/// normal way out.
const SETUP_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// The setup scripts running right now, keyed by repo root + issue id. A process-wide
/// singleton ([`SETUP_RUNS`]) rather than Tauri state, because the blocking reader
/// thread outlives any borrow.
///
/// `stream_init_script` opens its own PTY, outside `PtyManager` — so without this
/// registry nothing could see the child: quitting mid-setup orphaned the script and
/// everything it spawned, a hung `init.sh` pinned a blocking-pool thread with no way
/// to recover, and the Setup tab sat at "running" forever.
pub static SETUP_RUNS: LazyLock<SetupRuns> = LazyLock::new(SetupRuns::default);

#[derive(Default)]
pub struct SetupRuns(Mutex<HashMap<(String, String), Box<dyn ChildKiller + Send + Sync>>>);

impl SetupRuns {
    fn insert(&self, root: &str, issue_id: &str, killer: Box<dyn ChildKiller + Send + Sync>) {
        let mut runs = self.0.lock().unwrap_or_else(|e| e.into_inner());
        runs.insert((root.to_string(), issue_id.to_string()), killer);
    }

    fn remove(&self, root: &str, issue_id: &str) {
        let mut runs = self.0.lock().unwrap_or_else(|e| e.into_inner());
        runs.remove(&(root.to_string(), issue_id.to_string()));
    }

    /// Whether a setup script is already running for this worktree. Re-running would
    /// stack a second `init.sh` in the same directory.
    fn contains(&self, root: &str, issue_id: &str) -> bool {
        let runs = self.0.lock().unwrap_or_else(|e| e.into_inner());
        runs.contains_key(&(root.to_string(), issue_id.to_string()))
    }

    /// Kill one running setup script. The read loop then hits EOF and the run
    /// finishes normally (as a failure), so the UI closes the tab on its own.
    pub fn cancel(&self, root: &str, issue_id: &str) -> bool {
        let mut runs = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match runs.remove(&(root.to_string(), issue_id.to_string())) {
            Some(mut killer) => {
                let _ = killer.kill();
                true
            }
            None => false,
        }
    }

    /// Kill every running setup script — called on app exit, beside
    /// `PtyManager::close_all`, so a quit mid-setup doesn't leave `init.sh` and its
    /// children running headless.
    pub fn kill_all(&self) {
        let mut runs = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut killer) in runs.drain() {
            let _ = killer.kill();
        }
    }
}

/// A streamed setup-script event for the Trees "Setup" tab. `Line` is a committed
/// output line (appended). `Progress` is a transient redraw of the current line —
/// emitted when the script's output ends a line with a lone `\r` (progress bars,
/// spinners) — which the view shows in place so a redrawing bar reads as movement
/// instead of a frozen log. A final `Done` closes the tab.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SetupEvent {
    Line { text: String },
    Progress { text: String },
    Done { ok: bool },
}

use crate::db::Db;
use crate::git;
use crate::repo;

/// Sentinel worktree id for the repo's base branch (the repo root checked out on
/// main/master). It isn't a tracked `worktree_links` row — the path-resolving
/// helpers map it to the repo root + default branch — so the Trees view can offer
/// a terminal / file browser / commit box for the base branch itself.
pub const BASE_ID: &str = "__base__";

/// Reject an `issue_id` that isn't safe to `Path::join` onto the worktrees dir —
/// mirrors `git.rs`'s `safe_path` guard. IPC-supplied, so a value like `".."` or
/// `"/etc"` must not be allowed to escape `.santree/worktrees` and later get
/// `remove_dir_all`'d as an "adopted" worktree.
fn validate_issue_id(issue_id: &str) -> Result<()> {
    let mut components = Path::new(issue_id).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => Ok(()),
        _ => bail!("invalid issue id '{issue_id}'"),
    }
}

/// Reject a branch name that could be parsed as a flag by `git` instead of a
/// positional ref — an IPC-supplied `base` reaching `git fetch origin <base>`
/// unquoted (`git.rs`) must not be able to smuggle e.g. `--upload-pack=<cmd>`.
fn validate_branch_name(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') {
        bail!("invalid branch name '{name}'");
    }
    Ok(())
}

/// A stored issue ↔ worktree link's git coordinates, hydrated from
/// `worktree_links`. The `list` query reads the full row separately; this is
/// only what the single-worktree operations need to find the directory.
struct Link {
    branch: String,
    worktree_path: String,
}

/// A full `worktree_links` row — read back for building a `Worktree` (list/get) and
/// built up by `create` for the insert. One `FromRow` struct so the column list
/// isn't spelled out as a tuple twice.
#[derive(sqlx::FromRow)]
struct LinkRow {
    issue_id: String,
    title: String,
    project: Option<String>,
    branch: String,
    worktree_path: String,
    base_branch: String,
    agent: Option<String>,
    setup_ran: i64,
}

const LINK_COLUMNS: &str =
    "issue_id, title, project, branch, worktree_path, base_branch, agent, setup_ran";

/// Resolve a registered repo's top-level path, erroring if it has none (e.g. a
/// seed repo with no local checkout).
async fn repo_root(db: &Db, repo: &str) -> Result<String> {
    repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))
}

/// Fetch the link for one issue, or `None` when the worktree isn't tracked.
async fn link(db: &Db, repo_root: &str, issue_id: &str) -> Result<Option<Link>> {
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT branch, worktree_path
         FROM worktree_links WHERE repo_path = ? AND issue_id = ?",
    )
    .bind(repo_root)
    .bind(issue_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(branch, worktree_path)| Link {
        branch,
        worktree_path,
    }))
}

/// A worktree's git coordinates, for operations that need more than the path
/// (commit-message drafting, PR creation): branch, its base, and the directory.
#[derive(Clone)]
pub(crate) struct Coords {
    pub branch: String,
    pub base_branch: String,
    pub path: PathBuf,
}

/// Resolve a worktree's branch, base branch, and directory, erroring when the
/// issue isn't tracked.
pub(crate) async fn coords(db: &Db, repo: &str, issue_id: &str) -> Result<Coords> {
    let root = repo_root(db, repo).await?;
    if issue_id == BASE_ID {
        let root_path = PathBuf::from(&root);
        let base = tokio::task::spawn_blocking({
            let root_path = root_path.clone();
            move || git::default_branch(&root_path)
        })
        .await?;
        return Ok(Coords {
            branch: base.clone(),
            base_branch: base,
            path: root_path,
        });
    }
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT branch, base_branch, worktree_path
         FROM worktree_links WHERE repo_path = ? AND issue_id = ?",
    )
    .bind(&root)
    .bind(issue_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow!("no worktree for issue '{issue_id}'"))?;
    Ok(Coords {
        branch: row.0,
        base_branch: row.1,
        path: PathBuf::from(row.2),
    })
}

/// Refresh the stored title for a worktree. Self-healing: the Issue tab calls
/// this when the live Linear title differs from what's stored, so the sidebar
/// stays accurate without the (git-only, offline-capable) list ever hitting Linear.
pub async fn set_title(db: &Db, repo: &str, issue_id: &str, title: &str) -> Result<()> {
    let root = repo_root(db, repo).await?;
    sqlx::query("UPDATE worktree_links SET title = ? WHERE repo_path = ? AND issue_id = ?")
        .bind(title)
        .bind(&root)
        .bind(issue_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Resolve the worktree directory for an issue, erroring when it isn't tracked.
/// The base sentinel resolves to the repo root, so the commit-box / file ops work
/// on the base branch checkout directly.
async fn worktree_path(db: &Db, repo: &str, issue_id: &str) -> Result<PathBuf> {
    let root = repo_root(db, repo).await?;
    if issue_id == BASE_ID {
        return Ok(PathBuf::from(root));
    }
    let l = link(db, &root, issue_id)
        .await?
        .ok_or_else(|| anyhow!("no worktree for issue '{issue_id}'"))?;
    Ok(PathBuf::from(l.worktree_path))
}

/// The repo's base branch as a worktree-like entry: the repo root checked out on
/// the default branch (main/master). Surfaced in the Trees sidebar above the
/// per-issue worktrees so the base branch gets the same terminal / file browser /
/// commit box. `None` when the repo has no local path recorded (in practice
/// this never happens for a repo added via `repo::add`, which always stores
/// one — see the note on `Repo::path`).
pub async fn base_worktree(db: &Db, repo: &str) -> Result<Option<Worktree>> {
    let Some(root) = repo::path(db, repo).await? else {
        return Ok(None);
    };
    let wt = tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(&root);
        let base = git::default_branch(&p);
        Worktree {
            id: BASE_ID.to_string(),
            title: base.clone(),
            // The base branch isn't a ticket, has no agent of its own, and runs no
            // agent session — so there's nothing to report for any of the three.
            status: None,
            // The base IS its own base, so there's no diff to summarise.
            add_lines: 0,
            del_lines: 0,
            dirty: git::is_dirty(&p),
            ahead: 0,
            behind: git::behind(&p, &base),
            unpushed: git::unpushed(&p, &base, &base),
            // The base's remote-sync is the "Update base from origin" action, so
            // don't surface a redundant Pull button for it.
            remote_behind: 0,
            pull_conflict: false,
            agent: None,
            activity: None,
            branch: base.clone(),
            path: root,
            project: None,
            base_branch: base,
            setup_ran: false,
            pending: false,
        }
    })
    .await?;
    Ok(Some(wt))
}

/// Every tracked worktree for a repo, with live git stats. Empty when the repo
/// has no worktrees yet — or no local path at all — so the Trees view shows its
/// empty state (and the caller needn't pre-check the path).
pub async fn list(db: &Db, repo: &str) -> Result<Vec<Worktree>> {
    let Some(root) = repo::path(db, repo).await? else {
        return Ok(Vec::new());
    };
    let rows = sqlx::query_as::<_, LinkRow>(&format!(
        "SELECT {LINK_COLUMNS} FROM worktree_links WHERE repo_path = ? ORDER BY created_at DESC"
    ))
    .bind(&root)
    .fetch_all(db)
    .await?;

    // Each `build_worktree` shells out to git 4–5 times (blocking). Run them on
    // the blocking pool *concurrently* — spawn first, then await — so N worktrees
    // don't gate one another (and an async runtime thread never blocks on git).
    let handles: Vec<_> = rows
        .into_iter()
        .map(|row| tokio::task::spawn_blocking(move || build_worktree(row)))
        .collect();
    let mut worktrees = Vec::with_capacity(handles.len());
    for handle in handles {
        worktrees.push(handle.await?);
    }
    Ok(worktrees)
}

/// Build a `Worktree` (with live git stats) from a stored link row, probing the
/// branch's remote-sync state.
fn build_worktree(row: LinkRow) -> Worktree {
    // Freshen the branch's remote ref (throttled) so remote_behind reflects commits
    // added to the branch upstream — nothing else fetches it. Only when there's
    // something to pull does it run the (cheap) virtual merge to see if it'd
    // conflict, so the Pull button can disable itself up front.
    let remote = git::pull_state(Path::new(&row.worktree_path), &row.branch);
    build_worktree_from(row, remote.behind, remote.conflict)
}

/// Build a `Worktree` for a branch that was *just created locally* — no remote
/// probe. `git fetch origin <branch>` would be a guaranteed miss for a branch that
/// has never been pushed (and, offline, would hang for git's whole timeout), so
/// `remote_behind`/`pull_conflict` are zero by construction. An adopted worktree's
/// remote state, if any, lands on the next `list`/`get` refresh.
fn build_worktree_local(row: LinkRow) -> Worktree {
    build_worktree_from(row, 0, false)
}

fn build_worktree_from(row: LinkRow, remote_behind: u32, pull_conflict: bool) -> Worktree {
    let path = PathBuf::from(&row.worktree_path);
    let (add_lines, del_lines) = branch_stats(&path, &row.base_branch);
    Worktree {
        id: row.issue_id,
        title: row.title,
        // The link row stores no ticket status, and this path is deliberately
        // git-only (offline-capable — it never calls Linear), so there is no real
        // source for it here. The Trees view overlays the live status from its own
        // tasks fetch; shipping a constant would render a confident, meaningless
        // chip for every worktree whose issue isn't in that fetch.
        status: None,
        add_lines,
        del_lines,
        dirty: git::is_dirty(&path),
        ahead: git::ahead(&path, &row.base_branch),
        behind: git::behind(&path, &row.base_branch),
        unpushed: git::unpushed(&path, &row.branch, &row.base_branch),
        remote_behind,
        pull_conflict,
        agent: parse_agent(row.agent.as_deref()),
        // Live agent activity is derived from the running PTY sessions, which only
        // the frontend knows about — the backend doesn't guess.
        activity: None,
        branch: row.branch,
        path: row.worktree_path,
        project: row.project,
        base_branch: row.base_branch,
        setup_ran: row.setup_ran != 0,
        pending: false,
    }
}

/// Fetch the full link row for one issue, or `None` when the worktree isn't tracked.
async fn link_row(db: &Db, repo_root: &str, issue_id: &str) -> Result<Option<LinkRow>> {
    Ok(sqlx::query_as::<_, LinkRow>(&format!(
        "SELECT {LINK_COLUMNS} FROM worktree_links WHERE repo_path = ? AND issue_id = ?"
    ))
    .bind(repo_root)
    .bind(issue_id)
    .fetch_optional(db)
    .await?)
}

/// The tracked worktree for one issue (with live stats), or `None` if untracked.
pub async fn get(db: &Db, repo: &str, issue_id: &str) -> Result<Option<Worktree>> {
    let root = repo_root(db, repo).await?;
    let Some(row) = link_row(db, &root, issue_id).await? else {
        return Ok(None);
    };
    Ok(Some(
        tokio::task::spawn_blocking(move || build_worktree(row)).await?,
    ))
}

/// Create (or adopt) a worktree for an issue and record the link.
///
/// Idempotent: if the issue is already tracked it's just returned; if a worktree
/// directory already exists on disk but isn't tracked (e.g. it was created by the
/// santree CLI or a prior run) it's *adopted* — linked and opened — rather than
/// failing. Only a genuinely new worktree is branched off the base; running its
/// setup script is a separate step (`run_setup_streamed`) so its output streams
/// live to the Trees "Setup" tab instead of blocking this call for minutes.
// One focused orchestrator with clear positional args; a params struct would just
// churn the two command wrappers + tests for no real readability win.
#[allow(clippy::too_many_arguments)]
pub async fn create(
    db: &Db,
    repo: &str,
    issue_id: &str,
    title: &str,
    project: Option<&str>,
    base: Option<&str>,
    agent: AgentKind,
    checkout_branch: Option<&str>,
) -> Result<Worktree> {
    validate_issue_id(issue_id)?;
    if let Some(b) = base {
        validate_branch_name(b)?;
    }
    if let Some(b) = checkout_branch {
        validate_branch_name(b)?;
    }
    let root = repo_root(db, repo).await?;

    // Already tracked → just open it.
    if let Some(existing) = get(db, repo, issue_id).await? {
        return Ok(existing);
    }

    // The git work (branch resolution, `worktree add`, fetch) is blocking — run it
    // off the async runtime.
    let (base_branch, branch, wt_path_str) = {
        let root = root.clone();
        let issue_id = issue_id.to_string();
        let title = title.to_string();
        let base = base.map(str::to_string);
        let checkout_branch = checkout_branch.map(str::to_string);
        tokio::task::spawn_blocking(move || -> Result<_> {
            let root_path = Path::new(&root);
            let base_branch = match base {
                Some(b) => b,
                None => git::default_branch(root_path),
            };
            let wt_path = root_path.join(".santree").join("worktrees").join(&issue_id);
            let computed_branch =
                format!("santree/{}-{}", issue_id.to_lowercase(), slugify(&title));

            let branch = if wt_path.exists() {
                // Adopt a pre-existing worktree: reuse its real branch (from git) when
                // it is a registered worktree, else fall back to the computed name.
                log::info!(
                    "adopting existing worktree {issue_id} at {}",
                    wt_path.display()
                );
                git::worktree_branch(root_path, &wt_path).unwrap_or(computed_branch)
            } else if let Some(cb) = checkout_branch {
                // Check out an existing branch (a PR's head) rather than branching new
                // work — so commits made here land on the PR's branch.
                git::add_worktree_for_branch(root_path, &wt_path, &cb)?;
                log::info!("created worktree {issue_id} on existing branch {cb}");
                cb
            } else {
                git::create_worktree(root_path, &wt_path, &computed_branch, &base_branch)?;
                log::info!("created worktree {issue_id} on branch {computed_branch}");
                computed_branch
            };
            Ok((base_branch, branch, wt_path.to_string_lossy().into_owned()))
        })
        .await??
    };

    // `setup_ran` always starts false: setup now only ever runs via the separate
    // `run_setup_streamed` command (driven from the Trees "Setup" tab), never as
    // part of create.
    let row = LinkRow {
        issue_id: issue_id.to_string(),
        title: title.to_string(),
        project: project.map(str::to_string),
        branch,
        worktree_path: wt_path_str,
        base_branch,
        agent: Some(agent.as_str().to_string()),
        setup_ran: 0,
    };
    let row = if insert_link(db, &root, &row).await? {
        row
    } else {
        // Lost a race with a concurrent create for the same issue (double-clicked
        // Run, or an Issues launch racing a Trees one, both past the `get` check
        // above while the slow git work ran) — adopt the winner's row instead of
        // reporting our own, never-persisted values.
        link_row(db, &root, issue_id)
            .await?
            .ok_or_else(|| anyhow!("worktree {issue_id} missing after create"))?
    };

    // If opted in, reflect the new work in Linear by moving the issue to its
    // "started" state. Best-effort and genuinely fire-and-forget — nobody awaits
    // this, so it must not gate the create response (and the frontend's
    // pendingLaunch→real-worktree swap) on Linear's GraphQL round-trip latency.
    let move_in_progress = crate::settings::get(db, "app", "work_move_in_progress")
        .await
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    if move_in_progress {
        let db = db.clone();
        let repo = repo.to_string();
        let issue_id = issue_id.to_string();
        tokio::spawn(async move {
            if let Err(e) = crate::linear::move_issue_to_started(&db, &repo, &issue_id).await {
                log::warn!("couldn't move issue {issue_id} to In Progress: {e}");
            }
        });
    }

    // Build the response locally: `get` would probe the remote for a branch that by
    // construction isn't on origin yet, holding "Creating workspace…" for a doomed
    // network round-trip on every single task start.
    Ok(tokio::task::spawn_blocking(move || build_worktree_local(row)).await?)
}

/// Record the issue ↔ worktree link, reporting whether *this* call inserted it.
///
/// `ON CONFLICT DO NOTHING` rather than a plain insert: `create`'s "already tracked?"
/// check and this write are separated by seconds of git work, so two concurrent
/// creates for the same issue both reach it — and the loser must adopt the winner's
/// row, not fail the whole launch with a raw primary-key error.
async fn insert_link(db: &Db, repo_root: &str, row: &LinkRow) -> Result<bool> {
    let inserted = sqlx::query(
        "INSERT INTO worktree_links
            (repo_path, issue_id, title, project, branch, worktree_path, base_branch, agent, setup_ran)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_path, issue_id) DO NOTHING",
    )
    .bind(repo_root)
    .bind(&row.issue_id)
    .bind(&row.title)
    .bind(&row.project)
    .bind(&row.branch)
    .bind(&row.worktree_path)
    .bind(&row.base_branch)
    .bind(&row.agent)
    .bind(row.setup_ran)
    .execute(db)
    .await?
    .rows_affected();
    Ok(inserted > 0)
}

/// Remove a worktree (and its branch) and drop the link.
///
/// Restacks any children: a worktree stacked on the removed branch is re-pointed
/// to the removed branch's *own* base. So in `master → b1 → b2 → b3`, removing
/// `b2` (e.g. after its PR merged into `b1`) re-points `b3` to `b1` — not to
/// master. This keeps each stacked worktree's `base_branch` (and therefore its PR
/// base / diff) correct as intermediate branches land, walking one hop per removal
/// up the chain.
pub async fn remove(
    db: &Db,
    repo: &str,
    issue_id: &str,
    prompts_root: Option<&Path>,
) -> Result<()> {
    let root = repo_root(db, repo).await?;
    let (branch, base_branch, worktree_path) = sqlx::query_as::<_, (String, String, String)>(
        "SELECT branch, base_branch, worktree_path
         FROM worktree_links WHERE repo_path = ? AND issue_id = ?",
    )
    .bind(&root)
    .bind(issue_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow!("no worktree for issue '{issue_id}'"))?;

    {
        // Blocking git (`worktree remove`, `branch -D`) off the async runtime.
        let root = root.clone();
        let branch = branch.clone();
        let wt = worktree_path.clone();
        tokio::task::spawn_blocking(move || {
            git::remove_worktree(Path::new(&root), Path::new(&wt), &branch)
        })
        .await??;
    }
    sqlx::query("DELETE FROM worktree_links WHERE repo_path = ? AND issue_id = ?")
        .bind(&root)
        .bind(issue_id)
        .execute(db)
        .await?;
    // Drop any recorded live session state for this worktree. Keyed by the cwd
    // the hooks stored, which is the worktree path Claude ran in. (A row that
    // doesn't match — e.g. a symlink-resolved cwd — just lingers harmlessly;
    // the table is bounded regardless.)
    sqlx::query("DELETE FROM session_state WHERE cwd = ?")
        .bind(&worktree_path)
        .execute(db)
        .await?;
    // Delete the on-disk work prompt (best-effort; absent is fine).
    if let Some(prompts_root) = prompts_root {
        delete_prompt_file(prompts_root, &root, issue_id);
    }
    // Forget the terminal session tied to this worktree so recreating it later
    // starts a fresh conversation instead of `--resume`ing one about deleted code.
    crate::session::forget(db, repo, &format!("tree:{issue_id}")).await?;
    // Same for its persisted extra tabs (and each Claude tab's stored session).
    crate::tabs::remove_for_worktree(db, repo, issue_id).await?;
    // Re-point this branch's children onto its base (the grandparent).
    let restacked = sqlx::query(
        "UPDATE worktree_links SET base_branch = ? WHERE repo_path = ? AND base_branch = ?",
    )
    .bind(&base_branch)
    .bind(&root)
    .bind(&branch)
    .execute(db)
    .await?
    .rows_affected();
    log::info!("removed worktree {issue_id} ({restacked} children restacked)");
    Ok(())
}

/// Run `.santree/init.sh`, streaming each output line over `on_event` for the
/// Trees "Setup" tab, and record it as run on success. stderr is folded into
/// stdout so the log stays ordered. (Plain text — no TTY/colour.)
pub async fn run_setup_streamed(
    db: &Db,
    repo: &str,
    issue_id: &str,
    on_event: Channel<SetupEvent>,
) -> Result<()> {
    let root = repo_root(db, repo).await?;
    let l = link(db, &root, issue_id)
        .await?
        .ok_or_else(|| anyhow!("no worktree for issue '{issue_id}'"))?;
    let wt_path = PathBuf::from(&l.worktree_path);
    let script = init_script_path(&root);

    if !script.exists() || !is_executable(&script) {
        let _ = on_event.send(SetupEvent::Line {
            text: "No executable .santree/init.sh — nothing to run.".into(),
        });
        let _ = on_event.send(SetupEvent::Done { ok: true });
        return Ok(());
    }

    // Two `init.sh` runs in one worktree would race over the same directory.
    if SETUP_RUNS.contains(&root, issue_id) {
        bail!("setup is already running for '{issue_id}'");
    }

    let ev = on_event.clone();
    let root_for_script = root.clone();
    let id_for_script = issue_id.to_string();
    let ok = tokio::task::spawn_blocking(move || {
        stream_init_script(&script, &wt_path, &root_for_script, &id_for_script, &ev)
    })
    .await
    .unwrap_or(false);

    if ok {
        let _ = sqlx::query(
            "UPDATE worktree_links SET setup_ran = 1 WHERE repo_path = ? AND issue_id = ?",
        )
        .bind(&root)
        .bind(issue_id)
        .execute(db)
        .await;
    }
    let _ = on_event.send(SetupEvent::Done { ok });
    Ok(())
}

/// Stop the setup script running for a worktree, if any. Returns whether one was
/// running. The kill closes the PTY, so the streaming run finishes on its own and
/// reports failure — there's no separate teardown path to keep in sync.
pub async fn cancel_setup(db: &Db, repo: &str, issue_id: &str) -> Result<bool> {
    validate_issue_id(issue_id)?;
    let root = repo_root(db, repo).await?;
    Ok(SETUP_RUNS.cancel(&root, issue_id))
}

/// Drain complete line boundaries from `acc`, classifying each segment: `\n` (or
/// `\r\n`) ends a committed `Line`; a lone `\r` is a transient `Progress` redraw
/// (progress bars / spinners). A `\r` at the very end of `acc` is held — it may be
/// the first half of a `\r\n` split across reads — unless `flush` is set (EOF),
/// when the remainder is emitted as a final `Line`. ANSI escapes are stripped.
fn drain_setup_events(acc: &mut String, flush: bool) -> Vec<SetupEvent> {
    let mut out = Vec::new();
    while let Some(idx) = acc.find(['\n', '\r']) {
        if acc.as_bytes()[idx] == b'\r' {
            if idx + 1 == acc.len() {
                break; // trailing `\r` — wait for the next byte to disambiguate.
            }
            if acc.as_bytes()[idx + 1] == b'\n' {
                let line: String = acc.drain(..=idx + 1).collect();
                out.push(SetupEvent::Line {
                    text: strip_ansi(line.trim_end_matches(['\r', '\n'])),
                });
            } else {
                let line: String = acc.drain(..=idx).collect();
                out.push(SetupEvent::Progress {
                    text: strip_ansi(line.trim_end_matches('\r')),
                });
            }
        } else {
            let line: String = acc.drain(..=idx).collect();
            out.push(SetupEvent::Line {
                text: strip_ansi(line.trim_end_matches(['\r', '\n'])),
            });
        }
    }
    if flush && !acc.trim().is_empty() {
        let line = std::mem::take(acc);
        out.push(SetupEvent::Line {
            text: strip_ansi(line.trim_end_matches(['\r', '\n'])),
        });
    }
    out
}

/// Spawn the setup script (stderr folded into stdout) and forward each output line
/// to `ev`. Returns whether it exited successfully.
///
/// The child is registered in `runs` for as long as it lives, so a Stop from the UI
/// (or an app quit) can kill it — and a watchdog kills it at [`SETUP_DEADLINE`]. In
/// every one of those cases the read loop below hits EOF, `child.wait()` returns a
/// failure, and the run reports `Done { ok: false }` like any other failed script.
fn stream_init_script(
    script: &Path,
    wt: &Path,
    root: &str,
    issue_id: &str,
    ev: &Channel<SetupEvent>,
) -> bool {
    let _ = ev.send(SetupEvent::Line {
        text: format!("▸ {}", script.display()),
    });

    // Run under a PTY (not a plain pipe) so the script's children — nix/make/etc.,
    // which the init runs in parallel — see a TTY and emit output *live*. Over a
    // pipe they block-buffer, which made the log look frozen for the whole build.
    // `exec <script>` keeps stdout+stderr on the one pty; we strip ANSI for this
    // plain-text view.
    let size = PtySize {
        rows: 40,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = match native_pty_system().openpty(size) {
        Ok(p) => p,
        Err(e) => {
            let _ = ev.send(SetupEvent::Line {
                text: format!("failed to allocate pty: {e}"),
            });
            return false;
        }
    };

    let mut cmd = CommandBuilder::new("/bin/bash");
    cmd.args([
        "-c",
        &format!("exec {}", shell_quote(&script.to_string_lossy())),
    ]);
    cmd.cwd(wt);
    cmd.env("SANTREE_WORKTREE_PATH", wt);
    cmd.env("SANTREE_REPO_ROOT", root);
    cmd.env("TERM", "xterm-256color");

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            let _ = ev.send(SetupEvent::Line {
                text: format!("failed to start setup: {e}"),
            });
            return false;
        }
    };
    // Drop the slave so the master reader hits EOF once the script *and* its
    // children (which inherit the slave) exit — otherwise the read loop hangs.
    drop(pair.slave);

    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = ev.send(SetupEvent::Line {
                text: format!("failed to read setup output: {e}"),
            });
            let _ = child.kill();
            return false;
        }
    };

    SETUP_RUNS.insert(root, issue_id, child.clone_killer());

    // Backstop for a script that never finishes *at all*. Killing the child closes
    // the last handle on the slave, which is what unblocks the read loop below —
    // `reader.read` has no timeout of its own. The watchdog parks on a channel it
    // never receives from, so it wakes the moment this function returns (dropping
    // `done`) rather than sleeping out the full deadline after a fast setup.
    let (done, finished) = std::sync::mpsc::channel::<()>();
    {
        let mut killer = child.clone_killer();
        let (root, issue_id) = (root.to_string(), issue_id.to_string());
        std::thread::spawn(move || {
            if finished.recv_timeout(SETUP_DEADLINE)
                != Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            {
                return; // the run finished on its own
            }
            log::warn!(
                "setup for {issue_id} exceeded {}s — killing it",
                SETUP_DEADLINE.as_secs()
            );
            SETUP_RUNS.cancel(&root, &issue_id);
            let _ = killer.kill();
        });
    }

    // Read bytes and drain complete boundaries as they arrive (see
    // `drain_setup_events`), then flush any trailing partial line at EOF.
    let mut buf = [0u8; 4096];
    let mut acc = String::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                for e in drain_setup_events(&mut acc, false) {
                    let _ = ev.send(e);
                }
            }
        }
    }
    for e in drain_setup_events(&mut acc, true) {
        let _ = ev.send(e);
    }

    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    SETUP_RUNS.remove(root, issue_id);
    drop(done); // wake the watchdog so it doesn't outlive the run
    let _ = ev.send(SetupEvent::Line {
        text: format!("▸ setup {}", if ok { "complete" } else { "failed" }),
    });
    ok
}

/// Strip ANSI escape sequences (colour/SGR + other CSI, plus OSC) from a line so
/// the plain-text setup log shows clean text instead of raw escape codes.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: ESC `[` … <final byte 0x40–0x7e> (colours, cursor moves, etc).
            Some('[') => {
                chars.next();
                while let Some(&nc) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&nc) {
                        break;
                    }
                }
            }
            // OSC: ESC `]` … terminated by BEL or ST (`ESC \`) — e.g. a terminal
            // title/hyperlink sequence (npm, cargo wrappers, nix all emit these).
            // Without this, the payload *and* a raw BEL byte would leak straight
            // into the plain-text setup log.
            Some(']') => {
                chars.next();
                loop {
                    match chars.next() {
                        None | Some('\x07') => break,
                        Some('\x1b') if chars.peek() == Some(&'\\') => {
                            chars.next();
                            break;
                        }
                        _ => {}
                    }
                }
            }
            // Other escapes: drop the escape and its single intro byte.
            _ => {
                chars.next();
            }
        }
    }
    out
}

/// Single-quote a string for a POSIX shell command line.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Merge the base branch (origin/main, etc.) into the worktree — the "pull from
/// main/master" button. Errors on a conflicting merge (leaving the tree clean).
pub async fn pull(db: &Db, repo: &str, issue_id: &str) -> Result<String> {
    let c = coords(db, repo, issue_id).await?;
    // `pull_base` fetches + merges (network + blocking) — keep it off the runtime.
    tokio::task::spawn_blocking(move || git::pull_base(&c.path, &c.base_branch)).await?
}

/// Push the worktree's branch to origin (setting upstream) — the Trees "Push"
/// button and the post-commit auto-push. Network + blocking, so off the runtime.
pub async fn push(db: &Db, repo: &str, issue_id: &str) -> Result<()> {
    let c = coords(db, repo, issue_id).await?;
    tokio::task::spawn_blocking(move || git::push(&c.path, &c.branch)).await?
}

/// Integrate origin/<branch> into the worktree's own branch — the Trees "Pull"
/// button, for commits added to the branch remotely (PR-UI suggestions, "Update
/// branch", a teammate's push). Fast-forwards when possible, else merges — but
/// refuses up front (nothing touched) if that merge would conflict. Network +
/// blocking, so off the runtime.
pub async fn pull_remote(db: &Db, repo: &str, issue_id: &str) -> Result<()> {
    let c = coords(db, repo, issue_id).await?;
    tokio::task::spawn_blocking(move || git::pull_remote(&c.path, &c.branch)).await?
}

/// Fast-forward the repo's local base branch (main/master) to origin — the
/// "update master" action. Operates on the main repo dir, not the worktree.
pub async fn update_base(db: &Db, repo: &str, issue_id: &str) -> Result<String> {
    let root = repo_root(db, repo).await?;
    let base = sqlx::query_scalar::<_, String>(
        "SELECT base_branch FROM worktree_links WHERE repo_path = ? AND issue_id = ?",
    )
    .bind(&root)
    .bind(issue_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow!("no worktree for issue '{issue_id}'"))?;
    {
        // `update_base` fetches from origin (network + blocking).
        let root = root.clone();
        let base = base.clone();
        tokio::task::spawn_blocking(move || git::update_base(Path::new(&root), &base)).await??;
    }
    Ok(base)
}

// ── Commit-box operations (delegate to git, resolving the worktree path) ─────

/// Resolve the worktree directory for an issue and run `f` on it on the blocking
/// pool. The commit-box ops are all "find the worktree path, then run one git
/// command in it", so this names that shared shape once — and keeps the (blocking)
/// git call off the async runtime. `f` is `Send + 'static`, so callers pass owned
/// data (e.g. an owned `path`).
async fn with_worktree<T, F>(db: &Db, repo: &str, issue_id: &str, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> Result<T> + Send + 'static,
{
    let path = worktree_path(db, repo, issue_id).await?;
    tokio::task::spawn_blocking(move || f(&path)).await?
}

pub async fn status(db: &Db, repo: &str, issue_id: &str) -> Result<Vec<ChangedFile>> {
    with_worktree(db, repo, issue_id, git::status).await
}

pub async fn file_diff(
    db: &Db,
    repo: &str,
    issue_id: &str,
    path: &str,
    untracked: bool,
) -> Result<String> {
    let path = path.to_string();
    with_worktree(db, repo, issue_id, move |p| {
        git::file_diff(p, &path, untracked)
    })
    .await
}

pub async fn file_source(db: &Db, repo: &str, issue_id: &str, path: &str) -> Result<FileSource> {
    let path = path.to_string();
    with_worktree(db, repo, issue_id, move |p| git::file_source(p, &path)).await
}

pub async fn files(db: &Db, repo: &str, issue_id: &str) -> Result<Vec<String>> {
    with_worktree(db, repo, issue_id, git::list_files).await
}

pub async fn stage(db: &Db, repo: &str, issue_id: &str, path: &str) -> Result<()> {
    let path = path.to_string();
    with_worktree(db, repo, issue_id, move |p| git::stage(p, &path)).await
}

pub async fn unstage(db: &Db, repo: &str, issue_id: &str, path: &str) -> Result<()> {
    let path = path.to_string();
    with_worktree(db, repo, issue_id, move |p| git::unstage(p, &path)).await
}

pub async fn discard(
    db: &Db,
    repo: &str,
    issue_id: &str,
    path: &str,
    untracked: bool,
) -> Result<()> {
    let path = path.to_string();
    with_worktree(db, repo, issue_id, move |p| {
        git::discard(p, &path, untracked)
    })
    .await
}

pub async fn stage_all(db: &Db, repo: &str, issue_id: &str) -> Result<()> {
    with_worktree(db, repo, issue_id, git::stage_all).await
}

pub async fn unstage_all(db: &Db, repo: &str, issue_id: &str) -> Result<()> {
    with_worktree(db, repo, issue_id, git::unstage_all).await
}

/// Commit the worktree. When `stage_all` is set, everything is staged first
/// (honouring the "stage all before committing" setting).
pub async fn commit(
    db: &Db,
    repo: &str,
    issue_id: &str,
    message: &str,
    stage_all: bool,
) -> Result<()> {
    let path = worktree_path(db, repo, issue_id).await?;
    {
        // Blocking git (`add`/`commit`) off the async runtime.
        let message = message.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            if stage_all {
                git::stage_all(&path)?;
            }
            git::commit(&path, &message)
        })
        .await??;
    }
    // The message is now committed — drop the saved draft so it doesn't reappear.
    let _ = crate::commit_draft::set(db, repo, issue_id, "").await;
    Ok(())
}

/// Draft a commit message from the worktree's staged diff using a headless,
/// one-shot `claude -p` call (the same agent configured for the app). Uses the
/// `fill-commit` prompt template. Falls back to a plain message when Claude isn't
/// found, the diff is empty, or the call fails.
pub async fn commit_message(db: &Db, repo: &str, issue_id: &str) -> Result<String> {
    let root = repo_root(db, repo).await?;
    // The base sentinel commits the repo root on its own branch; per-issue
    // worktrees resolve their path + branch from the link row.
    let (path, known_branch) = if issue_id == BASE_ID {
        (PathBuf::from(&root), None)
    } else {
        let l = link(db, &root, issue_id)
            .await?
            .ok_or_else(|| anyhow!("no worktree for issue '{issue_id}'"))?;
        (PathBuf::from(&l.worktree_path), Some(l.branch))
    };

    // `default_branch` and `staged_diff` both shell out to git; run them off the
    // async runtime's worker threads.
    let p = path.clone();
    let (branch, diff) = tokio::task::spawn_blocking(move || {
        let branch = known_branch.unwrap_or_else(|| git::default_branch(&p));
        (branch, git::staged_diff(&p))
    })
    .await?;

    let fallback = if issue_id == BASE_ID {
        "update".to_string()
    } else {
        format!("[{issue_id}] update")
    };
    if diff.trim().is_empty() {
        return Ok(fallback);
    }

    // Cap the diff so the prompt stays within sane arg/token limits.
    let diff: String = diff.chars().take(12_000).collect();
    // The base worktree's `issue_id` is the `BASE_ID` sentinel, not a real ticket —
    // pass `None` so `{% if ticket_id %}` in the template omits the `[__base__] `
    // prefix, matching the non-AI fallback above.
    let prompt = crate::prompts::render(
        db,
        Some(repo),
        "fill-commit",
        minijinja::context! {
            branch_name => branch,
            ticket_id => (issue_id != BASE_ID).then_some(issue_id),
            diff_content => diff,
        },
    )
    .await?;

    // Claude can take 5–30s; run it off the async runtime's worker threads.
    let cwd = path.clone();
    let drafted = tokio::task::spawn_blocking(move || {
        crate::agent::run_print(&cwd, &prompt, &[], Some(crate::agent::HELPER_MODEL))
    })
    .await
    .ok()
    .flatten();

    Ok(drafted
        .map(|s| s.trim_matches(['"', '\'', '`']).trim().to_string())
        .unwrap_or(fallback))
}

// ── Agent work-prompt file ───────────────────────────────────────────────────
//
// The rendered `work` prompt can be very long (full ticket body + comment
// thread). Typing it into the interactive-shell seed (`exec claude '<prompt>'`)
// overflows the line and forces the shell into a `quote>` continuation, and the
// PTY line editor mangles control bytes — the same problem the `--settings` file
// works around (see `hooks.rs`). So we write the prompt to a stable file and seed
// the short `Read <path> …` instruction instead. The file is regenerated on every
// launch (so it reflects the latest ticket) and deleted with the worktree.

/// Stable, filesystem-safe key for a repo's local path (FNV-1a, hex). Namespaces
/// per-repo prompt files so two repos sharing an issue id (both have "AK-1") don't
/// collide. FNV is spelled out (not std's `DefaultHasher`, whose output isn't
/// guaranteed stable across releases) so the key a later app version computes to
/// *delete* the file matches the one an earlier version wrote.
fn repo_key(repo_root: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in repo_root.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Absolute path of an on-disk prompt file for a worktree:
/// `<prompts_root>/<repo-key>/<issue_id><suffix>`.
///
/// The `issue_id` is IPC-supplied, so it's validated *here* — at the sink that
/// `Path::join`s it — rather than trusting each caller to have done it: a `..`-y id
/// would otherwise escape the app data dir and let a compromised webview write a
/// file anywhere the app can.
fn prompt_path(
    prompts_root: &Path,
    repo_root: &str,
    issue_id: &str,
    suffix: &str,
) -> Result<PathBuf> {
    validate_issue_id(issue_id)?;
    Ok(prompts_root
        .join(repo_key(repo_root))
        .join(format!("{issue_id}{suffix}")))
}

/// Path of a worktree's rendered work prompt.
fn prompt_file_path(prompts_root: &Path, repo_root: &str, issue_id: &str) -> Result<PathBuf> {
    prompt_path(prompts_root, repo_root, issue_id, ".md")
}

/// Path of a worktree's CI-fix prompt (a distinct file so it never clobbers the
/// normal work prompt).
fn fix_ci_prompt_file_path(
    prompts_root: &Path,
    repo_root: &str,
    issue_id: &str,
) -> Result<PathBuf> {
    prompt_path(prompts_root, repo_root, issue_id, ".fixci.md")
}

/// Write a rendered prompt to `path` (creating its per-repo directory) and hand back
/// the path. The fs work — and, for the CI-fix prompt, a whole embedded job log —
/// runs on the blocking pool, like the rest of this module's filesystem I/O.
async fn write_prompt_file(path: PathBuf, body: String) -> Result<String> {
    tokio::task::spawn_blocking(move || -> Result<String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, body)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await?
}

/// The directory santree writes agent work-prompt files into, under the app's data
/// dir — never inside a repo checkout, so it can't surface in any worktree's
/// `git status`. Mirrors where `claude-hooks.json` lives. `None` when no writable
/// data dir resolves; the caller then launches without a prompt file.
pub fn prompts_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join("prompts"))
}

/// Best-effort delete of a worktree's on-disk prompt files — the work prompt and
/// the CI-fix prompt (missing is fine).
fn delete_prompt_file(prompts_root: &Path, repo_root: &str, issue_id: &str) {
    for path in [
        prompt_file_path(prompts_root, repo_root, issue_id),
        fix_ci_prompt_file_path(prompts_root, repo_root, issue_id),
    ]
    .into_iter()
    .flatten()
    {
        let _ = std::fs::remove_file(path);
    }
}

/// Render the agent's opening prompt for a freshly-started worktree, from the
/// `work` template (ticket id + title + implement instructions), write it to a
/// stable per-worktree file (see the module note above), and return that file's
/// **path**. The terminal seeds `exec <agent> 'Read <path> …'` with it. Cheap —
/// pure template render + one file write, no AI.
pub async fn work_prompt(
    db: &Db,
    repo: &str,
    issue_id: &str,
    prompts_root: &Path,
) -> Result<String> {
    let root = repo_root(db, repo).await?;
    let title: Option<String> =
        sqlx::query_scalar("SELECT title FROM worktree_links WHERE repo_path = ? AND issue_id = ?")
            .bind(&root)
            .bind(issue_id)
            .fetch_optional(db)
            .await?;

    // Resolve the effective prompt sources once (honoring app/repo overrides) —
    // reused to render both the embedded `issue` and the `work` prompt below.
    let sources = crate::prompts::resolve_sources(db, Some(repo)).await?;

    // Fetch the full ticket (description + comment thread) and render it the way
    // the CLI does, so the agent starts with real context instead of being told
    // to re-fetch via MCP. `triage_detail` fetches any issue by id, not just
    // triage ones. On any failure we leave `ticket_content` empty and the
    // template falls back to the MCP-fetch hint.
    let detail = match crate::linear::triage_detail(db, repo, issue_id).await {
        Ok(Some(detail)) => Some(detail),
        _ => None,
    };
    let ticket_content = detail
        .as_ref()
        .and_then(|d| crate::prompts::render_ticket_from(&sources, d).ok());
    // Also flatten the issue's fields into the context so a customized `work`
    // prompt can `{% include "issue" %}` directly, not only via `ticket_content`.
    let issue_ctx = detail
        .as_ref()
        .map(crate::prompts::issue_context)
        .unwrap_or_else(|| minijinja::context! {});

    // The user's per-task notes become the work prompt's `custom_context` — the
    // app's analog of the CLI's ad-hoc launch context.
    let custom_context = crate::notes::get(db, repo, issue_id)
        .await
        .ok()
        .flatten()
        .filter(|n| !n.trim().is_empty());

    let rendered = crate::prompts::render_from(
        &sources,
        "work",
        minijinja::context! {
            ticket_id => issue_id,
            title => title.unwrap_or_default(),
            ticket_content,
            custom_context,
            mode => "implement",
            ..issue_ctx,
        },
    )?
    .trim()
    .to_string();

    // Persist to a stable file and hand back its path (not the text) — the seed is
    // then the short `Read <path> …` line. Writing here (inside the launch fetch,
    // which pulled the live ticket above) is what keeps the file current: every
    // fresh launch re-renders from the latest Linear state and overwrites.
    let path = prompt_file_path(prompts_root, &root, issue_id)?;
    write_prompt_file(path, rendered).await
}

/// Render the CI-fix opening prompt — the failed check log plus the guardrails
/// (diagnose, fix, validate locally, and **never** commit/push) — to a stable
/// per-worktree file and return its **path**. Mirrors [`work_prompt`]: the log is
/// large, so the terminal seeds `Read <path> …` rather than typing it into the
/// PTY. Rewritten on every launch so it reflects the latest failing run.
pub async fn fix_ci_prompt(
    db: &Db,
    repo: &str,
    issue_id: &str,
    prompts_root: &Path,
    log: &str,
) -> Result<String> {
    validate_issue_id(issue_id)?;
    let root = repo_root(db, repo).await?;
    let title: Option<String> =
        sqlx::query_scalar("SELECT title FROM worktree_links WHERE repo_path = ? AND issue_id = ?")
            .bind(&root)
            .bind(issue_id)
            .fetch_optional(db)
            .await?;

    let rendered = crate::prompts::render(
        db,
        Some(repo),
        "fix-ci",
        minijinja::context! {
            ticket_id => issue_id,
            title => title.unwrap_or_default(),
            log_content => log,
        },
    )
    .await?
    .trim()
    .to_string();

    let path = fix_ci_prompt_file_path(prompts_root, &root, issue_id)?;
    write_prompt_file(path, rendered).await
}

// ── Setup script (.santree/init.sh) ──────────────────────────────────────────

fn init_script_path(repo_root: &str) -> PathBuf {
    Path::new(repo_root).join(".santree").join("init.sh")
}

/// Read the repo's `.santree/init.sh` for the Settings editor.
pub async fn init_script(db: &Db, repo: &str) -> Result<ScriptInfo> {
    let root = repo_root(db, repo).await?;
    let path = init_script_path(&root);
    Ok(tokio::task::spawn_blocking(move || ScriptInfo {
        exists: path.exists(),
        executable: is_executable(&path),
        content: std::fs::read_to_string(&path).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
    })
    .await?)
}

/// Write the repo's `.santree/init.sh`, creating `.santree/` if needed.
pub async fn set_init_script(db: &Db, repo: &str, content: &str) -> Result<()> {
    let root = repo_root(db, repo).await?;
    let path = init_script_path(&root);
    let content = content.to_string();
    tokio::task::spawn_blocking(move || -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, content)?;
        Ok(())
    })
    .await?
}

/// Mark `.santree/init.sh` executable (required for `run_setup_streamed` to run it).
pub async fn make_init_executable(db: &Db, repo: &str) -> Result<()> {
    let root = repo_root(db, repo).await?;
    let path = init_script_path(&root);
    tokio::task::spawn_blocking(move || {
        if !path.exists() {
            bail!("no init.sh to make executable");
        }
        set_executable(&path)
    })
    .await?
}

// ── Small helpers ─────────────────────────────────────────────────────────

/// Sum of additions/deletions of the branch vs its base (committed + uncommitted),
/// measured from the merge-base like a PR diff.
///
/// Trusts the stored `base_branch`: returns `(0, 0)` when it can't be resolved
/// rather than guessing a repo-wide default — for a stacked branch, diffing
/// against main/master would overcount by folding in the ancestors' changes. An
/// unresolvable base means the pointer is wrong and should be fixed (and `remove`
/// keeps it correct by re-pointing a removed branch's children to its own base).
fn branch_stats(cwd: &Path, base: &str) -> (u32, u32) {
    // Diff from the ref the worktree actually forked from (origin/<base>), not a
    // possibly-stale local <base> — see git::compare_base.
    let base = git::compare_base(cwd, base);
    let Ok(merge_base) = git::git(cwd, &["merge-base", &base, "HEAD"]) else {
        return (0, 0);
    };
    let Ok(raw) = git::git_output(cwd, &["diff", "--numstat", &merge_base]) else {
        return (0, 0);
    };
    raw.lines()
        .filter_map(git::parse_numstat_line)
        .fold((0, 0), |(a, d), (_, add, del, _)| (a + add, d + del))
}

/// Branch-name slug from an issue title (lowercase, dashed, capped) — matches
/// the CLI's `slugify`.
fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        if out.len() >= 40 {
            break;
        }
    }
    let slug = out.trim_matches('-');
    // A title with no ASCII alphanumerics (emoji- or CJK-only) slugs to empty,
    // which would make a trailing-dash branch git rejects — fall back to a stable
    // default so the branch name is always valid.
    if slug.is_empty() {
        "task".to_string()
    } else {
        slug.to_string()
    }
}

/// Parse the stored agent string. `None` when the row records no agent (or one this
/// build doesn't know) — the worktree simply reports no agent rather than claiming a
/// made-up one, and an unknown value never fails the whole list.
fn parse_agent(s: Option<&str>) -> Option<AgentKind> {
    s.and_then(|s| s.parse().ok())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    true
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(perms.mode() | 0o755);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use santree_core::domain::FileStatus;
    use std::process::Command;

    #[test]
    fn strip_ansi_removes_colour_codes() {
        assert_eq!(strip_ansi("\x1b[1;33m=== hi ===\x1b[0m"), "=== hi ===");
        assert_eq!(
            strip_ansi("\x1b[0;36m[Frontend]\x1b[0m go"),
            "[Frontend] go"
        );
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn strip_ansi_removes_osc_title_sequences() {
        // BEL-terminated OSC (the common case: window/tab title-setters).
        assert_eq!(
            strip_ansi("\x1b]0;building…\x07building project"),
            "building project"
        );
        // ST-terminated OSC (`ESC \`) — e.g. a terminal hyperlink sequence.
        assert_eq!(
            strip_ansi("\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\"),
            "link text"
        );
        // Mixed with CSI colour codes on the same line.
        assert_eq!(strip_ansi("\x1b]0;title\x07\x1b[32mgreen\x1b[0m"), "green");
    }

    fn line(text: &str) -> SetupEvent {
        SetupEvent::Line { text: text.into() }
    }
    fn progress(text: &str) -> SetupEvent {
        SetupEvent::Progress { text: text.into() }
    }

    #[test]
    fn drain_splits_newlines_and_holds_partials() {
        let mut acc = String::from("one\ntwo\nthr");
        assert_eq!(
            drain_setup_events(&mut acc, false),
            vec![line("one"), line("two")]
        );
        assert_eq!(acc, "thr", "partial line is held for the next read");
        acc.push_str("ee\n");
        assert_eq!(drain_setup_events(&mut acc, false), vec![line("three")]);
    }

    #[test]
    fn drain_treats_crlf_as_one_boundary() {
        let mut acc = String::from("a\r\nb\r\n");
        assert_eq!(
            drain_setup_events(&mut acc, false),
            vec![line("a"), line("b")]
        );
        assert!(acc.is_empty());
    }

    #[test]
    fn drain_emits_lone_cr_as_progress() {
        // A redrawing bar: each `\r`-terminated frame is a transient Progress; the
        // final, not-yet-terminated frame is held until more bytes arrive.
        let mut acc = String::from("10%\r20%\r30%");
        assert_eq!(
            drain_setup_events(&mut acc, false),
            vec![progress("10%"), progress("20%")]
        );
        assert_eq!(acc, "30%");
    }

    #[test]
    fn drain_holds_trailing_cr_until_disambiguated() {
        // `\r` arriving as the last byte must not be emitted yet — the next read may
        // reveal it was a `\r\n`, which is a single committed line, not Progress.
        let mut acc = String::from("done\r");
        assert_eq!(drain_setup_events(&mut acc, false), vec![]);
        assert_eq!(acc, "done\r", "trailing \\r is held");
        acc.push('\n');
        assert_eq!(drain_setup_events(&mut acc, false), vec![line("done")]);
        assert!(acc.is_empty());
    }

    #[test]
    fn drain_flush_emits_trailing_partial() {
        let mut acc = String::from("tail-no-newline");
        assert_eq!(drain_setup_events(&mut acc, false), vec![]);
        assert_eq!(
            drain_setup_events(&mut acc, true),
            vec![line("tail-no-newline")]
        );
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    /// A half-removed worktree (e.g. a delete interrupted by a hot-reload) must
    /// still clean up — `git worktree remove` fails fatally once the gitlink is
    /// gone, and the old code propagated that, wedging the worktree forever.
    #[test]
    fn remove_worktree_tolerates_half_removed_state() {
        let base = std::env::temp_dir().join(format!("santree-rm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo_dir = base.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        run_git(&repo_dir, &["init", "-b", "main"]);
        run_git(&repo_dir, &["config", "user.email", "t@t.test"]);
        run_git(&repo_dir, &["config", "user.name", "Test"]);
        std::fs::write(repo_dir.join("README.md"), "hello\n").unwrap();
        run_git(&repo_dir, &["add", "-A"]);
        run_git(&repo_dir, &["commit", "-m", "init"]);

        let wt = repo_dir.join(".santree/worktrees/AK-9");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        let wt_str = wt.to_string_lossy().into_owned();
        run_git(
            &repo_dir,
            &["worktree", "add", "-b", "santree/ak-9", &wt_str, "main"],
        );
        assert!(wt.exists());

        // Simulate the interrupted delete: drop the worktree's gitlink so git no
        // longer recognises it — `git worktree remove` now fails fatally.
        std::fs::remove_file(wt.join(".git")).unwrap();
        assert!(
            crate::git::git(&repo_dir, &["worktree", "remove", "--force", &wt_str]).is_err(),
            "precondition: git refuses to remove the half-broken worktree"
        );

        // Our removal tolerates it: dir gone, branch gone, Ok — and idempotent.
        crate::git::remove_worktree(&repo_dir, &wt, "santree/ak-9").unwrap();
        assert!(!wt.exists(), "worktree directory cleaned up");
        let branches = crate::git::git(&repo_dir, &["branch", "--list", "santree/ak-9"]).unwrap();
        assert!(branches.trim().is_empty(), "branch deleted");
        crate::git::remove_worktree(&repo_dir, &wt, "santree/ak-9").unwrap();

        let _ = std::fs::remove_dir_all(&base);
    }

    /// End-to-end: a real git repo + real SQLite, exercising the full start-task
    /// lifecycle — create worktree, record the link, then stage/commit and remove.
    /// (Running `.santree/init.sh` is a separate, streamed step — see
    /// `run_setup_streamed` — so it's no longer part of `create` and isn't
    /// exercised here.) This is the exact path the `create_worktree` /
    /// `commit_worktree` / `remove_worktree` commands drive, minus Tauri/Linear.
    #[tokio::test]
    async fn worktree_lifecycle_e2e() {
        let base = std::env::temp_dir().join(format!("santree-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo_dir = base.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();

        // A real git repo with one commit on `main`.
        run_git(&repo_dir, &["init", "-b", "main"]);
        run_git(&repo_dir, &["config", "user.email", "t@t.test"]);
        run_git(&repo_dir, &["config", "user.name", "Test"]);
        std::fs::write(repo_dir.join("README.md"), "hello\n").unwrap();
        run_git(&repo_dir, &["add", "-A"]);
        run_git(&repo_dir, &["commit", "-m", "init"]);

        // Real SQLite (migrations applied) with a repo row pointing at our git dir.
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        sqlx::query("INSERT INTO repos (name, tracker, path) VALUES ('test','Local git',?)")
            .bind(repo_dir.to_string_lossy().as_ref())
            .execute(&db)
            .await
            .unwrap();

        // 1. Create the worktree and record the link.
        let wt = create(
            &db,
            "test",
            "AK-1",
            "Do a thing",
            Some("Booking"),
            None,
            AgentKind::Claude,
            None,
        )
        .await
        .unwrap();
        assert_eq!(wt.id, "AK-1");
        assert!(
            !wt.setup_ran,
            "setup is a separate streamed step, not run by create"
        );
        // Nothing here knows the ticket's status, and no agent has run yet — report
        // neither rather than a placeholder. The chosen agent IS a real source.
        assert_eq!(wt.status, None);
        assert_eq!(wt.activity, None);
        assert_eq!(wt.agent, Some(AgentKind::Claude));
        // A branch that has never been pushed can't be behind its remote — `create`
        // says so without a doomed `git fetch origin <branch>` round-trip.
        assert_eq!(wt.remote_behind, 0);
        assert!(!wt.pull_conflict);
        let wt_dir = repo_dir.join(".santree/worktrees/AK-1");
        assert!(wt_dir.exists(), "worktree directory should exist");

        // The link is queryable.
        let listed = list(&db, "test").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].project.as_deref(), Some("Booking"));

        // Idempotent: creating again just returns the existing worktree (no error).
        let again = create(
            &db,
            "test",
            "AK-1",
            "Do a thing",
            None,
            None,
            AgentKind::Claude,
            None,
        )
        .await
        .unwrap();
        assert_eq!(again.id, "AK-1");
        assert_eq!(
            list(&db, "test").await.unwrap().len(),
            1,
            "no duplicate link"
        );

        // Adopt: drop the link but keep the on-disk worktree (mimics one made by
        // the CLI / a prior run), then create — it re-links and opens, not errors.
        sqlx::query("DELETE FROM worktree_links WHERE issue_id = 'AK-1'")
            .execute(&db)
            .await
            .unwrap();
        assert!(get(&db, "test", "AK-1").await.unwrap().is_none());
        let adopted = create(
            &db,
            "test",
            "AK-1",
            "Do a thing",
            None,
            None,
            AgentKind::Claude,
            None,
        )
        .await
        .unwrap();
        assert!(
            adopted.branch.contains("ak-1"),
            "adopted the real branch from git: {}",
            adopted.branch
        );
        assert!(
            get(&db, "test", "AK-1").await.unwrap().is_some(),
            "link re-created on adopt"
        );

        // 2. Make a change, see it in status, stage + commit, confirm clean.
        std::fs::write(wt_dir.join("new.txt"), "x\n").unwrap();
        let st = status(&db, "test", "AK-1").await.unwrap();
        let new_file = st
            .iter()
            .find(|f| f.path == "new.txt")
            .expect("new.txt in status");
        assert_eq!(new_file.status, FileStatus::Untracked);

        commit(&db, "test", "AK-1", "[AK-1] add file", true)
            .await
            .unwrap();
        assert!(
            status(&db, "test", "AK-1").await.unwrap().is_empty(),
            "clean after commit"
        );

        // A work-prompt file (normally written by `work_prompt` at launch) is
        // cleaned up on removal. Write one at the real path the removal recomputes.
        let prompts = base.join("prompts");
        let pfile =
            prompt_file_path(&prompts, repo_dir.to_string_lossy().as_ref(), "AK-1").unwrap();
        std::fs::create_dir_all(pfile.parent().unwrap()).unwrap();
        std::fs::write(&pfile, "prompt body").unwrap();

        // 3. Remove the worktree + link.
        remove(&db, "test", "AK-1", Some(&prompts)).await.unwrap();
        assert!(!wt_dir.exists(), "worktree directory should be gone");
        assert!(
            !pfile.exists(),
            "work-prompt file should be deleted with the worktree"
        );
        assert!(
            list(&db, "test").await.unwrap().is_empty(),
            "link should be gone"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// `remove`'s documented restacking behavior: in a stack `main → AK-1 → AK-2`,
    /// removing `AK-1` must re-point `AK-2`'s stored `base_branch` to `AK-1`'s OLD
    /// base (`main`), not leave it dangling on the now-deleted branch.
    #[tokio::test]
    async fn remove_restacks_children_onto_grandparent_base() {
        let base = std::env::temp_dir().join(format!("santree-restack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo_dir = base.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();

        run_git(&repo_dir, &["init", "-b", "main"]);
        run_git(&repo_dir, &["config", "user.email", "t@t.test"]);
        run_git(&repo_dir, &["config", "user.name", "Test"]);
        std::fs::write(repo_dir.join("README.md"), "hello\n").unwrap();
        run_git(&repo_dir, &["add", "-A"]);
        run_git(&repo_dir, &["commit", "-m", "init"]);

        let db = crate::db::init(base.join("test.db")).await.unwrap();
        sqlx::query("INSERT INTO repos (name, tracker, path) VALUES ('test','Local git',?)")
            .bind(repo_dir.to_string_lossy().as_ref())
            .execute(&db)
            .await
            .unwrap();

        // AK-1 branches off main.
        let ak1 = create(
            &db,
            "test",
            "AK-1",
            "First",
            None,
            None,
            AgentKind::Claude,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ak1.base_branch, "main");

        // AK-2 is stacked on AK-1's branch.
        let ak2 = create(
            &db,
            "test",
            "AK-2",
            "Second",
            None,
            Some(&ak1.branch),
            AgentKind::Claude,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ak2.base_branch, ak1.branch);

        // Removing AK-1 restacks AK-2 onto AK-1's own (old) base: main.
        remove(&db, "test", "AK-1", None).await.unwrap();
        let ak2_after = get(&db, "test", "AK-2").await.unwrap().unwrap();
        assert_eq!(
            ak2_after.base_branch, "main",
            "AK-2 should be re-pointed to AK-1's old base, not left on the deleted branch"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// `create` must not probe the remote: the branch it just cut has never been
    /// pushed, so `remote_behind`/`pull_conflict` are zero by construction and the
    /// `git fetch origin <branch>` is pure latency on every task start. Proven by
    /// planting a *pending* remote commit on the branch's name: `create` still says
    /// zero (it never looked), and the probing `get` path then reports it.
    #[tokio::test]
    async fn create_skips_the_remote_probe_and_get_reconciles() {
        let base = std::env::temp_dir().join(format!("santree-noprobe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo_dir = base.join("repo");
        let origin = base.join("origin.git");
        std::fs::create_dir_all(&repo_dir).unwrap();
        std::fs::create_dir_all(&origin).unwrap();

        run_git(&origin, &["init", "--bare", "-b", "main"]);
        run_git(&repo_dir, &["init", "-b", "main"]);
        run_git(&repo_dir, &["config", "user.email", "t@t.test"]);
        run_git(&repo_dir, &["config", "user.name", "Test"]);
        std::fs::write(repo_dir.join("README.md"), "hello\n").unwrap();
        run_git(&repo_dir, &["add", "-A"]);
        run_git(&repo_dir, &["commit", "-m", "init"]);
        run_git(
            &repo_dir,
            &["remote", "add", "origin", origin.to_string_lossy().as_ref()],
        );
        run_git(&repo_dir, &["push", "-u", "origin", "main"]);

        // Someone else already pushed a commit on the exact branch `create` will cut
        // (its name is derived from the issue id + title), so origin/<branch> is one
        // commit ahead of what the new worktree will check out.
        let branch = "santree/ak-3-remote-work";
        run_git(&repo_dir, &["checkout", "-b", branch]);
        std::fs::write(repo_dir.join("remote.txt"), "from elsewhere\n").unwrap();
        run_git(&repo_dir, &["add", "-A"]);
        run_git(&repo_dir, &["commit", "-m", "remote commit"]);
        run_git(&repo_dir, &["push", "origin", branch]);
        run_git(&repo_dir, &["checkout", "main"]);
        run_git(&repo_dir, &["branch", "-D", branch]);

        let db = crate::db::init(base.join("test.db")).await.unwrap();
        sqlx::query("INSERT INTO repos (name, tracker, path) VALUES ('test','Local git',?)")
            .bind(repo_dir.to_string_lossy().as_ref())
            .execute(&db)
            .await
            .unwrap();

        let wt = create(
            &db,
            "test",
            "AK-3",
            "Remote work",
            None,
            None,
            AgentKind::Claude,
            None,
        )
        .await
        .unwrap();
        assert_eq!(wt.branch, branch);
        assert_eq!(
            wt.remote_behind, 0,
            "create reports the branch as local-only — it never probed the remote"
        );
        assert!(!wt.pull_conflict);

        // The probing path sees what's really on origin, so nothing is lost.
        let fetched = get(&db, "test", "AK-3").await.unwrap().unwrap();
        assert_eq!(
            fetched.remote_behind, 1,
            "the pending remote commit lands on the next refresh"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The prompt-file path is a filesystem sink for an IPC-supplied `issue_id`: a
    /// traversing id must be rejected *there*, not left to each caller to remember
    /// (`work_prompt` didn't — and wrote an arbitrary `.md` outside the data dir).
    #[test]
    fn prompt_paths_reject_traversing_issue_ids() {
        let root = Path::new("/tmp/prompts");
        for bad in ["../../evil", "..", "/etc/passwd", "a/b", ""] {
            assert!(
                prompt_file_path(root, "/repo", bad).is_err(),
                "work-prompt path should reject issue id {bad:?}"
            );
            assert!(
                fix_ci_prompt_file_path(root, "/repo", bad).is_err(),
                "CI-fix prompt path should reject issue id {bad:?}"
            );
        }

        // A normal id still resolves under <prompts_root>/<repo-key>/.
        let ok = prompt_file_path(root, "/repo", "AK-1").unwrap();
        assert_eq!(ok.file_name().unwrap(), "AK-1.md");
        assert!(ok.starts_with(root));
    }

    /// Two creates for the same issue can both get past `create`'s "already tracked?"
    /// check while the (slow) git work runs — the second insert must adopt the first's
    /// row instead of blowing up on the primary key.
    #[tokio::test]
    async fn insert_link_is_idempotent_under_a_race() {
        let base = std::env::temp_dir().join(format!("santree-insert-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        let row = |branch: &str| LinkRow {
            issue_id: "AK-1".into(),
            title: "First".into(),
            project: None,
            branch: branch.into(),
            worktree_path: "/repo/.santree/worktrees/AK-1".into(),
            base_branch: "main".into(),
            agent: Some("Claude".into()),
            setup_ran: 0,
        };

        assert!(insert_link(&db, "/repo", &row("winner")).await.unwrap());
        // The loser's insert is a no-op — reported as such, not an error.
        assert!(!insert_link(&db, "/repo", &row("loser")).await.unwrap());

        let stored = link_row(&db, "/repo", "AK-1").await.unwrap().unwrap();
        assert_eq!(stored.branch, "winner", "the winner's row is left intact");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn slugify_cases() {
        // (title, expected slug)
        let cases: &[(&str, &str)] = &[
            ("Fix the login bug", "fix-the-login-bug"),
            // Emoji-only title has no ASCII alphanumerics — falls back to "task"
            // rather than slugging to an empty (trailing-dash) string.
            ("🎉🚀✨", "task"),
            // CJK-only title — same fallback, since `is_ascii_alphanumeric` never
            // matches non-ASCII scripts.
            ("修复登录错误", "task"),
        ];
        for (title, expected) in cases {
            assert_eq!(slugify(title), *expected, "title: {title:?}");
        }

        // A 60+ char title is capped at 40 chars.
        let long_title = "a".repeat(60);
        let slug = slugify(&long_title);
        assert_eq!(slug.len(), 40, "slug capped at 40 chars");
        assert_eq!(slug, "a".repeat(40));
    }
}
