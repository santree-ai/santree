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
    NewInlineComment, PrAttachment, PrCheck, PrComment, PrCommit, PrDetail, PrFile, PrLabel,
    PrState, PrThread, ReviewDecision, ReviewEvent, ReviewPr, Reviewer, ReviewerKind, TeamReviews,
    ViewerReview, ViewerReviewState,
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

/// Turn a failed REST response into an error carrying GitHub's own `message`
/// ("Validation Failed", "line must be part of the diff", "Can not approve your
/// own pull request"). The status alone is useless to a user leaving a comment —
/// a 422 says nothing about *which* field GitHub rejected.
async fn rest_error(res: reqwest::Response) -> anyhow::Error {
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
    anyhow!("GitHub: {detail}")
}

/// POST a JSON body to a REST endpoint, discarding the (unused) response body.
/// The shared shape behind the write paths that only need "did it work".
async fn rest_post(token: &str, url: reqwest::Url, body: serde_json::Value) -> Result<()> {
    let res = rest(gql::client().post(url), token)
        .json(&body)
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(rest_error(res).await);
    }
    Ok(())
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

/// What is left of the GitHub API budget the `gh` session is spending, from
/// GitHub's own `/rate_limit`. `None` when nothing is signed in.
///
/// Three of the fifteen pools GitHub reports, because they are the three santree
/// actually draws on: REST (`core`), the search pool the Reviews inbox spends,
/// and GraphQL. `/rate_limit` is documented as not counting against any of them,
/// so refreshing this never moves the numbers it reports.
///
/// The budget belongs to the *token*, not to santree — every other tool sharing
/// this `gh` login draws on the same pools, which is exactly why a number worth
/// showing has to come from GitHub rather than from a local tally.
pub async fn api_budget() -> Option<santree_core::domain::GithubApiBudget> {
    let token = token().await?;
    let limits = get_json::<RateLimitResponse>("https://api.github.com/rate_limit", &[], &token)
        .await
        .map_err(|e| log::warn!("reading the GitHub rate limit: {e:#}"))
        .ok()?;
    Some(limits.into_budget())
}

/// The three pools of `/rate_limit`'s `resources` object santree draws on. The
/// other twelve GitHub reports (SCIM, audit log, dependency snapshots…) are
/// deliberately not deserialized — a pool nothing spends is noise on a meter.
#[derive(Deserialize)]
struct RateLimitResponse {
    resources: RateLimitResources,
}

#[derive(Deserialize)]
struct RateLimitResources {
    core: Option<RateLimitPool>,
    search: Option<RateLimitPool>,
    graphql: Option<RateLimitPool>,
}

#[derive(Deserialize)]
struct RateLimitPool {
    limit: f64,
    remaining: f64,
    /// Unix **seconds** — Linear's equivalent header is milliseconds, and the
    /// two meet in the same frontend component.
    reset: f64,
}

impl RateLimitResponse {
    fn into_budget(self) -> santree_core::domain::GithubApiBudget {
        use santree_core::domain::{ApiBudgetKind, ApiBudgetWindow, GithubApiBudget};

        let window = |kind: ApiBudgetKind, pool: Option<RateLimitPool>| {
            pool.map(|p| ApiBudgetWindow {
                kind,
                limit: p.limit,
                remaining: p.remaining,
                resets_at_ms: Some(p.reset * 1000.0),
            })
        };
        GithubApiBudget {
            windows: [
                window(ApiBudgetKind::Rest, self.resources.core),
                window(ApiBudgetKind::Search, self.resources.search),
                window(ApiBudgetKind::GraphQl, self.resources.graphql),
            ]
            .into_iter()
            .flatten()
            .collect(),
        }
    }
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
struct PullItem {
    number: u32,
    title: String,
    html_url: String,
    state: String,
    merged_at: Option<String>,
    head: PullRef,
}

#[derive(Deserialize)]
struct PullRef {
    #[serde(rename = "ref")]
    name: String,
    /// The repo the head branch lives in. `None` once a fork is deleted, which is
    /// why [`RepoPr::same_repo`] treats absence as "not ours" rather than assuming.
    repo: Option<PullRepo>,
}

#[derive(Deserialize)]
struct PullRepo {
    full_name: String,
}

/// One PR from the repo's PR list. Carries both join keys [`crate::pr::statuses`]
/// uses to attach it to a worktree — its head branch and its title — so a whole
/// repo's PRs can be matched against every linked worktree client-side, with no
/// API call per worktree.
pub struct RepoPr {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: PrState,
    /// The PR's head branch. GitHub deletes the *branch* on merge but keeps this
    /// field on the PR record, so it stays a valid join key for merged PRs too.
    pub head_ref: String,
    /// Whether that head branch lives in **this** repo rather than a fork.
    ///
    /// `head_ref` is a bare branch name with no owner in it, so a PR raised from a
    /// fork whose branch happens to share a name with one of our worktree branches
    /// would otherwise bind a stranger's PR to the user's work — a false positive,
    /// which is worse than showing no PR at all. False when GitHub reports no head
    /// repo (a deleted fork): unconfirmed is not the same as ours.
    pub same_repo: bool,
}

/// The 100 most-recently-**updated** PRs in `owner/repo`, any state — one GitHub
/// API call regardless of how many worktrees the caller wants to match against.
///
/// Deliberately the `/pulls` list endpoint rather than a PR search: it is the
/// only one of the two that returns each PR's head branch (`head.ref`), which is
/// the exact key [`crate::pr::statuses`] joins on, it reads live data instead of
/// the search index (a just-opened PR shows up immediately), and it spends the
/// 5000/hour REST budget instead of search's ~30/minute secondary limit —
/// `worktreePrs` is refetched on a 60s staleTime *and* after every worktree
/// mutation, which is close enough to that ceiling to matter.
///
/// Ordered by update (not creation) time: in a busy monorepo, hundreds of PRs
/// can be *created* after a worktree's PR while it's still being actively
/// worked — pushes/comments keep it in the recently-updated window. A PR
/// outside even this window is caught by the caller's per-branch fallback
/// ([`prs_for_branch`]). Network errors bubble up.
pub async fn prs_for_repo(token: &str, owner: &str, repo: &str) -> Result<Vec<RepoPr>> {
    list_pulls(
        token,
        owner,
        repo,
        &[
            ("state", "all"),
            ("sort", "updated"),
            ("direction", "desc"),
            ("per_page", "100"),
        ],
    )
    .await
}

/// The PRs opened from `branch` — the narrow fallback for a worktree whose PR
/// fell outside [`prs_for_repo`]'s recently-updated window (e.g. a dormant PR in
/// a high-traffic repo). GitHub filters on the head ref recorded on the PR, so
/// this still finds a merged PR whose branch has since been deleted.
///
/// `head` is qualified with the repo owner, which is where santree pushes its
/// worktree branches; a PR raised from someone's fork is left to the bulk list.
pub async fn prs_for_branch(
    token: &str,
    owner: &str,
    repo: &str,
    branch: &str,
) -> Result<Vec<RepoPr>> {
    let head = format!("{owner}:{branch}");
    list_pulls(
        token,
        owner,
        repo,
        &[
            ("state", "all"),
            ("sort", "updated"),
            ("direction", "desc"),
            ("per_page", "10"),
            ("head", head.as_str()),
        ],
    )
    .await
}

/// `GET /repos/{owner}/{repo}/pulls` with the caller's filters, mapped to
/// [`RepoPr`]. Owner/repo are parsed from the `origin` remote and the branch
/// comes from the DB, so the path is built by [`api_url`] and the filters go
/// through reqwest's query encoder — never `format!`ed into the URL.
async fn list_pulls(
    token: &str,
    owner: &str,
    repo: &str,
    query: &[(&str, &str)],
) -> Result<Vec<RepoPr>> {
    let url = api_url(&["repos", owner, repo, "pulls"])?;
    let items: Vec<PullItem> = get_json(url, query, token).await?;
    let slug = format!("{owner}/{repo}");
    Ok(items.into_iter().map(|p| to_repo_pr(p, &slug)).collect())
}

fn to_repo_pr(p: PullItem, base_slug: &str) -> RepoPr {
    let state = if p.merged_at.is_some() {
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
        head_ref: p.head.name,
        same_repo: p.head.repo.is_some_and(|r| r.full_name == base_slug),
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
//
// `timelineItems` is the one non-obvious cost here: 50 search results × the 30
// events below is ~1.5k nodes, well inside GitHub's per-query node limit, and it
// buys the only honest answer to "how long has this been waiting on *me*" —
// `createdAt` alone counts from before the viewer was ever asked. A PR with more
// than 30 review-request events falls back to `createdAt`, which errs toward
// looking like it has waited *longer*, never shorter.
const PR_FIELDS: &str = r"
    id number title url state isDraft updatedAt createdAt headRefName baseRefName isInMergeQueue
    headRef { id }
    baseRef { id }
    repository { nameWithOwner }
    author { login avatarUrl }
    reviewDecision
    comments { totalCount }
    additions deletions changedFiles
    viewerLatestReview { state submittedAt }
    commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state } } } }
    reviewRequests(first: 20) {
      nodes {
        requestedReviewer {
          __typename
          ... on User { login avatarUrl }
          ... on Team { name }
        }
      }
    }
    timelineItems(last: 30, itemTypes: [REVIEW_REQUESTED_EVENT]) {
      nodes {
        ... on ReviewRequestedEvent {
          createdAt
          requestedReviewer {
            __typename
            ... on User { login }
            ... on Team { slug }
          }
        }
      }
    }
";

#[derive(Deserialize)]
struct Actor {
    /// The `Actor` interface's concrete type — `Bot` for a GitHub App, `User` for
    /// a person, `Mannequin`/`Organization` for the rest.
    ///
    /// `#[serde(default)]` is load-bearing, not tidiness: [`PR_FIELDS`] decodes
    /// into this same struct and deliberately does *not* select `__typename`, so a
    /// required field here would fail every Reviews inbox search to deserialize.
    #[serde(rename = "__typename", default)]
    typename: String,
    login: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: String,
}

impl Actor {
    /// Only `Bot` is a bot. `Mannequin` is an import placeholder standing in for a
    /// real person, and `Organization`/`EnterpriseUserAccount` are neither.
    ///
    /// Read from GitHub's own type rather than inferred from a `[bot]`-suffixed
    /// login: the suffix is a *rendering* convention applied to bot actors (and
    /// GraphQL's `Bot.login` often omits it), so matching on it is strictly weaker
    /// than asking what the actor is. It would also still miss the case a
    /// heuristic gets reached for — a machine **user** account a team runs CI as —
    /// which GitHub itself draws no line around, so neither do we.
    fn is_bot(&self) -> bool {
        self.typename == "Bot"
    }
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
struct NodeRef {
    id: String,
}

#[derive(Deserialize)]
struct Rollup {
    state: String,
}
#[derive(Deserialize)]
struct CommitWrap {
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Option<Rollup>,
    #[serde(rename = "committedDate")]
    committed_date: Option<String>,
    #[serde(default)]
    oid: Option<String>,
}
#[derive(Deserialize)]
struct CommitNode {
    commit: CommitWrap,
}

#[derive(Deserialize)]
struct LatestReviewNode {
    state: Option<String>,
    #[serde(rename = "submittedAt")]
    submitted_at: Option<String>,
}

/// Who a `ReviewRequestedEvent` named. Only the identity matters here (not the
/// avatar the sidebar's reviewer list needs), so this is a leaner union than
/// [`RequestedReviewer`] — and it carries a team's **slug**, since that's what
/// [`viewer_teams`] returns and what we match against.
#[derive(Deserialize)]
#[serde(tag = "__typename")]
enum RequestedIdentity {
    User {
        login: String,
    },
    Team {
        slug: String,
    },
    #[serde(other)]
    Other,
}

/// One `REVIEW_REQUESTED_EVENT` off the PR timeline. Every field is optional: the
/// timeline union yields a bare `{}` for any node that isn't the type we asked
/// for, and a request whose reviewer has since been deleted has no reviewer.
#[derive(Deserialize)]
struct ReviewRequestedEvent {
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "requestedReviewer")]
    requested_reviewer: Option<RequestedIdentity>,
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
    state: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "headRef")]
    head_ref: Option<NodeRef>,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
    #[serde(rename = "baseRef")]
    base_ref: Option<NodeRef>,
    #[serde(rename = "isInMergeQueue")]
    is_in_merge_queue: bool,
    repository: RepoRef,
    author: Option<Actor>,
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
    comments: TotalCount,
    additions: u32,
    deletions: u32,
    #[serde(rename = "changedFiles")]
    changed_files: u32,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "viewerLatestReview")]
    viewer_latest_review: Option<LatestReviewNode>,
    commits: Connection<CommitNode>,
    #[serde(rename = "reviewRequests")]
    review_requests: Connection<ReviewRequestNode>,
    #[serde(rename = "timelineItems")]
    timeline_items: Connection<ReviewRequestedEvent>,
}

