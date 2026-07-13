//! Minimal GitHub integration for opening pull requests.
//!
//! The app has no GitHub OAuth of its own yet, so it borrows the token the user
//! already authorized for the `gh` CLI (`gh auth token`) and talks to the REST
//! API directly with `reqwest` — no browser round-trip. The owner/repo comes from
//! the worktree's `origin` remote; the PR template is read from the checkout.

use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, bail, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use santree_core::domain::{
    CheckAnnotation, CheckLog, CheckLogBlock, CheckLogLevel, CheckLogLine, CheckRollup, CheckStatus,
    CheckStep, CommentKind, FileSource, MergeQueue, MergeQueueEntry, MergeQueueState, PrCheck,
    PrComment, PrDetail, PrFile, PrLabel, PrState, PrThread, ReviewDecision, ReviewInbox, ReviewPr,
    Reviewer, ReviewerKind, TeamReviews,
};

use crate::git;
use crate::gql::{self, Connection};
use crate::repo;

/// Stamp the headers every GitHub call needs: bearer auth, the v3 JSON Accept
/// type, and a User-Agent (GitHub rejects requests that omit one).
fn rest(builder: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    builder
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "santree")
}

/// GET a GitHub REST endpoint and decode its JSON body, erroring on a non-success
/// status. The shared shape behind the simple REST reads.
async fn get_json<T: DeserializeOwned>(
    url: String,
    query: &[(&str, &str)],
    token: &str,
) -> Result<T> {
    let res = rest(gql::client().get(url).query(query), token)
        .send()
        .await?;
    if !res.status().is_success() {
        let status = res.status();
        // A 403 carries rate-limit details in the body; surface them instead
        // of a bare status code.
        let body = res.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        bail!("GitHub returned {status}: {snippet}");
    }
    Ok(res.json().await?)
}

/// The GitHub token the user authorized for the `gh` CLI. `None` when `gh` isn't
/// installed or the user hasn't run `gh auth login`. Shells out, so it runs on the
/// blocking pool rather than the async executor.
///
/// `gh` is resolved through the user's login shell (not bare `Command::new("gh")`):
/// a Finder-launched bundle inherits a minimal PATH that misses Homebrew, so a bare
/// spawn would find `gh` in `tauri dev` (terminal PATH) but silently fail in a
/// release build — leaving the Reviews tab and graph PRs empty.
pub async fn token() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        let gh = crate::settings::discover_binary("gh")?;
        let out = Command::new(gh).args(["auth", "token"]).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    })
    .await
    .ok()
    .flatten()
}

/// The `gh` CLI integration status for Settings → Integrations: whether `gh` is
/// installed (resolved through the login shell, so it matches a real terminal —
/// see [`token`]), its version, and the signed-in account (borrowed from `gh`'s
/// own session via the REST `/user` endpoint). Infallible — a missing or
/// signed-out `gh` is reported as a status with the relevant flags false.
pub async fn status() -> santree_core::domain::GithubStatus {
    use santree_core::domain::GithubStatus;

    // `gh` lives in Homebrew on most Macs, which a Finder-launched bundle's
    // minimal PATH misses — resolve it the same way `token()` does. Discovery
    // spawns a login shell (tens-hundreds of ms on a cache miss), so keep it
    // off the async runtime like `token()` and `agent_auth` do.
    let Some(exec) = tokio::task::spawn_blocking(|| crate::settings::discover_binary("gh"))
        .await
        .ok()
        .flatten()
    else {
        return GithubStatus::default(); // installed: false; everything else empty
    };

    let version = {
        let exec = exec.clone();
        tokio::task::spawn_blocking(move || {
            let out = Command::new(exec).arg("--version").output().ok()?;
            out.status.success().then(|| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string()
            })
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
    };

    let mut status = GithubStatus {
        installed: true,
        detected_exec: exec,
        version,
        host: "github.com".into(),
        ..Default::default()
    };

    // Borrow gh's session and ask the API who we are. A signed-out or
    // network-less `gh` simply leaves `authenticated` false.
    if let Some(token) = token().await {
        #[derive(Deserialize)]
        struct GhUser {
            login: String,
            name: Option<String>,
        }
        if let Ok(user) =
            get_json::<GhUser>("https://api.github.com/user".to_string(), &[], &token).await
        {
            status.authenticated = true;
            status.account = user.login;
            status.name = user.name.unwrap_or_default();
        }
    }

    status
}

/// `(owner, repo)` parsed from the worktree's `origin` remote, or an error when
/// it isn't a recognizable GitHub remote.
pub fn owner_repo(cwd: &Path) -> Result<(String, String)> {
    let url = git::git(cwd, &["remote", "get-url", "origin"])
        .map_err(|_| anyhow!("no `origin` remote found"))?;
    let slug = repo::github_slug(&url).ok_or_else(|| anyhow!("origin is not a GitHub remote"))?;
    let (owner, name) = slug
        .split_once('/')
        .ok_or_else(|| anyhow!("malformed GitHub slug: {slug}"))?;
    Ok((owner.to_string(), name.to_string()))
}

/// The repo's PR template, read from the checkout (the worktree shares the
/// branch's files). Checks the standard locations; `None` when there's none.
pub fn pr_template(cwd: &Path) -> Option<String> {
    const PATHS: &[&str] = &[
        ".github/pull_request_template.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "docs/pull_request_template.md",
        "docs/PULL_REQUEST_TEMPLATE.md",
        "pull_request_template.md",
        "PULL_REQUEST_TEMPLATE.md",
    ];
    PATHS
        .iter()
        .find_map(|p| std::fs::read_to_string(cwd.join(p)).ok())
        .filter(|s| !s.trim().is_empty())
}

#[derive(Deserialize)]
struct CreatedPr {
    number: u32,
    html_url: String,
}

#[derive(Deserialize)]
struct SearchResp {
    items: Vec<SearchItem>,
}

#[derive(Deserialize)]
struct SearchItem {
    number: u32,
    title: String,
    html_url: String,
    state: String,
    pull_request: Option<PrRef>,
}

#[derive(Deserialize)]
struct PrRef {
    merged_at: Option<String>,
}

/// One PR from a repo-wide search — title included so [`crate::pr::statuses`] can
/// match it against several linked issue ids without a search call per issue.
pub struct RepoPr {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: PrState,
}

/// Every PR in `owner/repo`, newest-created first — one GitHub API call
/// regardless of how many worktrees/issues the caller wants to match against.
///
/// Replaces the old "one search per issue id" approach: GitHub's search API
/// has a secondary rate limit of ~30 requests/minute, and `worktreePrs` is
/// refetched on a 60s staleTime *and* after every worktree mutation — a repo
/// with a modest number of active worktrees could blow through that budget in
/// one refetch, silently dropping PR chips. Callers match titles against the
/// `[ISSUE-ID] …` tag our commit/PR flow writes (see `pr::issue_tag`) rather
/// than the branch, which GitHub deletes on merge (so merged PRs would vanish
/// from a branch-based lookup).
///
/// Capped at one page (100, GitHub's search max per page), so a repo with more
/// than 100 PRs newer than a given worktree's PR won't surface it here — an
/// accepted tradeoff since worktrees are actively-worked branches and their
/// PRs are typically among the most recent. Network errors bubble up.
pub async fn prs_for_repo(token: &str, owner: &str, repo: &str) -> Result<Vec<RepoPr>> {
    let q = format!("repo:{owner}/{repo} type:pr");
    let body: SearchResp = get_json(
        "https://api.github.com/search/issues".to_string(),
        &[
            ("q", q.as_str()),
            ("per_page", "100"),
            ("sort", "created"),
            ("order", "desc"),
        ],
        token,
    )
    .await?;
    Ok(body
        .items
        .into_iter()
        .map(|p| {
            let merged = p.pull_request.and_then(|r| r.merged_at).is_some();
            let state = if merged {
                PrState::Merged
            } else if p.state == "closed" {
                PrState::Closed
            } else {
                PrState::Open
            };
            RepoPr {
                number: p.number,
                title: p.title,
                url: p.html_url,
                state,
            }
        })
        .collect())
}

/// Open a pull request via the GitHub REST API. Returns `(number, url)`.
// One flat call mapping straight to the GitHub "create a pull request" body —
// grouping the fields into a struct would only add indirection here.
#[allow(clippy::too_many_arguments)]
pub async fn create_pr(
    token: &str,
    owner: &str,
    repo: &str,
    title: &str,
    head: &str,
    base: &str,
    body: &str,
    draft: bool,
) -> Result<(u32, String)> {
    let res = rest(
        gql::client().post(format!("https://api.github.com/repos/{owner}/{repo}/pulls")),
        token,
    )
    .json(&serde_json::json!({
        "title": title,
        "head": head,
        "base": base,
        "body": body,
        "draft": draft,
    }))
    .send()
    .await?;

    let status = res.status();
    if status.is_success() {
        let pr: CreatedPr = res.json().await.map_err(|e| anyhow!("decoding PR: {e}"))?;
        return Ok((pr.number, pr.html_url));
    }

    // Surface GitHub's own message (e.g. "A pull request already exists for …",
    // or a validation error) rather than a bare status code.
    let detail = res
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v.get("errors")
                .and_then(|e| e.get(0))
                .and_then(|e| e.get("message"))
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| status.to_string());
    bail!("GitHub: {detail}");
}

