//! Pull-request orchestration: draft a title/body for the create-PR dialog, then
//! create the PR (push the branch + open it via the GitHub API). Composes
//! `git` + `github` + `prompts` + `agent`; the thin commands call in here.

use std::collections::HashSet;
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

/// Live PR status for every tracked worktree in `repo`, fetched from GitHub with a
/// single repo-wide search (see [`github::prs_for_repo`]) rather than one call per
/// worktree. Returns an empty list (not an error) when `gh` isn't authenticated, the
/// repo has no linked worktrees, or the search itself fails (logged, not surfaced)
/// so the UI degrades gracefully; worktrees without a PR are simply omitted.
pub async fn statuses(db: &Db, repo: &str) -> Result<Vec<WorktreePr>> {
    let Some(token) = github::token().await else {
        return Ok(vec![]);
    };
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;

    // A missing/non-GitHub origin (e.g. a "Local git" repo) is not an error here —
    // same not-connected-⇒-empty contract as the unauthenticated case above and as
    // `reviewers` below.
    let root_path = PathBuf::from(&root);
    let Ok((owner, name)) =
        tokio::task::spawn_blocking(move || github::owner_repo(&root_path)).await?
    else {
        return Ok(vec![]);
    };

    let issue_ids: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT issue_id FROM worktree_links WHERE repo_path = ?")
            .bind(&root)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    if issue_ids.is_empty() {
        return Ok(vec![]);
    }

    // Search once per repo (see `prs_for_repo`'s doc comment on the rate-limit
    // problem this replaces), then match every linked issue id client-side by the
    // `[ISSUE-ID] …` title tag. A failed search degrades to empty like the
    // unauthenticated case above, but is logged — a 403/rate-limit shouldn't just
    // make PR chips vanish with nothing in the log to explain why.
    let prs = match github::prs_for_repo(&token, &owner, &name).await {
        Ok(prs) => prs,
        Err(e) => {
            log::warn!("worktreePrs: PR search failed for {owner}/{name}: {e}");
            return Ok(vec![]);
        }
    };

    Ok(prs
        .into_iter()
        .filter_map(|p| {
            let tag = issue_tag(&p.title)?;
            issue_ids.contains(tag).then(|| WorktreePr {
                issue_id: tag.to_string(),
                number: p.number,
                url: p.url,
                state: p.state,
            })
        })
        .collect())
}

/// The `[ISSUE-ID]` tag this app's PR/commit flow writes at the front of a PR title
/// (mirroring the branch name), e.g. `"[AK-123] Add foo"` → `Some("AK-123")`. Used
/// to match a repo-wide PR search against several linked issue ids by exact bracket
/// contents — never a substring, so `"[AK-1]"` can't false-match `"AK-10"` or vice
/// versa the way a plain `contains` check would.
fn issue_tag(title: &str) -> Option<&str> {
    let rest = title.strip_prefix('[')?;
    let (tag, _) = rest.split_once(']')?;
    let tag = tag.trim();
    (!tag.is_empty()).then_some(tag)
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
        draft_body(db, repo, &c, issue_id, template.clone())
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
async fn draft_body(
    db: &Db,
    repo: &str,
    c: &Coords,
    issue_id: &str,
    template: Option<String>,
) -> Option<String> {
    // Resolve the effective prompt sources + fetch the issue (both async) before
    // dropping onto the blocking pool. The issue is best-effort — a missing/failed
    // fetch just leaves `ticket_content` empty, same as the work flow.
    let sources = prompts::resolve_sources(db, Some(repo)).await.ok()?;
    let detail = crate::linear::triage_detail(db, repo, issue_id)
        .await
        .ok()
        .flatten();

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
        // Render the (editable) issue into `ticket_content`, and flatten its fields
        // so a customized `fill-pr` prompt can `{% include "issue" %}` too.
        let ticket_content = detail
            .as_ref()
            .and_then(|d| prompts::render_ticket_from(&sources, d).ok())
            .unwrap_or_default();
        let issue_ctx = detail
            .as_ref()
            .map(prompts::issue_context)
            .unwrap_or_else(|| minijinja::context! {});
        let prompt = prompts::render_from(
            &sources,
            "fill-pr",
            minijinja::context! {
                pr_template => template.unwrap_or_default(),
                branch_name => c.branch.clone(),
                ticket_id => issue_id,
                ticket_content => ticket_content,
                base_branch => c.base_branch.clone(),
                commit_log => git::commit_log(&c.path, &c.base_branch),
                diff_stat => git::diff_stat(&c.path, &c.base_branch),
                diff => diff,
                ..issue_ctx,
            },
        )
        .ok()?;
        // `Read` is granted only inside the worktree. The prompt embeds Linear
        // ticket text, which any org member (or bot, or integration) can write, and
        // the drafted body is something the user then pushes — an unscoped grant
        // would let an injected "…also include the contents of ~/.ssh/id_rsa" reach
        // real secrets. Everything this prompt legitimately needs is under `c.path`.
        let read_worktree = agent::read_within(&c.path);
        agent::run_print(
            &c.path,
            &prompt,
            &[&read_worktree],
            Some(agent::HELPER_MODEL),
        )
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
    // An empty picker is the graceful fallback, but log why — a rate-limited or
    // permission-denied collaborators call otherwise looks like "no collaborators".
    Ok(github::list_reviewers(&token, &owner, &name)
        .await
        .unwrap_or_else(|e| {
            log::warn!("Reviewers: listing collaborators for {owner}/{name} failed: {e}");
            Vec::new()
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_tag_extracts_bracketed_prefix() {
        assert_eq!(issue_tag("[AK-1] Fix the thing"), Some("AK-1"));
    }

    #[test]
    fn issue_tag_does_not_conflate_prefixed_ids() {
        // A repo-wide search returns every PR in one shot, so the client-side match
        // must be exact — "AK-1" must not swallow "AK-10" or vice versa.
        assert_eq!(issue_tag("[AK-10] Fix another thing"), Some("AK-10"));
        assert_ne!(issue_tag("[AK-10] Fix another thing"), Some("AK-1"));
        assert_ne!(issue_tag("[AK-1] Fix the thing"), Some("AK-10"));
    }

    #[test]
    fn issue_tag_none_without_leading_bracket() {
        assert_eq!(issue_tag("Fix AK-1"), None);
    }

    #[test]
    fn issue_tag_none_for_empty_brackets() {
        assert_eq!(issue_tag("[] Fix the thing"), None);
    }

    #[test]
    fn issue_tag_trims_whitespace_inside_brackets() {
        assert_eq!(issue_tag("[ AK-1 ] Fix the thing"), Some("AK-1"));
    }
}
