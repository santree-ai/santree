//! Pull-request orchestration: draft a title/body for the create-PR dialog, then
//! create the PR (push the branch + open it via the GitHub API). Composes
//! `git` + `github` + `prompts` + `agent`; the thin commands call in here.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri_specta::Event;

use anyhow::{anyhow, Result};

use santree_core::domain::{NewPr, PrDraft, WorktreePr};

use crate::agent;
use crate::db::Db;
use crate::git;
use crate::github;
use crate::prompts;
use crate::repo;
use crate::worktree::{self, Coords};

#[derive(Clone, serde::Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBasesChanged {
    pub repo: String,
    pub issue_ids: Vec<String>,
}

#[derive(Default)]
struct PrRefresh {
    slug: Option<String>,
    offset: usize,
    fallback: HashMap<String, Vec<github::RepoPr>>,
}

type RefreshLock = Arc<tokio::sync::Mutex<PrRefresh>>;
static REFRESH_LOCKS: LazyLock<Mutex<HashMap<String, RefreshLock>>> =
    LazyLock::new(Default::default);

/// Live PR status for every tracked worktree in `repo`, fetched from GitHub with a
/// single repo-wide PR list (see [`github::prs_for_repo`]) rather than one call per
/// worktree, and joined to worktrees by [`match_issue`]. Returns an empty list (not
/// an error) when `gh` isn't authenticated, the repo has no linked worktrees, or the
/// call itself fails (logged, not surfaced) so the UI degrades gracefully;
/// worktrees without a PR are simply omitted.
pub async fn statuses(db: &Db, repo: &str, app: &tauri::AppHandle) -> Result<Vec<WorktreePr>> {
    let Some(token) = github::token().await else {
        return Ok(vec![]);
    };
    // A Daedalus repo has no worktrees on this machine to have PRs for (its
    // worktrees run on the server — docs/remote.md), and the sidebar polls this
    // for every project, so it answers empty rather than failing.
    if repo::is_daedalus(db, repo).await? {
        return Ok(vec![]);
    }
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;

    // Serialize snapshots so a slower, older response cannot undo a newer stack.
    let lock = REFRESH_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(root.clone())
        .or_default()
        .clone();
    let mut refresh = lock.lock().await;

    // A missing/non-GitHub origin (e.g. a "Local git" repo) is not an error here —
    // same not-connected-⇒-empty contract as the unauthenticated case above and as
    // `reviewers` below.
    let root_path = PathBuf::from(&root);
    let Ok((owner, name)) =
        tokio::task::spawn_blocking(move || github::owner_repo(&root_path)).await?
    else {
        return Ok(vec![]);
    };

    let slug = format!("{owner}/{name}");
    if refresh.slug.as_deref() != Some(slug.as_str()) {
        *refresh = PrRefresh {
            slug: Some(slug.clone()),
            ..PrRefresh::default()
        };
    }
    let links = linked_worktrees(db, &root).await?;
    if links.is_empty() {
        return Ok(vec![]);
    }
    let issue_ids: HashSet<String> = links.iter().map(|(id, _)| id.clone()).collect();
    let by_branch: HashMap<String, String> = links
        .iter()
        .map(|(id, branch)| (branch.clone(), id.clone()))
        .collect();

    // List once per repo (see `prs_for_repo`'s doc comment on the rate-limit
    // problem this avoids), then match every linked worktree client-side. A failed
    // call degrades to empty like the unauthenticated case above, but is logged —
    // a 403/rate-limit shouldn't just make PR chips vanish with nothing in the log
    // to explain why.
    let mut prs = match github::prs_for_repo(&token, &owner, &name).await {
        Ok(prs) => prs,
        Err(e) => {
            log::warn!("worktreePrs: listing PRs failed for {owner}/{name}: {e}");
            return Ok(vec![]);
        }
    };

    // A worktree's PR can be older than everything in the recently-updated
    // window (a dormant PR in a high-traffic monorepo) — without this fallback
    // the UI reads that as "no PR" and re-offers Create PR. One narrow lookup
    // per still-unmatched worktree, capped so a burst of refetches on a repo full
    // of PR-less worktrees can't chew through the API budget; per the
    // no-silent-caps rule, the cap is logged. Rotate the probe window so dormant
    // open PRs cannot be permanently starved by earlier PR-less worktrees.
    const FALLBACK_LOOKUP_CAP: usize = 10;
    let matched: HashSet<&str> = prs
        .iter()
        .filter(|p| p.same_repo && p.state == santree_core::domain::PrState::Open)
        .map(|p| p.head_ref.as_str())
        .collect();
    let unmatched: Vec<(String, String)> = links
        .iter()
        .filter(|(_, branch)| !matched.contains(branch.as_str()))
        .cloned()
        .collect();
    if unmatched.len() > FALLBACK_LOOKUP_CAP {
        log::warn!("worktreePrs: {} unmatched worktrees in {owner}/{name}, probing the next {FALLBACK_LOOKUP_CAP}", unmatched.len());
    }
    let unmatched = fallback_candidates(unmatched, &mut refresh.offset, FALLBACK_LOOKUP_CAP);
    for (id, branch) in unmatched {
        match github::prs_for_branch(&token, &owner, &name, &branch).await {
            // GitHub already filtered on the head ref; running the result back
            // through the same join keeps one classifier rather than a second,
            // looser one living down here.
            Ok(found) => {
                let found: Vec<_> = found
                    .into_iter()
                    .filter(|p| {
                        match_issue(p, &by_branch, &issue_ids).as_deref() == Some(id.as_str())
                    })
                    .collect();
                refresh.fallback.insert(branch, found.clone());
                prs.extend(found);
            }
            // Degrade like the bulk list: this issue just shows no PR chip.
            Err(e) => log::warn!("worktreePrs: fallback PR lookup failed for {id}: {e}"),
        }
    }
    // The narrow lookup is newer than the bulk snapshot if a PR changed mid-refresh.
    prs.reverse();
    let mut seen_prs = HashSet::new();
    prs.retain(|p| seen_prs.insert(p.number));
    prs.reverse();
    let changed = reconcile_bases(db, &root, &links, &prs).await?;
    if !changed.is_empty() {
        WorktreeBasesChanged {
            repo: repo.to_string(),
            issue_ids: changed,
        }
        .emit(app)?;
    }
    refresh
        .fallback
        .retain(|branch, _| by_branch.contains_key(branch));
    // Cached probe results keep badges stable between probe windows. Only the
    // fresh responses above may reconcile bases; cached PRs never write the DB.
    for pr in &prs {
        if pr.same_repo && by_branch.contains_key(&pr.head_ref) {
            refresh.fallback.entry(pr.head_ref.clone()).or_default();
        }
    }
    let prs = with_cached_prs(prs, &mut refresh.fallback);
    Ok(prs
        .into_iter()
        .filter_map(|p| {
            let issue_id = match_issue(&p, &by_branch, &issue_ids)?;
            Some(WorktreePr {
                issue_id,
                repo: slug.clone(),
                number: p.number,
                url: p.url,
                state: p.state,
            })
        })
        .collect())
}