/// Request reviewers (by login) and team reviewers (by slug) on an open PR. Best-
/// effort relative to PR creation: the caller opens the PR first, then asks for
/// reviewers, so a reviewer-side failure (e.g. someone lacking repo access) doesn't
/// undo the PR. Errors carry GitHub's message for the toast.
pub async fn request_reviewers(
    token: &str,
    owner: &str,
    repo: &str,
    number: u32,
    users: &[String],
    teams: &[String],
) -> Result<()> {
    if users.is_empty() && teams.is_empty() {
        return Ok(());
    }
    let res = rest(
        gql::client().post(format!(
            "https://api.github.com/repos/{owner}/{repo}/pulls/{number}/requested_reviewers"
        )),
        token,
    )
    .json(&serde_json::json!({ "reviewers": users, "team_reviewers": teams }))
    .send()
    .await?;
    if res.status().is_success() {
        return Ok(());
    }
    let status = res.status();
    let detail = res
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| status.to_string());
    bail!("GitHub: {detail}");
}

/// Candidate reviewers for a repo: its collaborators with push access (anyone who
/// can be requested for review), as `User` reviewers with avatars. Excludes the
/// signed-in user — you can't review your own PR. Empty (not an error) when the
/// listing fails so the dialog degrades to a plain create.
pub async fn list_reviewers(token: &str, owner: &str, repo: &str) -> Result<Vec<Reviewer>> {
    #[derive(Deserialize)]
    struct Collaborator {
        login: String,
        #[serde(default)]
        avatar_url: String,
        #[serde(rename = "type", default)]
        kind: String,
    }
    let me = current_login(token).await;
    let list: Vec<Collaborator> = get_json(
        format!("https://api.github.com/repos/{owner}/{repo}/collaborators"),
        &[("permission", "push"), ("per_page", "100")],
        token,
    )
    .await?;
    Ok(list
        .into_iter()
        // Drop bots and the signed-in user (GitHub rejects self-review requests).
        .filter(|c| c.kind != "Bot" && me.as_deref() != Some(c.login.as_str()))
        .map(|c| Reviewer {
            kind: ReviewerKind::User,
            name: c.login,
            avatar_url: c.avatar_url,
        })
        .collect())
}

/// The signed-in GitHub login (the PR author), for excluding self from reviewer
/// lists. `None` when the `/user` call fails.
async fn current_login(token: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct GhUser {
        login: String,
    }
    get_json::<GhUser>("https://api.github.com/user".to_string(), &[], token)
        .await
        .ok()
        .map(|u| u.login)
}

// ── GraphQL (Reviews dashboard) ─────────────────────────────────────────────

const GRAPHQL_URL: &str = "https://api.github.com/graphql";

