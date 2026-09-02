//! Reviews dashboard orchestration: turn the **whole repo registry** into a PR
//! inbox (my PRs, individual review requests, per-team requests) and fetch the
//! detail (body + conversation + diff) for a single PR. Composes `repo` + `github`;
//! the thin commands call in here. When `gh` isn't authenticated it returns an
//! empty inbox / empty detail (no sample data) so the UI shows its empty state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

use santree_core::domain::{
    CheckLog, FileSource, MergeQueueView, NewInlineComment, PrDetail, PrLabel, PrState,
    ReviewCheckout, ReviewEvent, ReviewInbox, ReviewPr, ReviewProject, ReviewTarget, TeamReviews,
};

use crate::db::Db;
use crate::git;
use crate::github;
use crate::repo;
use crate::review_drafts;

/// `(owner, name)` of the active repo's `origin` remote. Remote parsing shells out
/// to git, so it runs off the async pool.
pub(crate) async fn origin(db: &Db, repo: &str) -> Result<(String, String)> {
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;
    let root_path = PathBuf::from(root);
    tokio::task::spawn_blocking(move || github::owner_repo(&root_path)).await?
}

/// Where review checkouts *used to* live: `.santree/reviews/`, a sibling of the
/// worktrees dir, holding detached throwaway trees. Nothing writes there any
/// more — a PR's checkout is an ordinary worktree beside every other one — and
/// [`sweep_legacy_checkouts`] clears what earlier versions left behind.
const LEGACY_REVIEWS_DIR: &str = "reviews";

/// Collision-free slug for one PR. Length-prefixing keeps it flat while
/// distinguishing slugs such as `a-b/c` and `a/b-c`.
fn review_slug(owner: &str, name: &str, number: u32) -> Result<String> {
    if !repo::valid_github_component(owner) || !repo::valid_github_component(name) {
        return Err(anyhow!(
            "refusing to derive a review checkout from '{owner}/{name}'"
        ));
    }
    let dir = format!("{}-{owner}-{}-{name}-{number}", owner.len(), name.len());
    let mut components = Path::new(&dir).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
        || dir.starts_with('.')
    {
        return Err(anyhow!(
            "refusing to derive a review checkout from '{owner}/{name}'"
        ));
    }
    Ok(dir)
}

/// The worktree id for one PR — **the same string the frontend's `reviewTreeId`
/// mints**, so a pull request's checkout has one name on both sides of the bridge
/// and "open this PR's tree" and "the AI review's checkout" can no longer be two
/// different directories.
///
/// The id becomes an `issue_id`, and an `issue_id` is a filesystem path component
/// and a `git` argument elsewhere in this codebase — so it has to survive
/// `git.rs`'s `safe_path`. It does, and by construction: [`review_slug`] has
/// already proved its half is a single normal component that starts with a digit,
/// and the prefix adds no separator, no `..` and no leading `-`.
pub(crate) fn review_worktree_id(owner: &str, name: &str, number: u32) -> Result<String> {
    Ok(format!("review-{}", review_slug(owner, name, number)?))
}

/// A registered project that is a clone of the PR's repo, named both ways.
///
/// [`repo_for_pr`] answers in filesystem paths; every db-scoped call downstream
/// (`worktree::create`, `worktree::get`, the panes' reads) is keyed by the
/// registry *name*, and with two clones of one GitHub repo registered the two are
/// not interchangeable. Joined once here rather than re-derived at each caller.
pub(crate) struct PrProject {
    pub project: String,
    pub root: String,
    pub owner: String,
    pub name: String,
}

pub(crate) async fn project_for_pr(
    db: &Db,
    active: &str,
    pr_repo: &str,
) -> Result<Option<PrProject>> {
    let Some((root, owner, name)) = repo_for_pr(db, active, pr_repo).await? else {
        return Ok(None);
    };
    let Some(project) = repo::registered(db)
        .await?
        .into_iter()
        .find(|(_, path)| path == &root)
        .map(|(project, _)| project)
    else {
        return Ok(None);
    };
    Ok(Some(PrProject {
        project,
        root,
        owner,
        name,
    }))
}

/// The registered checkout whose `origin` is `pr_repo`, as `(local root, owner,
/// name)`.
///
/// Searched across the **whole** registry, starting with `active`. The inbox
/// spans every registered project's org, so a PR routinely belongs to a sibling
/// project the user has also registered; matching only the active repo made those
/// degrade to a diff-only review of code already sitting on disk. `Ok(None)` when nothing registered
/// points at that slug — still the common case, and still not an error.
///
/// `pr_repo` crosses IPC and the answer becomes a filesystem root and a `git`
/// argv, so it is parsed into exactly two components and compared one component
/// at a time, ASCII-case-insensitively (how GitHub itself treats them). A prefix
/// or `contains` test would match `acme/web-evil` against `acme/web` and hand a
/// PR someone else's checkout. The returned owner/name come from *git's* answer
/// for the matched root, not from the argument, so every name downstream is one
/// the repo on disk agrees with.
async fn repo_for_pr(
    db: &Db,
    active: &str,
    pr_repo: &str,
) -> Result<Option<(String, String, String)>> {
    let (want_owner, want_name) = github::split_slug(pr_repo)?;
    if !repo::valid_github_component(want_owner) || !repo::valid_github_component(want_name) {
        return Err(anyhow!("refusing to resolve a checkout for '{pr_repo}'"));
    }
    let (want_owner, want_name) = (want_owner.to_string(), want_name.to_string());

    // Active repo first: it is the overwhelmingly common answer, every other
    // candidate costs a `git remote` shell-out to rule out, and the checkout
    // belongs in the clone the user is actually working in. That makes the answer
    // depend on `active`, which only matters when two clones of the *same* GitHub
    // repo are registered — so all four callers (create, look-up, delete, and the
    // terminal-cwd check) must be handed the same active repo, as they are: each
    // gets it from the Reviews model or from `agent_session`'s own `repo`.
    let mut roots: Vec<String> = repo::path(db, active).await?.into_iter().collect();
    for path in repo::paths(db).await? {
        if !roots.contains(&path) {
            roots.push(path);
        }
    }

    // One blocking hop for the whole scan rather than one per candidate — it
    // short-circuits on the first match, which is usually the first entry.
    tokio::task::spawn_blocking(move || {
        for root in roots {
            let Ok((owner, name)) = github::owner_repo(Path::new(&root)) else {
                continue;
            };
            if owner.eq_ignore_ascii_case(&want_owner) && name.eq_ignore_ascii_case(&want_name) {
                return Some((root, owner, name));
            }
        }
        None
    })
    .await
    .map_err(Into::into)
}

