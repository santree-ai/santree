//! Resource usage of the processes santree owns — the Resource Manager's data.
//!
//! One host-wide `ps` listing (from the shared [`crate::proc_table`] snapshot,
//! which agent detection reads too), parsed into a parent→children tree; each
//! PTY session's root pid (from [`PtyManager::sessions`]) is then summed with all
//! its descendants, and the app's own process gets whatever is left of its
//! subtree once the terminals are carved out. Read-only and input-free: nothing
//! here takes an IPC value, the `ps` argv is a constant, and no process is
//! signalled, written to or inspected beyond the columns `ps` prints.
//!
//! Terminals are grouped by the directory they started in, joined against the
//! repo registry and worktree links (the backend never learns which tab opened a
//! PTY — the frontend keys that by the session id this returns).
//!
//! Both figures are approximations, and the honest move is to ship the
//! denominator alongside them rather than to launder them into something that
//! looks exact:
//!
//! * **CPU** is `ps`'s `pcpu` — percent of *one* core, and on Darwin a decaying
//!   average over the process's lifetime rather than an instantaneous sample.
//!   Summed over a hot tree it reaches the hundreds, which is why
//!   [`ResourceUsage::core_count`] goes on the wire with it: the ceiling is
//!   `100 * cores`, and the frontend renders the share of the whole machine.
//!   A true delta would mean sampling cpu-time twice and holding state between
//!   calls; the decay bias is small next to a missing denominator, so this
//!   trades that accuracy for a number that needs no cache to be correct.
//! * **Memory** is summed RSS, and a page mapped by two processes is resident in
//!   both — a shared library, or a forked child before it writes. Nothing
//!   cheaply available fixes that for a whole tree (macOS's `phys_footprint`
//!   and Linux's `smaps_rollup` `Pss` are per-process syscalls/reads, and
//!   measured on this app `phys_footprint` came within 2% of RSS anyway), so
//!   the sum stands and the UI says what it is.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Result;
use santree_core::domain::{RepoUsage, ResourceUsage, TerminalUsage, WorktreeUsage};
use santree_pty::{PtyManager, SessionInfo};

use crate::db::{self, Db};
use crate::proc_table::{Proc, ProcTree};
use crate::worktree::BASE_ID;

/// Logical cores, the denominator that makes a summed `pcpu` mean anything: on
/// a 14-core machine `ps` will happily report 800% for one hot process tree,
/// which is not impossible, just unreadable without knowing the ceiling is
/// 1400%. `available_parallelism` is the honest number on both platforms — it
/// respects a cgroup quota or a CPU affinity mask, which is the real ceiling
/// for our children — and it cannot return zero. It falls back to one core if
/// the OS refuses to answer, which understates the denominator rather than
/// dividing by nothing.
fn core_count() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
}

/// What one process subtree adds up to.
#[derive(Debug, Default, Clone, PartialEq)]
struct Subtree {
    cpu_pct: f64,
    rss_bytes: f64,
    /// The name of the heaviest (resident) process in the subtree — what the
    /// terminal is actually running.
    heaviest: Option<String>,
}

/// Every process in `root`'s subtree, without descending into `stop` — the same
/// walk [`subtree`] sums, kept as individual rows. Heaviest first; `root` is
/// always first regardless, because it is the process the subtree is *about* and
/// a helper outweighing it doesn't change that.
fn subtree_procs<'a>(tree: &'a ProcTree, root: u32, stop: &HashSet<u32>) -> Vec<&'a Proc> {
    let mut out: Vec<&Proc> = tree
        .descend(root, stop)
        .into_iter()
        .map(|(_, p)| p)
        .collect();
    out.sort_by(|a, b| match (a.pid == root, b.pid == root) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => b.rss_bytes.total_cmp(&a.rss_bytes),
    });
    out
}

/// Sum `root` and every descendant, without descending into `stop` (pids whose
/// subtrees are accounted for elsewhere).
fn subtree(tree: &ProcTree, root: u32, stop: &HashSet<u32>) -> Subtree {
    let mut total = Subtree::default();
    let mut heaviest_rss = -1.0;
    for (_, p) in tree.descend(root, stop) {
        total.cpu_pct += p.cpu_pct;
        total.rss_bytes += p.rss_bytes;
        if p.rss_bytes > heaviest_rss {
            heaviest_rss = p.rss_bytes;
            total.heaviest = Some(p.name.clone());
        }
    }
    total
}