/// POST a GraphQL query to GitHub and return the typed `data` payload.
async fn graphql<T: DeserializeOwned>(
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<T> {
    let req = gql::client()
        .post(GRAPHQL_URL)
        .bearer_auth(token)
        .header("User-Agent", "santree")
        .json(&serde_json::json!({ "query": query, "variables": variables }));
    gql::post(req, "GitHub").await
}

// The PR fields the Reviews list needs — shared by all three category searches.
const PR_FIELDS: &str = r"
    id number title url isDraft updatedAt headRefName isInMergeQueue
    repository { nameWithOwner }
    author { login avatarUrl }
    reviewDecision
    comments { totalCount }
    additions deletions
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    reviewRequests(first: 20) {
      nodes {
        requestedReviewer {
          __typename
          ... on User { login avatarUrl }
          ... on Team { name }
        }
      }
    }
";

#[derive(Deserialize)]
struct Actor {
    login: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: String,
}

#[derive(Deserialize)]
struct TotalCount {
    #[serde(rename = "totalCount")]
    total_count: u32,
}

#[derive(Deserialize)]
struct RepoRef {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}

#[derive(Deserialize)]
struct Rollup {
    state: String,
}
#[derive(Deserialize)]
struct CommitWrap {
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Option<Rollup>,
}
#[derive(Deserialize)]
struct CommitNode {
    commit: CommitWrap,
}

#[derive(Deserialize)]
#[serde(tag = "__typename")]
enum RequestedReviewer {
    User {
        login: String,
        #[serde(rename = "avatarUrl")]
        avatar_url: String,
    },
    Team {
        name: String,
    },
    // Mannequins, bots, etc. — ignored.
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct ReviewRequestNode {
    #[serde(rename = "requestedReviewer")]
    requested_reviewer: Option<RequestedReviewer>,
}

#[derive(Deserialize)]
struct PrNode {
    id: String,
    number: u32,
    title: String,
    url: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "isInMergeQueue")]
    is_in_merge_queue: bool,
    repository: RepoRef,
    author: Option<Actor>,
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
    comments: TotalCount,
    additions: u32,
    deletions: u32,
    commits: Connection<CommitNode>,
    #[serde(rename = "reviewRequests")]
    review_requests: Connection<ReviewRequestNode>,
}

impl From<PrNode> for ReviewPr {
    fn from(n: PrNode) -> Self {
        let (author, author_avatar_url) = n
            .author
            .map(|a| (a.login, a.avatar_url))
            .unwrap_or_default();
        let review_decision = match n.review_decision.as_deref() {
            Some("APPROVED") => ReviewDecision::Approved,
            Some("CHANGES_REQUESTED") => ReviewDecision::ChangesRequested,
            Some("REVIEW_REQUIRED") => ReviewDecision::ReviewRequired,
            _ => ReviewDecision::None,
        };
        let checks = n
            .commits
            .nodes
            .first()
            .and_then(|c| c.commit.status_check_rollup.as_ref())
            .map(|r| match r.state.as_str() {
                "SUCCESS" => CheckRollup::Success,
                "FAILURE" | "ERROR" => CheckRollup::Failure,
                "PENDING" | "EXPECTED" => CheckRollup::Pending,
                _ => CheckRollup::None,
            })
            .unwrap_or(CheckRollup::None);
        let reviewers = n
            .review_requests
            .nodes
            .into_iter()
            .filter_map(|r| match r.requested_reviewer {
                Some(RequestedReviewer::User { login, avatar_url }) => Some(Reviewer {
                    kind: ReviewerKind::User,
                    name: login,
                    avatar_url,
                }),
                Some(RequestedReviewer::Team { name }) => Some(Reviewer {
                    kind: ReviewerKind::Team,
                    name,
                    avatar_url: String::new(),
                }),
                _ => None,
            })
            .collect();
        ReviewPr {
            id: n.id,
            number: n.number,
            title: n.title,
            url: n.url,
            repo: n.repository.name_with_owner,
            head_ref: n.head_ref_name,
            author,
            author_avatar_url,
            // The dashboard only ever queries `is:open`, so these are open PRs.
            state: PrState::Open,
            is_draft: n.is_draft,
            review_decision,
            checks,
            is_in_merge_queue: n.is_in_merge_queue,
            additions: n.additions,
            deletions: n.deletions,
            comment_count: n.comments.total_count,
            reviewers,
            updated_at: n.updated_at,
        }
    }
}

/// Run one `search(type: ISSUE)` query and map the PR nodes to `ReviewPr`.
async fn search_prs(token: &str, q: &str) -> Result<Vec<ReviewPr>> {
    #[derive(Deserialize)]
    struct Data {
        search: Connection<PrNode>,
    }
    let query = format!(
        "query($q: String!) {{ search(query: $q, type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ {PR_FIELDS} }} }} }} }}"
    );
    let data: Data = graphql(token, &query, serde_json::json!({ "q": q })).await?;
    Ok(data.search.nodes.into_iter().map(ReviewPr::from).collect())
}

/// The teams (slug, name) the viewer belongs to within `org`. Empty when the
/// viewer isn't in that org or it has no teams visible to them.
pub async fn viewer_teams(token: &str, org: &str) -> Result<Vec<(String, String)>> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Viewer,
    }
    #[derive(Deserialize)]
    struct Viewer {
        organizations: Connection<OrgNode>,
    }
    #[derive(Deserialize)]
    struct OrgNode {
        login: String,
        teams: Connection<TeamNode>,
    }
    #[derive(Deserialize)]
    struct TeamNode {
        slug: String,
        name: String,
    }
    let query = "query { viewer { organizations(first: 50) { nodes { login teams(first: 50, role: MEMBER) { nodes { slug name } } } } } }";
    let data: Data = graphql(token, query, serde_json::json!({})).await?;
    Ok(data
        .viewer
        .organizations
        .nodes
        .into_iter()
        .find(|o| o.login == org)
        .map(|o| {
            o.teams
                .nodes
                .into_iter()
                .map(|t| (t.slug, t.name))
                .collect()
        })
        .unwrap_or_default())
}

/// The categorized PR inbox for `org`: PRs the viewer authored, PRs where they're
/// individually requested, and one section per team that has open requests. All
/// searches run concurrently; empty team sections are dropped.
pub async fn review_inbox(
    token: &str,
    org: &str,
    teams: &[(String, String)],
) -> Result<ReviewInbox> {
    let common = "is:open is:pr archived:false sort:updated-desc";
    let mine_q = format!("{common} author:@me org:{org}");
    let requested_q = format!("{common} review-requested:@me org:{org}");

    let team_searches = futures::future::join_all(teams.iter().map(|(slug, name)| {
        let q = format!("{common} team-review-requested:{org}/{slug}");
        async move {
            let prs = search_prs(token, &q).await.unwrap_or_default();
            (slug.clone(), name.clone(), prs)
        }
    }));

    let (mine, requested, team_results) = tokio::join!(
        search_prs(token, &mine_q),
        search_prs(token, &requested_q),
        team_searches,
    );

    let teams = team_results
        .into_iter()
        .filter(|(_, _, prs)| !prs.is_empty())
        .map(|(slug, name, prs)| TeamReviews { slug, name, prs })
        .collect();

    Ok(ReviewInbox {
        mine: mine?,
        requested: requested?,
        teams,
    })
}

