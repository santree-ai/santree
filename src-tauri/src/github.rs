//! Minimal GitHub integration for opening pull requests.
//!
//! The app has no GitHub OAuth of its own yet, so it borrows the token the user
//! already authorized for the `gh` CLI (`gh auth token`) and talks to the REST
//! API directly with `reqwest` — no browser round-trip. The owner/repo comes from
//! the worktree's `origin` remote; the PR template is read from the checkout.

use std::path::Path;
use std::process::Command;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use santree_core::domain::{
    CheckAnnotation, CheckLog, CheckLogBlock, CheckLogLevel, CheckLogLine, CheckRollup,
    CheckStatus, CheckStep, CommentKind, FileSource, MergeQueue, MergeQueueEntry, MergeQueueState,
    PrCheck, PrComment, PrDetail, PrFile, PrLabel, PrState, PrThread, ReviewDecision, ReviewPr,
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

/// Build an `api.github.com` REST URL from path components. Owner, repo name and
/// file paths all arrive over IPC, so they're never interpolated into the URL with
/// `format!`: a `?` or `#` would split off a bogus query/fragment and a `..` would
/// re-point the request at a different endpoint. `path_segments_mut` percent-encodes
/// each segment by construction. A component may contain `/` (a repo-relative file
/// path) and is split into segments; `.`/`..` components are rejected — they can't
/// name a real file, and the URL crate would silently drop them.
fn api_url(components: &[&str]) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse("https://api.github.com").expect("static base URL");
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|()| anyhow!("GitHub API base is not a valid base URL"))?;
        for seg in components
            .iter()
            .flat_map(|c| c.split('/'))
            .filter(|s| !s.is_empty())
        {
            if seg == "." || seg == ".." {
                bail!("invalid path component in GitHub URL: {seg:?}");
            }
            path.push(seg);
        }
    }
    Ok(url)
}

