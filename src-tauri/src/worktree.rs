//! Worktree orchestration: the issue ↔ worktree lifecycle the Trees view drives.
//!
//! This is the live counterpart to the santree CLI's dashboard "start a task"
//! flow (create worktree → run `.santree/init.sh` → launch an agent), plus the
//! commit-box operations. The issue ↔ worktree relationship is stored in the
//! `worktree_links` table (keyed by repo + issue id) rather than inferred from
//! the branch name. Git itself is driven through [`crate::git`].

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;

use santree_core::domain::{
    Activity, AgentKind, ChangedFile, FileSource, ScriptInfo, TaskStatus, Worktree,
};

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

/// A stored issue ↔ worktree link's git coordinates, hydrated from
/// `worktree_links`. The `list` query reads the full row separately; this is
/// only what the single-worktree operations need to find the directory.
struct Link {
    branch: String,
    worktree_path: String,
}

/// A full `worktree_links` row, hydrated for building a `Worktree` (list/get).
/// One `FromRow` struct so the column list isn't spelled out as a tuple twice.
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
/// commit box. `None` when the repo has no local path (a seed/demo repo).
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
            status: TaskStatus::InProgress,
            // The base IS its own base, so there's no diff to summarise.
            add_lines: 0,
            del_lines: 0,
            dirty: git::is_dirty(&p),
            ahead: 0,
            behind: git::behind(&p, &base),
            unpushed: git::unpushed(&p, &base, &base),
            agent: AgentKind::Claude,
            activity: Activity::Idle,
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

/// Build a `Worktree` (with live git stats) from a stored link row.
fn build_worktree(row: LinkRow) -> Worktree {
    let path = PathBuf::from(&row.worktree_path);
    let (add_lines, del_lines) = branch_stats(&path, &row.base_branch);
    Worktree {
        id: row.issue_id,
        title: row.title,
        status: TaskStatus::InProgress,
        add_lines,
        del_lines,
        dirty: git::is_dirty(&path),
        ahead: git::ahead(&path, &row.base_branch),
        behind: git::behind(&path, &row.base_branch),
        unpushed: git::unpushed(&path, &row.branch, &row.base_branch),
        agent: parse_agent(row.agent.as_deref()),
        // Live agent activity needs the session-signal system (not yet wired);
        // default to Idle until then.
        activity: Activity::Idle,
        branch: row.branch,
        path: row.worktree_path,
        project: row.project,
        base_branch: row.base_branch,
        setup_ran: row.setup_ran != 0,
        pending: false,
    }
}

/// The tracked worktree for one issue (with live stats), or `None` if untracked.
pub async fn get(db: &Db, repo: &str, issue_id: &str) -> Result<Option<Worktree>> {
    let root = repo_root(db, repo).await?;
    let row = sqlx::query_as::<_, LinkRow>(&format!(
        "SELECT {LINK_COLUMNS} FROM worktree_links WHERE repo_path = ? AND issue_id = ?"
    ))
    .bind(&root)
    .bind(issue_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(
        tokio::task::spawn_blocking(move || build_worktree(row)).await?,
    ))
}