/// The repo's merge queue (its default branch's queue): the ordered list of PRs
/// waiting to merge, each tagged with whether the viewer authored it. `None` when
/// the repo has no merge queue enabled. One GraphQL round-trip — the viewer login
/// is fetched alongside the queue so entries can be marked "mine".
pub async fn merge_queue(token: &str, owner: &str, name: &str) -> Result<Option<MergeQueue>> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Login,
        repository: Option<RepoNode>,
    }
    #[derive(Deserialize)]
    struct Login {
        login: String,
    }
    #[derive(Deserialize)]
    struct RepoNode {
        // The queue is the default branch's queue; `MergeQueue` itself carries no
        // branch field, so the name comes from the repo's default branch ref.
        #[serde(rename = "defaultBranchRef")]
        default_branch_ref: Option<BranchRef>,
        #[serde(rename = "mergeQueue")]
        merge_queue: Option<QueueNode>,
    }
    #[derive(Deserialize)]
    struct BranchRef {
        name: String,
    }
    #[derive(Deserialize)]
    struct QueueNode {
        entries: Connection<EntryNode>,
    }
    #[derive(Deserialize)]
    struct EntryNode {
        /// GitHub's raw position; we re-rank by queue order for display, so this
        /// is only used to sort (its exact indexing base doesn't matter).
        #[serde(default)]
        position: Option<u32>,
        state: Option<String>,
        #[serde(rename = "pullRequest")]
        pull_request: Option<QueuePr>,
    }
    #[derive(Deserialize)]
    struct QueuePr {
        number: u32,
        title: String,
        url: String,
        author: Option<Actor>,
    }

    let query = r"
        query($owner: String!, $name: String!) {
          viewer { login }
          repository(owner: $owner, name: $name) {
            defaultBranchRef { name }
            mergeQueue {
              entries(first: 100) {
                nodes {
                  position
                  state
                  pullRequest { number title url author { login avatarUrl } }
                }
              }
            }
          }
        }
    ";
    let data: Data = graphql(
        token,
        query,
        serde_json::json!({ "owner": owner, "name": name }),
    )
    .await?;

    let viewer = data.viewer.login;
    let Some(repo_node) = data.repository else {
        return Ok(None);
    };
    let branch = repo_node
        .default_branch_ref
        .map(|b| b.name)
        .unwrap_or_default();
    let Some(queue) = repo_node.merge_queue else {
        return Ok(None);
    };

    // Order by GitHub's position (front of the line first), then re-number 1..N
    // so the displayed rank is unambiguous regardless of GitHub's indexing base.
    let mut nodes = queue.entries.nodes;
    nodes.sort_by_key(|e| e.position.unwrap_or(u32::MAX));
    let entries = nodes
        .into_iter()
        .filter_map(|e| e.pull_request.map(|pr| (e.state, pr)))
        .enumerate()
        .map(|(i, (state, pr))| {
            let (author, author_avatar_url) =
                pr.author.map(|a| (a.login, a.avatar_url)).unwrap_or_default();
            MergeQueueEntry {
                position: i as u32 + 1,
                state: match state.as_deref() {
                    Some("QUEUED") => MergeQueueState::Queued,
                    Some("AWAITING_CHECKS") => MergeQueueState::AwaitingChecks,
                    Some("MERGEABLE") => MergeQueueState::Mergeable,
                    Some("UNMERGEABLE") => MergeQueueState::Unmergeable,
                    Some("LOCKED") => MergeQueueState::Locked,
                    _ => MergeQueueState::Unknown,
                },
                is_mine: author == viewer,
                pr_number: pr.number,
                pr_title: pr.title,
                pr_url: pr.url,
                author,
                author_avatar_url,
            }
        })
        .collect();

    Ok(Some(MergeQueue {
        repo: format!("{owner}/{name}"),
        branch,
        entries,
    }))
}

/// Full detail for one PR: body + merged conversation + changed files (with diffs).
pub async fn pr_detail(token: &str, owner: &str, name: &str, number: u32) -> Result<PrDetail> {
    let (conversation, files) = tokio::join!(
        pr_conversation(token, owner, name, number),
        pr_files(token, owner, name, number),
    );
    let (body, labels, comments, threads, checks, base_sha, head_sha) = conversation?;
    Ok(PrDetail {
        body,
        labels,
        comments,
        threads,
        files: files?,
        checks,
        base_sha,
        head_sha,
    })
}

/// The repo's full label palette (the picker's options). REST, up to 100 labels.
pub async fn list_labels(token: &str, owner: &str, name: &str) -> Result<Vec<PrLabel>> {
    #[derive(Deserialize)]
    struct Label {
        name: String,
        color: String,
        description: Option<String>,
    }
    let list: Vec<Label> = get_json(
        format!("https://api.github.com/repos/{owner}/{name}/labels"),
        &[("per_page", "100")],
        token,
    )
    .await?;
    Ok(list
        .into_iter()
        .map(|l| PrLabel {
            name: l.name,
            color: l.color,
            description: l.description.filter(|d| !d.is_empty()),
        })
        .collect())
}

/// Replace the PR's labels with exactly `labels` (GitHub's PUT semantics — the set
/// is overwritten, so an empty list clears them). Returns the resulting labels.
/// Every name must be an existing repo label (the picker only offers those).
pub async fn set_pr_labels(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
    labels: &[String],
) -> Result<Vec<PrLabel>> {
    #[derive(Deserialize)]
    struct Label {
        name: String,
        color: String,
        description: Option<String>,
    }
    // Labels live on the underlying issue, not the pull endpoint.
    let res = rest(
        gql::client().put(format!(
            "https://api.github.com/repos/{owner}/{name}/issues/{number}/labels"
        )),
        token,
    )
    .json(&serde_json::json!({ "labels": labels }))
    .send()
    .await?;
    if !res.status().is_success() {
        let status = res.status();
        let detail = res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
            .unwrap_or_else(|| status.to_string());
        bail!("GitHub: {detail}");
    }
    let list: Vec<Label> = res.json().await?;
    Ok(list
        .into_iter()
        .map(|l| PrLabel {
            name: l.name,
            color: l.color,
            description: l.description.filter(|d| !d.is_empty()),
        })
        .collect())
}