/// GET a GitHub REST endpoint and decode its JSON body, erroring on a non-success
/// status. The shared shape behind the simple REST reads.
async fn get_json<T: DeserializeOwned>(
    url: impl reqwest::IntoUrl,
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

/// The last `gh auth token` read and when it was taken. Every GitHub call needs a
/// token — including per-file diff expansion, which spawns one `gh` subprocess per
/// file the reviewer opens — so the read is memoised. Only *hits* are cached, and
/// only for [`TOKEN_TTL`]: a `gh auth login`/`gh auth refresh` between calls is
/// picked up within a minute, and a signed-out `gh` is re-probed every time.
static TOKEN_CACHE: LazyLock<RwLock<Option<(String, Instant)>>> =
    LazyLock::new(|| RwLock::new(None));

/// How long a borrowed `gh` token is reused before re-reading it. Short enough that
/// a re-auth is picked up promptly, long enough to collapse the burst of calls a
/// single Reviews page-load makes.
const TOKEN_TTL: Duration = Duration::from_secs(60);

/// The GitHub token the user authorized for the `gh` CLI. `None` when `gh` isn't
/// installed or the user hasn't run `gh auth login`. Shells out on a cache miss, so
/// that runs on the blocking pool rather than the async executor.
///
/// `gh` is resolved through the user's login shell (not bare `Command::new("gh")`):
/// a Finder-launched bundle inherits a minimal PATH that misses Homebrew, so a bare
/// spawn would find `gh` in `tauri dev` (terminal PATH) but silently fail in a
/// release build — leaving the Reviews tab and graph PRs empty.
pub async fn token() -> Option<String> {
    let cached = TOKEN_CACHE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(_, read_at)| read_at.elapsed() < TOKEN_TTL)
        .map(|(token, _)| token.clone());
    if let Some(token) = cached {
        return Some(token);
    }

    let token = tokio::task::spawn_blocking(|| {
        let gh = crate::settings::discover_binary("gh")?;
        let out = Command::new(gh).args(["auth", "token"]).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    })
    .await
    .ok()
    .flatten()?;

    *TOKEN_CACHE.write().unwrap_or_else(|e| e.into_inner()) = Some((token.clone(), Instant::now()));
    Some(token)
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
        if let Ok(user) = get_json::<GhUser>("https://api.github.com/user", &[], &token).await {
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

/// The 100 most-recently-**updated** PRs in `owner/repo` — one GitHub API call
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
/// Ordered by update (not creation) time: in a busy monorepo, hundreds of PRs
/// can be *created* after a worktree's PR while it's still being actively
/// worked — pushes/comments keep it in the recently-updated window. A PR
/// outside even this window is caught by the caller's per-issue fallback
/// ([`prs_for_issue`]). Network errors bubble up.
pub async fn prs_for_repo(token: &str, owner: &str, repo: &str) -> Result<Vec<RepoPr>> {
    let q = format!("repo:{owner}/{repo} type:pr");
    let body: SearchResp = get_json(
        "https://api.github.com/search/issues",
        &[
            ("q", q.as_str()),
            ("per_page", "100"),
            ("sort", "updated"),
            ("order", "desc"),
        ],
        token,
    )
    .await?;
    Ok(body.items.into_iter().map(to_repo_pr).collect())
}

/// Newest PRs whose title mentions `issue_id` — the narrow fallback for a
/// worktree whose PR fell outside [`prs_for_repo`]'s recently-updated window
/// (e.g. a dormant PR in a high-traffic repo). The caller still verifies the
/// exact `[ISSUE-ID]` tag on each result; the search is just the candidate
/// filter (GitHub's tokenizer ignores the brackets).
pub async fn prs_for_issue(
    token: &str,
    owner: &str,
    repo: &str,
    issue_id: &str,
) -> Result<Vec<RepoPr>> {
    let q = format!("repo:{owner}/{repo} type:pr in:title \"{issue_id}\"");
    let body: SearchResp = get_json(
        "https://api.github.com/search/issues",
        &[
            ("q", q.as_str()),
            ("per_page", "10"),
            ("sort", "created"),
            ("order", "desc"),
        ],
        token,
    )
    .await?;
    Ok(body.items.into_iter().map(to_repo_pr).collect())
}

fn to_repo_pr(p: SearchItem) -> RepoPr {
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
        gql::client().post(api_url(&["repos", owner, repo, "pulls"])?),
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
        gql::client().post(api_url(&[
            "repos",
            owner,
            repo,
            "pulls",
            &number.to_string(),
            "requested_reviewers",
        ])?),
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

/// GitHub's REST maximum page size, and how many pages of collaborators we pull.
/// A repo with more than [`REVIEWERS_CAP`] pushers is an org-wide monorepo where the
/// dialog's search box is the only usable path anyway; the cap bounds the request
/// count and is logged when hit.
const REVIEWERS_PER_PAGE: usize = 100;
const REVIEWERS_CAP: usize = 1000;

/// Candidate reviewers for a repo: its collaborators with push access (anyone who
/// can be requested for review), as `User` reviewers with avatars. Excludes the
/// signed-in user — you can't review your own PR. Empty (not an error) when the
/// listing fails so the dialog degrades to a plain create.
///
/// Paged: a single page only reaches the first 100 collaborators, so on any repo
/// with a bigger push list the reviewers past it simply couldn't be requested.
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
    let url = api_url(&["repos", owner, repo, "collaborators"])?;
    let per_page = REVIEWERS_PER_PAGE.to_string();

    let mut fetched = 0;
    let mut reviewers: Vec<Reviewer> = Vec::new();
    loop {
        let page = fetched / REVIEWERS_PER_PAGE + 1;
        let batch: Vec<Collaborator> = get_json(
            url.clone(),
            &[
                ("permission", "push"),
                ("per_page", per_page.as_str()),
                ("page", &page.to_string()),
            ],
            token,
        )
        .await?;
        let short_page = batch.len() < REVIEWERS_PER_PAGE;
        fetched += batch.len();
        reviewers.extend(
            batch
                .into_iter()
                // Drop bots and the signed-in user (GitHub rejects self-review requests).
                .filter(|c| c.kind != "Bot" && me.as_deref() != Some(c.login.as_str()))
                .map(|c| Reviewer {
                    kind: ReviewerKind::User,
                    name: c.login,
                    avatar_url: c.avatar_url,
                }),
        );
        if short_page {
            break;
        }
        if fetched >= REVIEWERS_CAP {
            log::warn!(
                "{owner}/{repo} has more than {REVIEWERS_CAP} collaborators with push access; the reviewer list is truncated"
            );
            break;
        }
    }
    Ok(reviewers)
}

/// The signed-in GitHub login (the PR author), for excluding self from reviewer
/// lists. `None` when the `/user` call fails.
async fn current_login(token: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct GhUser {
        login: String,
    }
    get_json::<GhUser>("https://api.github.com/user", &[], token)
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

/// How many PRs one inbox category shows. The Reviews inbox is a dashboard, not a
/// review surface — a category with 50 open PRs is already well past what anyone
/// triages in a sitting — so we take the newest page rather than paging the whole
/// search. Hitting the cap is logged (see [`search_prs`]) so a section that looks
/// complete but isn't leaves a trace.
const INBOX_SEARCH_CAP: usize = 50;

/// Run one `search(type: ISSUE)` query and map the PR nodes to `ReviewPr`. Capped at
/// [`INBOX_SEARCH_CAP`] (newest-updated first, per the caller's `sort:updated-desc`).
async fn search_prs(token: &str, q: &str) -> Result<Vec<ReviewPr>> {
    #[derive(Deserialize)]
    struct Data {
        search: Connection<PrNode>,
    }
    let query = format!(
        "query($q: String!) {{ search(query: $q, type: ISSUE, first: {INBOX_SEARCH_CAP}) {{ nodes {{ ... on PullRequest {{ {PR_FIELDS} }} }} }} }}"
    );
    let data: Data = graphql(token, &query, serde_json::json!({ "q": q })).await?;
    if data.search.nodes.len() >= INBOX_SEARCH_CAP {
        log::warn!(
            "Reviews: search '{q}' hit the {INBOX_SEARCH_CAP}-PR cap; older PRs are not listed"
        );
    }
    Ok(data.search.nodes.into_iter().map(ReviewPr::from).collect())
}

/// The viewer's GitHub login.
async fn viewer_login(token: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Login,
    }
    #[derive(Deserialize)]
    struct Login {
        login: String,
    }
    let data: Data = graphql(token, "query { viewer { login } }", serde_json::json!({})).await?;
    Ok(data.viewer.login)
}

/// The teams (slug, name) the viewer belongs to within `org`. Empty when the
/// viewer isn't in that org or belongs to no teams there.
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
    // The bare teams connection lists every team in the org *visible* to the
    // viewer — at a big org that's dozens of teams they aren't on, each spawning a
    // review search. `userLogins` narrows it to actual memberships; it needs the
    // viewer's login, hence the extra (cheap) round trip. `role:` can't do this:
    // it filters by the viewer's role *in* the team, so one value or the other
    // would drop teams they merely maintain or merely belong to.
    let login = viewer_login(token).await?;
    let query = "query($login: String!) { viewer { organizations(first: 50) { nodes { login teams(first: 50, userLogins: [$login]) { nodes { slug name } } } } } }";
    let data: Data = graphql(token, query, serde_json::json!({ "login": login })).await?;
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

/// The filters every inbox search shares: open, non-archived PRs, newest-updated first.
const INBOX_FILTERS: &str = "is:open is:pr archived:false sort:updated-desc";

fn mine_query(org: &str) -> String {
    format!("{INBOX_FILTERS} author:@me org:{org}")
}
fn requested_query(org: &str) -> String {
    // `user-review-requested`, not `review-requested`: the plain qualifier also
    // matches PRs requested via a team the viewer is on, which belong to the
    // per-team sections — this section is direct requests only.
    format!("{INBOX_FILTERS} user-review-requested:@me org:{org}")
}
fn team_query(org: &str, slug: &str) -> String {
    format!("{INBOX_FILTERS} team-review-requested:{org}/{slug}")
}

/// The PRs the viewer authored and the PRs individually requested of them, in `org` —
/// two independent searches, run concurrently.
///
/// Split from the team sections ([`team_reviews`]) because those can't start until the
/// viewer's teams are known, and neither of these depends on that: `reviews::inbox`
/// overlaps the two halves instead of putting a `viewer_teams` round-trip on the critical
/// path of every Reviews load.
pub async fn personal_reviews(token: &str, org: &str) -> Result<(Vec<ReviewPr>, Vec<ReviewPr>)> {
    let (mine_q, requested_q) = (mine_query(org), requested_query(org));
    let (mine, requested) =
        tokio::join!(search_prs(token, &mine_q), search_prs(token, &requested_q),);
    Ok((mine?, requested?))
}

/// One inbox section per team with open review requests, searched concurrently; empty
/// sections are dropped. A failed team search degrades to an empty (and therefore
/// dropped) section rather than failing the whole inbox — but it's logged, since an empty
/// section is otherwise indistinguishable from "no open requests for this team".
pub async fn team_reviews(token: &str, org: &str, teams: &[(String, String)]) -> Vec<TeamReviews> {
    futures::future::join_all(teams.iter().map(|(slug, name)| async move {
        let prs = search_prs(token, &team_query(org, slug))
            .await
            .unwrap_or_else(|e| {
                log::warn!("Reviews: review-request search for team {org}/{slug} failed: {e}");
                Vec::new()
            });
        TeamReviews {
            slug: slug.clone(),
            name: name.clone(),
            prs,
        }
    }))
    .await
    .into_iter()
    .filter(|t| !t.prs.is_empty())
    .collect()
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
            let (author, author_avatar_url) = pr
                .author
                .map(|a| (a.login, a.avatar_url))
                .unwrap_or_default();
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
    let (files, files_truncated) = files?;
    Ok(PrDetail {
        body,
        labels,
        comments,
        threads,
        files,
        files_truncated,
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
        api_url(&["repos", owner, name, "labels"])?,
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
        gql::client().put(api_url(&[
            "repos",
            owner,
            name,
            "issues",
            &number.to_string(),
            "labels",
        ])?),
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
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
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

/// The selection every comment node in a PR's conversation uses. The follow-up page
/// queries must request the same shape as the PR query's first page or a later page
/// would decode into a different struct (`pr_conversation_selects_the_shared_fields`
/// pins the two together).
const COMMENT_FIELDS: &str = "author { login avatarUrl } body createdAt";

/// A GraphQL connection's maximum page size.
const GRAPHQL_PAGE: usize = 100;

/// The PR's conversation + head-commit checks. Every connection here asks for
/// `pageInfo` — each is drained to exhaustion (see [`drain_conversation`]), so this
/// is the first page, not the whole story.
const PR_CONVERSATION_QUERY: &str = r"
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          body
          baseRefOid
          headRefOid
          labels(first: 30) { nodes { name color description } }
          comments(first: 100) { nodes { author { login avatarUrl } body createdAt } pageInfo { hasNextPage endCursor } }
          reviews(first: 100) { nodes { author { login avatarUrl } body createdAt } pageInfo { hasNextPage endCursor } }
          reviewThreads(first: 100) {
            nodes {
              id path line diffSide isResolved isOutdated
              comments(first: 100) { nodes { author { login avatarUrl } body createdAt } pageInfo { hasNextPage endCursor } }
            }
            pageInfo { hasNextPage endCursor }
          }
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

/// A follow-up query for the remaining pages of one of the PR's conversation
/// connections. GraphQL can't parameterize a field name, so `field` is interpolated
/// and aliased to `page` — every connection then decodes through the same shape.
fn conversation_page_query(field: &str, node_fields: &str) -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!, $after: String!) {{
           repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{
             page: {field}(first: {GRAPHQL_PAGE}, after: $after) {{
               nodes {{ {node_fields} }}
               pageInfo {{ hasNextPage endCursor }}
             }}
           }} }}
         }}"
    )
}