/// Who the inbox is being built for. Threaded into the PR mapping because
/// "waiting since" is viewer-relative: the same PR has a different answer for the
/// author, for a directly-requested reviewer, and for someone on a requested team.
pub struct ViewerCtx {
    pub login: String,
    /// Slugs of the teams the viewer belongs to in this org.
    pub team_slugs: Vec<String>,
}

impl ViewerCtx {
    /// Whether a review-request event named this viewer, directly or through one of
    /// their teams.
    fn is_for_viewer(&self, who: &RequestedIdentity) -> bool {
        match who {
            RequestedIdentity::User { login } => login.eq_ignore_ascii_case(&self.login),
            RequestedIdentity::Team { slug } => {
                self.team_slugs.iter().any(|s| s.eq_ignore_ascii_case(slug))
            }
            RequestedIdentity::Other => false,
        }
    }
}

/// When the review clock started for `viewer` on this PR: the **newest**
/// review-request event naming them or one of their teams.
///
/// Newest rather than oldest because a re-request is a fresh ask — the author
/// pushed changes and wants another look, and dating that from the original
/// request would show a week-old age for something that landed on your plate an
/// hour ago. `None` when no event names the viewer (their own PR, a request older
/// than the fetched page, or a reviewer added at creation time — GitHub doesn't
/// always emit a timeline event for those), and the caller falls back to the PR's
/// creation date.
fn viewer_requested_at(events: &[ReviewRequestedEvent], viewer: &ViewerCtx) -> Option<String> {
    events
        .iter()
        .filter(|e| {
            e.requested_reviewer
                .as_ref()
                .is_some_and(|who| viewer.is_for_viewer(who))
        })
        .filter_map(|e| e.created_at.as_deref())
        // ISO-8601 UTC from GitHub is fixed-width, so lexical max is chronological max.
        .max()
        .map(str::to_owned)
}

/// GitHub's `PullRequestState` → the domain enum.
///
/// An unrecognised value maps to `Open`: the GraphQL enum has been three-valued
/// for a decade, and a PR santree can't classify is better shown as live than
/// silently reported as merged.
fn pr_state(raw: &str) -> PrState {
    match raw {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => PrState::Open,
    }
}

/// Map one PR node into the domain type, from `viewer`'s point of view.
///
/// Not a `From` impl: two of the fields (`waiting_since`, and the meaning of
/// `viewer_review`) only exist relative to who is asking.
fn to_review_pr(n: PrNode, viewer: &ViewerCtx) -> ReviewPr {
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
    let head_commit = n.commits.nodes.first().map(|c| &c.commit);
    let checks = head_commit
        .and_then(|c| c.status_check_rollup.as_ref())
        .map(|r| match r.state.as_str() {
            "SUCCESS" => CheckRollup::Success,
            "FAILURE" | "ERROR" => CheckRollup::Failure,
            "PENDING" | "EXPECTED" => CheckRollup::Pending,
            _ => CheckRollup::None,
        })
        .unwrap_or(CheckRollup::None);
    let head_committed_at = head_commit
        .and_then(|c| c.committed_date.clone())
        .unwrap_or_else(|| n.created_at.clone());
    let head_sha = head_commit.and_then(|c| c.oid.clone()).unwrap_or_default();
    // A review with no `submittedAt` is still pending (a started-but-unsent
    // review) — it hasn't reached the author, so it doesn't count as "you had
    // your say", and there's no timestamp to date it against the head commit.
    let viewer_review = n
        .viewer_latest_review
        .and_then(|r| Some((r.state?, r.submitted_at?)))
        .map(|(state, submitted_at)| ViewerReview {
            state: match state.as_str() {
                "APPROVED" => ViewerReviewState::Approved,
                "CHANGES_REQUESTED" => ViewerReviewState::ChangesRequested,
                "COMMENTED" => ViewerReviewState::Commented,
                _ => ViewerReviewState::Other,
            },
            submitted_at,
        });
    let waiting_since = viewer_requested_at(&n.timeline_items.nodes, viewer)
        .unwrap_or_else(|| n.created_at.clone());
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
        // Attributed by `reviews::inbox` once the repo registry is in hand — GitHub
        // has never heard of the user's projects.
        project: None,
        head_ref: n.head_ref_name,
        head_ref_id: n.head_ref.map(|r| r.id),
        base_ref: n.base_ref_name,
        base_ref_id: n.base_ref.map(|r| r.id),
        head_sha,
        author,
        author_avatar_url,
        state: pr_state(&n.state),
        is_draft: n.is_draft,
        review_decision,
        checks,
        is_in_merge_queue: n.is_in_merge_queue,
        additions: n.additions,
        deletions: n.deletions,
        changed_files: n.changed_files,
        comment_count: n.comments.total_count,
        // Santree enriches this from its local review drafts after the GitHub
        // inbox lands. GitHub has no concept of drafts that have not been sent.
        ai_draft_count: 0,
        reviewers,
        updated_at: n.updated_at,
        created_at: n.created_at,
        waiting_since,
        head_committed_at,
        viewer_review,
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
async fn search_prs(token: &str, q: &str, viewer: &ViewerCtx) -> Result<Vec<ReviewPr>> {
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
    Ok(data
        .search
        .nodes
        .into_iter()
        .map(|n| to_review_pr(n, viewer))
        .collect())
}

/// One PR by number, mapped into the same [`ReviewPr`] the inbox ships — so every
/// component written against an inbox row renders a worktree's own PR unchanged.
///
/// `Ok(None)`, not an error, when the number doesn't resolve: a deleted PR, or a
/// worktree whose recorded number has gone stale. A *repository* that doesn't
/// resolve is an error — GitHub answers that with `NOT_FOUND` in the `errors`
/// array, and "you can't see acme/api" is worth telling the user about.
///
/// The viewer's login is selected in the **same document** as the PR. A separate
/// `viewer { login }` round-trip would double the latency of a panel that opens on
/// every worktree click, for a field GraphQL hands back alongside the PR for free.
///
/// `team_slugs` is left empty, and that is a deliberate, bounded inaccuracy:
/// resolving them needs the login this very query is what fetches. The only
/// consequence is that a PR routed to the viewer through a *team* dates its
/// `waiting_since` from `created_at` rather than from the team request — erring
/// toward looking like it has waited longer, never shorter, the same direction
/// [`PR_FIELDS`]' 30-event timeline cap already errs in. This path serves the
/// viewer's own PR, where no request names them at all.
pub async fn pull_request(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
) -> Result<Option<ReviewPr>> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Login,
        repository: Option<Repo>,
    }
    #[derive(Deserialize)]
    struct Login {
        login: String,
    }
    #[derive(Deserialize)]
    struct Repo {
        #[serde(rename = "pullRequest")]
        pull_request: Option<PrNode>,
    }
    let data: Data = graphql(
        token,
        &single_pr_query(),
        serde_json::json!({ "owner": owner, "name": name, "number": number }),
    )
    .await?;
    let viewer = ViewerCtx {
        login: data.viewer.login,
        team_slugs: Vec::new(),
    };
    Ok(data
        .repository
        .and_then(|r| r.pull_request)
        .map(|n| to_review_pr(n, &viewer)))
}

/// The by-number PR query. The identity travels as GraphQL **variables** — never
/// interpolated — and the viewer's login rides along in the same document (see
/// [`pull_request`]). A free function so both of those stay pinned by a test.
fn single_pr_query() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{
           viewer {{ login }}
           repository(owner: $owner, name: $name) {{
             pullRequest(number: $number) {{ {PR_FIELDS} }}
           }}
         }}"
    )
}

/// `(owner, name)` from an "owner/name" slug. The slug crosses IPC, so a malformed
/// one is rejected rather than being pasted into a GitHub request or a path.
pub fn split_slug(pr_repo: &str) -> Result<(&str, &str)> {
    match pr_repo.split_once('/') {
        Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/') => {
            Ok((owner, name))
        }
        _ => Err(anyhow!("malformed repo slug: {pr_repo:?}")),
    }
}