/// Normalize a check run's / check step's (`status`, `conclusion`) pair into the
/// UI's flat [`CheckStatus`]. A run is only conclusive once `COMPLETED`; before
/// that (`QUEUED` / `IN_PROGRESS`) it's still pending regardless of conclusion.
fn check_run_status(status: &str, conclusion: Option<&str>) -> CheckStatus {
    if status != "COMPLETED" {
        return CheckStatus::Pending;
    }
    match conclusion {
        Some("SUCCESS") => CheckStatus::Success,
        // ACTION_REQUIRED blocks the PR and needs the user to act, so surface it
        // as a failure rather than hiding it in the collapsed "neutral" group.
        Some("FAILURE" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED") => {
            CheckStatus::Failure
        }
        Some("SKIPPED") => CheckStatus::Skipped,
        // NEUTRAL / CANCELLED / STALE (and any unknown future value) — finished
        // without a pass/fail verdict.
        _ => CheckStatus::Neutral,
    }
}

/// Body + top-level comments (issue comments and review summaries) merged
/// chronologically, the inline review-comment threads (grouped, with resolution
/// and anchor line/side), and the head commit's individual CI checks.
#[allow(clippy::type_complexity)]
async fn pr_conversation(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
) -> Result<(String, Vec<PrLabel>, Vec<PrComment>, Vec<PrThread>, Vec<PrCheck>, String, String)> {
    #[derive(Deserialize)]
    struct Data {
        repository: Option<Repo>,
    }
    #[derive(Deserialize)]
    struct Repo {
        #[serde(rename = "pullRequest")]
        pull_request: Option<Pr>,
    }
    #[derive(Deserialize)]
    struct Pr {
        body: String,
        #[serde(rename = "baseRefOid")]
        base_ref_oid: String,
        #[serde(rename = "headRefOid")]
        head_ref_oid: String,
        labels: Connection<LabelNode>,
        comments: Connection<Comment>,
        reviews: Connection<Review>,
        #[serde(rename = "reviewThreads")]
        review_threads: Connection<Thread>,
        // Renamed (vs the module-level `CommitNode`) because this one reads the
        // rollup's individual check `contexts`, not the aggregate `state`.
        commits: Connection<DetailCommitNode>,
    }
    #[derive(Deserialize)]
    struct LabelNode {
        name: String,
        color: String,
        description: Option<String>,
    }
    #[derive(Deserialize)]
    struct DetailCommitNode {
        commit: CommitInner,
    }
    #[derive(Deserialize)]
    struct CommitInner {
        #[serde(rename = "statusCheckRollup")]
        status_check_rollup: Option<RollupCtx>,
    }
    #[derive(Deserialize)]
    struct RollupCtx {
        contexts: Connection<Ctx>,
    }
    // Minimal shape for the contexts-only pagination follow-up: it re-navigates
    // to the same head commit's rollup but fetches none of the PR's other fields.
    #[derive(Deserialize)]
    struct CtxData {
        repository: Option<CtxRepo>,
    }
    #[derive(Deserialize)]
    struct CtxRepo {
        #[serde(rename = "pullRequest")]
        pull_request: Option<CtxPr>,
    }
    #[derive(Deserialize)]
    struct CtxPr {
        commits: Connection<DetailCommitNode>,
    }
    #[derive(Deserialize)]
    #[serde(tag = "__typename")]
    enum Ctx {
        CheckRun {
            name: String,
            conclusion: Option<String>,
            status: String,
            #[serde(rename = "detailsUrl")]
            details_url: Option<String>,
            #[serde(rename = "checkSuite")]
            check_suite: Option<CheckSuite>,
            steps: Option<Connection<StepNode>>,
            annotations: Option<Connection<AnnotationNode>>,
        },
        StatusContext {
            context: String,
            state: String,
            #[serde(rename = "targetUrl")]
            target_url: Option<String>,
            description: Option<String>,
        },
        #[serde(other)]
        Other,
    }
    #[derive(Deserialize)]
    struct CheckSuite {
        app: Option<App>,
    }
    #[derive(Deserialize)]
    struct App {
        name: String,
    }
    #[derive(Deserialize)]
    struct StepNode {
        number: u32,
        name: String,
        status: String,
        conclusion: Option<String>,
    }
    #[derive(Deserialize)]
    struct AnnotationNode {
        #[serde(rename = "annotationLevel")]
        annotation_level: Option<String>,
        message: String,
        path: Option<String>,
        title: Option<String>,
        #[serde(rename = "rawDetails")]
        raw_details: Option<String>,
        location: Option<AnnotationLocation>,
    }
    #[derive(Deserialize)]
    struct AnnotationLocation {
        start: Option<AnnotationLine>,
    }
    #[derive(Deserialize)]
    struct AnnotationLine {
        line: Option<u32>,
    }
    #[derive(Deserialize)]
    struct Comment {
        author: Option<Actor>,
        body: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    }
    #[derive(Deserialize)]
    struct Review {
        author: Option<Actor>,
        body: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    }
    #[derive(Deserialize)]
    struct Thread {
        path: String,
        line: Option<u32>,
        #[serde(rename = "diffSide")]
        diff_side: Option<String>,
        #[serde(rename = "isResolved")]
        is_resolved: bool,
        #[serde(rename = "isOutdated")]
        is_outdated: bool,
        comments: Connection<ThreadComment>,
    }
    #[derive(Deserialize)]
    struct ThreadComment {
        author: Option<Actor>,
        body: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    }

    let query = r"
        query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              body
              baseRefOid
              headRefOid
              labels(first: 30) { nodes { name color description } }
              comments(first: 100) { nodes { author { login avatarUrl } body createdAt } }
              reviews(first: 50) { nodes { author { login avatarUrl } body createdAt } }
              reviewThreads(first: 50) { nodes { path line diffSide isResolved isOutdated comments(first: 50) { nodes { author { login avatarUrl } body createdAt } } } }
              commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl checkSuite { app { name } }
                    steps(first: 50) { nodes { number name status conclusion } }
                    annotations(first: 50) { nodes { annotationLevel message path title rawDetails location { start { line } } } }
                  }
                  ... on StatusContext { context state targetUrl description }
                }
                pageInfo { hasNextPage endCursor }
              } } } } }
            }
          }
        }
    ";
    // Follow-up query for additional check-context pages (see the paging loop
    // below). Only the head commit's `contexts` connection, keyed by cursor.
    let contexts_query = r"
        query($owner: String!, $name: String!, $number: Int!, $after: String!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl checkSuite { app { name } }
                    steps(first: 50) { nodes { number name status conclusion } }
                    annotations(first: 50) { nodes { annotationLevel message path title rawDetails location { start { line } } } }
                  }
                  ... on StatusContext { context state targetUrl description }
                }
                pageInfo { hasNextPage endCursor }
              } } } } }
            }
          }
        }
    ";
    let data: Data = graphql(
        token,
        query,
        serde_json::json!({ "owner": owner, "name": name, "number": number }),
    )
    .await?;
    let pr = data
        .repository
        .and_then(|r| r.pull_request)
        .ok_or_else(|| anyhow!("PR {owner}/{name}#{number} not found"))?;

    let actor = |a: Option<Actor>| a.map(|a| (a.login, a.avatar_url)).unwrap_or_default();
    let mut comments: Vec<PrComment> = Vec::new();
    for c in pr.comments.nodes {
        let (author, author_avatar_url) = actor(c.author);
        comments.push(PrComment {
            author,
            author_avatar_url,
            body: c.body,
            created_at: c.created_at,
            kind: CommentKind::Issue,
            path: None,
        });
    }
    for r in pr.reviews.nodes {
        // Skip empty-body reviews (bare approvals add no conversation).
        if r.body.trim().is_empty() {
            continue;
        }
        let (author, author_avatar_url) = actor(r.author);
        comments.push(PrComment {
            author,
            author_avatar_url,
            body: r.body,
            created_at: r.created_at,
            kind: CommentKind::Review,
            path: None,
        });
    }
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    // Inline review threads stay grouped (each renders as one collapsible thread
    // anchored in the diff), rather than being flattened into `comments`.
    let mut threads: Vec<PrThread> = Vec::new();
    for t in pr.review_threads.nodes {
        let mut thread_comments: Vec<PrComment> = Vec::new();
        for c in t.comments.nodes {
            let (author, author_avatar_url) = actor(c.author);
            thread_comments.push(PrComment {
                author,
                author_avatar_url,
                body: c.body,
                created_at: c.created_at,
                kind: CommentKind::ReviewThread,
                path: Some(t.path.clone()),
            });
        }
        if thread_comments.is_empty() {
            continue;
        }
        threads.push(PrThread {
            path: t.path,
            line: t.line,
            // GitHub's `diffSide` is RIGHT for the new side, LEFT for the old;
            // default to the new side when absent (the common single-line case).
            on_right: t.diff_side.as_deref() != Some("LEFT"),
            is_resolved: t.is_resolved,
            is_outdated: t.is_outdated,
            comments: thread_comments,
        });
    }

    // Collect the head commit's check contexts, paging through all of them.
    // GitHub caps a GraphQL connection at 100 nodes/page, but the aggregate
    // rollup `state` that drives the PR's header badge counts every context —
    // so on a PR with >100 checks a still-running check beyond the first page
    // makes the header say "checks running" while the (truncated) list shows
    // only the passed/skipped ones. Page until exhausted so the list matches
    // the badge.
    let mut ctx_nodes: Vec<Ctx> = Vec::new();
    let mut ctx_page = pr
        .commits
        .nodes
        .into_iter()
        .next()
        .and_then(|c| c.commit.status_check_rollup)
        .map(|r| r.contexts);
    while let Some(page) = ctx_page.take() {
        ctx_nodes.extend(page.nodes);
        let Some(cursor) = page
            .page_info
            .end_cursor
            .filter(|_| page.page_info.has_next_page)
        else {
            break;
        };
        let more: CtxData = graphql(
            token,
            contexts_query,
            serde_json::json!({ "owner": owner, "name": name, "number": number, "after": cursor }),
        )
        .await?;
        ctx_page = more
            .repository
            .and_then(|r| r.pull_request)
            .and_then(|p| p.commits.nodes.into_iter().next())
            .and_then(|c| c.commit.status_check_rollup)
            .map(|r| r.contexts);
    }

    let mut checks: Vec<PrCheck> = Vec::new();
    for ctx in ctx_nodes {
        match ctx {
            Ctx::CheckRun {
                name,
                conclusion,
                status,
                details_url,
                check_suite,
                steps,
                annotations,
            } => {
                let st = check_run_status(&status, conclusion.as_deref());
                let job_id = details_url.as_deref().and_then(job_id_from_url);
                // Only failed checks carry their step/annotation detail — that's
                // the only place the UI expands it, and it keeps the payload lean.
                let (steps, annotations) = if st == CheckStatus::Failure {
                    let steps = steps
                        .map(|c| c.nodes)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|s| CheckStep {
                            number: s.number,
                            name: s.name,
                            status: check_run_status(&s.status, s.conclusion.as_deref()),
                        })
                        .collect();
                    let annotations = annotations
                        .map(|c| c.nodes)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|a| CheckAnnotation {
                            level: a.annotation_level.unwrap_or_default().to_lowercase(),
                            message: a.message,
                            path: a.path,
                            start_line: a.location.and_then(|l| l.start).and_then(|s| s.line),
                            title: a.title,
                            raw_details: a.raw_details,
                        })
                        .collect();
                    (steps, annotations)
                } else {
                    (Vec::new(), Vec::new())
                };
                checks.push(PrCheck {
                    name,
                    status: st,
                    description: check_suite.and_then(|s| s.app).map(|a| a.name),
                    url: details_url,
                    steps,
                    annotations,
                    job_id,
                });
            }
            Ctx::StatusContext {
                context,
                state,
                target_url,
                description,
            } => {
                let st = match state.as_str() {
                    "SUCCESS" => CheckStatus::Success,
                    "FAILURE" | "ERROR" => CheckStatus::Failure,
                    "PENDING" | "EXPECTED" => CheckStatus::Pending,
                    _ => CheckStatus::Neutral,
                };
                checks.push(PrCheck {
                    name: context,
                    status: st,
                    description,
                    url: target_url,
                    // Status contexts (legacy commit statuses) have no steps,
                    // annotations, or job log — only GitHub Actions check runs do.
                    steps: Vec::new(),
                    annotations: Vec::new(),
                    job_id: None,
                });
            }
            Ctx::Other => {}
        }
    }

    let labels = pr
        .labels
        .nodes
        .into_iter()
        .map(|l| PrLabel {
            name: l.name,
            color: l.color,
            description: l.description.filter(|d| !d.is_empty()),
        })
        .collect();

    Ok((
        pr.body,
        labels,
        comments,
        threads,
        checks,
        pr.base_ref_oid,
        pr.head_ref_oid,
    ))
}