#[derive(Deserialize)]
struct PageData<T> {
    repository: Option<PageRepo<T>>,
}
#[derive(Deserialize)]
struct PageRepo<T> {
    #[serde(rename = "pullRequest")]
    pull_request: Option<PagePr<T>>,
}
#[derive(Deserialize)]
struct PagePr<T> {
    page: Connection<T>,
}

/// Append the pages the PR query didn't return into `conn`, following the cursor
/// until exhausted. `query` comes from [`conversation_page_query`]. Nothing is
/// dropped silently: a reviewer who saw only the first page of `reviewThreads`
/// would read a PR as fully resolved while an unresolved thread sat past the cut.
async fn drain_conversation<T: DeserializeOwned>(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
    query: &str,
    conn: &mut Connection<T>,
) -> Result<()> {
    while conn.page_info.has_next_page {
        let Some(after) = conn.page_info.end_cursor.clone() else {
            break;
        };
        let data: PageData<T> = graphql(
            token,
            query,
            serde_json::json!({ "owner": owner, "name": name, "number": number, "after": after }),
        )
        .await?;
        let Some(page) = data.repository.and_then(|r| r.pull_request).map(|p| p.page) else {
            break;
        };
        conn.nodes.extend(page.nodes);
        conn.page_info = page.page_info;
    }
    Ok(())
}