fn with_cached_prs(
    fresh: Vec<github::RepoPr>,
    cached: &mut HashMap<String, Vec<github::RepoPr>>,
) -> Vec<github::RepoPr> {
    for pr in &fresh {
        if let Some(entries) = cached.get_mut(&pr.head_ref) {
            entries.retain(|old| old.number != pr.number);
            entries.push(pr.clone());
        }
    }
    let mut seen = HashSet::new();
    fresh
        .into_iter()
        .chain(cached.values().flatten().cloned())
        .filter(|pr| seen.insert(pr.number))
        .collect()
}

fn fallback_candidates(
    mut candidates: Vec<(String, String)>,
    offset: &mut usize,
    limit: usize,
) -> Vec<(String, String)> {
    if !candidates.is_empty() {
        let count = candidates.len();
        candidates.rotate_left(*offset % count);
        *offset = (*offset + limit) % count;
        candidates.truncate(limit);
    }
    candidates
}

/// Only exact same-repository head matches may change a base. Title tags are
/// useful for PR badges, but do not prove that a PR describes this branch.
async fn reconcile_bases(
    db: &Db,
    root: &str,
    links: &[(String, String)],
    prs: &[github::RepoPr],
) -> Result<Vec<String>> {
    let mut targets: HashMap<&str, HashSet<&str>> = HashMap::new();
    for pr in prs {
        if pr.same_repo && pr.state == santree_core::domain::PrState::Open {
            targets
                .entry(&pr.head_ref)
                .or_default()
                .insert(&pr.base_ref);
        }
    }
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT issue_id, branch, base_branch FROM worktree_links WHERE repo_path = ?",
    )
    .bind(root)
    .fetch_all(&mut *tx)
    .await?;
    let mut parents: HashMap<&str, &str> = rows
        .iter()
        .map(|(_, branch, base)| (branch.as_str(), base.as_str()))
        .collect();
    let mut changes = Vec::new();
    for (id, branch, old_base) in &rows {
        if !links
            .iter()
            .any(|(linked_id, linked_branch)| linked_id == id && linked_branch == branch)
        {
            continue;
        }
        let Some(bases) = targets.get(branch.as_str()) else {
            continue;
        };
        if bases.len() != 1 {
            log::warn!("worktreePrs: ambiguous open PR bases for {branch}; retaining {old_base}");
            continue;
        }
        let base = *bases.iter().next().unwrap();
        if git::safe_branch(base).is_err() || base == branch {
            log::warn!("worktreePrs: invalid PR base for {branch}; retaining {old_base}");
            continue;
        }
        if base != old_base {
            parents.insert(branch, base);
            changes.push((id, branch, base));
        }
    }
    // Check the final graph, not each update in isolation: reversing an edge can
    // require two simultaneous changes whose intermediate state is cyclic.
    for (_, branch, _) in &changes {
        let mut seen = HashSet::new();
        let mut cursor = branch.as_str();
        while let Some(parent) = parents.get(cursor) {
            if !seen.insert(cursor) {
                log::warn!("worktreePrs: refusing cyclic PR base updates in {root}");
                return Ok(vec![]);
            }
            cursor = parent;
        }
    }
    for (id, branch, base) in &changes {
        sqlx::query("UPDATE worktree_links SET base_branch = ? WHERE repo_path = ? AND issue_id = ? AND branch = ?")
            .bind(base).bind(root).bind(id).bind(branch).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(changes.into_iter().map(|(id, _, _)| id.clone()).collect())
}

