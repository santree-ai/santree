//! Pull-request orchestration: draft a title/body for the create-PR dialog, then
//! create the PR (push the branch + open it via the GitHub API). Composes
//! `git` + `github` + `prompts` + `agent`; the thin commands call in here.

use std::path::PathBuf;

use anyhow::{anyhow, Result};

use santree_core::domain::{NewPr, PrDraft, WorktreePr};

use crate::agent;
use crate::db::Db;
use crate::git;
use crate::github;
use crate::prompts;
use crate::repo;
use crate::worktree::{self, Coords};

/// Live PR status for every tracked worktree in `repo`, fetched from GitHub in
/// parallel. Returns an empty list (not an error) when `gh` isn't authenticated
/// so the UI degrades gracefully; worktrees without a PR are simply omitted.
pub async fn statuses(db: &Db, repo: &str) -> Result<Vec<WorktreePr>> {
    let Some(token) = github::token().await else {
        return Ok(vec![]);
    };
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;

    let root_path = PathBuf::from(&root);
    let (owner, name) =
        tokio::task::spawn_blocking(move || github::owner_repo(&root_path)).await??;

    let issue_ids =
        sqlx::query_scalar::<_, String>("SELECT issue_id FROM worktree_links WHERE repo_path = ?")
            .bind(&root)
            .fetch_all(db)
            .await?;

    // One title search per issue, concurrently. Each issue may have several PRs
    // (one `WorktreePr` row each, grouped by issue id on the frontend). Title search
    // (not branch listing) so merged PRs — whose branches GitHub deleted — still show.
    let handles: Vec<_> = issue_ids
        .into_iter()
        .map(|issue_id| {
            let (token, owner, name) = (token.clone(), owner.clone(), name.clone());
            tokio::spawn(async move {
                github::prs_for_issue(&token, &owner, &name, &issue_id)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(number, url, state)| WorktreePr {
                        issue_id: issue_id.clone(),
                        number,
                        url,
                        state,
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();

    let mut out = Vec::new();
    for h in handles {
        if let Ok(prs) = h.await {
            out.extend(prs);
        }
    }
    Ok(out)
}

/// Build a proposed PR (title + body) for the dialog. The title defaults to the
/// first commit's subject (already a clean AI-written summary from the commit
/// flow). With `fill`, the body is drafted by Claude from the repo's PR template
/// + the branch diff; otherwise it's the raw template (or empty).
pub async fn draft(db: &Db, repo: &str, issue_id: &str, fill: bool) -> Result<PrDraft> {
    let c = worktree::coords(db, repo, issue_id).await?;
    // `first_commit_subject` and `pr_template` shell out / read files; keep them
    // off the async runtime's worker threads.
    let (title, template) = {
        let c = c.clone();
        tokio::task::spawn_blocking(move || {
            (
                git::first_commit_subject(&c.path, &c.base_branch),
                github::pr_template(&c.path),
            )
        })
        .await?
    };
    let title = title.ok_or_else(|| {
        anyhow!(
            "No commits to open a PR for (branch isn't ahead of {}).",
            c.base_branch
        )
    })?;

    let body = if fill {
        // Fall back to the raw template if Claude isn't available / fails.
        draft_body(&c, issue_id, template.clone())
            .await
            .unwrap_or_else(|| template.unwrap_or_default())
    } else {
        template.unwrap_or_default()
    };

    Ok(PrDraft {
        title,
        body,
        base_branch: c.base_branch,
    })
}

/// Draft the PR body with a headless Claude call against the `fill-pr` template.
async fn draft_body(c: &Coords, issue_id: &str, template: Option<String>) -> Option<String> {
    // The diff reads, prompt render, and Claude call all block — run the whole
    // chain on one blocking thread instead of shelling out git on the runtime.
    let c = c.clone();
    let issue_id = issue_id.to_string();
    tokio::task::spawn_blocking(move || {
        // Cap the diff so the prompt stays within sane arg/token limits.
        let diff: String = git::diff_range(&c.path, &c.base_branch)
            .chars()
            .take(12_000)
            .collect();
        let prompt = prompts::render(
            "fill-pr",
            minijinja::context! {
                pr_template => template.unwrap_or_default(),
                branch_name => c.branch.clone(),
                ticket_id => issue_id,
                base_branch => c.base_branch.clone(),
                commit_log => git::commit_log(&c.path, &c.base_branch),
                diff_stat => git::diff_stat(&c.path, &c.base_branch),
                diff => diff,
            },
        )
        .ok()?;
        agent::run_print(&c.path, &prompt, &["Read"], Some(agent::HELPER_MODEL))
    })
    .await
    .ok()
    .flatten()
}

/// Create the PR: push the branch, then open it via the GitHub API. The token is
/// borrowed from the `gh` CLI; errors clearly if `gh` isn't authenticated.
pub async fn create(
    db: &Db,
    repo: &str,
    issue_id: &str,
    title: &str,
    body: &str,
    draft: bool,
    reviewers: &[String],
) -> Result<NewPr> {
    let c = worktree::coords(db, repo, issue_id).await?;
    let token = github::token()
        .await
        .ok_or_else(|| anyhow!("GitHub CLI not authenticated. Run `gh auth login`."))?;

    // Remote parsing + push are blocking (subprocess) — keep off the async pool.
    let path = c.path.clone();
    let (owner, name) = tokio::task::spawn_blocking(move || github::owner_repo(&path)).await??;

    let path = c.path.clone();
    let branch = c.branch.clone();
    tokio::task::spawn_blocking(move || git::push(&path, &branch)).await??;

    let (number, url) = github::create_pr(
        &token,
        &owner,
        &name,
        title,
        &c.branch,
        &c.base_branch,
        body,
        draft,
    )
    .await?;

    // Reviewers are requested after the PR exists. Best-effort: the PR is the
    // primary artifact, so a reviewer-side failure must not fail the whole call
    // (that would leave a created PR behind an error + a "PR already exists" retry).
    // Log it and return the PR — the user can add reviewers on GitHub.
    if let Err(e) = github::request_reviewers(&token, &owner, &name, number, reviewers, &[]).await {
        log::warn!("PR #{number} created but requesting reviewers failed: {e}");
    }

    Ok(NewPr { number, url })
}

/// Candidate reviewers (repo collaborators with push access) for the create-PR
/// dialog's reviewer picker. Empty when `gh` isn't authenticated or the repo has
/// no resolvable GitHub remote, so the dialog just omits the picker.
pub async fn reviewers(
    db: &Db,
    repo: &str,
    issue_id: &str,
) -> Result<Vec<santree_core::domain::Reviewer>> {
    let Some(token) = github::token().await else {
        return Ok(vec![]);
    };
    let c = worktree::coords(db, repo, issue_id).await?;
    let path = c.path.clone();
    let Ok((owner, name)) = tokio::task::spawn_blocking(move || github::owner_repo(&path)).await?
    else {
        return Ok(vec![]);
    };
    Ok(github::list_reviewers(&token, &owner, &name)
        .await
        .unwrap_or_default())
}