/// The same, for the replies *inside* one review thread — a thread isn't reachable
/// as a field of the PR, so its extra pages are fetched through the global `node`
/// lookup by id.
async fn drain_thread_comments<T: DeserializeOwned>(
    token: &str,
    thread_id: &str,
    conn: &mut Connection<T>,
) -> Result<()> {
    #[derive(Deserialize)]
    struct Data<T> {
        node: Option<Node<T>>,
    }
    // `page` is absent when the id names something that isn't a review thread —
    // impossible for an id we just read off one, but the shape allows it.
    #[derive(Deserialize)]
    struct Node<T> {
        page: Option<Connection<T>>,
    }
    let query = format!(
        "query($id: ID!, $after: String!) {{
           node(id: $id) {{ ... on PullRequestReviewThread {{
             page: comments(first: {GRAPHQL_PAGE}, after: $after) {{
               nodes {{ {COMMENT_FIELDS} }}
               pageInfo {{ hasNextPage endCursor }}
             }}
           }} }}
         }}"
    );
    while conn.page_info.has_next_page {
        let Some(after) = conn.page_info.end_cursor.clone() else {
            break;
        };
        let data: Data<T> = graphql(
            token,
            &query,
            serde_json::json!({ "id": thread_id, "after": after }),
        )
        .await?;
        let Some(page) = data.node.and_then(|n| n.page) else {
            break;
        };
        conn.nodes.extend(page.nodes);
        conn.page_info = page.page_info;
    }
    Ok(())
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
) -> Result<(
    String,
    Vec<PrLabel>,
    Vec<PrComment>,
    Vec<PrThread>,
    Vec<PrCheck>,
    String,
    String,
)> {
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
        /// Only used to page the thread's own replies (see [`drain_thread_comments`]).
        id: String,
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
        PR_CONVERSATION_QUERY,
        serde_json::json!({ "owner": owner, "name": name, "number": number }),
    )
    .await?;
    let mut pr = data
        .repository
        .and_then(|r| r.pull_request)
        .ok_or_else(|| anyhow!("PR {owner}/{name}#{number} not found"))?;

    // A GraphQL connection tops out at 100 nodes, and a long-running PR blows past
    // that on any of the three conversation connections. Truncating is worse than
    // slow here — an unresolved review thread past the first page would leave the
    // reviewer reading a PR as clean — so each is drained to exhaustion.
    let comments_q = conversation_page_query("comments", COMMENT_FIELDS);
    let reviews_q = conversation_page_query("reviews", COMMENT_FIELDS);
    let threads_q = conversation_page_query(
        "reviewThreads",
        &format!(
            "id path line diffSide isResolved isOutdated \
             comments(first: {GRAPHQL_PAGE}) {{ nodes {{ {COMMENT_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }}"
        ),
    );
    let (comment_pages, review_pages, thread_pages) = tokio::join!(
        drain_conversation(token, owner, name, number, &comments_q, &mut pr.comments),
        drain_conversation(token, owner, name, number, &reviews_q, &mut pr.reviews),
        drain_conversation(
            token,
            owner,
            name,
            number,
            &threads_q,
            &mut pr.review_threads,
        ),
    );
    comment_pages?;
    review_pages?;
    thread_pages?;
    for thread in &mut pr.review_threads.nodes {
        drain_thread_comments(token, &thread.id, &mut thread.comments).await?;
    }

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
    let url = api_url(&[
        "repos",
        owner,
        name,
        "actions",
        "jobs",
        &job_id.to_string(),
        "logs",
    ])?;
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