/// Find-or-create the **worktree** for a pull request.
///
/// This used to cut a detached throwaway under `.santree/reviews/`, budgeted to
/// five and deleted oldest-first, where the setup script never ran. It is now an
/// ordinary worktree beside every other one, on the PR's own branch — so a
/// reviewer can build and run what they are reading, open terminals and agents in
/// it, and keep it as long as they keep any other checkout. The only thing that
/// still tells it apart is a row in `review_worktrees`, which keeps it out of the
/// Trees list; see [`mark_review`].
///
/// `Ok(None)` — not an error — when the PR lives in a repo *none* of the
/// registered ones is a clone of. The Reviews inbox searches whole orgs, so most
/// PRs in it belong to repos the user has never cloned; the caller falls back to a
/// diff-only session rather than refusing to open. The checkout lands under the
/// repo that owns the PR, which need not be the active one (see [`repo_for_pr`]).
///
/// **Never called without the user's say-so.** Cutting a worktree writes a working
/// tree to disk, so the surfaces that need one (an AI review, a terminal, "start
/// work") ask first — see `ConfirmWorktreeDialog`. Running `.santree/init.sh` is a
/// separate step on top of that, off unless the dialog's toggle is on.
pub async fn review_workspace(
    db: &Db,
    repo: &str,
    target: &ReviewTarget,
) -> Result<Option<String>> {
    let Some(found) = project_for_pr(db, repo, &target.pr_repo).await? else {
        return Ok(None);
    };
    let id = review_worktree_id(&found.owner, &found.name, target.number)?;

    // Which branch the checkout lands on — the PR's own when the head is on this
    // repo, a fetched `santree/pr-<n>` when it is on a fork. Resolved before the
    // worktree is created because `worktree::create` locks on the branch name.
    let branch = {
        let (root, head_ref, head_sha) = (
            found.root.clone(),
            target.head_ref.clone(),
            target.head_sha.clone(),
        );
        let number = target.number;
        tokio::task::spawn_blocking(move || {
            git::pr_branch(Path::new(&root), number, &head_ref, &head_sha)
        })
        .await??
    };

    // A base that isn't a usable branch name falls back to the repo's default,
    // which is what `worktree::create` does with `None`.
    let base = git::safe_branch(&target.base_ref).ok();
    let worktree = crate::worktree::create(
        db,
        &found.project,
        &id,
        &target.title,
        None,
        base,
        None,
        crate::worktree::BranchPlan::Existing(&branch),
    )
    .await?;
    // Only when `create` actually made *this* id. It adopts by branch, so a PR
    // whose branch already has the user's own ticket-named worktree (AK-276, say)
    // comes back as that one — and marking it would take the tree they are
    // working in out of Trees. The checkout is shared; the label is not.
    if worktree.id == id {
        mark_review(db, &found.root, &id, &target.pr_repo, target.number).await?;
    }
    Ok(Some(worktree.path))
}

/// Stop treating a PR's checkout as a review: it becomes an ordinary worktree,
/// listed in Trees like any other.
///
/// This is what "keep this as a worktree" does. There is only one checkout per
/// pull request now, so working on a PR you were reading is a change of label
/// rather than a second directory — which is the whole point of the two being one
/// thing. Idempotent, and a no-op on a PR with no checkout.
pub async fn promote_review_worktree(
    db: &Db,
    repo: &str,
    pr_repo: &str,
    number: u32,
) -> Result<()> {
    let Some(found) = project_for_pr(db, repo, pr_repo).await? else {
        return Ok(());
    };
    let id = review_worktree_id(&found.owner, &found.name, number)?;
    unmark_review(db, &found.root, &id).await;
    Ok(())
}

/// Record that a worktree is a pull request's checkout.
///
/// This membership row is the *whole* distinction between a review worktree and
/// any other one: [`review_ids`] is what keeps it out of `worktree::list`, and
/// everything else — files, git status, tabs, session history, the setup script —
/// addresses it exactly as it addresses work the user started.
///
/// Idempotent, because a second review of the same PR adopts the same worktree.
pub(crate) async fn mark_review(
    db: &Db,
    root: &str,
    id: &str,
    pr_repo: &str,
    number: u32,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO review_worktrees (repo_path, issue_id, pr_repo, number)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_path, issue_id) DO UPDATE SET
            pr_repo = excluded.pr_repo,
            number = excluded.number",
    )
    .bind(root)
    .bind(id)
    .bind(pr_repo)
    .bind(number)
    .execute(db)
    .await?;
    Ok(())
}

/// Forget the membership row for a worktree. Best-effort: a row without its
/// worktree costs a hidden id, never a wrong answer.
pub(crate) async fn unmark_review(db: &Db, root: &str, id: &str) {
    if let Err(e) = sqlx::query("DELETE FROM review_worktrees WHERE repo_path = ? AND issue_id = ?")
        .bind(root)
        .bind(id)
        .execute(db)
        .await
    {
        log::warn!("couldn't forget review worktree {id}: {e}");
    }
}

/// The ids of every review worktree in one clone — the one exclusion
/// `worktree::list` (and the project's worktree count) makes.
pub(crate) async fn review_ids(db: &Db, root: &str) -> Result<Vec<String>> {
    Ok(
        sqlx::query_scalar("SELECT issue_id FROM review_worktrees WHERE repo_path = ?")
            .bind(root)
            .fetch_all(db)
            .await?,
    )
}

/// Every review worktree, as `(repo_path, issue_id)` — the cross-repo shape the
/// project counts need, which ask about all clones at once.
pub(crate) async fn all_review_ids(db: &Db) -> Result<Vec<(String, String)>> {
    Ok(
        sqlx::query_as("SELECT repo_path, issue_id FROM review_worktrees")
            .fetch_all(db)
            .await?,
    )
}

