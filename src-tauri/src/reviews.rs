//! Reviews dashboard orchestration: turn the active repo into an org-scoped PR
//! inbox (my PRs, individual review requests, per-team requests) and fetch the
//! detail (body + conversation + diff) for a single PR. Composes `repo` + `github`;
//! the thin commands call in here. When `gh` isn't authenticated it returns an
//! empty inbox / empty detail (no sample data) so the UI shows its empty state.

use std::path::PathBuf;

use anyhow::{anyhow, Result};

use santree_core::domain::{CheckLog, FileSource, MergeQueue, PrDetail, PrLabel, ReviewInbox};

use crate::db::Db;
use crate::github;
use crate::repo;

/// The categorized PR inbox for the org the active `repo` belongs to. Empty when
/// `gh` isn't authenticated.
pub async fn inbox(db: &Db, repo: &str) -> Result<ReviewInbox> {
    let empty = ReviewInbox {
        mine: vec![],
        requested: vec![],
        teams: vec![],
    };
    let Some(token) = github::token().await else {
        return Ok(empty);
    };
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;

    // The org is the owner of the repo's `origin` remote. Remote parsing shells out
    // to git, so keep it off the async pool.
    let root_path = PathBuf::from(&root);
    let (org, _name) =
        tokio::task::spawn_blocking(move || github::owner_repo(&root_path)).await??;

    // A failed team lookup only costs the per-team sections (the "mine"/"requested"
    // ones still load), so it degrades rather than failing the inbox — but it's
    // logged: without it, a rate-limited call looks exactly like "in no teams".
    let teams = github::viewer_teams(&token, &org)
        .await
        .unwrap_or_else(|e| {
            log::warn!("Reviews: listing viewer teams in {org} failed: {e}");
            Vec::new()
        });
    github::review_inbox(&token, &org, &teams).await
}

/// The merge queue for the active repo's default branch — the ordered list of
/// PRs waiting to merge, so the user can see where their own PRs sit in line.
/// `None` when `gh` isn't authenticated or the repo has no merge queue enabled.
pub async fn merge_queue(db: &Db, repo: &str) -> Result<Option<MergeQueue>> {
    let Some(token) = github::token().await else {
        return Ok(None);
    };
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;
    // owner/name from the `origin` remote — shells out to git, so off the async pool.
    let root_path = PathBuf::from(&root);
    let (owner, name) =
        tokio::task::spawn_blocking(move || github::owner_repo(&root_path)).await??;
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
        });
    };
    github::pr_detail(&token, owner, name, number).await
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