/// Remove the ANSI escapes CI tools emit — they'd render as garbage in the log
/// pane, which does its own tinting by level. Two families need different
/// terminators: CSI (`\x1b[31m`, ended by its final letter) and OSC (`\x1b]0;title\x07`,
/// ended by BEL or the `ESC \` string terminator). Treating an OSC as a CSI stops at
/// the first letter inside its payload and leaks the remainder (`;title`) into the text.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&']') {
            chars.next();
            while let Some(n) = chars.next() {
                if n == '\x07' {
                    break;
                }
                if n == '\x1b' {
                    // `ESC \` — consume the backslash half of the terminator.
                    chars.next_if_eq(&'\\');
                    break;
                }
            }
            continue;
        }
        // CSI and the short two-char escapes: consume through the terminating letter.
        for n in chars.by_ref() {
            if n.is_ascii_alphabetic() {
                break;
            }
        }
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

/// GitHub's page size for the PR files endpoint (its maximum).
const PR_FILES_PER_PAGE: usize = 100;

/// How many changed files we fetch for a PR. GitHub serves up to 3000, but a PR
/// that large isn't reviewable in this pane and each page is a round-trip — 5 pages
/// is the budget. Past it the list is truncated and [`PrDetail::files_truncated`]
/// tells the UI to say so: a reviewer who marks every listed file "Viewed" on a
/// silently-truncated list has approved a diff they never saw.
const PR_FILES_CAP: usize = 500;