/// Unregister the detached checkouts earlier versions left under
/// `.santree/reviews/`, once per launch.
///
/// They are real git worktrees, so deleting the directory alone would leave git's
/// admin entries behind and `git worktree list` reporting trees that aren't there.
/// Their registry rows are already gone (migration `0031`), which is what keeps
/// them from appearing in Trees in the meantime.
///
/// Best-effort throughout: this reclaims disk, and a repo that refuses costs disk
/// rather than correctness.
pub async fn sweep_legacy_checkouts(db: &Db) {
    let Ok(roots) = repo::paths(db).await else {
        return;
    };
    for root in roots {
        let dir = PathBuf::from(&root)
            .join(".santree")
            .join(LEGACY_REVIEWS_DIR);
        let removed = tokio::task::spawn_blocking(move || {
            if !dir.is_dir() {
                return false;
            }
            let root = dir
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or_default();
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                git::remove_legacy_review_checkout(&root, &entry.path());
            }
            let _ = std::fs::remove_dir_all(&dir);
            true
        })
        .await;
        if matches!(removed, Ok(true)) {
            log::info!("removed legacy review checkouts under {root}");
        }
    }
}

/// How many closed-PR checkouts one launch will ask GitHub about.
///
/// The sweep is self-continuing and takes the oldest rows first, so the cap
/// costs a day, not a checkout, and never starves the same rows twice. It exists because
/// the first launch after this code ships meets every checkout the old behaviour
/// stranded, and a burst of hundreds of lookups is exactly the API-budget spike
/// `pr::statuses` caps its own fallback against. Per the no-silent-caps rule,
/// hitting it is logged.
const RELEASE_LOOKUP_CAP: usize = 25;

/// Forget membership rows whose worktree is gone — removed by hand, or by a
/// `remove` that failed between its two writes. Such a row hides an id that no
/// longer exists, and nothing else ever drops it.
///
/// Pure SQL and no network, so it runs even signed out, and it is the half of
/// [`release_closed_checkouts`] that can be tested without one.
pub(crate) async fn forget_orphan_reviews(db: &Db) -> Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM review_worktrees WHERE (repo_path, issue_id) NOT IN
             (SELECT repo_path, issue_id FROM worktree_links)",
    )
    .execute(db)
    .await?
    .rows_affected())
}

/// Whether a checkout should be handed back to Trees, given what GitHub said
/// about its pull request.
///
/// `None` is a real answer, not a failure: GitHub replied and has no such PR
/// (repo renamed, deleted, or access withdrawn). A checkout the Reviews view can
/// never resolve again is exactly what wants releasing. An unreadable PR never
/// reaches here — the caller keeps that row for the next launch.
fn releases_checkout(state: Option<PrState>) -> bool {
    !matches!(state, Some(PrState::Open))
}

/// Give back the checkouts of pull requests that are no longer open, once per
/// launch.
///
/// A review checkout is hidden from Trees ([`review_ids`]) because it is a pull
/// request you are reading, not work you started. The one control that deletes it
/// lives in the Reviews rail, and that rail resolves its PR out of an inbox
/// filtered to *open* ones — so the moment a reviewed PR merges, its worktree
/// becomes unreachable in both directions at once: invisible in Trees, and
/// unopenable in Reviews. Nothing else collected it, which made a full checkout
/// per reviewed PR, kept forever.
///
/// **It deletes nothing.** It drops the membership row, which is the only thing
/// hiding the worktree; the checkout becomes an ordinary Trees entry whose PR
/// badge reads "Merged", removable exactly like every other worktree. Throwing
/// away a directory the user may have edited is not a sweep's call to make.
/// Making it visible again is.
///
/// Best-effort and interruptible: every step is idempotent, so a launch that dies
/// halfway loses nothing. Signed out of `gh` there is no state to ask about, so it
/// does the orphan pass and stops rather than guessing.
///
/// Returns how many checkouts it released.
pub async fn release_closed_checkouts(db: &Db) -> Result<u64> {
    let orphans = forget_orphan_reviews(db).await?;
    if orphans > 0 {
        log::info!("forgot {orphans} review row(s) whose worktree was already gone");
    }

    let mut rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT repo_path, issue_id, pr_repo, number FROM review_worktrees
             ORDER BY created_at",
    )
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(0);
    }
    // Signed out, "is it still open" is unknowable — which is not the same as
    // "closed". Every row keeps its checkout hidden until a launch can ask.
    let Some(token) = github::token().await else {
        return Ok(0);
    };
    if rows.len() > RELEASE_LOOKUP_CAP {
        log::info!(
            "{} review checkouts to check; asking about {RELEASE_LOOKUP_CAP} this launch",
            rows.len()
        );
        rows.truncate(RELEASE_LOOKUP_CAP);
    }

    let mut released = 0;
    for (root, id, pr_repo, number) in rows {
        let Ok((owner, name)) = github::split_slug(&pr_repo) else {
            // The slug is written by `mark_review` from a validated target, so this
            // is corruption rather than input. Leave it: a row we can't parse is
            // one we also can't be sure about.
            log::warn!("review checkout {id} has an unparseable repo slug {pr_repo:?}");
            continue;
        };
        let number = number as u32;
        let state = match github::pull_request(&token, owner, name, number).await {
            Ok(pr) => pr.map(|pr| pr.state),
            Err(e) => {
                // A transport failure is not an answer. Leave the row: the next
                // launch asks again, and until then the checkout stays as it is.
                log::warn!("couldn't read {pr_repo}#{number} to release its checkout: {e:#}");
                continue;
            }
        };
        if !releases_checkout(state) {
            continue;
        }
        unmark_review(db, &root, &id).await;
        released += 1;
    }
    Ok(released)
}

/// The worktree for one PR, in the shape the Reviews rail's branch panes speak —
/// plus the project whose clone holds it, since every worktree-scoped read is
/// keyed by that and the PR's project is routinely not the active one.
///
/// `None` when the PR has no checkout yet, when its worktree has since been
/// deleted, or when no registered project is a clone of the PR's repo.
pub async fn review_checkout(
    db: &Db,
    repo: &str,
    pr_repo: &str,
    number: u32,
) -> Result<Option<ReviewCheckout>> {
    let Some(found) = project_for_pr(db, repo, pr_repo).await? else {
        return Ok(None);
    };
    let id = review_worktree_id(&found.owner, &found.name, number)?;
    // The same read every other worktree gets: it is on a branch now, so its
    // ahead/behind and remote-sync numbers mean what they mean everywhere else.
    let Some(worktree) = crate::worktree::get(db, &found.project, &id).await? else {
        return Ok(None);
    };
    Ok(Some(ReviewCheckout {
        repo: found.project,
        worktree,
    }))
}