/// Create (or adopt) a worktree for an issue and record the link.
///
/// Idempotent: if the issue is already tracked it's just returned; if a worktree
/// directory already exists on disk but isn't tracked (e.g. it was created by the
/// santree CLI or a prior run) it's *adopted* — linked and opened — rather than
/// failing. Only a genuinely new worktree is branched off the base and gets its
/// setup script run.
#[allow(clippy::too_many_arguments)]
pub async fn create(
    db: &Db,
    repo: &str,
    issue_id: &str,
    title: &str,
    project: Option<&str>,
    base: Option<&str>,
    run_setup: bool,
    agent: AgentKind,
) -> Result<Worktree> {
    let root = repo_root(db, repo).await?;

    // Already tracked → just open it.
    if let Some(existing) = get(db, repo, issue_id).await? {
        return Ok(existing);
    }

    // The git work (branch resolution, `worktree add`, fetch) and `.santree/init.sh`
    // (which can run for minutes) are all blocking — run them off the async runtime.
    let (base_branch, branch, setup_ran, wt_path_str) = {
        let root = root.clone();
        let issue_id = issue_id.to_string();
        let title = title.to_string();
        let base = base.map(str::to_string);
        tokio::task::spawn_blocking(move || -> Result<_> {
            let root_path = Path::new(&root);
            let base_branch = match base {
                Some(b) => b,
                None => git::default_branch(root_path),
            };
            let wt_path = root_path.join(".santree").join("worktrees").join(&issue_id);
            let computed_branch =
                format!("santree/{}-{}", issue_id.to_lowercase(), slugify(&title));

            let mut setup_ran = false;
            let branch = if wt_path.exists() {
                // Adopt a pre-existing worktree: reuse its real branch (from git) when
                // it is a registered worktree, else fall back to the computed name.
                log::info!(
                    "adopting existing worktree {issue_id} at {}",
                    wt_path.display()
                );
                git::worktree_branch(root_path, &wt_path).unwrap_or(computed_branch)
            } else {
                git::create_worktree(root_path, &wt_path, &computed_branch, &base_branch)?;
                if run_setup {
                    // Setup failure is non-fatal — the worktree still exists; surface
                    // it and leave `setup_ran` false so the UI offers a re-run.
                    match run_init_script(root_path, &wt_path) {
                        Ok(_) => setup_ran = true,
                        Err(e) => log::warn!("init.sh failed for {issue_id}: {e}"),
                    }
                }
                log::info!("created worktree {issue_id} on branch {computed_branch}");
                computed_branch
            };
            Ok((
                base_branch,
                branch,
                setup_ran,
                wt_path.to_string_lossy().into_owned(),
            ))
        })
        .await??
    };

    sqlx::query(
        "INSERT INTO worktree_links
            (repo_path, issue_id, title, project, branch, worktree_path, base_branch, agent, setup_ran)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&root)
    .bind(issue_id)
    .bind(title)
    .bind(project)
    .bind(&branch)
    .bind(&wt_path_str)
    .bind(&base_branch)
    .bind(agent.as_str())
    .bind(setup_ran as i64)
    .execute(db)
    .await?;

    // If opted in, reflect the new work in Linear by moving the issue to its
    // "started" state. Best-effort — never fail the worktree create over it.
    let move_in_progress = crate::settings::get(db, "app", "work_move_in_progress")
        .await
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    if move_in_progress {
        if let Err(e) = crate::linear::move_issue_to_started(db, repo, issue_id).await {
            log::warn!("couldn't move issue {issue_id} to In Progress: {e}");
        }
    }

    get(db, repo, issue_id)
        .await?
        .ok_or_else(|| anyhow!("worktree {issue_id} missing after create"))
}

/// Remove a worktree (and its branch) and drop the link.
///
/// Restacks any children: a worktree stacked on the removed branch is re-pointed
/// to the removed branch's *own* base. So in `master → b1 → b2 → b3`, removing
/// `b2` (e.g. after its PR merged into `b1`) re-points `b3` to `b1` — not to
/// master. This keeps each stacked worktree's `base_branch` (and therefore its PR
/// base / diff) correct as intermediate branches land, walking one hop per removal
/// up the chain.
pub async fn remove(db: &Db, repo: &str, issue_id: &str) -> Result<()> {
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
        tokio::task::spawn_blocking(move || {
            git::remove_worktree(Path::new(&root), Path::new(&worktree_path), &branch)
        })
        .await??;
    }
    sqlx::query("DELETE FROM worktree_links WHERE repo_path = ? AND issue_id = ?")
        .bind(&root)
        .bind(issue_id)
        .execute(db)
        .await?;
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

    let ev = on_event.clone();
    let root_for_script = root.clone();
    let ok = tokio::task::spawn_blocking(move || {
        stream_init_script(&script, &wt_path, &root_for_script, &ev)
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
fn stream_init_script(script: &Path, wt: &Path, root: &str, ev: &Channel<SetupEvent>) -> bool {
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
            return false;
        }
    };

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
    let _ = ev.send(SetupEvent::Line {
        text: format!("▸ setup {}", if ok { "complete" } else { "failed" }),
    });
    ok
}