/// The viewer's GitHub login.
pub async fn viewer_login(token: &str) -> Result<String> {
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

/// The teams (slug, name) the viewer belongs to in each of `orgs`, in the order
/// asked. An org the viewer isn't in, or has no teams in, is simply absent.
///
/// Every org is answered by **one** round-trip: the query already lists the
/// viewer's organizations with their teams, so asking per org would re-run the
/// same expensive document once per registered project for one answer.
///
/// `login` is passed in rather than looked up here: the inbox needs it anyway (to
/// decide which review-request events started *its* clock), and fetching it twice
/// would put a second round-trip on the critical path of every Reviews load.
pub async fn viewer_teams(
    token: &str,
    orgs: &[String],
    login: &str,
) -> Result<Vec<(String, Vec<(String, String)>)>> {
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
    let query = "query($login: String!) { viewer { organizations(first: 50) { nodes { login teams(first: 50, userLogins: [$login]) { nodes { slug name } } } } } }";
    let data: Data = graphql(token, query, serde_json::json!({ "login": login })).await?;
    let memberships = data.viewer.organizations.nodes;
    Ok(orgs
        .iter()
        .filter_map(|org| {
            // GitHub compares owners case-insensitively and our spelling comes from
            // a git remote, which need not match the org's canonical login. The
            // *asked* spelling is what comes back, so the org keys here line up
            // with the ones the inbox reports having searched.
            let node = memberships
                .iter()
                .find(|o| o.login.eq_ignore_ascii_case(org))?;
            // A slug from GitHub goes straight into a `team-review-requested:`
            // qualifier below. Shape-checking it here keeps that guarantee local
            // rather than borrowed from whatever the API happens to return.
            let teams: Vec<(String, String)> = node
                .teams
                .nodes
                .iter()
                .filter(|t| repo::valid_github_component(&t.slug))
                .map(|t| (t.slug.clone(), t.name.clone()))
                .collect();
            (!teams.is_empty()).then(|| (org.clone(), teams))
        })
        .collect())
}

/// The filters every inbox search shares: open, non-archived PRs, newest-updated first.
const INBOX_FILTERS: &str = "is:open is:pr archived:false sort:updated-desc";

/// GitHub's documented ceiling on a search query. A registry spanning enough orgs
/// can't ask its question in one string, so the qualifiers are batched up to here.
/// The GraphQL endpoint currently answers longer queries too — measured, not
/// promised, and a query GitHub decides to reject drops orgs from the inbox, so
/// the documented number is the one we hold to.
const SEARCH_QUERY_LIMIT: usize = 256;

/// `prefix` plus one `org:` qualifier per org, split into the fewest queries that
/// each stay under [`SEARCH_QUERY_LIMIT`].
///
/// Repeated `org:` qualifiers OR, so one batch answers for every org in it — the
/// point being that the inbox pays one rate-limited call for a whole registry
/// rather than one per project. (There is no OR at the *qualifier* level to reach
/// for instead: GitHub 422s on `author:@me OR user-review-requested:@me`, with or
/// without parens, which is why the me/team split stays two searches.)
///
/// An org whose own term overflows the budget is emitted alone rather than
/// dropped: GitHub refusing a query is visible, a silently missing org is not.
fn org_batches(prefix: &str, orgs: &[String]) -> Vec<String> {
    let mut batches: Vec<String> = Vec::new();
    for org in orgs {
        let term = format!(" org:{org}");
        match batches.last_mut() {
            Some(q) if q.len() + term.len() <= SEARCH_QUERY_LIMIT => q.push_str(&term),
            _ => batches.push(format!("{prefix}{term}")),
        }
    }
    batches
}

fn mine_queries(orgs: &[String]) -> Vec<String> {
    org_batches(&format!("{INBOX_FILTERS} author:@me"), orgs)
}
fn requested_queries(orgs: &[String]) -> Vec<String> {
    // `user-review-requested`, not `review-requested`: the plain qualifier also
    // matches PRs requested via a team the viewer is on, which belong to the
    // per-team sections — this section is direct requests only.
    org_batches(&format!("{INBOX_FILTERS} user-review-requested:@me"), orgs)
}
fn team_query(org: &str, slug: &str) -> String {
    format!("{INBOX_FILTERS} team-review-requested:{org}/{slug}")
}

/// Run every batch concurrently and keep the ones that answered.
///
/// A failed batch costs the orgs *in it* and nothing else — a rate-limited or
/// half-visible org must not empty an inbox that spans several. But *all* of them
/// failing is not "nothing is waiting on you", so that surfaces as the error it
/// is: an inbox silently reading empty is the exact failure this aggregation
/// exists to remove.
async fn search_batches(
    token: &str,
    queries: &[String],
    viewer: &ViewerCtx,
) -> Result<Vec<ReviewPr>> {
    let results =
        futures::future::join_all(queries.iter().map(|q| search_prs(token, q, viewer))).await;
    keep_answered(queries, results)
}

/// The rule [`search_batches`] applies to its batches, as a pure function: keep
/// what came back, log what didn't, and only fail when *nothing* did.
fn keep_answered<T>(queries: &[String], results: Vec<Result<Vec<T>>>) -> Result<Vec<T>> {
    let (mut kept, mut answered, mut failure) = (Vec::new(), false, None);
    for (q, result) in queries.iter().zip(results) {
        match result {
            Ok(found) => {
                answered = true;
                kept.extend(found);
            }
            Err(e) => {
                log::warn!("Reviews: search '{q}' failed: {e}");
                failure = failure.or(Some(e));
            }
        }
    }
    match failure {
        Some(e) if !answered => Err(e),
        _ => Ok(kept),
    }
}

/// The PRs the viewer authored and the PRs individually requested of them, across
/// `orgs` — two independent searches (each possibly batched), run concurrently.
///
/// Split from the team sections ([`team_reviews`]) because those can't start until the
/// viewer's teams are known, and neither of these depends on that: `reviews::inbox`
/// overlaps the two halves instead of putting a `viewer_teams` round-trip on the critical
/// path of every Reviews load.
pub async fn personal_reviews(
    token: &str,
    orgs: &[String],
    viewer: &ViewerCtx,
) -> Result<(Vec<ReviewPr>, Vec<ReviewPr>)> {
    let (mine_q, requested_q) = (mine_queries(orgs), requested_queries(orgs));
    let (mine, requested) = tokio::join!(
        search_batches(token, &mine_q, viewer),
        search_batches(token, &requested_q, viewer),
    );
    Ok((mine?, requested?))
}

/// One inbox section per team with open review requests, searched concurrently; empty
/// sections are dropped. A failed team search degrades to an empty (and therefore
/// dropped) section rather than failing the whole inbox — but it's logged, since an empty
/// section is otherwise indistinguishable from "no open requests for this team".
pub async fn team_reviews(
    token: &str,
    org: &str,
    teams: &[(String, String)],
    viewer: &ViewerCtx,
) -> Vec<TeamReviews> {
    futures::future::join_all(teams.iter().map(|(slug, name)| async move {
        let prs = search_prs(token, &team_query(org, slug), viewer)
            .await
            .unwrap_or_else(|e| {
                log::warn!("Reviews: review-request search for team {org}/{slug} failed: {e}");
                Vec::new()
            });
        TeamReviews {
            org: org.to_string(),
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
/// is fetched alongside the queue so entries can be marked "mine", and so is the
/// 30-day merge count (a `search`, which has a budget of its own) that the panel
/// shows as the queue's throughput.
pub async fn merge_queue(token: &str, owner: &str, name: &str) -> Result<Option<MergeQueue>> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Login,
        repository: Option<RepoNode>,
        merged: Option<SearchCount>,
    }
    #[derive(Deserialize)]
    struct SearchCount {
        #[serde(rename = "issueCount")]
        issue_count: u32,
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
        url: String,
        #[serde(rename = "nextEntryEstimatedTimeToMerge")]
        next_estimated: Option<i64>,
        entries: Connection<EntryNode>,
    }
    #[derive(Deserialize)]
    struct EntryNode {
        /// GitHub's raw position; we re-rank by queue order for display, so this
        /// is only used to sort (its exact indexing base doesn't matter).
        #[serde(default)]
        position: Option<u32>,
        state: Option<String>,
        #[serde(rename = "enqueuedAt", default)]
        enqueued_at: String,
        #[serde(rename = "estimatedTimeToMerge")]
        estimated: Option<i64>,
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

    // GitHub reports the estimates in seconds; a negative or absurd value is
    // "no estimate" rather than a number to show.
    let secs = |v: Option<i64>| v.and_then(|s| u32::try_from(s).ok());

    let query = r"
        query($owner: String!, $name: String!, $merged: String!) {
          viewer { login }
          repository(owner: $owner, name: $name) {
            defaultBranchRef { name }
            mergeQueue {
              url
              nextEntryEstimatedTimeToMerge
              entries(first: 100) {
                nodes {
                  position
                  state
                  enqueuedAt
                  estimatedTimeToMerge
                  pullRequest { number title url author { login avatarUrl } }
                }
              }
            }
          }
          merged: search(type: ISSUE, query: $merged, first: 1) { issueCount }
        }
    ";
    let since = (chrono::Utc::now() - chrono::Duration::days(30)).format("%Y-%m-%d");
    let data: Data = graphql(
        token,
        query,
        serde_json::json!({
            "owner": owner,
            "name": name,
            "merged": format!("repo:{owner}/{name} is:pr is:merged merged:>={since}"),
        }),
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
        .filter_map(|e| {
            e.pull_request
                .map(|pr| (e.state, e.enqueued_at, secs(e.estimated), pr))
        })
        .enumerate()
        .map(|(i, (state, enqueued_at, estimated_secs, pr))| {
            let (author, author_avatar_url) = pr
                .author
                .map(|a| (a.login, a.avatar_url))
                .unwrap_or_default();
            MergeQueueEntry {
                position: i as u32 + 1,
                enqueued_at,
                estimated_secs,
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
        url: queue.url,
        next_estimated_secs: secs(queue.next_estimated),
        merged_last_30_days: data.merged.map(|m| m.issue_count),
        entries,
    }))
}

/// Full detail for one PR: body + merged conversation + changed files (with diffs).
pub async fn pr_detail(token: &str, owner: &str, name: &str, number: u32) -> Result<PrDetail> {
    // The compare call needs the two oids only the conversation query returns, so
    // it is chained to *that* leg rather than run after the join — the file pages,
    // usually the slow half, then cover it instead of extending the wait.
    let (conversation, files) = tokio::join!(
        async {
            let c = pr_conversation(token, owner, name, number).await?;
            // GitHub's PR patches are based on the merge base, not today's
            // base-branch tip. Loading old file contents from `baseRefOid` makes
            // context expansion disagree with every hunk after the base branch
            // advances.
            let base_sha = merge_base_sha(token, owner, name, &c.base_sha, &c.head_sha).await?;
            Ok::<_, anyhow::Error>((c, base_sha))
        },
        pr_files(token, owner, name, number),
    );
    let (c, base_sha) = conversation?;
    let (files, files_truncated) = files?;
    Ok(PrDetail {
        body: c.body,
        attachments: c.attachments,
        labels: c.labels,
        comments: c.comments,
        threads: c.threads,
        files,
        files_truncated,
        commits: c.commits,
        commits_truncated: c.commits_truncated,
        checks: c.checks,
        base_sha,
        head_sha: c.head_sha,
        pending_review_id: c.pending_review_id,
    })
}

/// Merge base behind GitHub's PR file patches. The compare endpoint exposes the
/// exact commit those hunks use; `baseRefOid` is only the moving branch tip.
async fn merge_base_sha(
    token: &str,
    owner: &str,
    name: &str,
    base: &str,
    head: &str,
) -> Result<String> {
    #[derive(Deserialize)]
    struct Compare {
        merge_base_commit: Commit,
    }
    #[derive(Deserialize)]
    struct Commit {
        sha: String,
    }

    let range = format!("{base}...{head}");
    let compare: Compare = get_json(
        api_url(&["repos", owner, name, "compare", &range])?,
        &[],
        token,
    )
    .await?;
    Ok(compare.merge_base_commit.sha)
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
        return Err(rest_error(res).await);
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

// ── Writing a review ─────────────────────────────────────────────────────────
//
// Everything below is driven by an explicit click by the *user*, never by an
// agent: santree's AI review can only write local drafts through its scoped MCP
// server, and its process launches under a GitHub-write deny list. Reviews go out
// under the user's own name, so the user writes them.

/// Which side of the diff a line lives on, in GitHub's spelling. RIGHT is the
/// head/new file, LEFT the base/old one.
fn diff_side(on_right: bool) -> &'static str {
    if on_right {
        "RIGHT"
    } else {
        "LEFT"
    }
}

/// A comment id on its way into a URL path segment. GitHub's ids are decimal, so
/// anything else came from somewhere other than a `PrThread` we handed out — and
/// `api_url` would happily percent-encode it into a request at a different
/// endpoint's expense. Reject rather than encode.
fn safe_comment_id(id: &str) -> Result<&str> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        bail!("'{id}' is not a GitHub comment id");
    }
    Ok(id)
}

/// Post one inline review comment to a PR line, immediately — GitHub's "Add
/// single comment". It lands as a one-comment review the author is notified of.
pub async fn add_review_comment(
    token: &str,
    owner: &str,
    name: &str,
    c: &NewInlineComment,
) -> Result<()> {
    let mut body = serde_json::json!({
        "body": c.body,
        "commit_id": c.head_sha,
        "path": c.path,
        "line": c.line,
        "side": diff_side(c.on_right),
    });
    // Sent only for a range. An explicit `start_line: null` is not the same as
    // omitting it here — GitHub 422s on the former.
    if let Some(start) = c.start_line {
        body["start_line"] = start.into();
        body["start_side"] = diff_side(c.on_right).into();
    }
    rest_post(
        token,
        api_url(&[
            "repos",
            owner,
            name,
            "pulls",
            &c.number.to_string(),
            "comments",
        ])?,
        body,
    )
    .await
}

/// The three facts a batch publish needs about a PR, straight from GitHub: which
/// node to open a review against, which commit the lines are numbered in, and
/// whether the viewer already has an unsubmitted review to add to.
///
/// A small query of its own rather than a slice of [`pr_detail`], which drags the
/// whole conversation and up to 500 files along with it — this runs on a click,
/// right before the comments go out.
pub struct PrPublishAnchor {
    pub pr_id: String,
    pub head_sha: String,
    pub pending_review_id: Option<String>,
}

pub async fn pr_publish_anchor(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
) -> Result<PrPublishAnchor> {
    let query = "query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            id
            headRefOid
            reviews(states: PENDING, first: 1) { nodes { id viewerDidAuthor } }
          }
        }
      }";
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
        id: String,
        #[serde(rename = "headRefOid")]
        head_ref_oid: String,
        reviews: Connection<PendingReview>,
    }
    #[derive(Deserialize)]
    struct PendingReview {
        id: String,
        #[serde(rename = "viewerDidAuthor")]
        viewer_did_author: bool,
    }

    let data: Data = graphql(
        token,
        query,
        serde_json::json!({ "owner": owner, "name": name, "number": number }),
    )
    .await?;
    let pr = data
        .repository
        .and_then(|r| r.pull_request)
        .ok_or_else(|| anyhow!("no pull request {owner}/{name}#{number}"))?;
    Ok(PrPublishAnchor {
        pr_id: pr.id,
        head_sha: pr.head_ref_oid,
        // A pending review that isn't the viewer's own can't be added to (and
        // GitHub never shows someone else's), so it's treated as none.
        pending_review_id: pr
            .reviews
            .nodes
            .into_iter()
            .find(|r| r.viewer_did_author)
            .map(|r| r.id),
    })
}