/// The repo's worktrees as `(issue id, branch)` — the join keys a repo-wide PR
/// list is matched against. Ordered by id so the per-issue fallback probe below is
/// deterministic in which ids it caps.
///
/// A review checkout is excluded. It sits on the PR's own branch, so it would
/// match — but "which of my worktrees has a pull request" is a question about work
/// the user started, and this answer is what the Trees sidebar hangs its PR marks
/// off. The Reviews side finds a PR's checkout through `reviews::review_checkout`,
/// which asks by pull request rather than by branch.
pub(crate) async fn linked_worktrees(db: &Db, root: &str) -> Result<Vec<(String, String)>> {
    let mut links: Vec<(String, String)> = sqlx::query_as(
        "SELECT issue_id, branch FROM worktree_links WHERE repo_path = ? ORDER BY issue_id",
    )
    .bind(root)
    .fetch_all(db)
    .await?;
    let reviews = crate::reviews::review_ids(db, root).await?;
    links.retain(|(id, _)| !reviews.contains(id));
    Ok(links)
}

/// The worktree a PR belongs to: its head branch first, its `[ISSUE-ID]` title tag
/// second.
///
/// The branch wins because it is the join GitHub itself makes — "a pull request
/// already exists for owner:branch" is the error you get for opening a second one
/// — and because it survives everything a title doesn't: the tag is a convention
/// nothing enforces (our own create-PR dialog defaults the title to the first
/// commit's subject, brackets and all optional), and PRs opened from `gh` or the
/// GitHub UI, or simply renamed later, carry no tag at all.
///
/// The tag stays as the fallback for what the branch can't answer: a PR whose
/// branch was renamed after it was opened, or a worktree adopted onto a branch
/// with a different name than the PR's.
fn match_issue(
    pr: &github::RepoPr,
    by_branch: &HashMap<String, String>,
    issue_ids: &HashSet<String>,
) -> Option<String> {
    // Only a head branch in *this* repo is a join key. A fork's `head_ref` is a
    // bare branch name from someone else's repo, so a name collision would attach
    // a stranger's PR to the user's worktree — showing the wrong PR is worse than
    // showing none. A fork PR can still match on its title tag below, which names
    // the ticket explicitly and can't collide by accident.
    if pr.same_repo {
        if let Some(id) = by_branch.get(&pr.head_ref) {
            return Some(id.clone());
        }
    }
    let tag = issue_tag(&pr.title)?;
    issue_ids.contains(tag).then(|| tag.to_string())
}