/// Pull the GitHub Actions job id out of a check run's `detailsUrl`
/// (`…/actions/runs/<run>/job/<job_id>`). `None` for non-Actions URLs (e.g. a
/// third-party check's own site), which have no fetchable runner log.
fn job_id_from_url(url: &str) -> Option<f64> {
    let tail = url.rsplit_once("/job/")?.1;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    // Job ids exceed u32 but are exact in an f64; parse as u64 then widen.
    digits.parse::<u64>().ok().map(|n| n as f64)
}

/// Line cap for a single step's log. The failing step can be thousands of lines
/// (a full test run); the error is always at the tail, so we keep the last N.
const MAX_LOG_LINES: usize = 1000;

/// Fetch a GitHub Actions job's raw log and reduce it to the failing step (see
/// [`parse_job_log`]). `job_id` comes from [`PrCheck::job_id`]. The logs endpoint
/// 302-redirects to a short-lived blob URL, which `reqwest` follows.
pub async fn check_log(token: &str, owner: &str, name: &str, job_id: u64) -> Result<CheckLog> {
    let url = format!("https://api.github.com/repos/{owner}/{name}/actions/jobs/{job_id}/logs");
    let res = rest(gql::client().get(url), token).send().await?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        bail!("GitHub returned {status}: {snippet}");
    }
    Ok(parse_job_log(&res.text().await?))
}