/// Open a *pending* review on the PR carrying this first draft comment — GitHub's
/// "Start a review". Omitting `event` is what leaves it unsubmitted: the comment
/// is invisible to everyone else until [`submit_review`] runs.
///
/// Returns the new review's node id, which is what lets a batch keep going:
/// everything after the first comment is an [`add_pending_review_comment`] against
/// this id, rather than a second review.
pub async fn start_review(token: &str, c: &NewInlineComment) -> Result<String> {
    let mutation = "mutation($pr: ID!, $oid: GitObjectID!, $path: String!, $line: Int!, $startLine: Int, $side: DiffSide!, $startSide: DiffSide, $body: String!) {
        addPullRequestReview(input: {
          pullRequestId: $pr,
          commitOID: $oid,
          threads: [{ path: $path, line: $line, startLine: $startLine, side: $side, startSide: $startSide, body: $body }]
        }) { pullRequestReview { id } }
      }";
    let out: StartReviewOut = graphql(
        token,
        mutation,
        serde_json::json!({
            "pr": c.pr_id,
            "oid": c.head_sha,
            "path": c.path,
            "line": c.line,
            // Both range ends move together: null for a single-line comment, and
            // the same side as the end otherwise (a range can't straddle sides).
            "startLine": c.start_line,
            "side": diff_side(c.on_right),
            "startSide": c.start_line.map(|_| diff_side(c.on_right)),
            "body": c.body,
        }),
    )
    .await?;
    Ok(out.add_pull_request_review.pull_request_review.id)
}

/// The one field [`start_review`] needs back.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartReviewOut {
    add_pull_request_review: StartedReview,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartedReview {
    pull_request_review: ReviewId,
}

#[derive(Deserialize)]
struct ReviewId {
    id: String,
}

/// Add another draft comment to an already-open pending review.
pub async fn add_pending_review_comment(
    token: &str,
    review_id: &str,
    c: &NewInlineComment,
) -> Result<()> {
    let mutation = "mutation($review: ID!, $path: String!, $line: Int!, $startLine: Int, $side: DiffSide!, $startSide: DiffSide, $body: String!) {
        addPullRequestReviewThread(input: {
          pullRequestReviewId: $review, path: $path, line: $line, startLine: $startLine,
          side: $side, startSide: $startSide, body: $body
        }) { clientMutationId }
      }";
    let _: serde_json::Value = graphql(
        token,
        mutation,
        serde_json::json!({
            "review": review_id,
            "path": c.path,
            "line": c.line,
            "startLine": c.start_line,
            "side": diff_side(c.on_right),
            "startSide": c.start_line.map(|_| diff_side(c.on_right)),
            "body": c.body,
        }),
    )
    .await?;
    Ok(())
}

/// Reply under an existing inline review thread. `reply_to_id` is the thread's
/// first comment ([`PrThread::reply_to_id`]) — GitHub threads replies off the
/// root comment, not off whichever one you were reading.
pub async fn reply_to_review_thread(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
    reply_to_id: &str,
    body: &str,
) -> Result<()> {
    rest_post(
        token,
        api_url(&[
            "repos",
            owner,
            name,
            "pulls",
            &number.to_string(),
            "comments",
            safe_comment_id(reply_to_id)?,
            "replies",
        ])?,
        serde_json::json!({ "body": body }),
    )
    .await
}

/// Mark an inline review thread resolved (or reopen it).
pub async fn set_thread_resolved(token: &str, thread_id: &str, resolved: bool) -> Result<()> {
    let mutation = if resolved {
        "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }"
    } else {
        "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { clientMutationId } }"
    };
    let _: serde_json::Value =
        graphql(token, mutation, serde_json::json!({ "id": thread_id })).await?;
    Ok(())
}

/// Submit the viewer's pending review — its draft comments become visible and the
/// verdict (comment / approve / request changes) lands on the PR.
pub async fn submit_review(
    token: &str,
    review_id: &str,
    event: ReviewEvent,
    body: &str,
) -> Result<()> {
    let mutation = "mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
        submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) { clientMutationId }
      }";
    let event = match event {
        ReviewEvent::Comment => "COMMENT",
        ReviewEvent::Approve => "APPROVE",
        ReviewEvent::RequestChanges => "REQUEST_CHANGES",
    };
    let _: serde_json::Value = graphql(
        token,
        mutation,
        serde_json::json!({
            "review": review_id,
            "event": event,
            // An absent body and an empty one are different to GitHub: `""` fails
            // validation on APPROVE, where "no summary" is the normal case.
            "body": (!body.trim().is_empty()).then_some(body),
        }),
    )
    .await?;
    Ok(())
}

/// Throw away the viewer's pending review and every draft comment in it.
pub async fn discard_review(token: &str, review_id: &str) -> Result<()> {
    let mutation = "mutation($review: ID!) {
        deletePullRequestReview(input: { pullRequestReviewId: $review }) { clientMutationId }
      }";
    let _: serde_json::Value =
        graphql(token, mutation, serde_json::json!({ "review": review_id })).await?;
    Ok(())
}

