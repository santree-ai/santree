//! Reviews dashboard orchestration: turn the active repo into an org-scoped PR
//! inbox (my PRs, individual review requests, per-team requests) and fetch the
//! detail (body + conversation + diff) for a single PR. Composes `repo` + `github`;
//! the thin commands call in here. When `gh` isn't authenticated it returns an
//! empty inbox / empty detail (no sample data) so the UI shows its empty state.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

use santree_core::domain::{
    CheckLog, FileSource, MergeQueue, NewInlineComment, PrDetail, PrLabel, ReviewEvent,
    ReviewInbox, ReviewTarget,
};

use crate::db::Db;
use crate::git;
use crate::github;
use crate::repo;

/// `(owner, name)` of the active repo's `origin` remote. Remote parsing shells out
/// to git, so it runs off the async pool.
async fn origin(db: &Db, repo: &str) -> Result<(String, String)> {
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
const REVIEWS_DIR: &str = "reviews";

/// How many review checkouts to keep per repo. Each is a full working tree, so
/// they're pruned oldest-first rather than accumulating one per PR ever opened.
const KEEP_REVIEW_CHECKOUTS: usize = 5;

/// Directory name for one PR's checkout — `owner-name-number`, flat rather than
/// nested so a single [`git::safe_path`]-equivalent component check covers it.
fn review_dir_name(owner: &str, name: &str, number: u32) -> String {
    format!("{owner}-{name}-{number}")
}

/// Find-or-create the read-only checkout of a PR's head, for the AI review
/// session to read real code in.
///
/// `Ok(None)` — not an error — when the PR lives in a repo this santree repo isn't
/// a clone of. The Reviews inbox is org-scoped, so most PRs in it belong to repos
/// the user has never cloned; the caller falls back to a diff-only session rather
/// than refusing to open.
pub async fn review_workspace(
    db: &Db,
    repo: &str,
    target: &ReviewTarget,
) -> Result<Option<String>> {
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;
    let (owner, name) = origin(db, repo).await?;
    // Parse-and-compare, never a prefix/contains match on the slug.
    if !target
        .pr_repo
        .eq_ignore_ascii_case(&format!("{owner}/{name}"))
    {
        return Ok(None);
    }

    let number = target.number;
    let head_sha = target.head_sha.clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(root);
        let reviews_root = root.join(".santree").join(REVIEWS_DIR);
        // The name is derived from the *remote* we just parsed, not from anything
        // the webview sent — but it still gets the single-component check, since
        // it's what `join` is about to trust.
        let dir = review_dir_name(&owner, &name, number);
        if dir.contains(['/', '\\']) || dir.starts_with('.') {
            return Err(anyhow!("refusing to build a review checkout named '{dir}'"));
        }
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
    let Some(root) = repo::path(db, repo).await? else {
        return Ok(None);
    };
    let (owner, name) = origin(db, repo).await?;
    if !target
        .pr_repo
        .eq_ignore_ascii_case(&format!("{owner}/{name}"))
    {
        return Ok(None);
    }
    let path = PathBuf::from(root)
        .join(".santree")
        .join(REVIEWS_DIR)
        .join(review_dir_name(&owner, &name, target.number));
    let exists = tokio::task::spawn_blocking({
        let path = path.clone();
        move || path.is_dir()
    })
    .await?;
    Ok(exists.then(|| path.to_string_lossy().into_owned()))
}

/// Delete one PR's review checkout. Idempotent — "it isn't there" is success.
pub async fn remove_review_workspace(db: &Db, repo: &str, number: u32) -> Result<()> {
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;
    let (owner, name) = origin(db, repo).await?;
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(root);
        let path = root
            .join(".santree")
            .join(REVIEWS_DIR)
            .join(review_dir_name(&owner, &name, number));
        git::remove_review_worktree(&root, &path);
    })
    .await?;
    Ok(())
}

/// The categorized PR inbox for the org the active `repo` belongs to. Empty when
/// `gh` isn't authenticated.
pub async fn inbox(db: &Db, repo: &str) -> Result<ReviewInbox> {
    let empty = ReviewInbox {
        mine: vec![],
        requested: vec![],
        teams: vec![],
    };
    // Independent, so they overlap: the token is a `gh auth token` subprocess on a
    // cold cache, the origin a DB read plus a `git remote` shell-out — both on the
    // critical path of every Reviews load.
    let (token, remote) = tokio::join!(github::token(), origin(db, repo));
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
    let (mine, requested) = personal?;

    Ok(ReviewInbox {
        mine,
        requested,
        teams,
    })
}

/// The merge queue for the active repo's default branch — the ordered list of
/// PRs waiting to merge, so the user can see where their own PRs sit in line.
/// `None` when `gh` isn't authenticated or the repo has no merge queue enabled.
pub async fn merge_queue(db: &Db, repo: &str) -> Result<Option<MergeQueue>> {
    let (token, remote) = tokio::join!(github::token(), origin(db, repo));
    let Some(token) = token else {
        return Ok(None);
    };
    let (owner, name) = remote?;
    github::merge_queue(&token, &owner, &name).await
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
pub async fn add_inline_comment(mut c: NewInlineComment) -> Result<()> {
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
        return github::add_review_comment(&token, owner, name, &c).await;
    }
    match c.review_id.as_deref() {
        Some(review) => github::add_pending_review_comment(&token, review, &c).await,
        None => github::start_review(&token, &c).await,
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
    path: &str,
) -> Result<FileSource> {
    let Some(token) = github::token().await else {
        return Ok(FileSource {
            old_text: String::new(),
            new_text: String::new(),
        });
    };
    github::pr_file_source(&token, owner, name, base, head, path).await
}