/// Strip the runner's `2026-06-23T13:17:54.6166025Z ` timestamp prefix from a log
/// line. The prefix is a whitespace-free ISO-8601 instant; content never looks
/// like one, so lines without a prefix (rare) pass through unchanged.
fn strip_timestamp(line: &str) -> &str {
    match line.split_once(' ') {
        Some((head, rest)) if head.ends_with('Z') && head.contains('T') => rest,
        _ => line,
    }
}

/// Remove ANSI SGR color escapes (`\x1b[…m` etc.) that CI tools emit — they'd
/// render as garbage in the log pane, which does its own tinting by level.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Consume through the escape's terminating letter (`m`, `K`, …).
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Parse one timestamp-stripped line's runner marker into a level, dropping
/// `##[endgroup]` markers entirely (pure noise). `None` = omit the line.
fn classify_line(line: &str) -> Option<CheckLogLine> {
    let body = line.trim_end_matches('\r');
    let trimmed = body.trim_start();
    if trimmed.starts_with("##[endgroup]") {
        return None;
    }
    // Markers: keep the text after the marker. Normal lines: keep indentation.
    let (level, text) = if let Some(rest) = trimmed.strip_prefix("##[error]") {
        (CheckLogLevel::Error, rest)
    } else if let Some(rest) = trimmed.strip_prefix("##[warning]") {
        (CheckLogLevel::Warning, rest)
    } else if let Some(rest) = trimmed.strip_prefix("##[group]") {
        (CheckLogLevel::Command, rest)
    } else if let Some(rest) = trimmed.strip_prefix("##[section]") {
        (CheckLogLevel::Command, rest)
    } else if let Some(rest) = trimmed.strip_prefix("##[command]") {
        (CheckLogLevel::Command, rest)
    } else {
        (CheckLogLevel::Normal, body)
    };
    Some(CheckLogLine {
        text: strip_ansi(text),
        level,
    })
}

/// Reduce a raw Actions job log to the failing step's lines. Pure (no network) so
/// it's unit-testable. Steps: (1) strip per-line timestamps; (2) track
/// `##[group]`/`##[endgroup]` nesting — a step starts at a depth-0
/// `##[group]Run …` and spans until the next one; (3) keep the step whose span
/// holds the first `##[error]` (falls back to the whole log when there's no error
/// marker or no recognizable step); (4) keep only the tail past the line cap;
/// (5) classify each line and drop `##[endgroup]` noise.
fn parse_job_log(raw: &str) -> CheckLog {
    let stripped: Vec<&str> = raw.lines().map(strip_timestamp).collect();

    let mut depth: i32 = 0;
    let mut step_starts: Vec<usize> = Vec::new();
    let mut first_error: Option<usize> = None;
    for (i, line) in stripped.iter().enumerate() {
        let body = line.trim_start();
        if let Some(rest) = body.strip_prefix("##[group]") {
            if depth == 0 && rest.starts_with("Run ") {
                step_starts.push(i);
            }
            depth += 1;
        } else if body.starts_with("##[endgroup]") {
            depth = (depth - 1).max(0);
        } else if first_error.is_none() && body.starts_with("##[error]") {
            first_error = Some(i);
        }
    }

    let (start, end) = match first_error {
        Some(err) => {
            let start = step_starts
                .iter()
                .copied()
                .rfind(|&s| s <= err)
                .unwrap_or(0);
            let end = step_starts
                .iter()
                .copied()
                .find(|&s| s > start)
                .unwrap_or(stripped.len());
            (start, end)
        }
        None => (0, stripped.len()),
    };
    let region = &stripped[start..end];

    let truncated = region.len() > MAX_LOG_LINES;
    let region = if truncated {
        &region[region.len() - MAX_LOG_LINES..]
    } else {
        region
    };

    CheckLog {
        blocks: build_blocks(region),
        truncated,
    }
}

/// Split a step's (timestamp-stripped) lines into render blocks: loose lines stay
/// visible; each top-level `##[group]…##[endgroup]` becomes one collapsible
/// [`CheckLogBlock::Group`]. Nested sub-groups are flattened into the parent's
/// `lines` (their headers kept as plain command lines) — one level of collapse,
/// matching how GitHub's step view reads.
fn build_blocks(region: &[&str]) -> Vec<CheckLogBlock> {
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < region.len() {
        let trimmed = region[i].trim_start();
        if let Some(title) = trimmed.strip_prefix("##[group]") {
            let mut lines = Vec::new();
            let mut depth = 1usize;
            i += 1;
            while i < region.len() && depth > 0 {
                let t = region[i].trim_start();
                if t.starts_with("##[group]") {
                    depth += 1;
                    lines.extend(classify_line(region[i]));
                } else if t.starts_with("##[endgroup]") {
                    depth -= 1; // drop the marker itself
                } else {
                    lines.extend(classify_line(region[i]));
                }
                i += 1;
            }
            blocks.push(CheckLogBlock::Group {
                title: strip_ansi(title.trim_end_matches('\r')),
                lines,
            });
        } else if trimmed.starts_with("##[endgroup]") {
            i += 1; // stray closer with no opener — ignore
        } else {
            if let Some(l) = classify_line(region[i]) {
                blocks.push(CheckLogBlock::Line {
                    text: l.text,
                    level: l.level,
                });
            }
            i += 1;
        }
    }
    blocks
}