/// The `[ISSUE-ID]` tag this app's PR/commit flow writes at the front of a PR title
/// (mirroring the branch name), e.g. `"[AK-123] Add foo"` → `Some("AK-123")`. Used
/// by [`match_issue`] to match a repo-wide PR list against several linked issue ids
/// by exact bracket contents — never a substring, so `"[AK-1]"` can't false-match
/// `"AK-10"` or vice versa the way a plain `contains` check would.
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
pub async fn draft(
    db: &Db,
    repo: &str,
    issue_id: &str,
    fill: bool,
    send_transcripts: bool,
) -> Result<PrDraft> {
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
        draft_body(db, repo, &c, issue_id, template.clone(), send_transcripts)
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

/// Ceiling on one PR-body draft. Above [`agent::SHORT_TIMEOUT`] because the prompt
/// carries a capped diff plus (optionally) whole session transcripts, and a
/// stronger model than the default reads them slower — but this one has a template
/// to fall back on, so it doesn't need the brief's patience.
const BODY_TIMEOUT: Duration = Duration::from_secs(240);

/// Draft the PR body with the configured headless provider against the `fill-pr`
/// template.
async fn draft_body(
    db: &Db,
    repo: &str,
    c: &Coords,
    issue_id: &str,
    template: Option<String>,
    send_transcripts: bool,
) -> Option<String> {
    // Resolve the effective prompt sources + fetch the issue (both async) before
    // dropping onto the blocking pool. The issue is best-effort — a missing/failed
    // fetch just leaves `ticket_content` empty, same as the work flow.
    let sources = prompts::resolve_sources(db, Some(repo)).await.ok()?;
    let helper = agent::helper_config(db, repo, agent::HelperKind::PrBody)
        .await
        .ok()?;
    let detail = crate::tracker::triage_detail(db, repo, issue_id)
        .await
        .ok()
        .flatten();
    // Opt-in: mine this worktree's agent session transcripts for decisions/
    // rationale the diff alone can't show. Best-effort — an unreadable/missing
    // transcript just leaves `transcripts` empty. Gathered here (async file I/O on
    // the blocking pool) rather than inside the render closure below.
    let transcripts = if send_transcripts {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        crate::session::worktree_transcripts(db, repo, issue_id, home.as_deref())
            .await
            .unwrap_or_default()
    } else {
        String::new()
    };

    // The diff reads, prompt render, and agent call all block — run the whole
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
                transcripts => transcripts,
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
        agent::run_helper(&helper, &c.path, &prompt, &[&read_worktree], BODY_TIMEOUT)
            // Best-effort: the caller falls back to the raw template.
            .ok()
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
    use santree_core::domain::PrState;

    /// One linked worktree per `(issue_id, branch)` pair, in the two shapes
    /// [`match_issue`] takes.
    fn links(pairs: &[(&str, &str)]) -> (HashMap<String, String>, HashSet<String>) {
        (
            pairs
                .iter()
                .map(|(id, branch)| ((*branch).to_string(), (*id).to_string()))
                .collect(),
            pairs.iter().map(|(id, _)| (*id).to_string()).collect(),
        )
    }

    fn pr(title: &str, head_ref: &str) -> github::RepoPr {
        github::RepoPr {
            number: 1,
            title: title.to_string(),
            url: "https://github.com/acme/api/pull/1".to_string(),
            state: PrState::Open,
            head_ref: head_ref.to_string(),
            base_ref: "main".to_string(),
            same_repo: true,
        }
    }

    #[test]
    fn fallback_refreshes_reach_worktrees_beyond_the_first_ten() {
        let candidates: Vec<_> = (0..23)
            .map(|i| (i.to_string(), format!("branch-{i}")))
            .collect();
        let mut offset = 0;
        let mut visited = HashSet::new();
        for _ in 0..3 {
            let batch = fallback_candidates(candidates.clone(), &mut offset, 10);
            assert_eq!(batch.len(), 10);
            visited.extend(batch.into_iter().map(|(id, _)| id));
        }
        assert_eq!(visited.len(), candidates.len());
        assert!(fallback_candidates(vec![], &mut offset, 10).is_empty());
        assert_eq!(
            fallback_candidates(candidates[..2].to_vec(), &mut offset, 10).len(),
            2
        );
    }

    #[test]
    fn skipped_probe_windows_keep_prs_but_fresh_responses_win() {
        let mut cache = HashMap::new();
        let old = targeting("old-branch", "old-base");
        cache.insert("old-branch".into(), vec![old]);
        // Another branch gets this refresh's probe; the dormant PR still displays.
        assert_eq!(with_cached_prs(vec![], &mut cache).len(), 1);
        let mut fresh = targeting("old-branch", "new-base");
        fresh.state = PrState::Closed;
        let result = with_cached_prs(vec![fresh], &mut cache);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].base_ref, "new-base");
        assert_eq!(result[0].state, PrState::Closed);
        assert_eq!(
            with_cached_prs(vec![], &mut cache)[0].state,
            PrState::Closed
        );
        // A successful empty lookup replaces the earlier cache entry.
        cache.insert("old-branch".into(), vec![]);
        assert!(with_cached_prs(vec![], &mut cache).is_empty());
    }

    async fn stack_db() -> (Db, PathBuf, Vec<(String, String)>) {
        let dir = std::env::temp_dir().join(format!("santree-pr-bases-{}", uuid::Uuid::new_v4()));
        let db = crate::db::init(dir.join("test.db")).await.unwrap();
        for (id, branch, base) in [("A", "a", "main"), ("B", "b", "a"), ("C", "c", "b")] {
            for root in ["repo", "other"] {
                sqlx::query("INSERT INTO worktree_links (repo_path, issue_id, branch, base_branch, worktree_path) VALUES (?, ?, ?, ?, ?)")
                    .bind(root).bind(id).bind(branch).bind(base).bind(format!("/{root}/{id}"))
                    .execute(&db).await.unwrap();
            }
        }
        let links = linked_worktrees(&db, "repo").await.unwrap();
        (db, dir, links)
    }

    async fn bases(db: &Db, root: &str) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT base_branch FROM worktree_links WHERE repo_path = ? ORDER BY issue_id",
        )
        .bind(root)
        .fetch_all(db)
        .await
        .unwrap()
    }

    fn targeting(head: &str, base: &str) -> github::RepoPr {
        github::RepoPr {
            base_ref: base.into(),
            ..pr("", head)
        }
    }

    #[tokio::test]
    async fn retargeted_stack_updates_atomically_and_only_in_its_repo() {
        let (db, dir, links) = stack_db().await;
        let prs = [
            targeting("a", "b"),
            targeting("b", "main"),
            targeting("c", "a"),
        ];
        let mut changed = reconcile_bases(&db, "repo", &links, &prs).await.unwrap();
        changed.sort();
        assert_eq!(changed, ["A", "B", "C"]);
        assert_eq!(bases(&db, "repo").await, ["b", "main", "a"]);
        assert_eq!(bases(&db, "other").await, ["main", "a", "b"]);
        assert!(reconcile_bases(&db, "repo", &links, &prs)
            .await
            .unwrap()
            .is_empty());
        db.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn absent_closed_fork_and_title_only_prs_preserve_local_bases() {
        let (db, dir, links) = stack_db().await;
        assert!(reconcile_bases(&db, "repo", &links, &[])
            .await
            .unwrap()
            .is_empty());
        let mut closed = targeting("b", "main");
        closed.state = PrState::Closed;
        let mut merged = targeting("c", "main");
        merged.state = PrState::Merged;
        let mut fork = targeting("a", "c");
        fork.same_repo = false;
        let mut title = targeting("unrelated", "main");
        title.title = "[C] Same ticket, different branch".into();
        assert!(
            reconcile_bases(&db, "repo", &links, &[closed, merged, fork, title])
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(bases(&db, "repo").await, ["main", "a", "b"]);
        db.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn cycles_ambiguous_targets_and_unsafe_refs_never_change_the_stack() {
        let (db, dir, links) = stack_db().await;
        for prs in [
            vec![targeting("a", "c"), targeting("c", "a")],
            vec![targeting("b", "b")],
            vec![targeting("b", "main"), targeting("b", "other-base")],
            vec![targeting("b", "--help")],
        ] {
            assert!(reconcile_bases(&db, "repo", &links, &prs)
                .await
                .unwrap()
                .is_empty());
            assert_eq!(bases(&db, "repo").await, ["main", "a", "b"]);
        }
        db.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn branch_reassigned_during_fetch_is_not_updated() {
        let (db, dir, links) = stack_db().await;
        sqlx::query("UPDATE worktree_links SET branch = 'new-b' WHERE repo_path = 'repo' AND issue_id = 'B'")
            .execute(&db).await.unwrap();
        assert!(reconcile_bases(
            &db,
            "repo",
            &links,
            &[targeting("b", "main"), targeting("new-b", "main")]
        )
        .await
        .unwrap()
        .is_empty());
        assert_eq!(bases(&db, "repo").await, ["main", "a", "b"]);
        db.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The same PR raised from a fork: identical head branch *name*, different repo.
    fn fork_pr(title: &str, head_ref: &str) -> github::RepoPr {
        github::RepoPr {
            same_repo: false,
            ..pr(title, head_ref)
        }
    }

    /// A fork's `head_ref` is a bare branch name from someone else's repo, so a
    /// collision with one of our worktree branches must NOT bind that PR to it —
    /// attaching a stranger's PR to the user's work is worse than attaching none.
    #[test]
    fn a_fork_pr_never_matches_on_a_colliding_branch_name() {
        let (by_branch, ids) = links(&[("AK-1", "feature/login")]);
        assert_eq!(
            match_issue(
                &fork_pr("Unrelated work", "feature/login"),
                &by_branch,
                &ids
            ),
            None
        );
        // The same fork PR still matches when its title names the ticket outright:
        // a tag cannot collide by accident the way a branch name can.
        assert_eq!(
            match_issue(
                &fork_pr("[AK-1] Unrelated work", "feature/login"),
                &by_branch,
                &ids
            ),
            Some("AK-1".to_string())
        );
    }

    #[test]
    fn match_issue_uses_the_head_ref_when_the_title_has_no_tag() {
        // The bug this join replaced: santree's own create-PR dialog defaults the
        // title to the first commit's subject, which carries no `[…]` tag — so a
        // real PR read as "no PR" and the worktree re-offered Create PR.
        let (by_branch, ids) = links(&[("AK-373", "santree/ak-373-kb-conflict-judge")]);
        let pr = pr(
            "AK-373 Add KB conflict and duplicate judge",
            "santree/ak-373-kb-conflict-judge",
        );
        assert_eq!(
            match_issue(&pr, &by_branch, &ids).as_deref(),
            Some("AK-373")
        );
    }

    #[test]
    fn match_issue_falls_back_to_the_title_tag_when_the_branch_is_unknown() {
        // A PR opened from a branch that has since been renamed still resolves.
        let (by_branch, ids) = links(&[("AK-373", "santree/ak-373-renamed")]);
        let pr = pr("[AK-373] Add the judge", "santree/ak-373-original");
        assert_eq!(
            match_issue(&pr, &by_branch, &ids).as_deref(),
            Some("AK-373")
        );
    }

    #[test]
    fn match_issue_prefers_the_head_ref_over_the_title_tag() {
        // A retitled/copy-pasted tag must not outrank the branch GitHub itself
        // keys "a pull request already exists for …" on.
        let (by_branch, ids) = links(&[("AK-1", "santree/ak-1"), ("AK-2", "santree/ak-2")]);
        let pr = pr("[AK-1] Actually opened from AK-2's branch", "santree/ak-2");
        assert_eq!(match_issue(&pr, &by_branch, &ids).as_deref(), Some("AK-2"));
    }

    #[test]
    fn match_issue_ignores_a_pr_belonging_to_no_worktree() {
        let (by_branch, ids) = links(&[("AK-373", "santree/ak-373")]);
        assert_eq!(
            match_issue(&pr("Bump deps", "renovate/deps"), &by_branch, &ids),
            None
        );
        // A tag for an issue this repo has no worktree for is not a match either.
        assert_eq!(
            match_issue(&pr("[AK-999] Other", "other"), &by_branch, &ids),
            None
        );
    }

    #[test]
    fn match_issue_does_not_conflate_prefixed_ids() {
        // The exactness `issue_tag` protects, checked through the join that uses
        // it: "AK-1" must not swallow "AK-10" or vice versa.
        let (by_branch, ids) = links(&[("AK-1", "santree/ak-1")]);
        assert_eq!(
            match_issue(
                &pr("[AK-10] Fix another thing", "santree/ak-10"),
                &by_branch,
                &ids
            ),
            None
        );
        let (by_branch, ids) = links(&[("AK-10", "santree/ak-10")]);
        assert_eq!(
            match_issue(
                &pr("[AK-1] Fix the thing", "santree/ak-1"),
                &by_branch,
                &ids
            ),
            None
        );
    }

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
