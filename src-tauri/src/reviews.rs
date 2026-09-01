//! Reviews dashboard orchestration: turn the active repo into an org-scoped PR
//! inbox (my PRs, individual review requests, per-team requests) and fetch the
//! detail (body + conversation + diff) for a single PR. Composes `repo` + `github`;
//! the thin commands call in here. When `gh` isn't authenticated it returns an
//! empty inbox / empty detail (no sample data) so the UI shows its empty state.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

use santree_core::domain::{
    CheckLog, FileSource, MergeQueueView, NewInlineComment, PrDetail, PrLabel, ReviewEvent,
    ReviewInbox, ReviewPr, ReviewTarget,
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

/// Where review checkouts live inside a repo: a **sibling** of
/// `.santree/worktrees/`, deliberately not underneath it. `git_watch`'s
/// `WorktreeWatcher` watches that directory recursively, so a checkout created
/// here would otherwise fire a storm of worktree-changed events and show up in the
/// Trees sidebar as if it were one of the user's own tasks.
pub(crate) const REVIEWS_DIR: &str = "reviews";

/// How many review checkouts to keep per repo. Each is a full working tree, so
/// they're pruned oldest-first rather than accumulating one per PR ever opened.
const KEEP_REVIEW_CHECKOUTS: usize = 5;

/// Collision-free directory name for one PR's checkout. Length-prefixing keeps
/// it flat while distinguishing slugs such as `a-b/c` and `a/b-c`.
pub(crate) fn review_dir_name(owner: &str, name: &str, number: u32) -> Result<String> {
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

/// The registered checkout whose `origin` is `pr_repo`, as `(local root, owner,
/// name)`.
///
/// Searched across the **whole** registry, starting with `active`. The inbox is
/// org-scoped, so a PR routinely belongs to a sibling project the user has also
/// registered; matching only the active repo made those degrade to a diff-only
/// review of code already sitting on disk. `Ok(None)` when nothing registered
/// points at that slug — still the common case, and still not an error.
///
/// `pr_repo` crosses IPC and the answer becomes a filesystem root and a `git`
/// argv, so it is parsed into exactly two components and compared one component
/// at a time, ASCII-case-insensitively (how GitHub itself treats them). A prefix
/// or `contains` test would match `acme/web-evil` against `acme/web` and hand a
/// PR someone else's checkout. The returned owner/name come from *git's* answer
/// for the matched root, not from the argument, so every name downstream is one
/// the repo on disk agrees with.
pub(crate) async fn repo_for_pr(
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

/// Find-or-create the read-only checkout of a PR's head, for the AI review
/// session to read real code in.
///
/// `Ok(None)` — not an error — when the PR lives in a repo *none* of the
/// registered ones is a clone of. The Reviews inbox is org-scoped, so most PRs in
/// it belong to repos the user has never cloned; the caller falls back to a
/// diff-only session rather than refusing to open. The checkout lands under the
/// repo that owns the PR, which need not be the active one (see [`repo_for_pr`]).
pub async fn review_workspace(
    db: &Db,
    repo: &str,
    target: &ReviewTarget,
) -> Result<Option<String>> {
    let Some((root, owner, name)) = repo_for_pr(db, repo, &target.pr_repo).await? else {
        return Ok(None);
    };

    let number = target.number;
    let head_sha = target.head_sha.clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(root);
        let reviews_root = root.join(".santree").join(REVIEWS_DIR);
        // The name is derived from the remote, then validated again where `join`
        // turns it into filesystem authority.
        let dir = review_dir_name(&owner, &name, number)?;
        let path = reviews_root.join(&dir);

        prune_review_checkouts(&root, &reviews_root, &dir);
        git::add_review_worktree(&root, &path, number, &head_sha)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await?
}

/// Drop the oldest review checkouts so at most [`KEEP_REVIEW_CHECKOUTS`] remain
/// once `keep` is (re)created. Best-effort: an unreadable directory or a stubborn
/// worktree costs disk, not correctness.
fn prune_review_checkouts(root: &Path, reviews_root: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(reviews_root) else {
        return;
    };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name() != std::ffi::OsStr::new(keep))
        .filter(|e| e.path().is_dir())
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if dirs.len() < KEEP_REVIEW_CHECKOUTS {
        return;
    }
    // Newest first, then drop everything past the budget (which reserves one slot
    // for the checkout about to be created).
    dirs.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in dirs.into_iter().skip(KEEP_REVIEW_CHECKOUTS - 1) {
        git::remove_review_worktree(root, &path);
    }
}

/// The PR's review checkout **if it already exists**, without creating one.
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
    let Some((root, owner, name)) = repo_for_pr(db, repo, &target.pr_repo).await? else {
        return Ok(None);
    };
    let dir = review_dir_name(&owner, &name, target.number)?;
    let path = PathBuf::from(root)
        .join(".santree")
        .join(REVIEWS_DIR)
        .join(dir);
    let exists = tokio::task::spawn_blocking({
        let path = path.clone();
        move || path.is_dir()
    })
    .await?;
    Ok(exists.then(|| path.to_string_lossy().into_owned()))
}

/// Delete one PR's review checkout. Idempotent — "it isn't there" is success,
/// which includes a `pr_repo` no registered checkout matches.
pub async fn remove_review_workspace(
    db: &Db,
    repo: &str,
    pr_repo: &str,
    number: u32,
) -> Result<()> {
    let Some((root, owner, name)) = repo_for_pr(db, repo, pr_repo).await? else {
        return Ok(());
    };
    let dir = review_dir_name(&owner, &name, number)?;
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(root);
        let path = root.join(".santree").join(REVIEWS_DIR).join(dir);
        git::remove_review_worktree(&root, &path);
    })
    .await?;
    Ok(())
}