/// The PR's checkout **if it already exists**, without creating one.
///
/// Exists so the AI commands never take a workspace path over IPC. A path that
/// crosses the bridge becomes a process's working directory and its `Read` grant
/// — deriving it from `(repo, target)` here means a compromised webview can't
/// point a headless model at an arbitrary directory, and it can't disagree with
/// what [`review_workspace`] would have produced.
pub async fn existing_review_workspace(
    db: &Db,
    repo: &str,
    target: &ReviewTarget,
) -> Result<Option<String>> {
    Ok(review_checkout(db, repo, &target.pr_repo, target.number)
        .await?
        .map(|checkout| checkout.worktree.path))
}

/// Delete one PR's checkout. Idempotent — "it isn't there" is success, which
/// includes a `pr_repo` no registered clone matches.
///
/// The full worktree removal, branch included, exactly as deleting one from Trees
/// does: it is a real worktree now, and a half-removal would leave git's admin
/// entry pointing at a directory that is gone.
pub async fn remove_review_workspace(
    db: &Db,
    repo: &str,
    pr_repo: &str,
    number: u32,
) -> Result<()> {
    let Some(found) = project_for_pr(db, repo, pr_repo).await? else {
        return Ok(());
    };
    let id = review_worktree_id(&found.owner, &found.name, number)?;
    // No prompts root: a per-worktree prompt file is written when *you* start a
    // task in a tree, and nothing writes one for a pull request you are reading.
    crate::worktree::remove(db, &found.project, &id, None).await?;
    // The membership row goes with the worktree it classified.
    unmark_review(db, &found.root, &id).await;
    Ok(())
}

/// Every registered project paired with the GitHub repo its `origin` resolves to.
///
/// One blocking hop for the whole registry: each resolution is a `git remote`
/// shell-out, and the inbox can't ask its question until it knows all of them.
///
/// A project whose origin doesn't resolve (no remote, not GitHub, a slug that
/// isn't two clean components) keeps its row with `slug: None` instead of dropping
/// out — it's still a project the user registered, and "this checkout has no
/// GitHub origin" is a different answer from "nothing is waiting on you". The
/// components are re-validated here because this string goes on to be a search
/// qualifier and the key a PR is attributed by.
async fn projects(db: &Db) -> Result<Vec<ReviewProject>> {
    let rows = repo::registered(db).await?;
    Ok(tokio::task::spawn_blocking(move || {
        rows.into_iter()
            .map(|(name, path)| ReviewProject {
                repo: name,
                slug: github::owner_repo(Path::new(&path))
                    .ok()
                    .filter(|(owner, repo)| {
                        repo::valid_github_component(owner) && repo::valid_github_component(repo)
                    })
                    .map(|(owner, repo)| format!("{owner}/{repo}")),
            })
            .collect()
    })
    .await?)
}

/// The distinct orgs the registry spans, in registration order.
///
/// Several projects routinely share one org (`acme/web` beside `acme/kubernetes`),
/// and the searches below are org-scoped: asking once per *repo* would ask GitHub
/// the same question twice and pay a rate-limited call for the duplicate. Compared
/// ASCII-case-insensitively, the way GitHub treats owners; the first spelling
/// registered is the one searched, and the one the inbox reports back.
fn distinct_orgs(projects: &[ReviewProject]) -> Vec<String> {
    let mut orgs: Vec<String> = Vec::new();
    for slug in projects.iter().filter_map(|p| p.slug.as_deref()) {
        let Ok((owner, _)) = github::split_slug(slug) else {
            continue;
        };
        if !orgs.iter().any(|known| known.eq_ignore_ascii_case(owner)) {
            orgs.push(owner.to_string());
        }
    }
    orgs
}

/// Lowercased `owner/name` → registry name, for attributing a PR to the project
/// it belongs to.
///
/// The key is safe to build by lowercasing *because* the slug was already parsed
/// into exactly two components and validated as ASCII (see [`projects`]): the
/// lookup is then component-wise equality by construction, never the prefix or
/// `contains` test that would file `acme/web-evil`'s PRs under `acme/web`.
///
/// Two checkouts of the same GitHub repo derive two registry rows; the first
/// registered wins, since one PR belongs on one row.
fn project_index(projects: &[ReviewProject]) -> HashMap<String, String> {
    let mut index = HashMap::new();
    for project in projects {
        if let Some(slug) = &project.slug {
            index
                .entry(slug.to_ascii_lowercase())
                .or_insert_with(|| project.repo.clone());
        }
    }
    index
}

/// Which registered project a PR belongs to, from GitHub's `nameWithOwner`.
/// `None` for the many PRs in an org whose repo the user has never registered —
/// they're real inbox rows, they just aren't one of the user's projects.
fn project_of(index: &HashMap<String, String>, pr_repo: &str) -> Option<String> {
    let (owner, name) = github::split_slug(pr_repo).ok()?;
    if !repo::valid_github_component(owner) || !repo::valid_github_component(name) {
        return None;
    }
    // Recomposed from the validated components rather than lowercasing the raw
    // argument: the key then *is* two clean components, whatever `split_slug` may
    // come to accept.
    index
        .get(&format!(
            "{}/{}",
            owner.to_ascii_lowercase(),
            name.to_ascii_lowercase()
        ))
        .cloned()
}

/// The per-team sections for every org, fetched together.
///
/// A failed membership lookup costs the team sections and nothing else, so it
/// degrades rather than failing the inbox — but it's logged: without that, a
/// rate-limited call looks exactly like "in no teams".
async fn team_sections(token: &str, orgs: &[String], login: &str) -> Vec<TeamReviews> {
    let memberships = github::viewer_teams(token, orgs, login)
        .await
        .unwrap_or_else(|e| {
            log::warn!("Reviews: listing viewer teams across {orgs:?} failed: {e}");
            Vec::new()
        });
    futures::future::join_all(memberships.iter().map(|(org, teams)| {
        // The team slugs are scoped to *this* org: a request naming `other/core`
        // must not start the review clock for a member of `acme/core`.
        let viewer = github::ViewerCtx {
            login: login.to_string(),
            team_slugs: teams.iter().map(|(slug, _)| slug.clone()).collect(),
        };
        async move { github::team_reviews(token, org, teams, &viewer).await }
    }))
    .await
    .into_iter()
    .flatten()
    .collect()
}