/// What to do after a page of PR files came back. Pure so the truncation decision
/// (the load-bearing part) is unit-testable without a network.
#[derive(Debug, PartialEq, Eq)]
enum FilePaging {
    /// The page was full and we're under the cap — fetch the next one.
    More,
    /// The page was full but we've hit the cap — there are files we won't fetch.
    Truncated,
    /// A short page means GitHub had nothing more to give.
    Done,
}

fn file_paging(fetched: usize, page_len: usize) -> FilePaging {
    if page_len < PR_FILES_PER_PAGE {
        FilePaging::Done
    } else if fetched >= PR_FILES_CAP {
        FilePaging::Truncated
    } else {
        FilePaging::More
    }
}

/// Changed files for a PR, with their unified-diff patches (REST files API), paged
/// up to [`PR_FILES_CAP`]. The bool is "there are more files we didn't fetch".
async fn pr_files(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
) -> Result<(Vec<PrFile>, bool)> {
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
    let url = api_url(&["repos", owner, name, "pulls", &number.to_string(), "files"])?;
    let per_page = PR_FILES_PER_PAGE.to_string();

    let mut files: Vec<PrFile> = Vec::new();
    let truncated = loop {
        let page = files.len() / PR_FILES_PER_PAGE + 1;
        let batch: Vec<RestFile> = get_json(
            url.clone(),
            &[("per_page", per_page.as_str()), ("page", &page.to_string())],
            token,
        )
        .await?;
        let paging = file_paging(files.len() + batch.len(), batch.len());
        files.extend(batch.into_iter().map(|f| PrFile {
            path: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
            sha: f.sha,
        }));
        match paging {
            FilePaging::More => {}
            FilePaging::Truncated => break true,
            FilePaging::Done => break false,
        }
    };
    if truncated {
        log::warn!(
            "PR {owner}/{name}#{number} has more than {PR_FILES_CAP} changed files; the diff list is truncated"
        );
    }
    Ok((files, truncated))
}