/// Changed files for a PR, with their unified-diff patches (REST files API).
async fn pr_files(token: &str, owner: &str, name: &str, number: u32) -> Result<Vec<PrFile>> {
    #[derive(Deserialize)]
    struct RestFile {
        filename: String,
        status: String,
        additions: u32,
        deletions: u32,
        patch: Option<String>,
        /// Blob SHA of the file at the PR's head — drives the "Viewed" mark.
        sha: String,
    }
    let files: Vec<RestFile> = get_json(
        format!("https://api.github.com/repos/{owner}/{name}/pulls/{number}/files"),
        &[("per_page", "100")],
        token,
    )
    .await?;
    Ok(files
        .into_iter()
        .map(|f| PrFile {
            path: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
            sha: f.sha,
        })
        .collect())
}

/// The full text of a file at a given commit, via the REST contents API with the
/// `raw` media type (returns the bytes directly rather than base64 JSON). A 404 —
/// the file doesn't exist at that commit (added on the new side, or deleted on the
/// old side) — maps to empty, which the diff viewer treats as "no content".
async fn file_content(token: &str, owner: &str, name: &str, r#ref: &str, path: &str) -> String {
    let res = gql::client()
        .get(format!(
            "https://api.github.com/repos/{owner}/{name}/contents/{path}"
        ))
        .query(&[("ref", r#ref)])
        .bearer_auth(token)
        .header("Accept", "application/vnd.github.raw")
        .header("User-Agent", "santree")
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => String::new(),
    }
}

/// The old (base) and new (head) full contents of a PR file, so the diff viewer
/// can expand unchanged context beyond the patch hunks (GitHub-style). Fetched on
/// demand per file. Either side is empty for an added/deleted file.
pub async fn pr_file_source(
    token: &str,
    owner: &str,
    name: &str,
    base: &str,
    head: &str,
    path: &str,
) -> Result<FileSource> {
    let (old_text, new_text) = tokio::join!(
        file_content(token, owner, name, base, path),
        file_content(token, owner, name, head, path),
    );
    Ok(FileSource { old_text, new_text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_id_parses_from_actions_url() {
        assert_eq!(
            job_id_from_url("https://github.com/o/r/actions/runs/28027969704/job/82960623951"),
            Some(82960623951.0)
        );
        // Non-Actions check URLs have no job segment.
        assert_eq!(job_id_from_url("https://circleci.com/build/123"), None);
    }

    /// The failing step is sliced from its `##[group]Run …` start to the next
    /// one, teardown groups inside it are kept, and the trailing generic
    /// "Process completed" error of the *next* step is excluded.
    #[test]
    fn parse_job_log_slices_to_failing_step() {
        // Mirrors real runner output: each `##[group]Run …` header is closed
        // immediately, so the step's command output streams at depth 0. Teardown
        // groups (Stopping services) nest inside the step and are kept.
        let raw = "\
2026-01-01T00:00:00.0Z ##[group]Run actions/checkout
2026-01-01T00:00:00.0Z with: {}
2026-01-01T00:00:00.0Z ##[endgroup]
2026-01-01T00:00:00.0Z Syncing repository
2026-01-01T00:00:00.0Z ##[group]Run make test
2026-01-01T00:00:00.0Z shell: bash
2026-01-01T00:00:00.0Z ##[endgroup]
2026-01-01T00:00:00.0Z \u{1b}[31mFAILED test_foo\u{1b}[0m
2026-01-01T00:00:00.0Z 1 failed, 2 passed
2026-01-01T00:00:00.0Z ##[group]Stopping services
2026-01-01T00:00:00.0Z container stopped
2026-01-01T00:00:00.0Z ##[endgroup]
2026-01-01T00:00:00.0Z ##[error]make test exited with code 1
2026-01-01T00:00:00.0Z ##[group]Run cleanup
2026-01-01T00:00:00.0Z ##[endgroup]
2026-01-01T00:00:00.0Z ##[error]Process completed with exit code 1.";
        let log = parse_job_log(raw);
        assert!(!log.truncated);

        // The `Run make test` header opens a collapsible group; the loose test
        // output and the error are standalone (always-visible) lines.
        let first_group = log.blocks.iter().find_map(|b| match b {
            CheckLogBlock::Group { title, lines } => Some((title.as_str(), lines)),
            _ => None,
        });
        assert_eq!(first_group.map(|(t, _)| t), Some("Run make test"));

        let loose: Vec<(&str, CheckLogLevel)> = log
            .blocks
            .iter()
            .filter_map(|b| match b {
                CheckLogBlock::Line { text, level } => Some((text.as_str(), *level)),
                _ => None,
            })
            .collect();
        // ANSI stripped; the real error (loose stdout) and the marker error kept.
        assert!(loose.iter().any(|(t, _)| *t == "FAILED test_foo"));
        assert!(loose
            .iter()
            .any(|(t, l)| *t == "make test exited with code 1" && *l == CheckLogLevel::Error));
        // Teardown group inside the step is preserved as a collapsible group.
        assert!(log.blocks.iter().any(|b| matches!(
            b,
            CheckLogBlock::Group { title, .. } if title == "Stopping services"
        )));
        // The next step's generic error and "Run cleanup" are excluded.
        assert!(!loose
            .iter()
            .any(|(t, _)| t.contains("Process completed")));
        assert!(!log.blocks.iter().any(|b| matches!(
            b,
            CheckLogBlock::Group { title, .. } if title.contains("cleanup")
        )));
    }

    #[test]
    fn parse_job_log_keeps_only_tail_when_huge() {
        // Loose lines (no enclosing group) so they render as standalone blocks.
        let mut raw = String::from("2026-01-01T00:00:00.0Z ##[group]Run big\n");
        raw.push_str("2026-01-01T00:00:00.0Z shell: bash\n");
        raw.push_str("2026-01-01T00:00:00.0Z ##[endgroup]\n");
        for i in 0..(MAX_LOG_LINES + 500) {
            raw.push_str(&format!("2026-01-01T00:00:00.0Z line {i}\n"));
        }
        raw.push_str("2026-01-01T00:00:00.0Z ##[error]boom");
        let log = parse_job_log(&raw);
        assert!(log.truncated);
        // Tail kept: the error survives, the very first content line doesn't.
        let has = |needle: &str| {
            log.blocks.iter().any(|b| match b {
                CheckLogBlock::Line { text, .. } => text == needle,
                _ => false,
            })
        };
        assert!(has("boom"));
        assert!(!has("line 0"));
    }
}