/// Post a top-level conversation comment (the PR's issue thread, not a diff line).
pub async fn add_issue_comment(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
    body: &str,
) -> Result<()> {
    rest_post(
        token,
        api_url(&[
            "repos",
            owner,
            name,
            "issues",
            &number.to_string(),
            "comments",
        ])?,
        serde_json::json!({ "body": body }),
    )
    .await
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
const COMMENT_FIELDS: &str = "author { __typename login avatarUrl } body bodyHTML createdAt";

/// The same, for a *review* node. Beyond the shared comment shape it carries the
/// three fields that identify the viewer's own unsubmitted review, which is what
/// further draft comments attach to (and what must be kept out of the displayed
/// conversation — a pending review's body is not something anyone has posted yet).
const REVIEW_FIELDS: &str =
    "id state viewerDidAuthor author { __typename login avatarUrl } body bodyHTML createdAt";

/// The same, for a comment *inside* a review thread. `fullDatabaseId` is the id
/// GitHub's REST reply endpoint takes (`databaseId` is a 32-bit `Int` and review
/// comment ids have outgrown it); `state` marks the viewer's own drafts.
const THREAD_COMMENT_FIELDS: &str =
    "fullDatabaseId state author { __typename login avatarUrl } body bodyHTML createdAt";

/// A GraphQL connection's maximum page size.
const GRAPHQL_PAGE: usize = 100;

/// The PR's conversation + commit list + head-commit checks. Every connection here
/// asks for `pageInfo` — each is drained to exhaustion (see [`drain_conversation`]),
/// so this is the first page, not the whole story. `history` is the exception: it
/// stops at one page and reports `hasNextPage` as `commits_truncated`.
///
/// `history` is an **alias** for the same `commits` field the check rollup selects
/// as `commits(last: 1)`. GraphQL rejects two selections of one field with
/// different arguments under the same response key, so the list has to be named
/// apart from the head-commit lookup rather than sharing it.
const PR_CONVERSATION_QUERY: &str = r"
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          body
          bodyHTML
          baseRefOid
          headRefOid
          labels(first: 30) { nodes { name color description } }
          comments(first: 100) { nodes { author { __typename login avatarUrl } body bodyHTML createdAt } pageInfo { hasNextPage endCursor } }
          reviews(first: 100) { nodes { id state viewerDidAuthor author { __typename login avatarUrl } body bodyHTML createdAt } pageInfo { hasNextPage endCursor } }
          reviewThreads(first: 100) {
            nodes {
              id path line startLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve
              comments(first: 100) { nodes { fullDatabaseId state author { __typename login avatarUrl } body bodyHTML createdAt } pageInfo { hasNextPage endCursor } }
            }
            pageInfo { hasNextPage endCursor }
          }
          history: commits(first: 100) {
            nodes { commit { oid abbreviatedOid messageHeadline messageBody committedDate url author { name avatarUrl user { login avatarUrl } } } }
            pageInfo { hasNextPage }
          }
          commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                name status conclusion detailsUrl startedAt completedAt checkSuite { app { name } }
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

/// One inline review thread off a PR — the *anchor* contract.
///
/// At module level, unlike the rest of [`pr_conversation`]'s wire structs, because
/// these fields decide where a comment is drawn: `startLine` and `diffSide` are
/// `Option`s reached only through their renames, so a lost rename doesn't fail —
/// it collapses a multi-line comment to one line and moves an old-side comment
/// onto the new side, i.e. it puts the comment on the wrong line. Being nameable
/// is what lets a test decode the real GitHub shape and catch that.
#[derive(Deserialize)]
struct ReviewThreadNode {
    /// Pages the thread's own replies (see [`drain_thread_comments`]), and is
    /// what resolve/unresolve mutates.
    id: String,
    path: String,
    line: Option<u32>,
    #[serde(rename = "startLine")]
    start_line: Option<u32>,
    #[serde(rename = "diffSide")]
    diff_side: Option<String>,
    #[serde(rename = "isResolved")]
    is_resolved: bool,
    #[serde(rename = "isOutdated")]
    is_outdated: bool,
    #[serde(rename = "viewerCanResolve")]
    viewer_can_resolve: bool,
    #[serde(rename = "viewerCanUnresolve")]
    viewer_can_unresolve: bool,
    comments: Connection<ReviewThreadComment>,
}

/// Which side of the diff a thread is anchored to. GitHub's `diffSide` is `RIGHT`
/// for the new file and `LEFT` for the old; absent defaults to the new side, the
/// common single-line case.
fn thread_on_right(diff_side: Option<&str>) -> bool {
    diff_side != Some("LEFT")
}

/// The host GitHub serves a private repo's attachments from once it has signed
/// the link. Matched by parse at the sink, never by prefix.
const ATTACHMENT_CDN: &str = "private-user-images.githubusercontent.com";

/// Where an attachment's id sits in the markdown GitHub gives us back.
const ATTACHMENT_PATH: &str = "https://github.com/user-attachments/assets/";

/// Pair every attachment a PR's prose points at with a link that will load.
///
/// The markdown carries `https://github.com/user-attachments/assets/<id>`, which
/// on a private repo is served only to a browser session — an API token gets the
/// sign-in page, and an unauthenticated `<img>` gets a 404. GitHub's own
/// rendering of the same text carries pre-signed CDN links, which need no
/// credential, so this reads the ids out of one and the links out of the other.
///
/// The two are matched by the id *appearing in* the signed URL rather than by
/// order or by the CDN's filename shape: GitHub is free to change how it names
/// the object, and a positional match would silently hand a comment the wrong
/// image the first time a render dropped one.
fn attachment_links(markdown: &[&str], html: &[&str]) -> Vec<PrAttachment> {
    let mut ids: Vec<String> = Vec::new();
    for text in markdown {
        for rest in text.split(ATTACHMENT_PATH).skip(1) {
            let id: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    if ids.is_empty() {
        return Vec::new();
    }

    let mut links: Vec<PrAttachment> = Vec::new();
    for text in html {
        for rest in text.split("src=\"").skip(1) {
            let Some(url) = rest.split('"').next() else {
                continue;
            };
            // The signature *is* the credential on these links, so the host is
            // checked by parse before one is handed to the UI — a `src` a PR
            // author wrote themselves must not reach it wearing GitHub's name.
            if reqwest::Url::parse(url)
                .ok()
                .and_then(|u| u.host_str().map(String::from))
                != Some(ATTACHMENT_CDN.to_string())
            {
                continue;
            }
            let decoded = url.replace("&amp;", "&");
            for id in &ids {
                if decoded.contains(id.as_str()) && !links.iter().any(|a| &a.id == id) {
                    links.push(PrAttachment {
                        id: id.clone(),
                        url: decoded.clone(),
                    });
                    break;
                }
            }
        }
    }
    links
}

#[derive(Deserialize)]
struct ReviewThreadComment {
    /// GitHub's `BigInt` scalar — a JSON *string* of digits, not a number.
    /// Kept untyped so a future representation change can't fail the whole
    /// PR's conversation to deserialize over an id only the reply path uses.
    #[serde(rename = "fullDatabaseId")]
    full_database_id: Option<serde_json::Value>,
    /// `PENDING` while it belongs to an unsubmitted review of the viewer's.
    state: Option<String>,
    author: Option<Actor>,
    body: String,
    #[serde(rename = "bodyHTML", default)]
    body_html: String,
    #[serde(rename = "createdAt")]
    created_at: String,
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
               nodes {{ {THREAD_COMMENT_FIELDS} }}
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

/// Everything [`pr_conversation`] reads off one PR — the half of [`PrDetail`] that
/// isn't the changed-file list. A struct rather than a tuple because it has long
/// since outgrown one: seven of these are `String`/`Vec`, and a mis-ordered pair
/// at the call site would still compile.
struct Conversation {
    body: String,
    attachments: Vec<PrAttachment>,
    labels: Vec<PrLabel>,
    comments: Vec<PrComment>,
    threads: Vec<PrThread>,
    commits: Vec<PrCommit>,
    commits_truncated: bool,
    checks: Vec<PrCheck>,
    base_sha: String,
    head_sha: String,
    pending_review_id: Option<String>,
}

/// Body + top-level comments (issue comments and review summaries) merged
/// chronologically, the inline review-comment threads (grouped, with resolution
/// and anchor line/side), the head commit's individual CI checks, and the id of
/// the viewer's own unsubmitted review when they have one.
async fn pr_conversation(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
) -> Result<Conversation> {
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
        #[serde(rename = "bodyHTML", default)]
        body_html: String,
        #[serde(rename = "baseRefOid")]
        base_ref_oid: String,
        #[serde(rename = "headRefOid")]
        head_ref_oid: String,
        labels: Connection<LabelNode>,
        comments: Connection<Comment>,
        reviews: Connection<Review>,
        #[serde(rename = "reviewThreads")]
        review_threads: Connection<ReviewThreadNode>,
        /// The PR's commit list — the query's `history:` alias for `commits`.
        history: Connection<HistoryCommitNode>,
        // Renamed (vs the module-level `CommitNode`) because this one reads the
        // rollup's individual check `contexts`, not the aggregate `state`.
        commits: Connection<DetailCommitNode>,
    }
    #[derive(Deserialize)]
    struct HistoryCommitNode {
        commit: HistoryCommit,
    }
    #[derive(Deserialize)]
    struct HistoryCommit {
        oid: String,
        #[serde(rename = "abbreviatedOid")]
        abbreviated_oid: String,
        #[serde(rename = "messageHeadline")]
        message_headline: String,
        #[serde(rename = "messageBody")]
        message_body: String,
        #[serde(rename = "committedDate")]
        committed_date: String,
        url: String,
        author: Option<GitActor>,
    }
    /// A commit's author. `user` is the GitHub account the commit's email resolves
    /// to and is `None` for a commit authored from an unlinked address — which is
    /// why the git-side `name` is carried too, rather than showing an empty author.
    #[derive(Deserialize)]
    struct GitActor {
        name: Option<String>,
        #[serde(rename = "avatarUrl")]
        avatar_url: Option<String>,
        user: Option<GitActorUser>,
    }
    #[derive(Deserialize)]
    struct GitActorUser {
        login: String,
        #[serde(rename = "avatarUrl")]
        avatar_url: String,
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
            #[serde(rename = "startedAt")]
            started_at: Option<String>,
            #[serde(rename = "completedAt")]
            completed_at: Option<String>,
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
        /// GitHub's own rendering of `body`. Read for its signed attachment
        /// links and then dropped — santree renders the markdown.
        #[serde(rename = "bodyHTML", default)]
        body_html: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    }
    #[derive(Deserialize)]
    struct Review {
        id: String,
        /// `PENDING` for the viewer's own unsubmitted review; `APPROVED` /
        /// `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED` once submitted.
        state: String,
        #[serde(rename = "viewerDidAuthor")]
        viewer_did_author: bool,
        author: Option<Actor>,
        body: String,
        #[serde(rename = "bodyHTML", default)]
        body_html: String,
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
                    name status conclusion detailsUrl startedAt completedAt checkSuite { app { name } }
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
    let reviews_q = conversation_page_query("reviews", REVIEW_FIELDS);
    let threads_q = conversation_page_query(
        "reviewThreads",
        &format!(
            "id path line startLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve \
             comments(first: {GRAPHQL_PAGE}) {{ nodes {{ {THREAD_COMMENT_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }}"
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

    // Every page is in hand, so the prose and GitHub's rendering of it can be
    // read side by side. Done here, before the mapping loops below consume the
    // nodes — and once for the whole conversation, since an attachment posted in
    // a comment is the same asset wherever else it is linked.
    let attachments = {
        let mut markdown: Vec<&str> = vec![pr.body.as_str()];
        let mut html: Vec<&str> = vec![pr.body_html.as_str()];
        for c in &pr.comments.nodes {
            markdown.push(&c.body);
            html.push(&c.body_html);
        }
        for r in &pr.reviews.nodes {
            markdown.push(&r.body);
            html.push(&r.body_html);
        }
        for t in &pr.review_threads.nodes {
            for c in &t.comments.nodes {
                markdown.push(&c.body);
                html.push(&c.body_html);
            }
        }
        attachment_links(&markdown, &html)
    };

    // A deleted author decodes to `None`, and the `unwrap_or_default` reads that as
    // "not a bot" — which is right: an account GitHub has erased was a person often
    // enough that guessing otherwise would be the wrong way to be wrong.
    let actor = |a: Option<Actor>| {
        a.map(|a| {
            let is_bot = a.is_bot();
            (a.login, a.avatar_url, is_bot)
        })
        .unwrap_or_default()
    };
    let mut comments: Vec<PrComment> = Vec::new();
    for c in pr.comments.nodes {
        let (author, author_avatar_url, is_bot) = actor(c.author);
        comments.push(PrComment {
            author,
            author_avatar_url,
            body: c.body,
            created_at: c.created_at,
            kind: CommentKind::Issue,
            path: None,
            is_pending: false,
            is_bot,
        });
    }
    // GitHub allows one unsubmitted review per user, and shows nobody else's — so
    // at most one node can match, and it can only be the viewer's.
    let mut pending_review_id = None;
    for r in pr.reviews.nodes {
        if r.state == "PENDING" {
            if r.viewer_did_author {
                pending_review_id = Some(r.id);
            }
            // Its body is a draft summary nobody has posted; showing it in the
            // conversation would read as a review the author can already see.
            continue;
        }
        // Skip empty-body reviews (bare approvals add no conversation).
        if r.body.trim().is_empty() {
            continue;
        }
        let (author, author_avatar_url, is_bot) = actor(r.author);
        comments.push(PrComment {
            author,
            author_avatar_url,
            body: r.body,
            created_at: r.created_at,
            kind: CommentKind::Review,
            path: None,
            is_pending: false,
            is_bot,
        });
    }
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    // Inline review threads stay grouped (each renders as one collapsible thread
    // anchored in the diff), rather than being flattened into `comments`.
    let mut threads: Vec<PrThread> = Vec::new();
    for t in pr.review_threads.nodes {
        // The first comment is what a reply is posted *under* — GitHub's reply
        // endpoint takes the thread's root, not any comment in it.
        let reply_to_id = t
            .comments
            .nodes
            .first()
            .and_then(|c| c.full_database_id.as_ref())
            .map(bigint_to_string)
            .unwrap_or_default();
        let mut thread_comments: Vec<PrComment> = Vec::new();
        for c in t.comments.nodes {
            let (author, author_avatar_url, is_bot) = actor(c.author);
            thread_comments.push(PrComment {
                author,
                author_avatar_url,
                body: c.body,
                created_at: c.created_at,
                kind: CommentKind::ReviewThread,
                path: Some(t.path.clone()),
                is_pending: c.state.as_deref() == Some("PENDING"),
                is_bot,
            });
        }
        if thread_comments.is_empty() {
            continue;
        }
        threads.push(PrThread {
            id: t.id,
            reply_to_id,
            path: t.path,
            line: t.line,
            start_line: t.start_line,
            on_right: thread_on_right(t.diff_side.as_deref()),
            is_resolved: t.is_resolved,
            is_outdated: t.is_outdated,
            viewer_can_resolve: t.viewer_can_resolve,
            viewer_can_unresolve: t.viewer_can_unresolve,
            comments: thread_comments,
        });
    }

    // `commits(first:)` comes back oldest-first, which is the order the Commits
    // tab lists them in, so nothing is re-sorted here.
    let commits_truncated = pr.history.page_info.has_next_page;
    let commits: Vec<PrCommit> = pr
        .history
        .nodes
        .into_iter()
        .map(|node| {
            let c = node.commit;
            let (login, avatar) = match c.author {
                Some(GitActor { user: Some(u), .. }) => (u.login, u.avatar_url),
                Some(a) => (a.name.unwrap_or_default(), a.avatar_url.unwrap_or_default()),
                None => (String::new(), String::new()),
            };
            PrCommit {
                oid: c.oid,
                abbreviated_oid: c.abbreviated_oid,
                message_headline: c.message_headline,
                message_body: c.message_body,
                author: login,
                author_avatar_url: avatar,
                committed_date: c.committed_date,
                url: c.url,
            }
        })
        .collect();

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
                started_at,
                completed_at,
                check_suite,
                steps,
                annotations,
            } => {
                let st = check_run_status(&status, conclusion.as_deref());
                let job_id = details_url.as_deref().and_then(job_id_from_url);
                let run_id = details_url.as_deref().and_then(run_id_from_url);
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
                    run_id,
                    started_at,
                    completed_at,
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
                    // annotations, job log, or run timings — only GitHub Actions
                    // check runs do.
                    steps: Vec::new(),
                    annotations: Vec::new(),
                    job_id: None,
                    run_id: None,
                    started_at: None,
                    completed_at: None,
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

    Ok(Conversation {
        body: pr.body,
        attachments,
        labels,
        comments,
        threads,
        commits,
        commits_truncated,
        checks,
        base_sha: pr.base_ref_oid,
        head_sha: pr.head_ref_oid,
        pending_review_id,
    })
}

/// GitHub's `BigInt` scalar comes back as a JSON *string* of digits; older
/// integer-valued fields come back as numbers. Render either as the decimal
/// string a REST path segment needs, and anything else as empty (the caller
/// treats that as "no id", never as a usable one).
fn bigint_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Pull the GitHub Actions job id out of a check run's `detailsUrl`
/// (`…/actions/runs/<run>/job/<job_id>`). `None` for non-Actions URLs (e.g. a
/// third-party check's own site), which have no fetchable runner log.
fn job_id_from_url(url: &str) -> Option<f64> {
    id_after(url, "/job/")
}

/// The Actions **workflow run** id from the same `detailsUrl`
/// (`…/actions/runs/<run>/job/<job>`). Shown beside the job id when a check is
/// expanded — the pair is how a run is identified anywhere outside santree.
fn run_id_from_url(url: &str) -> Option<f64> {
    id_after(url, "/runs/")
}

/// The decimal id immediately following `marker` in a details URL. Ids exceed
/// `u32` but are exact in an `f64` (Specta forbids exporting 64-bit ints).
fn id_after(url: &str, marker: &str) -> Option<f64> {
    let tail = url.rsplit_once(marker)?.1;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
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

/// Drain a page-numbered endpoint under [`file_paging`]'s rules: `fetch(page)`
/// returns one page, 1-based, and the driver stops on a short page or at
/// [`PR_FILES_CAP`]. The bool is "there are more we didn't fetch".
///
/// Split from [`pr_files`]'s request so the loop that *decides* that bool is
/// reachable without HTTP: the paging table is well pinned, but nothing else
/// proves the caller ever acts on `Truncated` — a driver that always broke `false`
/// would page forever or under-report, and every existing test would still pass.
async fn collect_pages<T, F, Fut>(fetch: F) -> Result<(Vec<T>, bool)>
where
    F: Fn(usize) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<T>>>,
{
    let mut items: Vec<T> = Vec::new();
    let truncated = loop {
        let page = items.len() / PR_FILES_PER_PAGE + 1;
        let batch = fetch(page).await?;
        let paging = file_paging(items.len() + batch.len(), batch.len());
        items.extend(batch);
        match paging {
            FilePaging::More => {}
            FilePaging::Truncated => break true,
            FilePaging::Done => break false,
        }
    };
    Ok((items, truncated))
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
        previous_filename: Option<String>,
        status: String,
        additions: u32,
        deletions: u32,
        patch: Option<String>,
        /// Blob SHA of the file at the PR's head — drives the "Viewed" mark.
        sha: String,
    }
    let url = api_url(&["repos", owner, name, "pulls", &number.to_string(), "files"])?;
    let per_page = PR_FILES_PER_PAGE.to_string();

    let (files, truncated) = collect_pages(|page| {
        let (url, per_page) = (url.clone(), per_page.clone());
        async move {
            let batch: Vec<RestFile> = get_json(
                url,
                &[("per_page", per_page.as_str()), ("page", &page.to_string())],
                token,
            )
            .await?;
            Ok(batch
                .into_iter()
                .map(|f| PrFile {
                    path: f.filename,
                    previous_path: f.previous_filename,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                    patch: f.patch,
                    sha: f.sha,
                })
                .collect())
        }
    })
    .await?;
    if truncated {
        log::warn!(
            "PR {owner}/{name}#{number} has more than {PR_FILES_CAP} changed files; the diff list is truncated"
        );
    }
    Ok((files, truncated))
}

/// The node fields behind GitHub's own per-viewer "Viewed" marks. Shared by the
/// first-page query and the cursor follow-ups so the two can't drift.
const VIEWED_FILE_FIELDS: &str = "path viewerViewedState";

/// The paths this token's user has marked "Viewed" on the PR — GitHub's own state,
/// the same marks the github.com Files tab shows.
///
/// Only `VIEWED` is kept. GitHub flips a mark to `DISMISSED` when the file changes
/// after being viewed, which is exactly the "re-review whatever actually changed"
/// rule the local store reimplements with blob SHAs — so dropping `DISMISSED` here
/// is what makes the synced and local modes behave identically.
///
/// Note the REST files endpoint (`pr_files`) has no equivalent field; viewed state
/// is GraphQL-only, which is why this is a second request rather than one more
/// column on the file list.
pub async fn pr_viewed_files(
    token: &str,
    owner: &str,
    name: &str,
    number: u32,
) -> Result<Vec<String>> {
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
        files: Connection<ViewedFile>,
    }
    #[derive(Deserialize)]
    struct ViewedFile {
        path: String,
        #[serde(rename = "viewerViewedState")]
        state: String,
    }

    let query = format!(
        "query($owner: String!, $name: String!, $number: Int!) {{
           repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{
             files(first: {GRAPHQL_PAGE}) {{
               nodes {{ {VIEWED_FILE_FIELDS} }}
               pageInfo {{ hasNextPage endCursor }}
             }}
           }} }}
         }}"
    );
    let vars = serde_json::json!({ "owner": owner, "name": name, "number": number });
    let data: Data = graphql(token, &query, vars).await?;
    let Some(mut files) = data
        .repository
        .and_then(|r| r.pull_request)
        .map(|p| p.files)
    else {
        return Ok(vec![]);
    };

    // Bounded by the same [`PR_FILES_CAP`] as the file list itself, not drained to
    // exhaustion like the conversation connections: a mark for a file past the cap
    // belongs to a file the review pane never renders, so paging further would be
    // round-trips spent on rows nothing can display.
    let page_query = conversation_page_query("files", VIEWED_FILE_FIELDS);
    while files.page_info.has_next_page && files.nodes.len() < PR_FILES_CAP {
        let Some(after) = files.page_info.end_cursor.clone() else {
            break;
        };
        let page: PageData<ViewedFile> = graphql(
            token,
            &page_query,
            serde_json::json!({ "owner": owner, "name": name, "number": number, "after": after }),
        )
        .await?;
        let Some(page) = page.repository.and_then(|r| r.pull_request).map(|p| p.page) else {
            break;
        };
        files.nodes.extend(page.nodes);
        files.page_info = page.page_info;
    }

    Ok(files
        .nodes
        .into_iter()
        .filter(|f| f.state == "VIEWED")
        .map(|f| f.path)
        .collect())
}