/// The full text of a file at a given commit, via the REST contents API with the
/// `raw` media type (returns the bytes directly rather than base64 JSON). Only a
/// 404 — the file doesn't exist at that commit (added on the new side, or deleted on
/// the old side) — maps to empty, which the diff viewer treats as "no content".
/// Every other failure is an error: a rate-limited 403 or a transient 5xx rendered
/// as empty is indistinguishable from a genuinely absent file, so the expanded diff
/// would silently claim the file has no content.
async fn file_content(
    token: &str,
    owner: &str,
    name: &str,
    r#ref: &str,
    path: &str,
) -> Result<String> {
    let res = gql::client()
        .get(api_url(&["repos", owner, name, "contents", path])?)
        .query(&[("ref", r#ref)])
        .bearer_auth(token)
        .header("Accept", "application/vnd.github.raw")
        .header("User-Agent", "santree")
        .send()
        .await?;
    let status = res.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(String::new());
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        bail!("GitHub returned {status}: {snippet}");
    }
    Ok(res.text().await?)
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
    Ok(FileSource {
        old_text: old_text?,
        new_text: new_text?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_url_encodes_untrusted_components() {
        // A `?`/`#` in a repo-relative path must stay *in* the path, not split off a
        // query or fragment; spaces and other unsafe bytes are percent-encoded too.
        let url = api_url(&["repos", "o", "r", "contents", "src/a b?x=1#frag.rs"]).unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.github.com/repos/o/r/contents/src/a%20b%3Fx=1%23frag.rs"
        );
        assert_eq!(url.query(), None);
        assert_eq!(url.fragment(), None);
    }

    #[test]
    fn api_url_keeps_path_structure_but_rejects_traversal() {
        // Slashes inside a component are real separators (a repo path)…
        assert_eq!(
            api_url(&["repos", "o", "r", "contents", "a/b/c.rs"])
                .unwrap()
                .path(),
            "/repos/o/r/contents/a/b/c.rs"
        );
        // …but `..` would re-point the request at another endpoint.
        assert!(api_url(&["repos", "o", "r", "contents", "../../../user"]).is_err());
        assert!(api_url(&["repos", "o", "..", "pulls"]).is_err());
    }

    /// Splitting the inbox into [`personal_reviews`] + [`team_reviews`] moved these
    /// queries; each still has to scope to the org (a bare `author:@me` would pull in
    /// every PR the user has open anywhere) and share the open-PR filters, or a section
    /// would quietly list the wrong PRs.
    #[test]
    fn every_inbox_search_is_org_scoped_and_shares_the_open_pr_filters() {
        assert_eq!(
            mine_query("acme"),
            "is:open is:pr archived:false sort:updated-desc author:@me org:acme"
        );
        // Direct requests only — team-routed requests live in the team sections.
        assert_eq!(
            requested_query("acme"),
            "is:open is:pr archived:false sort:updated-desc user-review-requested:@me org:acme"
        );
        // The team search is scoped by the `org/slug` handle itself.
        assert_eq!(
            team_query("acme", "core"),
            "is:open is:pr archived:false sort:updated-desc team-review-requested:acme/core"
        );
    }

    #[test]
    fn file_paging_stops_on_short_page_and_at_the_cap() {
        // Short page ⇒ GitHub had nothing more, regardless of how many we hold.
        assert_eq!(file_paging(7, 7), FilePaging::Done);
        assert_eq!(file_paging(PR_FILES_CAP, 3), FilePaging::Done);
        // Full page under the cap ⇒ keep going.
        assert_eq!(
            file_paging(PR_FILES_PER_PAGE, PR_FILES_PER_PAGE),
            FilePaging::More
        );
        // Full page landing on the cap ⇒ more files exist that we won't fetch.
        assert_eq!(
            file_paging(PR_FILES_CAP, PR_FILES_PER_PAGE),
            FilePaging::Truncated
        );
    }

    /// A follow-up page decodes into the same struct as the first one, so the two
    /// selections have to stay identical — and the paged connections have to ask
    /// for the cursor that drives the drain at all.
    #[test]
    fn pr_conversation_selects_the_shared_fields() {
        assert!(PR_CONVERSATION_QUERY.contains(COMMENT_FIELDS));
        for field in ["comments", "reviews", "reviewThreads"] {
            assert!(
                conversation_page_query(field, COMMENT_FIELDS).contains(&format!("page: {field}(")),
                "{field} page query must alias the connection to `page`"
            );
        }
        assert_eq!(
            PR_CONVERSATION_QUERY
                .matches("pageInfo { hasNextPage endCursor }")
                .count(),
            5,
            "comments, reviews, reviewThreads, thread comments and check contexts all page"
        );
    }

    /// OSC sequences (a `##[group]`-heavy CI step often sets the window title)
    /// don't end at the first letter the way a CSI does — consuming one as a CSI
    /// leaked the rest of its payload into the cleaned log.
    #[test]
    fn strip_ansi_handles_csi_and_osc() {
        assert_eq!(strip_ansi("\x1b[31mFAILED\x1b[0m test"), "FAILED test");
        // OSC terminated by BEL…
        assert_eq!(strip_ansi("\x1b]0;npm run build\x07built"), "built");
        // …and by the `ESC \` string terminator (OSC 8 hyperlinks).
        assert_eq!(
            strip_ansi("see \x1b]8;;https://ci.example/log\x1b\\the log"),
            "see the log"
        );
        assert_eq!(strip_ansi("plain line"), "plain line");
    }

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
        assert!(!loose.iter().any(|(t, _)| t.contains("Process completed")));
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