/// A registered repo's root, canonicalised for comparison.
struct RepoRef {
    name: String,
    root: PathBuf,
}

/// A linked worktree, canonicalised likewise.
struct LinkRef {
    repo_root: PathBuf,
    issue_id: String,
    title: String,
    path: PathBuf,
}

/// Where a terminal's cwd puts it in the repo → worktree tree.
#[derive(Debug, PartialEq, Eq)]
struct Placement {
    repo: String,
    worktree_id: String,
    label: String,
}

/// Resolve a cwd against the registry: a linked worktree's exact path wins, then
/// a repo root (the base entry), then any directory inside a root (a review
/// checkout, a sub-folder the user `cd`'d a shell into) keyed by its relative
/// path. A cwd outside every registered repo is its own group, named by the
/// directory — real data, not a placeholder. Roots are tried longest-first so a
/// repo nested inside another attributes to the inner one. Comparison is on
/// canonical paths component-wise (`strip_prefix`), never a string prefix.
fn place(cwd: &Path, repos: &[RepoRef], links: &[LinkRef]) -> Placement {
    let repo_name = |root: &Path| {
        repos
            .iter()
            .find(|r| r.root == root)
            .map(|r| r.name.clone())
            .unwrap_or_else(|| root.to_string_lossy().into_owned())
    };
    if let Some(link) = links.iter().find(|l| l.path == cwd) {
        return Placement {
            repo: repo_name(&link.repo_root),
            worktree_id: link.issue_id.clone(),
            label: if link.title.is_empty() {
                link.issue_id.clone()
            } else {
                link.title.clone()
            },
        };
    }
    for repo in repos {
        if repo.root == cwd {
            return Placement {
                repo: repo.name.clone(),
                worktree_id: BASE_ID.to_string(),
                label: repo
                    .root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| repo.name.clone()),
            };
        }
        if let Ok(rel) = cwd.strip_prefix(&repo.root) {
            let rel = rel.to_string_lossy().into_owned();
            return Placement {
                repo: repo.name.clone(),
                worktree_id: rel.clone(),
                label: rel,
            };
        }
    }
    let dir = cwd.to_string_lossy().into_owned();
    Placement {
        repo: dir.clone(),
        worktree_id: dir.clone(),
        label: dir,
    }
}

/// The repo roots and worktree links to place terminals against. Canonicalised
/// here (a stored path may be a symlink or spelled differently from the pty's
/// cwd); a path that no longer exists is kept as stored so a terminal still
/// running in a deleted worktree isn't orphaned to its own group.
async fn registry(db: &Db) -> Result<(Vec<RepoRef>, Vec<LinkRef>)> {
    let repos: Vec<(String, String)> =
        sqlx::query_as("SELECT name, path FROM repos WHERE path IS NOT NULL")
            .fetch_all(db)
            .await?;
    let links: Vec<(String, String, String, String)> =
        sqlx::query_as("SELECT repo_path, issue_id, title, worktree_path FROM worktree_links")
            .fetch_all(db)
            .await?;
    Ok(tokio::task::spawn_blocking(move || {
        let mut repos: Vec<RepoRef> = repos
            .into_iter()
            .map(|(name, path)| RepoRef {
                name,
                root: canonical(&path),
            })
            .collect();
        repos.sort_by_key(|r| std::cmp::Reverse(r.root.as_os_str().len()));
        let links = links
            .into_iter()
            .map(|(repo_path, issue_id, title, worktree_path)| LinkRef {
                repo_root: canonical(&repo_path),
                issue_id,
                title,
                path: canonical(&worktree_path),
            })
            .collect();
        (repos, links)
    })
    .await?)
}