/// The categorized PR inbox across **every** registered project. Empty — but
/// labelled with the projects and orgs it covered, and with whether it could ask
/// at all — when `gh` isn't authenticated.
///
/// Registry-wide rather than active-repo-scoped: the inbox used to derive one org
/// from the selected project's `origin`, so with several projects registered an
/// empty inbox was routinely the right answer to the wrong question — the review
/// waiting on you sat in the project you weren't looking at.
pub async fn inbox(db: &Db) -> Result<ReviewInbox> {
    // Independent, so they overlap: the token is a `gh auth token` subprocess on a
    // cold cache, the registry a DB read plus a `git remote` shell-out per project —
    // both on the critical path of every Reviews load.
    let (token, projects) = tokio::join!(github::token(), projects(db));
    let projects = projects?;
    let orgs = distinct_orgs(&projects);
    // The scope survives every early return below: an empty inbox that can't name
    // what it covered is indistinguishable from the repo-scoped merge queue beside it.
    let mut view = ReviewInbox {
        mine: vec![],
        requested: vec![],
        teams: vec![],
        projects,
        orgs,
        github_connected: token.is_some(),
    };
    // Nobody to ask, or nothing to ask about: both are the empty inbox. A registry
    // of purely local checkouts is as much a non-event as a signed-out `gh`.
    let (Some(token), false) = (token, view.orgs.is_empty()) else {
        return Ok(view);
    };

    // The one unavoidable serial hop: every search maps its PRs *relative to the
    // viewer* (which review-request event started their clock), so the login has to be
    // known before any of them start. It's a single cheap `viewer { login }` query.
    let login = github::viewer_login(&token).await?;

    // Only the team sections need to know the viewer's *teams*; the two personal
    // searches don't, so they run *alongside* that lookup rather than behind it — it
    // used to sit on the critical path of every Reviews load. The personal searches
    // therefore map with an empty team list, which is exactly right for them: a
    // directly-requested PR carries a `User` review-request event naming the viewer,
    // and an authored PR has no request for them at all (it falls back to `createdAt`).
    let solo = github::ViewerCtx {
        login: login.clone(),
        team_slugs: vec![],
    };
    let (personal, teams) = tokio::join!(
        github::personal_reviews(&token, &view.orgs, &solo),
        team_sections(&token, &view.orgs, &login),
    );
    let (mut mine, mut requested) = personal?;
    let mut teams = teams;

    // GitHub owns the inbox, but AI review drafts and the repo registry are local
    // state. Both joins happen here so every row arrives with one authoritative
    // count and one authoritative project, without a database query — or a `git
    // remote` — per visible PR.
    let ai_counts = review_drafts::counts(db).await?;
    let index = project_index(&view.projects);
    let attach_local = |pr: &mut ReviewPr| {
        pr.ai_draft_count = ai_counts
            .get(&(pr.repo.clone(), pr.number))
            .copied()
            .unwrap_or(0);
        pr.project = project_of(&index, &pr.repo);
    };
    mine.iter_mut().for_each(attach_local);
    requested.iter_mut().for_each(attach_local);
    for team in &mut teams {
        team.prs.iter_mut().for_each(attach_local);
    }

    view.mine = mine;
    view.requested = requested;
    view.teams = teams;
    Ok(view)
}

/// The merge queue for the active repo's default branch — the ordered list of
/// PRs waiting to merge, so the user can see where their own PRs sit in line.
///
/// Unlike [`inbox`], this question is scoped to a single `owner/name`, and the
/// answer is carried back with it: the panel's "no queue here" is about *this*
/// repo while the inbox beside it is about the whole org, and neither empty
/// state is readable without saying which.
pub async fn merge_queue(db: &Db, repo: &str) -> Result<MergeQueueView> {
    let (token, remote) = tokio::join!(github::token(), origin(db, repo));
    let slug = remote
        .as_ref()
        .map(|(owner, name)| format!("{owner}/{name}"))
        .unwrap_or_default();
    let Some(token) = token else {
        return Ok(MergeQueueView {
            repo: slug,
            github_connected: false,
            queue: None,
        });
    };
    let (owner, name) = remote?;
    Ok(MergeQueueView {
        repo: slug,
        github_connected: true,
        queue: github::merge_queue(&token, &owner, &name).await?,
    })
}

/// Full detail (body, conversation, changed files) for one PR. Empty when `gh`
/// isn't authenticated.
pub async fn detail(owner: &str, name: &str, number: u32) -> Result<PrDetail> {
    let Some(token) = github::token().await else {
        return Ok(PrDetail {
            body: String::new(),
            attachments: vec![],
            labels: vec![],
            comments: vec![],
            threads: vec![],
            files: vec![],
            files_truncated: false,
            commits: vec![],
            commits_truncated: false,
            checks: vec![],
            base_sha: String::new(),
            head_sha: String::new(),
            pending_review_id: None,
        });
    };
    github::pr_detail(&token, owner, name, number).await
}

/// The inbox's view of one PR, by number — what the Trees right panel renders for
/// a worktree's own pull request. `None` when `gh` isn't authenticated or the PR
/// doesn't exist, which the panel shows as its empty state.
///
/// The AI-draft count is joined here for the same reason [`inbox`] joins it:
/// GitHub has no concept of a draft that hasn't been sent, so a bare `0` from the
/// mapping would be a hardcoded value the UI presents as live data. Scoped
/// `review_drafts::list` rather than the whole-table `counts` — one PR doesn't
/// warrant the scan.
pub async fn pull_request(
    db: &Db,
    owner: &str,
    name: &str,
    number: u32,
) -> Result<Option<ReviewPr>> {
    let Some(token) = github::token().await else {
        return Ok(None);
    };
    let Some(mut pr) = github::pull_request(&token, owner, name, number).await? else {
        return Ok(None);
    };
    pr.ai_draft_count = review_drafts::list(db, &pr.repo, pr.number).await?.len() as u32;
    Ok(Some(pr))
}