/// Strip ANSI escape sequences (colour/SGR + other CSI) from a line so the
/// plain-text setup log shows clean text instead of raw `\x1b[…m` codes.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // ESC `[` … <final byte 0x40–0x7e> (CSI, e.g. colours); other escapes
        // (e.g. ESC `]` OSC) — drop the escape and the following intro byte.
        if chars.peek() == Some(&'[') {
            chars.next();
            while let Some(&nc) = chars.peek() {
                chars.next();
                if ('@'..='~').contains(&nc) {
                    break;
                }
            }
        } else {
            chars.next();
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
    let prompt = crate::prompts::render(
        "fill-commit",
        minijinja::context! {
            branch_name => branch,
            ticket_id => issue_id,
            diff_content => diff,
        },
    )?;

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

/// Render the agent's opening prompt for a freshly-started worktree, from the
/// `work` template (ticket id + title + implement instructions). The terminal
/// seeds `exec <agent> '<prompt>'` with this. Cheap — pure template render, no AI.
pub async fn work_prompt(db: &Db, repo: &str, issue_id: &str) -> Result<String> {
    let root = repo_root(db, repo).await?;
    let title: Option<String> =
        sqlx::query_scalar("SELECT title FROM worktree_links WHERE repo_path = ? AND issue_id = ?")
            .bind(&root)
            .bind(issue_id)
            .fetch_optional(db)
            .await?;

    // Fetch the full ticket (description + comment thread) and render it the way
    // the CLI does, so the agent starts with real context instead of being told
    // to re-fetch via MCP. `triage_detail` fetches any issue by id, not just
    // triage ones. On any failure we leave `ticket_content` empty and the
    // template falls back to the MCP-fetch hint.
    let ticket_content = match crate::linear::triage_detail(db, repo, issue_id).await {
        Ok(Some(detail)) => crate::prompts::render_ticket(&detail).ok(),
        _ => None,
    };

    // The user's per-task notes become the work prompt's `custom_context` — the
    // app's analog of the CLI's ad-hoc launch context.
    let custom_context = crate::notes::get(db, repo, issue_id)
        .await
        .ok()
        .flatten()
        .filter(|n| !n.trim().is_empty());

    crate::prompts::render(
        "work",
        minijinja::context! {
            ticket_id => issue_id,
            title => title.unwrap_or_default(),
            ticket_content,
            custom_context,
            mode => "implement",
        },
    )
    .map(|s| s.trim().to_string())
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

/// Mark `.santree/init.sh` executable (so it runs on worktree creation).
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

/// Run `.santree/init.sh` in the worktree, with the same env the CLI passes,
/// returning its combined stdout+stderr. Errors when the script is missing or
/// not executable.
fn run_init_script(repo_root: &Path, worktree_path: &Path) -> Result<String> {
    let script = repo_root.join(".santree").join("init.sh");
    if !script.exists() {
        bail!("no .santree/init.sh in this repo");
    }
    if !is_executable(&script) {
        bail!("init.sh is not executable");
    }
    let out = std::process::Command::new(&script)
        .current_dir(worktree_path)
        .env("SANTREE_WORKTREE_PATH", worktree_path)
        .env("SANTREE_REPO_ROOT", repo_root)
        .output()
        .map_err(|e| anyhow!("failed to run init.sh: {e}"))?;
    let mut log = String::from_utf8_lossy(&out.stdout).into_owned();
    log.push_str(&String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        bail!("init.sh exited with {}:\n{log}", out.status);
    }
    Ok(log)
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
    let Ok(merge_base) = git::git(cwd, &["merge-base", base, "HEAD"]) else {
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

/// Parse a stored agent string, defaulting to Claude for missing/unknown values
/// (e.g. a row written by an older build) rather than failing the whole list.
fn parse_agent(s: Option<&str>) -> AgentKind {
    s.and_then(|s| s.parse().ok()).unwrap_or(AgentKind::Claude)
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
    /// lifecycle — create worktree, run the setup script, record the link, then
    /// stage/commit and remove. This is the exact path the `create_worktree` /
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

        // A setup script that drops a marker so we can prove it ran.
        let santree = repo_dir.join(".santree");
        std::fs::create_dir_all(&santree).unwrap();
        let script = santree.join("init.sh");
        std::fs::write(&script, "#!/usr/bin/env bash\ntouch setup-ran\n").unwrap();
        set_executable(&script).unwrap();

        // Real SQLite (migrations applied) with a repo row pointing at our git dir.
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        sqlx::query(
            "INSERT INTO repos (name, tracker, agents, path) VALUES ('test','Local git',0,?)",
        )
        .bind(repo_dir.to_string_lossy().as_ref())
        .execute(&db)
        .await
        .unwrap();

        // 1. Create the worktree + run setup + record the link.
        let wt = create(
            &db,
            "test",
            "AK-1",
            "Do a thing",
            Some("Booking"),
            None,
            true,
            AgentKind::Claude,
        )
        .await
        .unwrap();
        assert_eq!(wt.id, "AK-1");
        assert!(wt.setup_ran, "setup should have run");
        let wt_dir = repo_dir.join(".santree/worktrees/AK-1");
        assert!(wt_dir.exists(), "worktree directory should exist");
        assert!(
            wt_dir.join("setup-ran").exists(),
            "init.sh should have run in the worktree"
        );

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
            false,
            AgentKind::Claude,
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
            false,
            AgentKind::Claude,
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
        // (`setup-ran` from init.sh is also an untracked change, so we look up
        // our file by path rather than asserting an exact count.)
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

        // 3. Remove the worktree + link.
        remove(&db, "test", "AK-1").await.unwrap();
        assert!(!wt_dir.exists(), "worktree directory should be gone");
        assert!(
            list(&db, "test").await.unwrap().is_empty(),
            "link should be gone"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