/// The categorized PR inbox for the org the active `repo` belongs to. Empty —
/// but labelled with the org it asked about, and with whether it could ask —
/// when `gh` isn't authenticated.
pub async fn inbox(db: &Db, repo: &str) -> Result<ReviewInbox> {
    // Independent, so they overlap: the token is a `gh auth token` subprocess on a
    // cold cache, the origin a DB read plus a `git remote` shell-out — both on the
    // critical path of every Reviews load.
    let (token, remote) = tokio::join!(github::token(), origin(db, repo));
    // The scope survives both failure modes below: an empty inbox that can't name
    // its org is indistinguishable from the repo-scoped merge queue beside it.
    let empty = ReviewInbox {
        mine: vec![],
        requested: vec![],
        teams: vec![],
        org: remote
            .as_ref()
            .map(|(org, _)| org.clone())
            .unwrap_or_default(),
        github_connected: token.is_some(),
    };
    // Token first: an unauthenticated `gh` is an empty inbox, so a repo with no
    // local path has to stay a non-event there, exactly as when these ran in sequence.
    let Some(token) = token else {
        return Ok(empty);
    };
    let (org, _name) = remote?;

    // The one unavoidable serial hop: every search now maps its PRs *relative to the
    // viewer* (which review-request event started their clock), so the login has to be
    // known before any of them start. It's a single cheap `viewer { login }` query —
    // and it was already being fetched on the team path, just later.
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
    let (personal, teams) = tokio::join!(github::personal_reviews(&token, &org, &solo), async {
        // A failed team lookup only costs the per-team sections, so it degrades rather
        // than failing the inbox — but it's logged: without it, a rate-limited call looks
        // exactly like "in no teams".
        let teams = github::viewer_teams(&token, &org, &login)
            .await
            .unwrap_or_else(|e| {
                log::warn!("Reviews: listing viewer teams in {org} failed: {e}");
                Vec::new()
            });
        let viewer = github::ViewerCtx {
            login: login.clone(),
            team_slugs: teams.iter().map(|(slug, _)| slug.clone()).collect(),
        };
        github::team_reviews(&token, &org, &teams, &viewer).await
    });
    let (mut mine, mut requested) = personal?;
    let mut teams = teams;

    // GitHub owns the inbox, but AI review drafts are local state. Join them here
    // so every sidebar row gets one authoritative count
    // without issuing a database query per visible PR.
    let ai_counts = review_drafts::counts(db).await?;
    let attach_count = |pr: &mut santree_core::domain::ReviewPr| {
        pr.ai_draft_count = ai_counts
            .get(&(pr.repo.clone(), pr.number))
            .copied()
            .unwrap_or(0);
    };
    mine.iter_mut().for_each(attach_count);
    requested.iter_mut().for_each(attach_count);
    for team in &mut teams {
        team.prs.iter_mut().for_each(attach_count);
    }

    Ok(ReviewInbox {
        mine,
        requested,
        teams,
        org,
        github_connected: true,
    })
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
            labels: vec![],
            comments: vec![],
            threads: vec![],
            files: vec![],
            files_truncated: false,
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
    fn review_directory_is_one_normal_component() {
        assert_ne!(
            review_dir_name("a-b", "c", 7).unwrap(),
            review_dir_name("a", "b-c", 7).unwrap()
        );
        assert!(review_dir_name("acme", "x/../../../victim", 7).is_err());
        assert!(review_dir_name("..", "victim", 7).is_err());
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
}