/// The token every write path needs. Unlike the reads, "not signed in" can't
/// degrade to an empty result here — there'd be nothing to post *through*, and
/// silently succeeding would lose what the user typed.
async fn write_token() -> Result<String> {
    github::token()
        .await
        .ok_or_else(|| anyhow!("GitHub (gh) isn't authenticated"))
}

/// Leave an inline comment on a PR line: posted now, or held in the viewer's
/// pending review when `pending` is set (GitHub's "Start a review" / "Add to
/// review"). The user's own click, always — see the note in `github.rs`.
///
/// Returns the id of the pending review this *opened*, and `None` otherwise, so a
/// caller posting several comments in a row can put the rest into the same review
/// (see `review_drafts::publish`).
pub async fn add_inline_comment(mut c: NewInlineComment) -> Result<Option<String>> {
    let token = write_token().await?;
    let (owner, name) = github::split_slug(&c.pr_repo)?;
    if c.body.trim().is_empty() {
        return Err(anyhow!("a comment needs a body"));
    }
    // A range that doesn't actually span lines is a single-line comment, and
    // GitHub 422s on a start that isn't strictly before the end. Normalizing here
    // covers every write path below at once, whatever the diff view handed up.
    if c.start_line.is_some_and(|start| start >= c.line) {
        c.start_line = None;
    }
    if !c.pending {
        github::add_review_comment(&token, owner, name, &c).await?;
        return Ok(None);
    }
    match c.review_id.as_deref() {
        Some(review) => {
            github::add_pending_review_comment(&token, review, &c).await?;
            Ok(None)
        }
        None => github::start_review(&token, &c).await.map(Some),
    }
}

/// The signed-in GitHub user's login — who the review composer is writing as.
/// `None` when `gh` isn't authenticated, which the composer renders as a
/// nameless avatar rather than an error: not knowing who you are doesn't stop
/// you drafting a comment.
pub async fn viewer_login() -> Result<Option<String>> {
    let Some(token) = github::token().await else {
        return Ok(None);
    };
    Ok(Some(github::viewer_login(&token).await?))
}

/// Reply under an existing inline review thread.
pub async fn reply_to_thread(
    pr_repo: &str,
    number: u32,
    reply_to_id: &str,
    body: &str,
) -> Result<()> {
    let token = write_token().await?;
    let (owner, name) = github::split_slug(pr_repo)?;
    if body.trim().is_empty() {
        return Err(anyhow!("a reply needs a body"));
    }
    github::reply_to_review_thread(&token, owner, name, number, reply_to_id, body).await
}

/// Resolve or reopen an inline review thread.
pub async fn set_thread_resolved(thread_id: &str, resolved: bool) -> Result<()> {
    let token = write_token().await?;
    github::set_thread_resolved(&token, thread_id, resolved).await
}

/// Submit the viewer's pending review with a verdict. A body is required for
/// everything but an approval — that's GitHub's rule, enforced here so the user
/// hears it before the round-trip rather than as a 422.
pub async fn submit_review(review_id: &str, event: ReviewEvent, body: &str) -> Result<()> {
    let token = write_token().await?;
    if event != ReviewEvent::Approve && body.trim().is_empty() {
        return Err(anyhow!("GitHub needs a summary for this kind of review"));
    }
    github::submit_review(&token, review_id, event, body).await
}

/// Discard the viewer's pending review and every draft comment in it.
pub async fn discard_review(review_id: &str) -> Result<()> {
    let token = write_token().await?;
    github::discard_review(&token, review_id).await
}

/// Post a top-level conversation comment on a PR.
pub async fn add_conversation_comment(pr_repo: &str, number: u32, body: &str) -> Result<()> {
    let token = write_token().await?;
    let (owner, name) = github::split_slug(pr_repo)?;
    if body.trim().is_empty() {
        return Err(anyhow!("a comment needs a body"));
    }
    github::add_issue_comment(&token, owner, name, number, body).await
}

/// The repo's full label palette — the options for the PR label picker. Empty when
/// `gh` isn't authenticated.
pub async fn repo_labels(owner: &str, name: &str) -> Result<Vec<PrLabel>> {
    let Some(token) = github::token().await else {
        return Ok(vec![]);
    };
    github::list_labels(&token, owner, name).await
}

/// Replace a PR's labels with `labels` (GitHub PUT semantics — the whole set is
/// overwritten), returning the resulting labels. Errors when `gh` isn't
/// authenticated, since there's nothing to write through.
pub async fn set_pr_labels(
    owner: &str,
    name: &str,
    number: u32,
    labels: Vec<String>,
) -> Result<Vec<PrLabel>> {
    let token = github::token()
        .await
        .ok_or_else(|| anyhow!("GitHub (gh) isn't authenticated"))?;
    github::set_pr_labels(&token, owner, name, number, &labels).await
}

/// A failed check run's job log, sliced to the failing step (see
/// [`github::check_log`]). Empty when `gh` isn't authenticated.
pub async fn check_log(owner: &str, name: &str, job_id: u64) -> Result<CheckLog> {
    let Some(token) = github::token().await else {
        return Ok(CheckLog {
            blocks: vec![],
            truncated: false,
        });
    };
    github::check_log(&token, owner, name, job_id).await
}