/// Set (or clear) GitHub's own "Viewed" mark for one PR file, for the token's user.
///
/// `pr_id` is the PR's GraphQL node id — the frontend already holds it as
/// [`ReviewPr::id`], so the mark costs one round-trip instead of a lookup plus a
/// mutation. It reaches GitHub as a JSON *variable*, never spliced into the query
/// text, so an untrusted id can't reshape the document; a bad one is a GraphQL
/// error, which `graphql` surfaces.
pub async fn set_file_viewed(token: &str, pr_id: &str, path: &str, viewed: bool) -> Result<()> {
    let mutation = if viewed {
        "mutation($id: ID!, $path: String!) {
           markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
         }"
    } else {
        "mutation($id: ID!, $path: String!) {
           unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
         }"
    };
    let _: serde_json::Value = graphql(
        token,
        mutation,
        serde_json::json!({ "id": pr_id, "path": path }),
    )
    .await?;
    Ok(())
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
    old_path: &str,
    new_path: &str,
) -> Result<FileSource> {
    let (old_text, new_text) = tokio::join!(
        file_content(token, owner, name, base, old_path),
        file_content(token, owner, name, head, new_path),
    );
    Ok(FileSource {
        old_text: old_text?,
        new_text: new_text?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer() -> ViewerCtx {
        ViewerCtx {
            login: "santiago".into(),
            team_slugs: vec!["agent-knowledge".into()],
        }
    }

    fn requested(at: &str, who: RequestedIdentity) -> ReviewRequestedEvent {
        ReviewRequestedEvent {
            created_at: Some(at.into()),
            requested_reviewer: Some(who),
        }
    }

    #[test]
    fn waiting_since_takes_the_newest_request_naming_the_viewer() {
        // A re-request is a fresh ask — dating the wait from the *original* request
        // would show a week-old age for something that landed an hour ago.
        let events = [
            requested(
                "2026-08-01T10:00:00Z",
                RequestedIdentity::User {
                    login: "santiago".into(),
                },
            ),
            requested(
                "2026-08-05T09:00:00Z",
                RequestedIdentity::User {
                    login: "santiago".into(),
                },
            ),
        ];
        assert_eq!(
            viewer_requested_at(&events, &viewer()).as_deref(),
            Some("2026-08-05T09:00:00Z")
        );
    }

    #[test]
    fn waiting_since_counts_a_request_via_one_of_the_viewers_teams() {
        let events = [requested(
            "2026-08-04T08:00:00Z",
            RequestedIdentity::Team {
                slug: "agent-knowledge".into(),
            },
        )];
        assert_eq!(
            viewer_requested_at(&events, &viewer()).as_deref(),
            Some("2026-08-04T08:00:00Z")
        );
    }

    #[test]
    fn waiting_since_ignores_requests_aimed_at_other_people() {
        // Someone else being (re-)asked must not restart *your* clock — that's the
        // whole failure mode of using the PR's `updatedAt` as a waiting signal.
        let events = [
            requested(
                "2026-08-05T09:00:00Z",
                RequestedIdentity::User {
                    login: "someone-else".into(),
                },
            ),
            requested(
                "2026-08-06T09:00:00Z",
                RequestedIdentity::Team {
                    slug: "platform".into(),
                },
            ),
            requested("2026-08-06T10:00:00Z", RequestedIdentity::Other),
        ];
        assert_eq!(viewer_requested_at(&events, &viewer()), None);
    }

    #[test]
    fn waiting_since_matches_logins_and_slugs_case_insensitively() {
        // GitHub echoes back whatever casing the login/slug was created with.
        let events = [requested(
            "2026-08-04T08:00:00Z",
            RequestedIdentity::User {
                login: "Santiago".into(),
            },
        )];
        assert!(viewer_requested_at(&events, &viewer()).is_some());
    }

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
    /// queries; each still has to scope to the orgs (a bare `author:@me` would pull in
    /// every PR the user has open anywhere) and share the open-PR filters, or a section
    /// would quietly list the wrong PRs.
    #[test]
    fn every_inbox_search_is_org_scoped_and_shares_the_open_pr_filters() {
        let orgs = ["acme".to_string()];
        assert_eq!(
            mine_queries(&orgs),
            ["is:open is:pr archived:false sort:updated-desc author:@me org:acme"]
        );
        // Direct requests only — team-routed requests live in the team sections.
        assert_eq!(
            requested_queries(&orgs),
            ["is:open is:pr archived:false sort:updated-desc user-review-requested:@me org:acme"]
        );
        // The team search is scoped by the `org/slug` handle itself.
        assert_eq!(
            team_query("acme", "core"),
            "is:open is:pr archived:false sort:updated-desc team-review-requested:acme/core"
        );
    }

    /// Several projects under one org must not each buy their own search — and the
    /// orgs that *do* differ ride in one query while they fit, which is the whole
    /// reason a registry-wide inbox costs about what a single-repo one did.
    #[test]
    fn orgs_share_one_query_until_the_length_limit_forces_another() {
        let orgs = ["acme".to_string(), "other".to_string()];
        assert_eq!(
            mine_queries(&orgs),
            ["is:open is:pr archived:false sort:updated-desc author:@me org:acme org:other"]
        );

        // 39 characters is GitHub's longest legal org name; enough of them overflow
        // the limit, and the split has to happen *before* the query is too long to
        // send, not after.
        let many: Vec<String> = (0..8).map(|i| format!("{:0>38}{i}", "org")).collect();
        let batches = mine_queries(&many);
        assert!(batches.len() > 1, "eight max-length orgs need splitting");
        assert!(batches.iter().all(|q| q.len() <= SEARCH_QUERY_LIMIT));
        // Splitting must not lose one: every org still appears exactly once.
        for org in &many {
            let hits = batches.iter().filter(|q| q.contains(org)).count();
            assert_eq!(hits, 1, "{org} appears in {hits} batches");
        }
    }

    /// A single org too long to batch is still asked about. Dropping it would make
    /// a project silently absent from an inbox that claims to span everything.
    #[test]
    fn an_oversized_org_is_still_asked_about_alone() {
        let orgs = ["o".repeat(SEARCH_QUERY_LIMIT)];
        let batches = mine_queries(&orgs);
        assert_eq!(batches.len(), 1);
        assert!(batches[0].ends_with(&orgs[0]));
        assert!(mine_queries(&[]).is_empty());
    }

    /// One org the token can't see, or one rate-limited batch, must not empty an
    /// inbox that spans several — but a *total* failure has to stay an error, since
    /// "everything failed" and "nothing is waiting on you" render identically.
    #[test]
    fn a_failed_batch_keeps_the_ones_that_answered() {
        let queries = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let partial = keep_answered(
            &queries,
            vec![Err(anyhow!("403")), Ok(vec![1, 2]), Ok(vec![3])],
        );
        assert_eq!(partial.unwrap(), vec![1, 2, 3]);

        // A batch that answered with nothing still counts as an answer.
        let quiet = keep_answered(&queries, vec![Err(anyhow!("403")), Ok(vec![]), Ok(vec![7])]);
        assert_eq!(quiet.unwrap(), vec![7]);

        let total: Result<Vec<u8>> = keep_answered(
            &queries[..2],
            vec![Err(anyhow!("403")), Err(anyhow!("rate limited"))],
        );
        assert_eq!(total.unwrap_err().to_string(), "403");

        // Nothing asked is not a failure — a registry with no GitHub origins.
        assert!(keep_answered::<u8>(&[], vec![]).unwrap().is_empty());
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

    /// Drive [`collect_pages`] over pages of the given lengths, recording which
    /// page numbers it actually asked for. A page past the fixture comes back
    /// empty — a short page — so a driver that lost its stop condition ends the
    /// test instead of hanging it.
    async fn pages_of(lens: &[usize]) -> (usize, bool, Vec<usize>) {
        let asked = std::cell::RefCell::new(Vec::new());
        let (items, truncated) = collect_pages(|page| {
            asked.borrow_mut().push(page);
            let len = lens.get(page - 1).copied().unwrap_or(0);
            async move { Ok((0..len).collect::<Vec<usize>>()) }
        })
        .await
        .unwrap();
        (items.len(), truncated, asked.into_inner())
    }

    /// The loop that *consumes* `file_paging`. The table above says what each
    /// verdict means; this is the only thing that proves the caller acts on it — a
    /// driver that never returned `true` would report a 900-file PR as complete,
    /// and a reviewer marking every listed file "Viewed" would be approving a diff
    /// they never saw.
    #[tokio::test]
    async fn collect_pages_stops_at_the_cap_and_reports_the_truncation() {
        let full = PR_FILES_CAP / PR_FILES_PER_PAGE;
        // More full pages exist than the cap allows.
        let (count, truncated, asked) = pages_of(&vec![PR_FILES_PER_PAGE; full + 2]).await;
        assert!(truncated, "landing on the cap must report truncation");
        assert_eq!(count, PR_FILES_CAP);
        // The cap is a stop, not a filter: the page past it is never requested.
        assert_eq!(asked, (1..=full).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn collect_pages_walks_pages_in_order_until_a_short_one() {
        let (count, truncated, asked) = pages_of(&[PR_FILES_PER_PAGE, PR_FILES_PER_PAGE, 40]).await;
        assert!(!truncated, "a short page means GitHub had nothing more");
        assert_eq!(count, PR_FILES_PER_PAGE * 2 + 40);
        assert_eq!(asked, vec![1, 2, 3], "pages are asked for in order, from 1");

        // A single short page is one request, not two.
        assert_eq!(pages_of(&[7]).await, (7, false, vec![1]));
    }

    /// The markdown GitHub hands back for a screenshot in a description. On a
    /// private repo this URL 404s for anyone without a browser session, which is
    /// every `<img>` santree renders.
    const SHOT: &str =
        "![](https://github.com/user-attachments/assets/1fd1135c-83a4-4933-959f-8ec2bb86c04e)";
    /// GitHub's own rendering of it: same asset, a link that needs no credential.
    const SIGNED: &str = "<img src=\"https://private-user-images.githubusercontent.com/5023589/642515346-1fd1135c-83a4-4933-959f-8ec2bb86c04e.png?jwt=abc\">";

    #[test]
    fn attachment_links_pairs_an_asset_with_its_signed_url() {
        let links = attachment_links(&[SHOT], &[SIGNED]);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].id, "1fd1135c-83a4-4933-959f-8ec2bb86c04e");
        assert_eq!(
            reqwest::Url::parse(&links[0].url).unwrap().host_str(),
            Some(ATTACHMENT_CDN)
        );
    }

    /// The pairing is by the id appearing *in* the signed URL, never by order:
    /// GitHub renders in document order today, and a body whose second image
    /// failed to render would otherwise hand image two the link for image one.
    #[test]
    fn attachment_links_matches_by_id_not_by_position() {
        let markdown = "https://github.com/user-attachments/assets/aaa \
             https://github.com/user-attachments/assets/bbb";
        let html = "<img src=\"https://private-user-images.githubusercontent.com/1/9-bbb.png\">";
        let links = attachment_links(&[markdown], &[html]);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].id, "bbb");
        assert!(links[0].url.ends_with("9-bbb.png"));
    }

    /// The signature *is* the credential on these links, so the host is checked
    /// by parse. A PR author who writes their own `<img>` must not be able to
    /// pass a URL off as GitHub's by putting the name in a prefix.
    #[test]
    fn attachment_links_refuses_a_host_that_merely_starts_the_same() {
        let html = "<img src=\"https://private-user-images.githubusercontent.com.evil.test/1/9-1fd1135c-83a4-4933-959f-8ec2bb86c04e.png\">";
        assert!(attachment_links(&[SHOT], &[html]).is_empty());
    }

    /// A body with no attachments never walks the HTML at all — and a PR whose
    /// render dropped an image gets no entry, which the UI shows as its alt text
    /// rather than as a broken icon.
    #[test]
    fn attachment_links_is_empty_without_a_pair() {
        assert!(attachment_links(&["no images here"], &[SIGNED]).is_empty());
        assert!(attachment_links(&[SHOT], &["<p>rendered without the image</p>"]).is_empty());
    }

    /// GitHub escapes the query string's separators in the rendered HTML; the
    /// raw `&amp;` would reach the CDN as part of a parameter name and 403.
    #[test]
    fn attachment_links_unescapes_the_rendered_query_string() {
        let html = "<img src=\"https://private-user-images.githubusercontent.com/1/9-aaa.png?jwt=x&amp;v=2\">";
        let links = attachment_links(&["https://github.com/user-attachments/assets/aaa"], &[html]);
        assert_eq!(
            links[0].url,
            "https://private-user-images.githubusercontent.com/1/9-aaa.png?jwt=x&v=2"
        );
    }

    /// A follow-up page decodes into the same struct as the first one, so the two
    /// selections have to stay identical — and the paged connections have to ask
    /// for the cursor that drives the drain at all.
    #[test]
    fn pr_conversation_selects_the_shared_fields() {
        // Each connection's first page (spelled out in the query) and its
        // follow-up pages (built from these consts) must select the same shape,
        // or a later page decodes into a different struct than the first.
        for fields in [COMMENT_FIELDS, REVIEW_FIELDS, THREAD_COMMENT_FIELDS] {
            assert!(
                PR_CONVERSATION_QUERY.contains(fields),
                "PR_CONVERSATION_QUERY must select `{fields}`"
            );
            // The bot flag is read from the `Actor` interface's concrete type. All
            // four selections carry it or none usefully do — a comment whose page
            // dropped it would silently come back "not a bot".
            assert!(
                fields.contains("author { __typename"),
                "`{fields}` must ask for the author's __typename"
            );
        }
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

    /// The commit list and the check rollup select the *same* `commits` field with
    /// different arguments, which GraphQL only allows under different response
    /// keys. Un-aliasing the list would make the whole query a validation error —
    /// i.e. every PR's detail read fails, not just its Commits tab.
    #[test]
    fn pr_conversation_aliases_the_commit_list_apart_from_the_check_rollup() {
        assert!(
            PR_CONVERSATION_QUERY.contains("history: commits(first: 100)"),
            "the commit list must be aliased, not a second bare `commits` selection"
        );
        assert!(
            PR_CONVERSATION_QUERY.contains("commits(last: 1)"),
            "the check rollup still reads the head commit"
        );
        // Only one unaliased `commits(` selection may exist, or the two collide.
        assert_eq!(
            PR_CONVERSATION_QUERY.matches("commits(").count()
                - PR_CONVERSATION_QUERY.matches("history: commits(").count(),
            1,
            "exactly one `commits` selection goes unaliased"
        );
        // `commits_truncated` is this flag; without it the list silently stops at
        // 100 and a reviewer reads a cut history as the whole one.
        assert!(
            PR_CONVERSATION_QUERY.contains("pageInfo { hasNextPage }"),
            "the commit list must ask whether it was cut short"
        );
    }

    /// `PR_FIELDS` is a bare string, so dropping `state` from it would compile
    /// happily and silently resurrect the always-`Open` placeholder the mapping
    /// used to ship. Word-boundary comparison: a naive `contains("state")` would
    /// be satisfied by `reviewDecision`'s neighbours and prove nothing.
    #[test]
    fn pr_fields_selects_the_state_the_mapping_reads() {
        assert!(
            PR_FIELDS.split_whitespace().any(|field| field == "state"),
            "PR_FIELDS must select `state`, which to_review_pr maps"
        );
    }

    #[test]
    fn pr_state_maps_every_github_value() {
        assert_eq!(pr_state("OPEN"), PrState::Open);
        assert_eq!(pr_state("MERGED"), PrState::Merged);
        assert_eq!(pr_state("CLOSED"), PrState::Closed);
        // Chosen, not stumbled into: an unclassifiable PR reads as live rather
        // than being reported as merged.
        assert_eq!(pr_state("SOMETHING_NEW"), PrState::Open);
    }

    #[test]
    fn single_pr_query_reuses_the_inbox_field_set() {
        let q = single_pr_query();
        assert!(q.contains(PR_FIELDS), "a PR row must be the inbox's shape");
        // Merging the viewer lookup into this document is the design (one
        // round-trip on a panel that opens on every worktree click), not an
        // accident of how it was written.
        assert!(q.contains("viewer { login }"));
        // The identity travels as variables. If this ever becomes a `format!` of
        // owner/name into the query body, that is an injection sink.
        for var in ["$owner: String!", "$name: String!", "$number: Int!"] {
            assert!(q.contains(var), "the query must declare `{var}`");
        }
        assert!(q.contains("pullRequest(number: $number)"));
    }

    /// The bot flag comes from GitHub's own actor type. This pins that it is not
    /// a login-name heuristic, and that the field stays optional — `PR_FIELDS`
    /// decodes into the same `Actor` without selecting `__typename`, so a
    /// required field here would fail the whole Reviews inbox to deserialize.
    #[test]
    fn actor_reads_bot_from_typename_not_the_login() {
        let parse = |json: &str| serde_json::from_str::<Actor>(json).expect("Actor decodes");

        let bot = parse(r#"{"__typename":"Bot","login":"github-actions","avatarUrl":""}"#);
        assert!(bot.is_bot());

        // A person whose login merely looks automated is still a person.
        let human = parse(r#"{"__typename":"User","login":"renovate[bot]","avatarUrl":""}"#);
        assert!(!human.is_bot());

        // A mannequin stands in for a real person during an import.
        let mannequin = parse(r#"{"__typename":"Mannequin","login":"someone","avatarUrl":""}"#);
        assert!(!mannequin.is_bot());

        let no_typename = parse(r#"{"login":"someone","avatarUrl":""}"#);
        assert!(!no_typename.is_bot());
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

    /// A reply's target id becomes a URL path segment, so only digits may reach
    /// it: `api_url` percent-encodes rather than rejects, so `../../user` would
    /// otherwise become a request against a different endpoint.
    #[test]
    fn safe_comment_id_takes_digits_only() {
        assert!(safe_comment_id("2317450981").is_ok());
        assert!(safe_comment_id("").is_err());
        assert!(safe_comment_id("../../user").is_err());
        assert!(safe_comment_id("-1").is_err());
        assert!(safe_comment_id("12a").is_err());
    }

    /// `fullDatabaseId` is a GraphQL `BigInt` — a JSON string. Reading it as a
    /// number would round ids past 2^53 and silently reply to the wrong comment.
    #[test]
    fn bigint_renders_either_json_shape() {
        assert_eq!(
            bigint_to_string(&serde_json::json!("2317450981")),
            "2317450981"
        );
        assert_eq!(bigint_to_string(&serde_json::json!(42)), "42");
        // Anything else is "no id" — never a usable one.
        assert_eq!(bigint_to_string(&serde_json::Value::Null), "");
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

    /// The expanded check row shows the pair — `check #<job>` beside
    /// `workflow #<run>` — so both have to come out of the one details URL.
    #[test]
    fn run_id_parses_from_the_same_actions_url() {
        let url = "https://github.com/o/r/actions/runs/28027969704/job/82960623951";
        assert_eq!(run_id_from_url(url), Some(28027969704.0));
        assert_eq!(run_id_from_url("https://circleci.com/build/123"), None);
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

    /// The `/rate_limit` mapping, against a real (trimmed) payload from
    /// `gh api rate_limit`.
    ///
    /// Two things this pins that nothing else would catch: GitHub's `reset` is
    /// unix **seconds** while Linear's equivalent is milliseconds, and the two
    /// land in the same frontend meter — off by 1000× the countdown reads
    /// "resets in 0m" forever. And only the three pools santree spends are
    /// mapped, so a future GitHub adding a sixteenth resource can't silently
    /// grow the meter.
    #[test]
    fn the_github_rate_limit_maps_three_pools_and_converts_seconds_to_millis() {
        let payload = r#"{
            "resources": {
                "core":    {"limit":5000,"used":18,"remaining":4982,"reset":1787938231},
                "search":  {"limit":30,"used":2,"remaining":28,"reset":1787934691},
                "graphql": {"limit":5000,"used":40,"remaining":4960,"reset":1787938231},
                "scim":    {"limit":15000,"used":0,"remaining":15000,"reset":1787938231}
            },
            "rate": {"limit":5000,"used":18,"remaining":4982,"reset":1787938231}
        }"#;
        let budget = serde_json::from_str::<RateLimitResponse>(payload)
            .expect("the real payload shape")
            .into_budget();

        let kinds: Vec<_> = budget.windows.iter().map(|w| w.kind).collect();
        assert_eq!(
            kinds,
            vec![
                santree_core::domain::ApiBudgetKind::Rest,
                santree_core::domain::ApiBudgetKind::Search,
                santree_core::domain::ApiBudgetKind::GraphQl,
            ],
            "only the pools santree spends, in meter order"
        );
        let rest = &budget.windows[0];
        assert_eq!(rest.remaining, 4982.0);
        assert_eq!(rest.limit, 5000.0);
        assert_eq!(
            rest.resets_at_ms,
            Some(1_787_938_231_000.0),
            "seconds → milliseconds"
        );
        assert_eq!(
            budget.windows[1].limit, 30.0,
            "search is its own small pool"
        );
    }

    // ── The wire shapes (decoded, not built) ─────────────────────────────
    //
    // 73 of the 77 `Deserialize` types in this module were never fed a byte of
    // JSON. These three are the ones where a silently-defaulted field corrupts
    // something the user then acts on, so they are decoded from the exact shape
    // the queries above ask for:
    //
    //   * `PrNode`     — the whole Reviews inbox. Twenty renames; `reviewDecision`
    //                    and `viewerLatestReview` are `Option`s that default to
    //                    "nothing is required / you never reviewed".
    //   * review threads — where a comment is *drawn*. `startLine`/`diffSide`
    //                    default to None, which silently moves a comment.
    //   * `PageData`   — the cursor every `drain_*` loop turns on.
    //
    // Checks and the REST file list are deliberately left out: their wire fields
    // are either snake_case already (`RestFile`) or lose presentation detail
    // (a job link, a duration) rather than a decision.

    /// One `PR_FIELDS` node, exactly as GitHub sends it, through the mapping the
    /// inbox renders.
    ///
    /// Every field below reaches [`PrNode`] through a `#[serde(rename)]`, and the
    /// `Option`s among them fall back rather than fail: drop `reviewDecision`'s
    /// rename and every PR reads as `ReviewDecision::None`; drop
    /// `viewerLatestReview`'s and the inbox forgets you ever reviewed anything;
    /// drop `headRef`/`baseRef`'s and a PR stops binding to its worktree.
    #[test]
    fn a_pr_node_decodes_the_fields_the_inbox_sorts_and_renders_by() {
        let node: PrNode = serde_json::from_str(
            r#"{
              "id": "PR_kwDO", "number": 51, "title": "Make Codex a first-class agent",
              "url": "https://github.com/acme/web/pull/51", "state": "OPEN",
              "isDraft": true, "updatedAt": "2026-08-29T12:00:00Z",
              "createdAt": "2026-08-27T09:00:00Z",
              "headRefName": "santi/codex-first-class", "baseRefName": "main",
              "isInMergeQueue": false,
              "headRef": { "id": "REF_head" },
              "baseRef": { "id": "REF_base" },
              "repository": { "nameWithOwner": "acme/web" },
              "author": { "__typename": "User", "login": "santiago", "avatarUrl": "https://a/1.png" },
              "reviewDecision": "CHANGES_REQUESTED",
              "comments": { "totalCount": 7 },
              "additions": 120, "deletions": 34, "changedFiles": 9,
              "viewerLatestReview": { "state": "APPROVED", "submittedAt": "2026-08-28T10:00:00Z" },
              "commits": { "nodes": [{ "commit": {
                "oid": "deadbee", "committedDate": "2026-08-29T11:00:00Z",
                "statusCheckRollup": { "state": "FAILURE" } } }] },
              "reviewRequests": { "nodes": [
                { "requestedReviewer": { "__typename": "User", "login": "ada", "avatarUrl": "https://a/2.png" } },
                { "requestedReviewer": { "__typename": "Team", "name": "Agent Knowledge" } },
                { "requestedReviewer": { "__typename": "Mannequin", "login": "ghost" } }
              ] },
              "timelineItems": { "nodes": [
                { "createdAt": "2026-08-28T08:00:00Z",
                  "requestedReviewer": { "__typename": "User", "login": "santiago" } }
              ] }
            }"#,
        )
        .expect("a PR_FIELDS node");

        let pr = to_review_pr(node, &viewer());

        assert_eq!(pr.repo, "acme/web");
        assert_eq!(pr.head_ref, "santi/codex-first-class");
        assert_eq!(pr.head_ref_id.as_deref(), Some("REF_head"));
        assert_eq!(pr.base_ref_id.as_deref(), Some("REF_base"));
        assert_eq!(pr.head_sha, "deadbee");
        assert_eq!(pr.head_committed_at, "2026-08-29T11:00:00Z");
        assert_eq!(pr.changed_files, 9);
        assert_eq!(pr.comment_count, 7);
        assert!(pr.is_draft, "a draft PR must not read as ready for review");
        assert_eq!(pr.state, PrState::Open);
        assert_eq!(pr.checks, CheckRollup::Failure);
        assert_eq!(pr.review_decision, ReviewDecision::ChangesRequested);
        // "You already looked at this" — the field the inbox dims a row on.
        let review = pr.viewer_review.as_ref().expect("the viewer's own review");
        assert_eq!(review.state, ViewerReviewState::Approved);
        assert_eq!(review.submitted_at, "2026-08-28T10:00:00Z");
        // The timeline event naming the viewer dates the wait, not `createdAt`.
        assert_eq!(pr.waiting_since, "2026-08-28T08:00:00Z");
        // A user, a team, and a mannequin that is neither.
        let reviewers: Vec<(&str, ReviewerKind)> = pr
            .reviewers
            .iter()
            .map(|r| (r.name.as_str(), r.kind))
            .collect();
        assert_eq!(
            reviewers,
            [
                ("ada", ReviewerKind::User),
                ("Agent Knowledge", ReviewerKind::Team)
            ]
        );
    }

    /// An inline review thread, decoded from the shape the `reviewThreads`
    /// selection asks for.
    ///
    /// CLAUDE.md's rule — never let a comment land on the wrong line — rests on
    /// these four fields. `startLine` and `diffSide` are `Option`s reached only
    /// through their renames, so losing one doesn't fail: a multi-line comment
    /// collapses to its last line, and an old-side comment is drawn on the new
    /// side, against whatever code now occupies that number.
    #[test]
    fn a_review_thread_decodes_the_anchor_the_comment_is_drawn_at() {
        let thread: ReviewThreadNode = serde_json::from_str(
            r#"{
              "id": "PRRT_kwDO", "path": "src-tauri/src/github.rs",
              "line": 480, "startLine": 471, "diffSide": "LEFT",
              "isResolved": false, "isOutdated": true,
              "viewerCanResolve": true, "viewerCanUnresolve": false,
              "comments": { "nodes": [{
                "fullDatabaseId": "2318804429", "state": "PENDING",
                "author": { "__typename": "Bot", "login": "github-actions", "avatarUrl": "" },
                "body": "This drops the guard.", "createdAt": "2026-08-28T09:00:00Z"
              }], "pageInfo": { "hasNextPage": true, "endCursor": "Y3Vyc" } }
            }"#,
        )
        .expect("a reviewThreads node");

        assert_eq!(thread.path, "src-tauri/src/github.rs");
        assert_eq!(thread.line, Some(480));
        assert_eq!(
            thread.start_line,
            Some(471),
            "a multi-line comment must not collapse to its last line"
        );
        assert!(
            !thread_on_right(thread.diff_side.as_deref()),
            "a LEFT-side comment belongs on the old file, not the new one"
        );
        assert!(!thread.is_resolved, "an open thread still needs a human");
        assert!(thread.is_outdated);
        assert!(thread.viewer_can_resolve && !thread.viewer_can_unresolve);

        let comment = &thread.comments.nodes[0];
        // GitHub's BigInt arrives as a string of digits; the reply endpoint needs it.
        assert_eq!(
            bigint_to_string(comment.full_database_id.as_ref().unwrap()),
            "2318804429"
        );
        assert_eq!(comment.state.as_deref(), Some("PENDING"));
        assert!(comment.author.as_ref().expect("author").is_bot());
        assert_eq!(comment.created_at, "2026-08-28T09:00:00Z");
        // The thread's replies page too — `drain_thread_comments` loops on this.
        assert!(thread.comments.page_info.has_next_page);
        assert_eq!(
            thread.comments.page_info.end_cursor.as_deref(),
            Some("Y3Vyc")
        );

        // An absent `diffSide` is the common single-line case: the new side.
        assert!(thread_on_right(None));
        assert!(thread_on_right(Some("RIGHT")));
    }

    /// The follow-up page every `drain_*` loop decodes. Its cursor is the only
    /// thing that stops a long PR being read off its first hundred nodes — the
    /// failure `drain_conversation`'s own comment names: a PR that looks fully
    /// resolved while an unresolved thread sits past the cut.
    #[test]
    fn a_conversation_page_decodes_the_cursor_that_drains_it() {
        let page: PageData<ReviewThreadNode> = serde_json::from_str(
            r#"{"data_ignored":1,"repository":{"pullRequest":{"page":{
                 "nodes": [{
                   "id": "PRRT_2", "path": "a.rs", "line": 3, "startLine": null,
                   "diffSide": "RIGHT", "isResolved": false, "isOutdated": false,
                   "viewerCanResolve": true, "viewerCanUnresolve": false,
                   "comments": { "nodes": [] } }],
                 "pageInfo": { "hasNextPage": true, "endCursor": "cursor-2" }}}}}"#,
        )
        .expect("a conversation page");

        let conn = page
            .repository
            .and_then(|r| r.pull_request)
            .map(|p| p.page)
            .expect("the aliased `page` connection");
        assert_eq!(conn.nodes.len(), 1);
        assert!(conn.page_info.has_next_page, "the drain must keep going");
        assert_eq!(conn.page_info.end_cursor.as_deref(), Some("cursor-2"));

        // A PR whose id names nothing decodes to "stop", not to a failure.
        let empty: PageData<ReviewThreadNode> =
            serde_json::from_str(r#"{"repository":{"pullRequest":null}}"#).unwrap();
        assert!(empty.repository.expect("repository").pull_request.is_none());
    }

    /// A pool GitHub omits is absent, not zero. A zero-remaining row reads as
    /// "you are out of budget", which is the opposite of "we didn't hear".
    #[test]
    fn a_missing_pool_is_left_out_rather_than_reported_as_empty() {
        let budget = serde_json::from_str::<RateLimitResponse>(
            r#"{"resources":{"core":{"limit":5000,"used":0,"remaining":5000,"reset":1}}}"#,
        )
        .expect("a payload with one pool")
        .into_budget();
        assert_eq!(budget.windows.len(), 1);
        assert_eq!(
            budget.windows[0].kind,
            santree_core::domain::ApiBudgetKind::Rest
        );
    }
}