fn canonical(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

/// The snapshot: every PTY session's subtree placed under its repo/worktree, plus
/// the app's own process. Nothing here pins a runtime worker: the `ps` is async
/// I/O, and both CPU hops — parsing the listing and canonicalising the registry —
/// run on the blocking pool (see [`crate::proc_table::snapshot`]).
pub async fn resource_usage(db: &Db, manager: &PtyManager) -> Result<ResourceUsage> {
    let sessions = manager.sessions();
    let (repos, links) = registry(db).await?;
    let tree = crate::proc_table::snapshot().await?;
    Ok(assemble(
        &tree,
        sessions,
        std::process::id(),
        &repos,
        &links,
        db::now_ms() as f64,
        core_count(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    tree: &ProcTree,
    sessions: Vec<SessionInfo>,
    app_pid: u32,
    repos: &[RepoRef],
    links: &[LinkRef],
    sampled_at_ms: f64,
    core_count: u32,
) -> ResourceUsage {
    // Each terminal's root is carved out of the app's subtree (they're its
    // children), so the app entry counts only itself and its non-terminal helpers.
    let roots: HashSet<u32> = sessions.iter().filter_map(|s| s.pid).collect();
    let none = HashSet::new();

    // repo → worktree id → (label, terminals)
    let mut groups: HashMap<String, HashMap<String, (String, Vec<TerminalUsage>)>> = HashMap::new();
    for session in sessions {
        let Some(pid) = session.pid else {
            continue; // no pid to account for: nothing to show
        };
        let live = tree.live(pid);
        let sub = if live {
            subtree(tree, pid, &none)
        } else {
            Subtree::default()
        };
        let label = sub.heaviest.clone().unwrap_or_else(|| {
            // Nothing alive to name: say what was spawned.
            Path::new(&session.command)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| session.command.clone())
        });
        let cwd = canonical(session.cwd.as_deref().unwrap_or_default());
        let placement = place(&cwd, repos, links);
        groups
            .entry(placement.repo)
            .or_default()
            .entry(placement.worktree_id)
            .or_insert_with(|| (placement.label, Vec::new()))
            .1
            .push(TerminalUsage {
                session_id: Some(session.id),
                label,
                pid,
                cpu_pct: sub.cpu_pct,
                rss_bytes: sub.rss_bytes,
                live,
            });
    }

    let mut out: Vec<RepoUsage> = groups
        .into_iter()
        .map(|(repo, worktrees)| {
            let mut worktrees: Vec<WorktreeUsage> = worktrees
                .into_iter()
                .map(|(id, (label, mut terminals))| {
                    terminals.sort_by(|a, b| b.rss_bytes.total_cmp(&a.rss_bytes));
                    WorktreeUsage {
                        id,
                        label,
                        cpu_pct: terminals.iter().map(|t| t.cpu_pct).sum(),
                        rss_bytes: terminals.iter().map(|t| t.rss_bytes).sum(),
                        terminals,
                    }
                })
                .collect();
            worktrees.sort_by(|a, b| b.rss_bytes.total_cmp(&a.rss_bytes));
            RepoUsage {
                repo,
                cpu_pct: worktrees.iter().map(|w| w.cpu_pct).sum(),
                rss_bytes: worktrees.iter().map(|w| w.rss_bytes).sum(),
                worktrees,
            }
        })
        .collect();

    // santree itself: the app process and its helpers (`codex app-server`,
    // `caffeinate`, git, setup scripts...), minus the terminals above.
    //
    // Listed one process per row rather than as a single summed line: "the app is
    // using N GB" is not an answer you can act on, and the row that matters is
    // almost always a helper — a language server, a stuck `git`, the Codex app
    // server — that a total hides completely.
    //
    // What is NOT here, and cannot be: the WKWebView content/GPU/network
    // processes. macOS spawns them from launchd, so they are not our children,
    // carry no argument naming their client, and `ps` exposes no responsible-pid
    // column to join on — there is no sound way to tell ours from another
    // WebKit app's in a process-table scan. Rather than guess, this reports the
    // side it can prove.
    let app = subtree(tree, app_pid, &roots);
    let app_name = tree
        .get(app_pid)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "santree".to_string());
    let processes: Vec<TerminalUsage> = subtree_procs(tree, app_pid, &roots)
        .into_iter()
        .map(|p| TerminalUsage {
            // `None`: these are processes, not PTY sessions — the frontend keys
            // its tab labels off a session id and must not find one here.
            session_id: None,
            label: p.name.clone(),
            pid: p.pid,
            cpu_pct: p.cpu_pct,
            rss_bytes: p.rss_bytes,
            live: !p.zombie,
        })
        .collect();
    out.push(RepoUsage {
        repo: "santree".to_string(),
        cpu_pct: app.cpu_pct,
        rss_bytes: app.rss_bytes,
        worktrees: vec![WorktreeUsage {
            id: "santree".to_string(),
            label: app_name,
            cpu_pct: app.cpu_pct,
            rss_bytes: app.rss_bytes,
            terminals: processes,
        }],
    });

    out.sort_by(|a, b| b.rss_bytes.total_cmp(&a.rss_bytes));
    ResourceUsage {
        sampled_at_ms,
        core_count,
        total_rss_bytes: out.iter().map(|r| r.rss_bytes).sum(),
        total_cpu_pct: out.iter().map(|r| r.cpu_pct).sum(),
        repos: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc_table::parse_ps;

    /// The columns `proc_table` selects. Parsing is tested there; this fixture
    /// only has to be a plausible host for the accounting below.
    const LISTING: &str = "\
    1     0   0.0  24688 Ss   /sbin/launchd
  100     1   1.5  50000 S    /Applications/santree.app/Contents/MacOS/santree
  200   100   0.0   4000 S    /bin/zsh
  201   200  12.5 300000 R+   /opt/homebrew/bin/claude
  202   201   0.5  20000 S    /usr/local/bin/node
  210   100   0.0   3000 Z    /bin/zsh
  300     1   0.0   5000 S    /Applications/Other.app/Contents/MacOS/Other
  400   100   2.0  10000 S    /opt/homebrew/bin/codex
    x     y   0.0      0 S    junk
  500   100   abc    100 S    /bin/bad-cpu
  600   100   0.0
";

    /// A terminal's figures are its whole subtree; the app's are its subtree
    /// minus the terminals it hosts; a dead root reports nothing.
    #[test]
    fn subtree_sums_descendants_and_stops_at_carved_out_roots() {
        let tree = ProcTree::new(parse_ps(LISTING));

        let terminal = subtree(&tree, 200, &HashSet::new());
        assert_eq!(terminal.cpu_pct, 13.0);
        assert_eq!(terminal.rss_bytes, (4000.0 + 300_000.0 + 20_000.0) * 1024.0);
        assert_eq!(terminal.heaviest.as_deref(), Some("claude"));

        let app = subtree(&tree, 100, &HashSet::from([200, 210]));
        assert_eq!(app.cpu_pct, 1.5 + 2.0, "santree + codex, not the terminal");
        assert_eq!(app.rss_bytes, (50_000.0 + 10_000.0) * 1024.0);
        assert_eq!(app.heaviest.as_deref(), Some("santree"));

        assert!(tree.live(200));
        assert!(!tree.live(210), "a zombie is not live");
        assert!(!tree.live(999), "a vanished pid is not live");
        assert_eq!(subtree(&tree, 999, &HashSet::new()), Subtree::default());
    }

    /// The cwd → group resolution order, and that containment is component-wise.
    #[test]
    fn place_prefers_worktree_then_root_then_containment() {
        let repos = vec![
            RepoRef {
                name: "acme/app".into(),
                root: PathBuf::from("/code/app"),
            },
            RepoRef {
                name: "acme/app-nested".into(),
                root: PathBuf::from("/code/app/vendor/nested"),
            },
        ];
        let links = vec![LinkRef {
            repo_root: PathBuf::from("/code/app"),
            issue_id: "AK-1".into(),
            title: "Fix login".into(),
            path: PathBuf::from("/code/app-worktrees/AK-1"),
        }];
        // Longest root first, as `registry` orders them.
        let mut repos = repos;
        repos.sort_by_key(|r| std::cmp::Reverse(r.root.as_os_str().len()));

        assert_eq!(
            place(Path::new("/code/app-worktrees/AK-1"), &repos, &links),
            Placement {
                repo: "acme/app".into(),
                worktree_id: "AK-1".into(),
                label: "Fix login".into(),
            }
        );
        assert_eq!(
            place(Path::new("/code/app"), &repos, &links),
            Placement {
                repo: "acme/app".into(),
                worktree_id: BASE_ID.into(),
                label: "app".into(),
            }
        );
        assert_eq!(
            place(
                Path::new("/code/app/.santree/reviews/acme-app-7"),
                &repos,
                &links
            ),
            Placement {
                repo: "acme/app".into(),
                worktree_id: ".santree/reviews/acme-app-7".into(),
                label: ".santree/reviews/acme-app-7".into(),
            }
        );
        // Inside the nested repo → the nested repo, not the outer one.
        assert_eq!(
            place(Path::new("/code/app/vendor/nested/src"), &repos, &links).repo,
            "acme/app-nested"
        );
        // `/code/app-worktrees` shares a string prefix with `/code/app` but is not
        // inside it: it's its own group.
        assert_eq!(
            place(Path::new("/code/app-worktrees/scratch"), &repos, &links),
            Placement {
                repo: "/code/app-worktrees/scratch".into(),
                worktree_id: "/code/app-worktrees/scratch".into(),
                label: "/code/app-worktrees/scratch".into(),
            }
        );
    }

    /// End to end over a fake listing: terminals land under their worktree with
    /// subtree sums, a dead one reports zeros, santree gets the remainder, and
    /// everything is heaviest-first with an honest total.
    #[test]
    fn assemble_groups_terminals_and_carves_the_app_out() {
        let tree = ProcTree::new(parse_ps(LISTING));
        let repos = vec![RepoRef {
            name: "acme/app".into(),
            root: PathBuf::from("/code/app"),
        }];
        let links = vec![LinkRef {
            repo_root: PathBuf::from("/code/app"),
            issue_id: "AK-1".into(),
            title: "Fix login".into(),
            path: PathBuf::from("/code/app-worktrees/AK-1"),
        }];
        // `owner`/`label`/`epoch` identify a session to the reattach path;
        // resource accounting never reads them, so the fixtures keep them
        // uniform rather than meaningful.
        let sessions = vec![
            SessionInfo {
                id: 0,
                pid: Some(200),
                cwd: Some("/code/app-worktrees/AK-1".into()),
                command: "/bin/zsh".into(),
                owner: "page".into(),
                ..Default::default()
            },
            SessionInfo {
                id: 1,
                pid: Some(210),
                cwd: Some("/code/app".into()),
                command: "/bin/zsh".into(),
                owner: "page".into(),
                ..Default::default()
            },
            SessionInfo {
                id: 2,
                pid: None,
                cwd: Some("/code/app".into()),
                command: "sh".into(),
                owner: "page".into(),
                ..Default::default()
            },
        ];

        let usage = assemble(&tree, sessions, 100, &repos, &links, 42.0, 8);
        assert_eq!(usage.sampled_at_ms, 42.0);
        assert_eq!(usage.core_count, 8, "the CPU denominator rides along");

        let names: Vec<&str> = usage.repos.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(names, vec!["acme/app", "santree"], "heaviest first");

        let app = &usage.repos[0];
        assert_eq!(app.rss_bytes, (4000.0 + 300_000.0 + 20_000.0) * 1024.0);
        let ids: Vec<&str> = app.worktrees.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["AK-1", BASE_ID]);
        let live = &app.worktrees[0].terminals[0];
        assert_eq!(
            (live.session_id, live.pid, live.label.as_str(), live.live),
            (Some(0), 200, "claude", true)
        );
        let dead = &app.worktrees[1].terminals[0];
        assert_eq!(
            (
                dead.session_id,
                dead.label.as_str(),
                dead.live,
                dead.rss_bytes
            ),
            (Some(1), "zsh", false, 0.0)
        );
        assert_eq!(
            app.worktrees[1].terminals.len(),
            1,
            "a session with no pid has nothing to account for"
        );

        let santree = &usage.repos[1];
        assert_eq!(
            santree.cpu_pct, 3.5,
            "app + codex helper, terminals carved out"
        );
        // The app is broken out per process, not collapsed into one row: the app
        // itself first, then each helper, so a helper that has run away is
        // visible instead of hidden inside a total.
        let own: Vec<(Option<u32>, u32, &str, f64)> = santree.worktrees[0]
            .terminals
            .iter()
            .map(|t| (t.session_id, t.pid, t.label.as_str(), t.rss_bytes))
            .collect();
        assert_eq!(
            own,
            vec![
                (None, 100, "santree", 50_000.0 * 1024.0),
                (None, 400, "codex", 10_000.0 * 1024.0),
            ],
            "app process first, then its helpers; the carved-out terminals are absent"
        );

        assert_eq!(usage.total_rss_bytes, app.rss_bytes + santree.rss_bytes);
        assert_eq!(usage.total_cpu_pct, 13.0 + 3.5);
    }

    /// The denominator has to be real and non-zero, or dividing by it turns a
    /// readable percentage into `Infinity` in the UI.
    #[test]
    fn core_count_is_a_usable_denominator() {
        let cores = core_count();
        assert!(cores >= 1, "at least one core, never zero: {cores}");
        assert!(
            cores <= 4096,
            "a plausible core count, not a parse artifact"
        );
    }
}