/// The old (base) + new (head) full contents of one PR file, for expanding
/// unchanged context in the diff. Empty when `gh` isn't authenticated.
pub async fn file_source(
    owner: &str,
    name: &str,
    base: &str,
    head: &str,
    old_path: &str,
    new_path: &str,
) -> Result<FileSource> {
    let Some(token) = github::token().await else {
        return Ok(FileSource {
            old_text: String::new(),
            new_text: String::new(),
        });
    };
    github::pr_file_source(&token, owner, name, base, head, old_path, new_path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pr_slug_is_one_normal_component() {
        assert_ne!(
            review_slug("a-b", "c", 7).unwrap(),
            review_slug("a", "b-c", 7).unwrap()
        );
        assert!(review_slug("acme", "x/../../../victim", 7).is_err());
        assert!(review_slug("..", "victim", 7).is_err());
    }

    /// The membership row is the *whole* difference between a review checkout and
    /// any other worktree, so `list` has to honour it and every id-addressed read
    /// has to ignore it. Asserted on the two together, because the bug this design
    /// replaces was a filter applied at some readers and not others.
    #[tokio::test]
    async fn a_marked_worktree_leaves_the_list_but_stays_addressable() {
        let (base, db) = registry("review-marked-rows").await;
        let root = register(&db, &base, "web", "https://github.com/acme/web.git").await;
        let root_str = root.to_str().unwrap();

        for (id, path) in [("AK-1", "work"), ("review-4-acme-3-web-7", "pr")] {
            sqlx::query(
                "INSERT INTO worktree_links (repo_path, issue_id, branch, worktree_path, base_branch)
                 VALUES (?, ?, 'feature', ?, 'main')",
            )
            .bind(root_str)
            .bind(id)
            .bind(root.join(path).to_str().unwrap())
            .execute(&db)
            .await
            .unwrap();
        }
        mark_review(&db, root_str, "review-4-acme-3-web-7", "acme/web", 7)
            .await
            .unwrap();

        assert_eq!(
            review_ids(&db, root_str).await.unwrap(),
            vec!["review-4-acme-3-web-7".to_string()],
            "the marked row is the one Trees leaves out"
        );
        assert_eq!(
            all_review_ids(&db).await.unwrap(),
            vec![(root_str.to_string(), "review-4-acme-3-web-7".to_string())]
        );
        // Still a `worktree_links` row: everything that addresses a worktree by id
        // — files, git status, tabs, session history, setup — must still find it.
        let addressable: Vec<String> =
            sqlx::query_scalar("SELECT issue_id FROM worktree_links ORDER BY issue_id")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(addressable, vec!["AK-1", "review-4-acme-3-web-7"]);

        unmark_review(&db, root_str, "review-4-acme-3-web-7").await;
        assert!(review_ids(&db, root_str).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The orphan half of the launch sweep, which needs no network: a membership
    /// row whose worktree is gone hides an id that no longer exists, and nothing
    /// else ever drops it. The row with a live worktree must survive the same
    /// pass — this is a reconcile, not a purge.
    #[tokio::test]
    async fn releasing_forgets_review_rows_whose_worktree_is_gone() {
        let (base, db) = registry("review-release-orphans").await;
        let root = register(&db, &base, "web", "https://github.com/acme/web.git").await;
        let root_str = root.to_str().unwrap();

        // Only the first gets a `worktree_links` row; the second is the orphan.
        sqlx::query(
            "INSERT INTO worktree_links (repo_path, issue_id, branch, worktree_path, base_branch)
             VALUES (?, 'review-4-acme-3-web-7', 'feature', ?, 'main')",
        )
        .bind(root_str)
        .bind(root.join("pr").to_str().unwrap())
        .execute(&db)
        .await
        .unwrap();
        mark_review(&db, root_str, "review-4-acme-3-web-7", "acme/web", 7)
            .await
            .unwrap();
        mark_review(&db, root_str, "review-4-acme-3-web-9", "acme/web", 9)
            .await
            .unwrap();

        assert_eq!(forget_orphan_reviews(&db).await.unwrap(), 1);
        assert_eq!(
            review_ids(&db, root_str).await.unwrap(),
            vec!["review-4-acme-3-web-7".to_string()],
            "the row whose worktree is still there is kept"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The whole decision, without a network: only a PR GitHub says is still
    /// open keeps its checkout hidden. A PR GitHub has no record of releases it
    /// too — a checkout Reviews can never resolve is the case this exists for.
    #[test]
    fn only_an_open_pull_request_keeps_its_checkout_hidden() {
        assert!(!releases_checkout(Some(PrState::Open)));
        assert!(releases_checkout(Some(PrState::Merged)));
        assert!(releases_checkout(Some(PrState::Closed)));
        assert!(releases_checkout(None));
    }

    /// One checkout per pull request per clone. Two reviews of one PR must adopt
    /// the same worktree rather than racing a second row into the table.
    #[tokio::test]
    async fn marking_the_same_pull_request_twice_is_one_row() {
        let (base, db) = registry("review-marked-twice").await;
        let root = register(&db, &base, "web", "https://github.com/acme/web.git").await;
        let root_str = root.to_str().unwrap();
        for _ in 0..2 {
            mark_review(&db, root_str, "review-4-acme-3-web-7", "acme/web", 7)
                .await
                .unwrap();
        }
        assert_eq!(review_ids(&db, root_str).await.unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    fn project(repo: &str, slug: Option<&str>) -> ReviewProject {
        ReviewProject {
            repo: repo.into(),
            slug: slug.map(Into::into),
        }
    }

    /// Several projects under one org ask GitHub once. The user's own registry has
    /// `canary` and `canary-kubernetes` side by side; a search per repo would buy
    /// the same answer twice out of one rate limit.
    #[test]
    fn projects_sharing_an_org_collapse_to_one_search_scope() {
        let projects = [
            project("acme/web", Some("acme/web")),
            project("acme/kubernetes", Some("acme/kubernetes")),
            // A different org, and the same org spelled differently — GitHub treats
            // owners case-insensitively, so this is not a third scope.
            project("other/tool", Some("other/tool")),
            project("acme/api", Some("Acme/api")),
            // No GitHub origin at all: a listed project that can't be searched.
            project("scratch", None),
        ];
        assert_eq!(distinct_orgs(&projects), ["acme", "other"]);
        assert!(distinct_orgs(&[project("scratch", None)]).is_empty());
    }

    /// Attribution is what puts a PR on a project's row, so it is compared one
    /// whole component at a time: `acme/web-evil` starting with `acme/web` must not
    /// spend its count. Case is ignored, since a remote's spelling need not match
    /// GitHub's.
    #[test]
    fn a_pr_is_attributed_to_its_project_and_no_near_miss() {
        let projects = [
            project("acme/web", Some("acme/web")),
            project("acme/kubernetes", Some("acme/kubernetes")),
            project("scratch", None),
        ];
        let index = project_index(&projects);

        assert_eq!(project_of(&index, "acme/web").as_deref(), Some("acme/web"));
        assert_eq!(
            project_of(&index, "Acme/Kubernetes").as_deref(),
            Some("acme/kubernetes")
        );
        for near_miss in [
            "acme/web-evil",
            "acme/we",
            "acme/webb",
            "acme-evil/web",
            "acme/web/extra",
            "acme/web/../web",
            "acme",
            "",
        ] {
            assert_eq!(
                project_of(&index, near_miss),
                None,
                "{near_miss} must not be attributed to acme/web"
            );
        }
    }

    /// Two checkouts of one GitHub repo are two registry rows (see `repo::add`);
    /// the PR belongs on one of them, and it's the one registered first.
    #[test]
    fn a_second_checkout_does_not_double_count_a_pr() {
        let projects = [
            project("acme/web", Some("acme/web")),
            project("acme/web (web-fork)", Some("acme/web")),
        ];
        assert_eq!(
            project_of(&project_index(&projects), "acme/web").as_deref(),
            Some("acme/web")
        );
    }

    /// A registered git repo at `<base>/<name>` whose `origin` is `remote`,
    /// inserted into `db` under `name` — the registry rows [`repo_for_pr`] scans.
    async fn register(db: &Db, base: &Path, name: &str, remote: &str) -> PathBuf {
        let root = base.join(name);
        std::fs::create_dir_all(&root).unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["remote", "add", "origin", remote],
        ] {
            assert!(std::process::Command::new("git")
                .args(&args)
                .current_dir(&root)
                .status()
                .unwrap()
                .success());
        }
        sqlx::query("INSERT INTO repos (name, path) VALUES (?, ?)")
            .bind(name)
            .bind(root.to_str().unwrap())
            .execute(db)
            .await
            .unwrap();
        root
    }

    async fn registry(label: &str) -> (PathBuf, Db) {
        let base = std::env::temp_dir().join(format!("santree-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        (base, db)
    }

    /// The fix for a PR that degraded to diff-only although its project was
    /// registered: the active repo is one candidate among all of them, not the
    /// only one. The owner/name come back from the matched repo's own `origin`.
    #[tokio::test]
    async fn a_pull_request_resolves_to_any_registered_clone() {
        let (base, db) = registry("review-repo-for-pr").await;
        register(&db, &base, "web", "https://github.com/acme/web.git").await;
        let other = register(&db, &base, "k8s", "git@github.com:acme/kubernetes.git").await;

        assert_eq!(
            repo_for_pr(&db, "web", "acme/kubernetes").await.unwrap(),
            Some((
                other.to_string_lossy().into_owned(),
                "acme".into(),
                "kubernetes".into()
            ))
        );
        // GitHub treats owner/name case-insensitively, so the slug the inbox
        // hands back must not have to match the remote's spelling.
        assert!(repo_for_pr(&db, "web", "Acme/Kubernetes")
            .await
            .unwrap()
            .is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The org-scoped inbox is full of repos the user never cloned. That has to
    /// stay `Ok(None)` — the caller degrades to a diff-only review rather than
    /// refusing to open the PR at all.
    #[tokio::test]
    async fn an_unregistered_repo_still_degrades_to_diff_only() {
        let (base, db) = registry("review-unregistered").await;
        register(&db, &base, "web", "https://github.com/acme/web.git").await;

        assert_eq!(repo_for_pr(&db, "web", "acme/nowhere").await.unwrap(), None);
        assert_eq!(
            repo_for_pr(&db, "web", "someone-else/web").await.unwrap(),
            None
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The slug crosses IPC and the answer becomes a filesystem root plus a `git`
    /// argv. Both components are compared whole: a name that merely *starts with*
    /// a registered one must not borrow its checkout.
    #[tokio::test]
    async fn a_near_miss_repo_name_never_borrows_a_checkout() {
        let (base, db) = registry("review-near-miss").await;
        register(&db, &base, "web", "https://github.com/acme/web.git").await;

        for slug in ["acme/web-evil", "acme/we", "acme-evil/web", "acme/webb"] {
            assert_eq!(
                repo_for_pr(&db, "web", slug).await.unwrap(),
                None,
                "{slug} must not resolve to acme/web's checkout"
            );
        }
        // Not two components at all — rejected before anything is scanned.
        assert!(repo_for_pr(&db, "web", "acme/web/../../victim")
            .await
            .is_err());
        assert!(repo_for_pr(&db, "web", "acme").await.is_err());
        assert!(repo_for_pr(&db, "web", "acme/..").await.is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A registered repo whose `origin` isn't a parseable GitHub remote is not a
    /// candidate for anything — it can neither be matched nor deleted through.
    /// The escape this guards was a remote of `.../acme/x/../../victim`.
    #[tokio::test]
    async fn malicious_origin_cannot_escape_review_deletion_root() {
        let (base, db) = registry("review-remove-origin").await;
        let repo_root =
            register(&db, &base, "repo", "https://github.com/acme/x/../../victim").await;
        let victim = repo_root.join(".santree/victim-7");
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(victim.join("keep"), "safe").unwrap();

        assert_eq!(repo_for_pr(&db, "repo", "acme/victim").await.unwrap(), None);
        assert!(
            remove_review_workspace(&db, "repo", "acme/x/../../victim", 7)
                .await
                .is_err()
        );
        assert!(remove_review_workspace(&db, "repo", "acme/victim", 7)
            .await
            .is_ok());
        assert!(victim.join("keep").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The registry→GitHub resolution the whole inbox is built on. A checkout whose
    /// `origin` isn't a usable GitHub remote keeps its row rather than dropping out
    /// of the project list — and it doesn't take the projects beside it down with
    /// it, which is the per-unit degradation the aggregation depends on.
    #[tokio::test]
    async fn a_repo_without_a_usable_github_origin_still_gets_a_row() {
        let (base, db) = registry("review-projects").await;
        register(&db, &base, "web", "https://github.com/acme/web.git").await;
        register(&db, &base, "mirror", "https://gitlab.com/acme/mirror.git").await;
        register(
            &db,
            &base,
            "escape",
            "https://github.com/acme/x/../../victim",
        )
        .await;

        let projects = projects(&db).await.unwrap();
        assert_eq!(
            projects,
            vec![
                project("web", Some("acme/web")),
                project("mirror", None),
                project("escape", None),
            ]
        );
        // The one project that did resolve is still searched, and only once.
        assert_eq!(distinct_orgs(&projects), ["acme"]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
