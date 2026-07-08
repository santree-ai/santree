//! Reviews dashboard orchestration: turn the active repo into an org-scoped PR
//! inbox (my PRs, individual review requests, per-team requests) and fetch the
//! detail (body + conversation + diff) for a single PR. Composes `repo` + `github`;
//! the thin commands call in here. When `gh` isn't authenticated it returns an
//! empty inbox / empty detail (no sample data) so the UI shows its empty state.

use std::path::PathBuf;

use anyhow::{anyhow, Result};

use santree_core::domain::{FileSource, MergeQueue, PrDetail, ReviewInbox};

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

    let teams = github::viewer_teams(&token, &org).await.unwrap_or_default();
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
            comments: vec![],
            threads: vec![],
            files: vec![],
            checks: vec![],
            base_sha: String::new(),
            head_sha: String::new(),
        });
    };
    github::pr_detail(&token, owner, name, number).await
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
