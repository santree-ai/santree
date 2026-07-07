//! Linear integration: multi-org token store (SQLite), OAuth PKCE connect flow,
//! and the GraphQL fetch that turns assigned issues into a positioned dependency
//! graph. Tokens and repo↔org links live in the app database; pure mapping and
//! layout live in `santree_core`.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use futures::future::join_all;
use futures::StreamExt;
use rand::RngCore;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use santree_core::domain::{
    LinearOrg, LinearStatus, Task, TaskStatus, TriageComment, TriageDetail, TriageSchedule,
    TriageShift, TriageTicket, WorkflowState,
};
use santree_core::{layout, linear as core_linear};

use crate::db::{now_ms, Db};
use crate::gql::{self, Connection};
use crate::settings;

const CLIENT_ID: &str = "4be2738749371d7d3401061aabe2d11b";
const AUTHORIZE_URL: &str = "https://linear.app/oauth/authorize";
const TOKEN_URL: &str = "https://api.linear.app/oauth/token";
const GRAPHQL_URL: &str = "https://api.linear.app/graphql";
const OAUTH_PORT: u16 = 8420;
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

// ── Org token store (SQLite) ──────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct OrgRow {
    slug: String,
    name: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

/// Every connected org (slug + display name).
pub async fn list_orgs(db: &Db) -> Result<Vec<LinearOrg>> {
    let rows =
        sqlx::query_as::<_, (String, String)>("SELECT slug, name FROM linear_orgs ORDER BY name")
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(slug, name)| LinearOrg { slug, name })
        .collect())
}

async fn org_row(db: &Db, slug: &str) -> Result<Option<OrgRow>> {
    Ok(
        sqlx::query_as::<_, OrgRow>("SELECT * FROM linear_orgs WHERE slug = ?")
            .bind(slug)
            .fetch_optional(db)
            .await?,
    )
}

async fn upsert_org(db: &Db, org: &OrgRow) -> Result<()> {
    sqlx::query(
        "INSERT INTO linear_orgs (slug, name, access_token, refresh_token, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at",
    )
    .bind(&org.slug)
    .bind(&org.name)
    .bind(&org.access_token)
    .bind(&org.refresh_token)
    .bind(org.expires_at)
    .execute(db)
    .await?;
    Ok(())
}

/// The org slug a repo should use: its explicit link, else the first connected org.
async fn resolve_org_slug(db: &Db, repo: &str) -> Result<Option<String>> {
    let linked: Option<Option<String>> =
        sqlx::query_scalar("SELECT linear_org_slug FROM repos WHERE name = ?")
            .bind(repo)
            .fetch_optional(db)
            .await?;
    if let Some(Some(slug)) = linked {
        return Ok(Some(slug));
    }
    Ok(
        sqlx::query_scalar("SELECT slug FROM linear_orgs ORDER BY name LIMIT 1")
            .fetch_optional(db)
            .await?,
    )
}

/// Bind (or clear, with `None`) the Linear org a repo uses. Updates the existing
/// repo row only — binding an org for an unregistered repo used to INSERT a
/// half-populated row (NULL path/tracker) that showed up as a phantom repo.
pub async fn set_repo_org(db: &Db, repo: &str, slug: Option<String>) -> Result<()> {
    let affected = sqlx::query("UPDATE repos SET linear_org_slug = ? WHERE name = ?")
        .bind(slug)
        .bind(repo)
        .execute(db)
        .await?
        .rows_affected();
    if affected == 0 {
        bail!("repo '{repo}' is not registered");
    }
    Ok(())
}

// ── Token refresh ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

/// Per-org locks serializing token refresh. Linear rotates the refresh token on
/// each use, so two commands refreshing the same org concurrently (Issues +
/// Triage both load on startup) would race: the second sends an already-consumed
/// token and fails — or both persist, last-writer-wins. We single-flight per slug.
static REFRESH_LOCKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(Default::default);

fn refresh_lock(slug: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    // Poison-tolerant (matching the pty/openers/settings locks): the map holds
    // only Arcs, so a thread that panicked mid-access left it structurally sound.
    REFRESH_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(slug.to_string())
        .or_default()
        .clone()
}

/// A valid access token for `slug`, refreshing + persisting if near expiry.
async fn valid_token(db: &Db, slug: &str) -> Result<String> {
    let row = org_row(db, slug)
        .await?
        .ok_or_else(|| anyhow!("org {slug} not connected"))?;
    if now_ms() < row.expires_at - REFRESH_SKEW_MS {
        return Ok(row.access_token);
    }

    // Near expiry: serialize the refresh per org, then re-read — another caller
    // may have refreshed while we waited, so we'd reuse its fresh token.
    let lock = refresh_lock(slug);
    let _guard = lock.lock().await;
    let row = org_row(db, slug)
        .await?
        .ok_or_else(|| anyhow!("org {slug} not connected"))?;
    if now_ms() < row.expires_at - REFRESH_SKEW_MS {
        return Ok(row.access_token);
    }

    let res = gql::client()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", row.refresh_token.as_str()),
        ])
        .send()
        .await
        .context("refresh request")?;
    if !res.status().is_success() {
        bail!("token refresh failed: {}", res.status());
    }
    let body: TokenResponse = res.json().await?;
    let updated = OrgRow {
        slug: row.slug,
        name: row.name,
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: now_ms() + body.expires_in * 1000,
    };
    upsert_org(db, &updated).await?;
    Ok(updated.access_token)
}

// ── GraphQL fetch ────────────────────────────────────────────────────────

// NOTE: Linear caps query complexity at 10000. This query sits near that ceiling
// — `assignedIssues(first: 100)` × `inverseRelations(first: N)` × the per-issue
// fields (incl. `assignee`) is the dominant cost. `first: 12` on the relations
// keeps it under the limit *with* assignee on both levels; raising either count,
// or adding fields, can push it over (the API then 400s and the graph goes empty).
const ASSIGNED_ISSUES_QUERY: &str = r#"
query AssignedIssues {
  viewer {
    assignedIssues(
      filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }
      orderBy: updatedAt
      first: 100
    ) {
      nodes {
        identifier
        title
        state { name type }
        project { name color icon }
        assignee { name displayName avatarUrl }
        inverseRelations(first: 12) {
          nodes {
            type
            issue { identifier title state { name type } project { name color icon } assignee { name displayName avatarUrl } }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}
"#;

#[derive(Deserialize)]
struct StateNode {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    type_: String,
}
impl Default for StateNode {
    /// An issue that arrived without a state is treated as an unstarted "Unknown".
    fn default() -> Self {
        Self {
            id: None,
            name: "Unknown".into(),
            type_: "unstarted".into(),
        }
    }
}

#[derive(Deserialize)]
struct RelatedIssue {
    identifier: String,
    #[serde(default)]
    title: String,
    state: Option<StateNode>,
    #[serde(default)]
    project: Option<ProjectNode>,
    #[serde(default)]
    assignee: Option<UserNode>,
}

#[derive(Deserialize)]
struct RelationNode {
    #[serde(default, rename = "type")]
    type_: String,
    /// The issue on the *other* side of an inverse relation (this issue's blocker).
    #[serde(default)]
    issue: Option<RelatedIssue>,
}

#[derive(Deserialize)]
struct ProjectNode {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    icon: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueNode {
    identifier: String,
    title: String,
    state: Option<StateNode>,
    project: Option<ProjectNode>,
    #[serde(default)]
    assignee: Option<UserNode>,
    #[serde(default)]
    inverse_relations: Connection<RelationNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Viewer {
    assigned_issues: Connection<IssueNode>,
}
#[derive(Deserialize)]
struct QueryData {
    viewer: Viewer,
}

const TERMINAL_STATES: [&str; 3] = ["completed", "canceled", "duplicate"];

/// An assignee's `(name, avatar_url)` for a Task — the full name (falling back to
/// the @handle), and the avatar URL. `(None, None)` when unassigned.
fn assignee_fields(u: Option<UserNode>) -> (Option<String>, Option<String>) {
    match u {
        Some(u) => {
            let name = u
                .name
                .filter(|s| !s.is_empty())
                .or(u.display_name.filter(|s| !s.is_empty()));
            (name, u.avatar_url)
        }
        None => (None, None),
    }
}

/// A project's `(name, color, icon)` for a Task, defaulting the name when unset.
fn project_fields(p: Option<ProjectNode>) -> (String, Option<String>, Option<String>) {
    match p {
        Some(p) => (
            p.name.unwrap_or_else(|| "No Project".into()),
            p.color,
            p.icon,
        ),
        None => ("No Project".into(), None, None),
    }
}

/// Map an assigned issue to an actionable Task, returning its blocker issues so
/// the caller can pull any that aren't themselves assigned into the graph as
/// grayed context nodes.
fn map_issue(node: IssueNode) -> (Task, Vec<RelatedIssue>) {
    let state = node.state.unwrap_or_default();
    let status: TaskStatus = core_linear::map_status(&state.name, &state.type_);

    // `inverseRelations` of type "blocks" point *at* this issue → its blockers.
    let mut blocked_by = Vec::new();
    let mut done_flags = Vec::new();
    let mut blockers = Vec::new();
    for rel in node.inverse_relations.nodes {
        if rel.type_ != "blocks" {
            continue;
        }
        if let Some(issue) = rel.issue {
            let state_type = issue
                .state
                .as_ref()
                .map(|s| s.type_.as_str())
                .unwrap_or_default();
            done_flags.push(TERMINAL_STATES.contains(&state_type));
            blocked_by.push(issue.identifier.clone());
            blockers.push(issue);
        }
    }

    let (project, project_color, project_icon) = project_fields(node.project);
    let (assignee, assignee_avatar_url) = assignee_fields(node.assignee);
    let task = Task {
        id: node.identifier,
        title: node.title,
        project,
        project_color,
        project_icon,
        status,
        // Ready only when all blockers are done *and* the work hasn't started
        // yet — an In Progress / In Review ticket is never "ready to start".
        ready: core_linear::is_ready(&done_flags) && status.is_startable(),
        blocked_by,
        actionable: true,
        assignee,
        assignee_avatar_url,
        x: 0,
        y: 0,
    };
    (task, blockers)
}

/// A blocker that isn't one of the viewer's assigned issues, mapped to a grayed,
/// non-actionable context node (no children — we don't recurse).
fn map_related(issue: RelatedIssue) -> Task {
    let state = issue.state.unwrap_or_default();
    let (project, project_color, project_icon) = project_fields(issue.project);
    let (assignee, assignee_avatar_url) = assignee_fields(issue.assignee);
    Task {
        id: issue.identifier,
        title: issue.title,
        project,
        project_color,
        project_icon,
        status: core_linear::map_status(&state.name, &state.type_),
        ready: false,
        blocked_by: vec![],
        actionable: false,
        assignee,
        assignee_avatar_url,
        x: 0,
        y: 0,
    }
}

/// Fetch the assigned issues for `repo`'s org and lay them out as a graph, or
/// `None` when no org is connected. Returning `None` instead of erroring lets a
/// not-yet-connected repo show an empty graph rather than an error state.
pub async fn list_issues(db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
    let Some(token) = repo_token(db, repo).await? else {
        return Ok(None);
    };
    let data: QueryData = graphql(&token, ASSIGNED_ISSUES_QUERY, serde_json::json!({})).await?;
    // Looping past the first page would multiply this query's cost, and it's
    // already near Linear's ~10000 complexity ceiling (see the NOTE above) — so a
    // >100-issue backlog is truncated rather than risking a 400. Warn instead of
    // silently dropping the rest.
    if data.viewer.assigned_issues.page_info.has_next_page {
        log::warn!(
            "assignedIssues truncated at 100 for repo {repo}: more assigned issues exist but \
             weren't fetched (looping risks exceeding Linear's query complexity cap)"
        );
    }
    let nodes = data.viewer.assigned_issues.nodes;

    let assigned: std::collections::HashSet<String> =
        nodes.iter().map(|n| n.identifier.clone()).collect();

    // Map assigned issues (actionable) and collect every blocker they reference.
    let mut tasks: Vec<Task> = Vec::with_capacity(nodes.len());
    // BTreeMap (not HashMap) so blockers drain in a stable identifier order —
    // HashMap's random iteration order shuffled graph node positions between fetches.
    let mut blockers: std::collections::BTreeMap<String, RelatedIssue> =
        std::collections::BTreeMap::new();
    for node in nodes {
        let (task, refs) = map_issue(node);
        for r in refs {
            if !assigned.contains(&r.identifier) {
                blockers.entry(r.identifier.clone()).or_insert(r);
            }
        }
        tasks.push(task);
    }

    // Pull any blockers that aren't the viewer's own work into the graph as
    // grayed, non-actionable context nodes (so every "blocked by" has a node).
    for (_, issue) in blockers {
        tasks.push(map_related(issue));
    }

    layout::layout_tasks(&mut tasks);
    Ok(Some(tasks))
}

/// Connection status for a repo: whether any org is connected, and which one this repo uses.
pub async fn auth_status(db: &Db, repo: &str) -> Result<LinearStatus> {
    let orgs = list_orgs(db).await?;
    let slug = resolve_org_slug(db, repo).await?;
    let org = slug
        .as_ref()
        .and_then(|s| orgs.iter().find(|o| &o.slug == s).map(|o| o.name.clone()));
    Ok(LinearStatus {
        authenticated: !orgs.is_empty(),
        org_slug: slug,
        org,
    })
}

// ── Triage (live) ────────────────────────────────────────────────────────
// The triage queue is the viewer's assigned issues that sit in a `triage`
// workflow state (mirrors the santree CLI). Detail pulls the single issue with
// its description + comments; inline Linear-CDN images are downloaded with the
// access token and embedded as data URIs so the webview can render them.

/// A valid access token for the org this repo uses, or `None` when no org is
/// connected. Returning `None` (rather than erroring) lets each live command
/// resolve the org exactly once and return an empty result when not connected.
async fn repo_token(db: &Db, repo: &str) -> Result<Option<String>> {
    let Some(slug) = resolve_org_slug(db, repo).await? else {
        return Ok(None);
    };
    valid_token(db, &slug).await.map(Some)
}

/// POST a GraphQL query and return the typed `data` payload.
async fn graphql<T: DeserializeOwned>(
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<T> {
    let req = gql::client()
        .post(GRAPHQL_URL)
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": query, "variables": variables }));
    crate::gql::post(req, "Linear").await
}

#[derive(Deserialize)]
struct LabelName {
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserNode {
    #[serde(default)]
    id: Option<String>,
    /// Full name ("Felipe Perdomo").
    #[serde(default)]
    name: Option<String>,
    /// The @handle ("felipeperdomo").
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

/// How a user's name is rendered — mirrors Linear's "Display names" preference.
#[derive(Clone, Copy, PartialEq)]
enum NameStyle {
    Full,
    Username,
}

/// Read the global display-names preference (defaults to full name).
async fn name_style(db: &Db) -> NameStyle {
    match settings::get(db, "app", "display_names").await {
        Ok(Some(v)) if v == "username" => NameStyle::Username,
        _ => NameStyle::Full,
    }
}

/// Choose a user's label from (full name, @handle) per the preference, falling
/// back to whichever is present when the preferred one is missing.
fn pick_name(
    name: Option<String>,
    display_name: Option<String>,
    style: NameStyle,
) -> Option<String> {
    let name = name.filter(|s| !s.is_empty());
    let display_name = display_name.filter(|s| !s.is_empty());
    match style {
        NameStyle::Full => name.or(display_name),
        NameStyle::Username => display_name.or(name),
    }
}
/// A non-human comment author (integration / Linear system actor).
#[derive(Deserialize)]
struct BotActor {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "avatarUrl")]
    avatar_url: Option<String>,
}

/// Resolve a comment/issue actor to `(display name, avatar url)`, preferring the
/// human user, then a bot actor.
fn actor(
    user: Option<UserNode>,
    bot: Option<BotActor>,
    style: NameStyle,
) -> (String, Option<String>) {
    if let Some(u) = user {
        let name = pick_name(u.name, u.display_name, style).unwrap_or_else(|| "Unknown".into());
        return (name, u.avatar_url);
    }
    if let Some(b) = bot {
        return (b.name.unwrap_or_else(|| "Unknown".into()), b.avatar_url);
    }
    ("Unknown".into(), None)
}

// The triage queue is the on-call inbox for the teams the viewer belongs to that
// run a triage rotation — issues in a `triage` workflow state, regardless of
// assignee (most triage items are unassigned until someone picks them up). We
// scope to *rotation* teams only: a team without a triage rotation has no on-call
// owner, so its triage state isn't anyone's responsibility and would just be
// noise here. This mirrors the schedule strips (build via `triage_schedule`), so
// the teams shown there are exactly the teams whose issues land in this queue.

/// The signed-in user's id (for "mine") and the keys of their *rotation* teams
/// (teams whose triage responsibility is backed by a non-empty time schedule) —
/// both hang off the same `viewer` root, in one round-trip for the common case
/// (`fetch_all_team_memberships` only loops past that if a user is in >100
/// teams). Non-rotation teams are dropped so the queue stays scoped to actual
/// on-call inboxes. Reuses [`TRIAGE_SCHEDULES_QUERY`] / [`SchedQueryData`] (a
/// superset of what's needed
/// here) so there's a single source of truth for the `teamMemberships` shape.
async fn viewer_triage_scope(token: &str) -> Result<(Option<String>, Vec<String>)> {
    let data = fetch_all_team_memberships(token).await?;
    let Some(viewer) = data.viewer else {
        return Ok((None, Vec::new()));
    };
    let keys = viewer
        .team_memberships
        .map(|c| c.nodes)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.team)
        .filter(is_rotation_team)
        .map(|t| t.key)
        .collect();
    Ok((viewer.id, keys))
}

const TRIAGE_INBOX_QUERY: &str = r#"
query TriageInbox($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 100, after: $after) {
    nodes {
      identifier title priority createdAt slaBreachesAt snoozedUntilAt
      state { name type }
      team { key }
      assignee { id name displayName }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"#;

#[derive(Deserialize)]
struct TeamKeyNode {
    key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriageRow {
    identifier: String,
    title: String,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    sla_breaches_at: Option<String>,
    #[serde(default)]
    snoozed_until_at: Option<String>,
    #[serde(default)]
    team: Option<TeamKeyNode>,
    #[serde(default)]
    assignee: Option<UserNode>,
    #[serde(default)]
    labels: Connection<LabelName>,
}
#[derive(Deserialize)]
struct TriageInboxData {
    issues: Connection<TriageRow>,
}

/// The triage inbox for a repo's workspace, scoped to the viewer's teams.
/// Active issues first, snoozed sunk to the bottom (by SLA breach time within).
pub async fn triage_tickets(db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>> {
    let Some(token) = repo_token(db, repo).await? else {
        return Ok(None);
    };
    // The viewer (for "mine") and their *rotation* teams (to scope the inbox) come
    // from one query. Propagate a failure here rather than swallowing it into an
    // empty scope — that used to render a transient network/auth error as the
    // positive "All caught up" empty state. A genuinely empty scope (no rotation
    // team configured) still comes back as `Ok((_, vec![]))` below and is the only
    // legitimate empty-inbox path.
    let (me, keys) = viewer_triage_scope(&token).await?;
    // No rotation team → no on-call inbox. Show an empty queue rather than
    // flooding the list with the whole workspace's (un-owned) triage issues.
    if keys.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let filter = serde_json::json!({
        "state": { "type": { "eq": "triage" } },
        "team": { "key": { "in": keys } },
    });
    // A busy org's triage inbox can exceed one page; this filtered query is cheap
    // relative to the complexity budget (unlike assignedIssues), so loop the
    // cursor rather than silently truncating at 100.
    let mut nodes: Vec<TriageRow> = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let data: TriageInboxData = graphql(
            &token,
            TRIAGE_INBOX_QUERY,
            serde_json::json!({ "filter": filter, "after": after }),
        )
        .await?;
        let page_info = data.issues.page_info;
        nodes.extend(data.issues.nodes);
        if !page_info.has_next_page {
            break;
        }
        let Some(cursor) = page_info.end_cursor else {
            break;
        };
        after = Some(cursor);
    }
    let now = now_ms();
    let style = name_style(db).await;

    let mut rows: Vec<(TriageTicket, bool, i64)> = nodes
        .into_iter()
        .map(|r| {
            let snooze_ms = r.snoozed_until_at.as_deref().and_then(parse_ms);
            let snoozed = core_linear::is_snoozed(snooze_ms, now);
            let sla_ms = r.sla_breaches_at.as_deref().and_then(parse_ms);
            let labels: Vec<String> = r.labels.nodes.into_iter().map(|l| l.name).collect();
            let team = r.team.map(|t| t.key);
            let assignee_user = r.assignee;
            let mine = match (
                me.as_deref(),
                assignee_user.as_ref().and_then(|u| u.id.as_deref()),
            ) {
                (Some(me), Some(a)) => me == a,
                _ => false,
            };
            let assignee = assignee_user.and_then(|u| pick_name(u.name, u.display_name, style));
            // Specta forbids exporting i64 (BigInt precision-loss risk), so the raw
            // millisecond timestamps cross the bridge as f64 — exact for epoch-ms
            // values for millennia to come.
            let created_at_ms = r
                .created_at
                .as_deref()
                .and_then(parse_ms)
                .map(|v| v as f64)
                .unwrap_or_default();
            let ticket = TriageTicket {
                id: r.identifier,
                title: r.title,
                priority: core_linear::map_priority(r.priority),
                created_at_ms,
                meta: triage_meta(assignee.as_deref(), &labels),
                team,
                sla_breach_ms: sla_ms.map(|v| v as f64),
                snoozed_until_ms: snoozed.then_some(snooze_ms).flatten().map(|v| v as f64),
                mine,
            };
            (ticket, snoozed, sla_ms.unwrap_or(i64::MAX))
        })
        .collect();

    // Active first, snoozed last; within each, soonest SLA breach first.
    rows.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)));
    Ok(Some(rows.into_iter().map(|(t, _, _)| t).collect()))
}

/// One-line meta: assignee (or "unassigned") · first label. The team is carried
/// separately on the ticket so the queue can group by it.
fn triage_meta(assignee: Option<&str>, labels: &[String]) -> String {
    let mut parts: Vec<String> = vec![assignee.unwrap_or("unassigned").to_string()];
    if let Some(l) = labels.first() {
        parts.push(l.clone());
    }
    parts.join(" · ")
}

const ISSUE_DETAIL_QUERY: &str = r#"
query GetIssue($id: String!) {
  issue(id: $id) {
    identifier title description url priority createdAt slaBreachesAt snoozedUntilAt
    state { id name type }
    team { states(first: 50) { nodes { id name type color position } } }
    labels { nodes { name } }
    project { name }
    creator { name displayName avatarUrl }
    comments(first: 100) {
      nodes {
        id body createdAt parent { id }
        user { name displayName avatarUrl }
        botActor { name avatarUrl }
        children {
          nodes {
            id body createdAt
            user { name displayName avatarUrl }
            botActor { name avatarUrl }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

/// Follow-up page of a single issue's top-level comments, keyed by cursor. Kept
/// separate from [`ISSUE_DETAIL_QUERY`] so paginating a chatty thread doesn't
/// re-fetch the description/labels/team states on every page.
const ISSUE_COMMENTS_PAGE_QUERY: &str = r#"
query GetIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes {
        id body createdAt parent { id }
        user { name displayName avatarUrl }
        botActor { name avatarUrl }
        children {
          nodes {
            id body createdAt
            user { name displayName avatarUrl }
            botActor { name avatarUrl }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

/// A comment's parent reference. Its presence is all we use (to drop replies from
/// the top-level list), so the body is intentionally empty — the queried `id` is
/// ignored on deserialization.
#[derive(Deserialize)]
struct ParentRef {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
    #[serde(default)]
    id: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    parent: Option<ParentRef>,
    #[serde(default)]
    user: Option<UserNode>,
    #[serde(default)]
    bot_actor: Option<BotActor>,
    #[serde(default)]
    children: Option<Connection<CommentNode>>,
}
/// One of a team's workflow states (for the status picker).
#[derive(Deserialize, Default)]
struct WorkflowStateNode {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    type_: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    position: f64,
}
#[derive(Deserialize, Default)]
struct TeamStates {
    #[serde(default)]
    states: Connection<WorkflowStateNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueDetailNode {
    identifier: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    url: String,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    sla_breaches_at: Option<String>,
    #[serde(default)]
    snoozed_until_at: Option<String>,
    state: Option<StateNode>,
    #[serde(default)]
    team: Option<TeamStates>,
    #[serde(default)]
    labels: Connection<LabelName>,
    project: Option<ProjectNode>,
    #[serde(default)]
    creator: Option<UserNode>,
    #[serde(default)]
    comments: Connection<CommentNode>,
}
#[derive(Deserialize)]
struct IssueDetailData {
    issue: Option<IssueDetailNode>,
}

#[derive(Deserialize)]
struct IssueCommentsPage {
    comments: Connection<CommentNode>,
}
#[derive(Deserialize)]
struct IssueCommentsPageData {
    issue: Option<IssueCommentsPage>,
}

/// Map one comment (and its one level of threaded replies) into the domain
/// type, downloading inline images in each body.
async fn map_comment(
    client: &reqwest::Client,
    node: CommentNode,
    token: &str,
    style: NameStyle,
) -> TriageComment {
    let mut child_nodes = node.children.map(|c| c.nodes).unwrap_or_default();
    child_nodes.sort_by_key(|c| c.created_at.as_deref().and_then(parse_ms).unwrap_or(0));
    // Inline each reply's images concurrently; join_all preserves order. Resolve
    // the timestamp up front so the per-reply futures don't borrow `ch`.
    let children = join_all(child_nodes.into_iter().map(|ch| {
        let created_at_ms = ch
            .created_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64)
            .unwrap_or_default();
        async move {
            let (author, avatar_url) = actor(ch.user, ch.bot_actor, style);
            TriageComment {
                id: ch.id,
                author,
                avatar_url,
                created_at_ms,
                body: inline_images(client, &ch.body, token).await,
                children: vec![],
            }
        }
    }))
    .await;

    let (author, avatar_url) = actor(node.user, node.bot_actor, style);
    TriageComment {
        id: node.id,
        author,
        avatar_url,
        created_at_ms: node
            .created_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64)
            .unwrap_or_default(),
        body: inline_images(client, &node.body, token).await,
        children,
    }
}

/// The full triage issue (description + comments) for the discussion pane, with
/// inline Linear-CDN images downloaded and embedded as data URIs.
pub async fn triage_detail(db: &Db, repo: &str, ticket_id: &str) -> Result<Option<TriageDetail>> {
    let Some(token) = repo_token(db, repo).await? else {
        return Ok(None);
    };
    let data: IssueDetailData = graphql(
        &token,
        ISSUE_DETAIL_QUERY,
        serde_json::json!({ "id": ticket_id }),
    )
    .await?;
    let mut issue = data
        .issue
        .ok_or_else(|| anyhow!("issue {ticket_id} not found"))?;

    // A long-running thread can exceed one page of comments — pull the rest via
    // cursor. Comments are cheap relative to the complexity budget (unlike
    // assignedIssues), so looping here is safe.
    let mut cursor = issue.comments.page_info.end_cursor.clone();
    while issue.comments.page_info.has_next_page {
        let Some(after) = cursor.take() else { break };
        let page: IssueCommentsPageData = graphql(
            &token,
            ISSUE_COMMENTS_PAGE_QUERY,
            serde_json::json!({ "id": ticket_id, "after": after }),
        )
        .await?;
        let Some(page_issue) = page.issue else { break };
        issue.comments.nodes.extend(page_issue.comments.nodes);
        issue.comments.page_info = page_issue.comments.page_info;
        cursor = issue.comments.page_info.end_cursor.clone();
    }

    let now = now_ms();
    let style = name_style(db).await;
    let client = gql::client();

    let description = inline_images(client, &issue.description.unwrap_or_default(), &token).await;

    // Top-level comments (replies hang off each via `children`), oldest first.
    let mut top: Vec<CommentNode> = issue
        .comments
        .nodes
        .into_iter()
        .filter(|c| c.parent.is_none())
        .collect();
    top.sort_by_key(|c| c.created_at.as_deref().and_then(parse_ms).unwrap_or(0));
    // Map (and inline-fetch images for) each top-level comment concurrently;
    // join_all preserves the oldest-first order.
    let comments = join_all(
        top.into_iter()
            .map(|node| map_comment(client, node, &token, style)),
    )
    .await;

    let (author, author_avatar_url) = actor(issue.creator, None, style);
    let snooze_ms = issue.snoozed_until_at.as_deref().and_then(parse_ms);
    let state = issue.state;
    let state_id = state.as_ref().and_then(|s| s.id.clone());

    // The team's workflow states, ordered as in Linear, for the status picker.
    let mut state_nodes = issue.team.map(|t| t.states.nodes).unwrap_or_default();
    state_nodes.sort_by(|a, b| a.position.total_cmp(&b.position));
    let states: Vec<WorkflowState> = state_nodes
        .into_iter()
        .map(|s| WorkflowState {
            id: s.id,
            name: s.name,
            type_: s.type_,
            color: s.color,
        })
        .collect();

    Ok(Some(TriageDetail {
        id: issue.identifier,
        title: issue.title,
        priority: core_linear::map_priority(issue.priority),
        state: state.map(|s| s.name).unwrap_or_else(|| "Triage".into()),
        state_id,
        states,
        url: issue.url,
        author,
        author_avatar_url,
        created_at_ms: issue
            .created_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64)
            .unwrap_or_default(),
        labels: issue.labels.nodes.into_iter().map(|l| l.name).collect(),
        project: issue.project.and_then(|p| p.name),
        sla_breach_ms: issue
            .sla_breaches_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64),
        snoozed_until_ms: core_linear::is_snoozed(snooze_ms, now)
            .then_some(snooze_ms)
            .flatten()
            .map(|v| v as f64),
        description,
        comments,
    }))
}

const SET_STATE_MUTATION: &str = r#"
mutation SetState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { state { name } }
  }
}
"#;

/// Move an issue to a different workflow state (e.g. out of `triage` into
/// `backlog`/`unstarted` to "promote" it). Requires a write-scoped token.
pub async fn set_issue_state(
    db: &Db,
    repo: &str,
    ticket_id: &str,
    state_id: &str,
) -> Result<Option<()>> {
    #[derive(Deserialize)]
    struct UpdResult {
        #[serde(default)]
        success: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SetStateData {
        issue_update: Option<UpdResult>,
    }
    let Some(token) = repo_token(db, repo).await? else {
        return Ok(None);
    };
    let data: SetStateData = graphql(
        &token,
        SET_STATE_MUTATION,
        serde_json::json!({ "id": ticket_id, "stateId": state_id }),
    )
    .await?;
    if data.issue_update.map(|u| u.success).unwrap_or(false) {
        Ok(Some(()))
    } else {
        // `graphql()` already surfaces any `errors` array (permission/scope
        // problems land there), so reaching here means a bare `success: false`
        // with no error — don't guess a specific cause.
        bail!("Linear rejected the status change")
    }
}

// `commentCreate.issueId` requires the issue's UUID, but the UI only holds the
// human identifier (e.g. "MSG-5147"), so resolve the UUID first.
const ISSUE_UUID_QUERY: &str = r#"
query IssueUuid($id: String!) { issue(id: $id) { id } }
"#;

const CREATE_COMMENT_MUTATION: &str = r#"
mutation CreateComment($issueId: String!, $parentId: String, $body: String!) {
  commentCreate(input: { issueId: $issueId, parentId: $parentId, body: $body }) {
    success
  }
}
"#;

/// Post a comment on an issue — a top-level comment, or a reply when `parent_id`
/// is the id of the comment being replied to. Requires a write-scoped token;
/// returns `Ok(None)` when no Linear org is connected for the repo.
pub async fn create_comment(
    db: &Db,
    repo: &str,
    ticket_id: &str,
    parent_id: Option<&str>,
    body: &str,
) -> Result<Option<()>> {
    let Some(token) = repo_token(db, repo).await? else {
        return Ok(None);
    };

    #[derive(Deserialize)]
    struct IssueId {
        id: String,
    }
    #[derive(Deserialize)]
    struct IssueIdData {
        issue: Option<IssueId>,
    }
    let id_data: IssueIdData = graphql(
        &token,
        ISSUE_UUID_QUERY,
        serde_json::json!({ "id": ticket_id }),
    )
    .await?;
    let issue_uuid = id_data
        .issue
        .ok_or_else(|| anyhow!("issue {ticket_id} not found"))?
        .id;

    #[derive(Deserialize)]
    struct CreateResult {
        #[serde(default)]
        success: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CreateCommentData {
        comment_create: Option<CreateResult>,
    }
    let data: CreateCommentData = graphql(
        &token,
        CREATE_COMMENT_MUTATION,
        serde_json::json!({ "issueId": issue_uuid, "parentId": parent_id, "body": body }),
    )
    .await?;
    if data.comment_create.map(|c| c.success).unwrap_or(false) {
        Ok(Some(()))
    } else {
        // `graphql()` surfaces any `errors` array, so a bare `success: false`
        // here has no specific cause to report.
        bail!("Linear rejected the comment")
    }
}

const STARTED_STATE_QUERY: &str = r#"
query StartedState($id: String!) {
  issue(id: $id) {
    state { type }
    team {
      states(filter: { type: { eq: "started" } }) {
        nodes { id position }
      }
    }
  }
}
"#;

/// Move an issue into its team's "started" (In Progress) workflow state — used
/// when a worktree begins so Linear reflects active work. Best-effort: no token →
/// `Ok(None)`; already started/done/canceled → left as-is. Picks the lowest-
/// position "started" state. Requires a write-scoped token.
pub async fn move_issue_to_started(db: &Db, repo: &str, issue_id: &str) -> Result<Option<()>> {
    #[derive(Deserialize)]
    struct StateType {
        #[serde(rename = "type")]
        kind: Option<String>,
    }
    #[derive(Deserialize)]
    struct StartedState {
        id: String,
        #[serde(default)]
        position: f64,
    }
    #[derive(Deserialize)]
    struct TeamStates {
        states: Connection<StartedState>,
    }
    #[derive(Deserialize)]
    struct IssueNode {
        #[serde(default)]
        state: Option<StateType>,
        #[serde(default)]
        team: Option<TeamStates>,
    }
    #[derive(Deserialize)]
    struct Data {
        issue: Option<IssueNode>,
    }

    let Some(token) = repo_token(db, repo).await? else {
        return Ok(None);
    };
    let data: Data = graphql(
        &token,
        STARTED_STATE_QUERY,
        serde_json::json!({ "id": issue_id }),
    )
    .await?;
    let Some(issue) = data.issue else {
        return Ok(None);
    };
    // Never drag an issue backwards — only promote one that hasn't started yet.
    let kind = issue.state.and_then(|s| s.kind).unwrap_or_default();
    if matches!(
        kind.as_str(),
        "started" | "completed" | "canceled" | "duplicate"
    ) {
        return Ok(Some(()));
    }
    let mut states = issue.team.map(|t| t.states.nodes).unwrap_or_default();
    states.sort_by(|a, b| a.position.total_cmp(&b.position));
    let Some(target) = states.first() else {
        return Ok(None); // team has no started state — nothing to do
    };
    set_issue_state(db, repo, issue_id, &target.id).await
}

const TRIAGE_SCHEDULES_QUERY: &str = r#"
query TriageSchedules($after: String) {
  viewer {
    id
    teamMemberships(first: 100, after: $after) {
      nodes {
        team {
          key name
          triageResponsibility {
            currentUser { id }
            timeSchedule { name entries { startsAt endsAt userId userEmail } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

#[derive(Deserialize)]
struct IdRef {
    #[serde(default)]
    id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedEntry {
    #[serde(default)]
    starts_at: Option<String>,
    #[serde(default)]
    ends_at: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    user_email: Option<String>,
}
#[derive(Deserialize)]
struct TimeSchedule {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    entries: Vec<SchedEntry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriageResp {
    #[serde(default)]
    current_user: Option<IdRef>,
    #[serde(default)]
    time_schedule: Option<TimeSchedule>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamNode {
    key: String,
    name: String,
    #[serde(default)]
    triage_responsibility: Option<TriageResp>,
}

/// A team runs a triage rotation when its responsibility is backed by a non-empty
/// time schedule; a team without one has no on-call owner, so its triage issues
/// aren't anyone's responsibility. The queue and the schedule strips share this.
fn is_rotation_team(t: &TeamNode) -> bool {
    t.triage_responsibility
        .as_ref()
        .and_then(|r| r.time_schedule.as_ref())
        .is_some_and(|s| !s.entries.is_empty())
}
#[derive(Deserialize)]
struct Membership {
    #[serde(default)]
    team: Option<TeamNode>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedViewer {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    team_memberships: Option<Connection<Membership>>,
}
#[derive(Deserialize)]
struct SchedQueryData {
    viewer: Option<SchedViewer>,
}

/// Fetch every page of the viewer's team memberships. A user rarely belongs to
/// more than a handful of teams, so unlike `assignedIssues` this is cheap to loop
/// in full rather than truncate — a team past the first 100 would otherwise drop
/// silently out of both the triage queue's scope and the schedule strips.
async fn fetch_all_team_memberships(token: &str) -> Result<SchedQueryData> {
    let mut data: SchedQueryData =
        graphql(token, TRIAGE_SCHEDULES_QUERY, serde_json::json!({})).await?;
    let Some(viewer) = data.viewer.as_mut() else {
        return Ok(data);
    };
    let Some(conn) = viewer.team_memberships.as_mut() else {
        return Ok(data);
    };
    let mut cursor = conn.page_info.end_cursor.clone();
    while conn.page_info.has_next_page {
        let Some(after) = cursor.take() else { break };
        let page: SchedQueryData = graphql(
            token,
            TRIAGE_SCHEDULES_QUERY,
            serde_json::json!({ "after": after }),
        )
        .await?;
        let Some(mut page_conn) = page.viewer.and_then(|v| v.team_memberships) else {
            break;
        };
        conn.nodes.append(&mut page_conn.nodes);
        conn.page_info = page_conn.page_info;
        cursor = conn.page_info.end_cursor.clone();
    }
    Ok(data)
}

/// A user's display name + avatar, keyed by id in the resolved name map.
#[derive(Clone)]
struct UserInfo {
    name: String,
    avatar_url: Option<String>,
}
#[derive(Deserialize)]
struct UsersData {
    users: Connection<UserNode>,
}

/// The viewer's triage on-call rotations — one per team that has a
/// time-schedule-backed triage responsibility (empty when none do). Rotations
/// the viewer participates in are surfaced first.
pub async fn triage_schedule(db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
    let Some(token) = repo_token(db, repo).await? else {
        return Ok(None);
    };
    let data = fetch_all_team_memberships(&token).await?;
    let Some(viewer) = data.viewer else {
        return Ok(Some(Vec::new()));
    };
    let viewer_id = viewer.id;

    // Teams whose triage responsibility is backed by a non-empty schedule.
    let teams: Vec<TeamNode> = viewer
        .team_memberships
        .map(|m| m.nodes)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.team)
        .filter(is_rotation_team)
        .collect();
    if teams.is_empty() {
        return Ok(Some(Vec::new()));
    }

    // Resolve all referenced user ids → display names in one batch.
    let mut ids: Vec<String> = Vec::new();
    for t in &teams {
        if let Some(r) = &t.triage_responsibility {
            if let Some(cu) = r.current_user.as_ref().and_then(|c| c.id.clone()) {
                ids.push(cu);
            }
            for e in r.time_schedule.iter().flat_map(|s| &s.entries) {
                if let Some(uid) = &e.user_id {
                    ids.push(uid.clone());
                }
            }
        }
    }
    ids.sort();
    ids.dedup();
    let style = name_style(db).await;
    let names = resolve_user_names(&token, &ids, style)
        .await
        .unwrap_or_default();
    let now = now_ms();

    let mut schedules: Vec<TriageSchedule> = teams
        .into_iter()
        .map(|t| build_schedule(t, viewer_id.as_deref(), &names, now))
        .collect();
    // Surface rotations the viewer is part of first.
    schedules.sort_by_key(|s| !s.shifts.iter().any(|sh| sh.is_me));
    Ok(Some(schedules))
}

fn build_schedule(
    team: TeamNode,
    viewer_id: Option<&str>,
    names: &std::collections::HashMap<String, UserInfo>,
    now: i64,
) -> TriageSchedule {
    let resp = team.triage_responsibility.unwrap_or(TriageResp {
        current_user: None,
        time_schedule: None,
    });
    let schedule_name = resp
        .time_schedule
        .as_ref()
        .and_then(|s| s.name.clone())
        .unwrap_or_else(|| format!("{} triage", team.name));

    let mut shifts: Vec<(TriageShift, i64)> = resp
        .time_schedule
        .into_iter()
        .flat_map(|s| s.entries)
        .map(|e| {
            let start = e.starts_at.as_deref().and_then(parse_ms);
            let end = e.ends_at.as_deref().and_then(parse_ms);
            let is_current = matches!((start, end), (Some(s), Some(en)) if now >= s && now < en);
            let is_me = viewer_id.is_some() && e.user_id.as_deref() == viewer_id;
            let info = e.user_id.as_deref().and_then(|id| names.get(id));
            let name = info
                .map(|u| u.name.clone())
                .or(e.user_email)
                .unwrap_or_else(|| "Unknown".into());
            let avatar_url = info.and_then(|u| u.avatar_url.clone());
            (
                TriageShift {
                    name,
                    avatar_url,
                    range: shift_range(start, end),
                    is_current,
                    is_me,
                },
                start.unwrap_or(0),
            )
        })
        .collect();
    shifts.sort_by_key(|(_, start)| *start);
    let shifts: Vec<TriageShift> = shifts.into_iter().map(|(s, _)| s).collect();

    let current = shifts.iter().find(|s| s.is_current);
    let current_user_id = resp.current_user.and_then(|c| c.id);
    let current_name = current.map(|s| s.name.clone()).or_else(|| {
        current_user_id
            .as_deref()
            .and_then(|id| names.get(id))
            .map(|u| u.name.clone())
    });
    let current_avatar_url = current.and_then(|s| s.avatar_url.clone()).or_else(|| {
        current_user_id
            .as_deref()
            .and_then(|id| names.get(id))
            .and_then(|u| u.avatar_url.clone())
    });
    let current_is_me = current
        .map(|s| s.is_me)
        .unwrap_or_else(|| viewer_id.is_some() && current_user_id.as_deref() == viewer_id);

    TriageSchedule {
        team: team.name,
        schedule_name,
        current_name,
        current_avatar_url,
        current_is_me,
        shifts,
    }
}

async fn resolve_user_names(
    token: &str,
    ids: &[String],
    style: NameStyle,
) -> Result<std::collections::HashMap<String, UserInfo>> {
    if ids.is_empty() {
        return Ok(Default::default());
    }
    const QUERY: &str = r#"
query ResolveUsers($ids: [ID!]!) {
  users(filter: { id: { in: $ids } }, first: 250) { nodes { id name displayName avatarUrl } }
}
"#;
    let data: UsersData = graphql(token, QUERY, serde_json::json!({ "ids": ids })).await?;
    Ok(data
        .users
        .nodes
        .into_iter()
        .filter_map(|u| {
            let id = u.id?;
            let name = pick_name(u.name, u.display_name, style).unwrap_or_else(|| id.clone());
            Some((
                id,
                UserInfo {
                    name,
                    avatar_url: u.avatar_url,
                },
            ))
        })
        .collect())
}

// ── Timestamp + image helpers ──────────────────────────────────────────────

/// Parse an RFC3339 timestamp (Linear's format) to epoch milliseconds.
fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// A short on-call range like "Jun 19 – Jun 26" from start/end epoch millis. The
/// schedule's end is exclusive (midnight of the following day), so we show the
/// last covered day instead — "Jun 19 – Jun 25" reads as the actual shift.
fn shift_range(start: Option<i64>, end: Option<i64>) -> String {
    let day = |ms: i64| {
        chrono::DateTime::from_timestamp_millis(ms)
            .map(|dt| dt.format("%b %-d").to_string())
            .unwrap_or_default()
    };
    match (start, end) {
        (Some(s), Some(e)) => format!("{} – {}", day(s), day(e - 86_400_000)),
        (Some(s), None) => day(s),
        (None, Some(e)) => day(e),
        (None, None) => String::new(),
    }
}

/// The CDN host image URLs are inlined from.
const IMAGE_HOST: &str = "https://uploads.linear.app";

/// Byte-offset spans (in order) of every `https://uploads.linear.app/...` image
/// URL in `md`. Pure and synchronous so the scan (the part that shipped a
/// substring-corruption bug) is unit-testable without mocking a fetch.
fn image_spans(md: &str) -> Vec<(usize, usize)> {
    let bytes = md.as_bytes();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut search = 0;
    while let Some(rel) = md[search..].find(IMAGE_HOST) {
        let start = search + rel;
        // Require a path boundary ('/' or end-of-match) right after the host so a
        // prefix match like `https://uploads.linear.app.evil.com` (which contains
        // our string as a prefix, not the real host) is skipped, not treated as a
        // trusted Linear URL. fetch_data_uri re-validates the host as a second layer.
        if !matches!(
            md.as_bytes().get(start + IMAGE_HOST.len()),
            Some(b'/') | None
        ) {
            search = start + IMAGE_HOST.len();
            continue;
        }
        let mut end = start;
        while end < md.len()
            && !matches!(
                bytes[end],
                b')' | b' ' | b'\n' | b'\t' | b'"' | b']' | b'>' | b'<'
            )
        {
            end += 1;
        }
        spans.push((start, end));
        search = end;
    }
    spans
}

/// Rebuild `md` with each `spans` entry replaced by its match in
/// `replacements` (keyed by the exact URL substring). A span with no entry
/// (e.g. its fetch failed) is left untouched. Splices by span rather than
/// `str::replace` so one URL being a substring of another can't corrupt the
/// output, and the whole body is rewritten in a single pass.
fn splice_images(
    md: &str,
    spans: &[(usize, usize)],
    replacements: &std::collections::HashMap<&str, &str>,
) -> String {
    let mut out = String::with_capacity(md.len());
    let mut cursor = 0;
    for &(start, end) in spans {
        out.push_str(&md[cursor..start]);
        out.push_str(
            replacements
                .get(&md[start..end])
                .copied()
                .unwrap_or(&md[start..end]),
        );
        cursor = end;
    }
    out.push_str(&md[cursor..]);
    out
}

/// Replace `https://uploads.linear.app/...` image URLs in markdown with
/// base64 data URIs, downloading each with the access token. URLs that fail to
/// fetch are left untouched.
async fn inline_images(client: &reqwest::Client, md: &str, token: &str) -> String {
    if !md.contains(IMAGE_HOST) {
        return md.to_string();
    }
    let spans = image_spans(md);
    if spans.is_empty() {
        return md.to_string();
    }

    // Fetch each distinct URL once, concurrently.
    let mut distinct: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for &(start, end) in &spans {
        if seen.insert(&md[start..end]) {
            distinct.push(md[start..end].to_string());
        }
    }
    let fetched = join_all(
        distinct
            .iter()
            .map(|url| async move { fetch_data_uri(client, url, token).await.ok() }),
    )
    .await;
    let replacements: std::collections::HashMap<&str, &str> = distinct
        .iter()
        .zip(&fetched)
        .filter_map(|(url, uri)| uri.as_deref().map(|u| (url.as_str(), u)))
        .collect();

    splice_images(md, &spans, &replacements)
}

/// Cap on a single inlined image so one huge attachment can't balloon the IPC
/// payload / memory (the data URI is ~1.33× the raw bytes on top of that).
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// Session cache of fetched image data URIs (keyed by URL), so reopening a ticket
/// doesn't re-download its images. Bounded by *total bytes* with FIFO eviction —
/// a count cap could still pin hundreds of MB since each entry is up to
/// `MAX_IMAGE_BYTES`. The token is stable for the session, so URL is a safe key.
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct ImageCache {
    map: std::collections::HashMap<String, String>,
    order: std::collections::VecDeque<String>,
    bytes: usize,
}
impl ImageCache {
    fn get(&self, url: &str) -> Option<String> {
        self.map.get(url).cloned()
    }
    fn insert(&mut self, url: String, uri: String) {
        self.insert_bounded(url, uri, MAX_CACHE_BYTES);
    }

    /// `insert` with the byte cap as a parameter, so the FIFO eviction logic is
    /// unit-testable without allocating real megabytes of string data.
    fn insert_bounded(&mut self, url: String, uri: String, max_bytes: usize) {
        if self.map.contains_key(&url) {
            return;
        }
        self.bytes += uri.len();
        self.order.push_back(url.clone());
        self.map.insert(url, uri);
        while self.bytes > max_bytes {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            if let Some(v) = self.map.remove(&evicted) {
                self.bytes -= v.len();
            }
        }
    }
}

static IMAGE_CACHE: std::sync::LazyLock<tokio::sync::Mutex<ImageCache>> =
    std::sync::LazyLock::new(Default::default);

async fn fetch_data_uri(client: &reqwest::Client, url: &str, token: &str) -> Result<String> {
    // Re-validate the host by parsing (not string-prefix) right before the token
    // goes out over the wire — the last line of defense against sending the org's
    // Linear OAuth token to a lookalike host (e.g. uploads.linear.app.evil.com).
    let parsed = reqwest::Url::parse(url)?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("uploads.linear.app") {
        bail!("refusing to fetch image from untrusted host: {url}");
    }
    if let Some(hit) = IMAGE_CACHE.lock().await.get(url) {
        return Ok(hit);
    }
    let res = client.get(url).bearer_auth(token).send().await?;
    if !res.status().is_success() {
        bail!("image fetch returned {}", res.status());
    }
    if let Some(len) = res.content_length() {
        if len > MAX_IMAGE_BYTES {
            bail!("image too large to inline ({len} bytes)");
        }
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    // Stream the body with a running cap rather than buffering it whole and
    // checking after: a missing or lying Content-Length defeats the pre-check
    // above, so without this a huge response would spike memory before we noticed.
    let mut data: Vec<u8> = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if data.len() as u64 + chunk.len() as u64 > MAX_IMAGE_BYTES {
            bail!("image too large to inline (exceeds {MAX_IMAGE_BYTES} bytes)");
        }
        data.extend_from_slice(&chunk);
    }
    let uri = format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&data)
    );
    IMAGE_CACHE
        .lock()
        .await
        .insert(url.to_string(), uri.clone());
    Ok(uri)
}

// ── OAuth PKCE connect flow ──────────────────────────────────────────────

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

/// Run the OAuth flow, persist the org's tokens, and return the updated org list.
pub async fn connect(db: &Db) -> Result<Vec<LinearOrg>> {
    let verifier = b64url(&random_bytes(32));
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = hex(&random_bytes(16));

    let redirect_uri = format!("http://localhost:{OAUTH_PORT}");
    let params = [
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri.as_str()),
        ("response_type", "code"),
        // `write` lets the app move issues between workflow states (the triage
        // status picker). Read-only tokens from older connects must reconnect.
        ("scope", "read,write"),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    open_browser(&format!("{AUTHORIZE_URL}?{query}"));

    let expected_state = state.clone();
    let code = tokio::task::spawn_blocking(move || wait_for_code(&expected_state))
        .await
        .context("oauth listener task")??;

    let (access_token, refresh_token, expires_at) =
        exchange_code(&code, &redirect_uri, &verifier).await?;
    let (slug, name) = fetch_viewer_org(&access_token).await?;

    upsert_org(
        db,
        &OrgRow {
            slug,
            name,
            access_token,
            refresh_token,
            expires_at,
        },
    )
    .await?;
    list_orgs(db).await
}

fn wait_for_code(expected_state: &str) -> Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", OAUTH_PORT)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            anyhow!(
                "Port {OAUTH_PORT} is already in use — another Linear sign-in may be in progress. Close it and try again."
            )
        } else {
            anyhow::Error::new(e).context("binding oauth port")
        }
    })?;
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(120);

    loop {
        if Instant::now() > deadline {
            bail!("timed out waiting for Linear authorization");
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("");
                let (code, returned_state, error) = parse_callback(path);
                let state_matches = returned_state.as_deref() == Some(expected_state);
                let ok = code.is_some() && state_matches;

                let html = if ok {
                    "<html><body><h2>Authentication successful!</h2><p>You can close this tab.</p></body></html>"
                } else {
                    "<html><body><h2>Authentication failed.</h2></body></html>"
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                        html.len(),
                        html
                    )
                    .as_bytes(),
                );
                if ok {
                    return Ok(code.unwrap());
                }
                // Linear's deny redirect carries `error=access_denied` (no code) rather
                // than a failure status — without this, a user who declines sits on the
                // full 120s timeout before seeing an error. Only trust the error when the
                // state matches, so a stray request to the callback port can't abort the flow.
                if state_matches {
                    if let Some(error) = error {
                        bail!("Linear authorization failed: {error}");
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Extract `code`, `state`, and `error` from a callback path like
/// `/?code=…&state=…` (success) or `/?error=access_denied&state=…` (the user
/// declined), percent-decoding each value (a `%`-escaped code would otherwise
/// mismatch).
fn parse_callback(path: &str) -> (Option<String>, Option<String>, Option<String>) {
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    (code, state, error)
}

/// Exchange an auth code for `(access_token, refresh_token, expires_at_ms)`.
async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<(String, String, i64)> {
    let res = gql::client()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .context("code exchange")?;
    if !res.status().is_success() {
        bail!("token exchange failed: {}", res.status());
    }
    let body: TokenResponse = res.json().await?;
    Ok((
        body.access_token,
        body.refresh_token,
        now_ms() + body.expires_in * 1000,
    ))
}

/// Returns the viewer's organization `(url_key, name)`.
async fn fetch_viewer_org(access_token: &str) -> Result<(String, String)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Org {
        url_key: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct ViewerOrg {
        organization: Org,
    }
    #[derive(Deserialize)]
    struct Data {
        viewer: ViewerOrg,
    }

    let data: Data = graphql(
        access_token,
        "query { viewer { organization { urlKey name } } }",
        serde_json::json!({}),
    )
    .await?;
    let org = data.viewer.organization;
    Ok((org.url_key, org.name))
}

fn open_browser(url: &str) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "start"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(cmd).arg(url).spawn();
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        image_spans, map_issue, parse_callback, parse_ms, refresh_lock, shift_range, splice_images,
        triage_meta, ImageCache, IssueNode, ProjectNode, RelatedIssue, RelationNode, StateNode,
        UserNode, IMAGE_HOST,
    };
    use crate::gql::{Connection, PageInfo};
    use std::collections::HashMap;

    /// The exact bug class that previously shipped: naive `str::replace` on a
    /// URL that is a strict prefix of another URL in the same doc corrupted the
    /// longer one (replacing its prefix and stranding the suffix). Span-based
    /// splicing must keep both intact.
    #[test]
    fn prefix_url_does_not_corrupt_longer_url() {
        let md = format!("![a]({IMAGE_HOST}/abc) ![b]({IMAGE_HOST}/abc/nested)");
        let spans = image_spans(&md);
        assert_eq!(spans.len(), 2);

        let short = format!("{IMAGE_HOST}/abc");
        let long = format!("{IMAGE_HOST}/abc/nested");
        let replacements: HashMap<&str, &str> =
            HashMap::from([(short.as_str(), "DATA_A"), (long.as_str(), "DATA_B")]);

        let out = splice_images(&md, &spans, &replacements);
        assert_eq!(out, "![a](DATA_A) ![b](DATA_B)");
    }

    #[test]
    fn url_at_end_of_string_is_captured() {
        let md = format!("see {IMAGE_HOST}/end");
        let spans = image_spans(&md);
        assert_eq!(spans, vec![(4, md.len())]);

        let key = format!("{IMAGE_HOST}/end");
        let replacements: HashMap<&str, &str> = HashMap::from([(key.as_str(), "DATA")]);
        assert_eq!(splice_images(&md, &spans, &replacements), "see DATA");
    }

    #[test]
    fn repeated_url_is_replaced_at_every_occurrence() {
        let md = format!("{IMAGE_HOST}/x and again {IMAGE_HOST}/x");
        let spans = image_spans(&md);
        assert_eq!(spans.len(), 2);

        let key = format!("{IMAGE_HOST}/x");
        let replacements: HashMap<&str, &str> = HashMap::from([(key.as_str(), "DATA")]);
        assert_eq!(
            splice_images(&md, &spans, &replacements),
            "DATA and again DATA"
        );
    }

    /// A failed fetch means no entry lands in the replacements map — the span
    /// must be left exactly as-is, not corrupted or dropped.
    #[test]
    fn missing_replacement_leaves_span_untouched() {
        let md = format!("![a]({IMAGE_HOST}/missing)");
        let spans = image_spans(&md);
        let replacements: HashMap<&str, &str> = HashMap::new();
        assert_eq!(splice_images(&md, &spans, &replacements), md);
    }

    #[test]
    fn every_boundary_terminator_ends_the_span() {
        for term in [')', ' ', '\n', '\t', '"', ']', '>', '<'] {
            let md = format!("{IMAGE_HOST}/x{term}rest");
            let spans = image_spans(&md);
            assert_eq!(
                spans,
                vec![(0, IMAGE_HOST.len() + 2)],
                "terminator {term:?} did not close the span"
            );
        }
    }

    #[test]
    fn url_with_no_terminator_runs_to_end_of_string() {
        let md = format!("{IMAGE_HOST}/x");
        assert_eq!(image_spans(&md), vec![(0, md.len())]);
    }

    /// The critical fix this refactor must not regress: a lookalike host that
    /// merely has our host as a string *prefix* (not the real host) is skipped,
    /// so its token-bearing URL is never queued for fetch.
    #[test]
    fn lookalike_host_is_not_a_match() {
        let md = format!("{IMAGE_HOST}.evil.com/x");
        assert!(image_spans(&md).is_empty());
    }

    // ── refresh_lock ──────────────────────────────────────────────────────

    #[test]
    fn refresh_lock_same_slug_returns_the_same_arc() {
        let a = refresh_lock("refresh-lock-test-same");
        let b = refresh_lock("refresh-lock-test-same");
        assert!(std::sync::Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn refresh_lock_different_slugs_return_different_arcs() {
        let a = refresh_lock("refresh-lock-test-a");
        let b = refresh_lock("refresh-lock-test-b");
        assert!(!std::sync::Arc::ptr_eq(&a, &b));
    }

    // ── ImageCache ────────────────────────────────────────────────────────

    #[test]
    fn image_cache_evicts_oldest_entry_once_over_the_byte_cap() {
        let mut cache = ImageCache::default();
        cache.insert_bounded("a".into(), "x".repeat(10), 15);
        // Total is now 20 bytes > the 15-byte cap: the oldest entry ("a") must
        // be evicted to bring the running total back under the cap.
        cache.insert_bounded("b".into(), "x".repeat(10), 15);
        assert!(cache.get("a").is_none());
        assert_eq!(cache.get("b"), Some("x".repeat(10)));
    }

    #[test]
    fn image_cache_insert_is_a_no_op_for_an_existing_key() {
        let mut cache = ImageCache::default();
        cache.insert_bounded("a".into(), "one".into(), 1000);
        cache.insert_bounded("a".into(), "two".into(), 1000);
        // The first value wins; a re-insert of the same URL doesn't overwrite it
        // (or double-count its bytes against the cap).
        assert_eq!(cache.get("a"), Some("one".into()));
    }

    #[test]
    fn image_cache_keeps_entries_under_the_cap() {
        let mut cache = ImageCache::default();
        cache.insert_bounded("a".into(), "12345".into(), 100);
        cache.insert_bounded("b".into(), "67890".into(), 100);
        assert_eq!(cache.get("a"), Some("12345".into()));
        assert_eq!(cache.get("b"), Some("67890".into()));
    }

    // ── parse_callback ────────────────────────────────────────────────────

    #[test]
    fn parse_callback_reads_code_and_state() {
        let (code, state, error) = parse_callback("/?code=abc123&state=xyz789");
        assert_eq!(code.as_deref(), Some("abc123"));
        assert_eq!(state.as_deref(), Some("xyz789"));
        assert_eq!(error, None);
    }

    #[test]
    fn parse_callback_percent_decodes_values() {
        // A `%`-escaped code (e.g. one containing `+` or `/`) must come back
        // decoded, or it would mismatch the raw code sent in the token exchange.
        let (code, state, _) = parse_callback("/?code=a%2Bb%2Fc&state=has%20space");
        assert_eq!(code.as_deref(), Some("a+b/c"));
        assert_eq!(state.as_deref(), Some("has space"));
    }

    #[test]
    fn parse_callback_reads_error_on_deny() {
        // Linear's deny redirect: no code, an `error`, and the original `state`.
        let (code, state, error) = parse_callback("/?error=access_denied&state=xyz789");
        assert_eq!(code, None);
        assert_eq!(state.as_deref(), Some("xyz789"));
        assert_eq!(error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn parse_callback_handles_missing_query_string() {
        let (code, state, error) = parse_callback("/");
        assert_eq!(code, None);
        assert_eq!(state, None);
        assert_eq!(error, None);
    }

    // ── shift_range ───────────────────────────────────────────────────────

    fn ms(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn shift_range_shows_the_last_covered_day_not_the_exclusive_end() {
        // A schedule end is exclusive (midnight of the day after the shift), so a
        // Jan 1 - Jan 8 (exclusive) window is a shift that runs through Jan 7.
        let start = ms("2024-01-01T00:00:00Z");
        let end = ms("2024-01-08T00:00:00Z");
        assert_eq!(shift_range(Some(start), Some(end)), "Jan 1 – Jan 7");
    }

    #[test]
    fn shift_range_open_start_shows_only_the_end_day() {
        let end = ms("2024-03-05T00:00:00Z");
        assert_eq!(shift_range(None, Some(end)), "Mar 5");
    }

    #[test]
    fn shift_range_open_end_shows_only_the_start_day() {
        let start = ms("2024-03-05T00:00:00Z");
        assert_eq!(shift_range(Some(start), None), "Mar 5");
    }

    #[test]
    fn shift_range_neither_bound_is_empty() {
        assert_eq!(shift_range(None, None), "");
    }

    // ── parse_ms ──────────────────────────────────────────────────────────

    #[test]
    fn parse_ms_parses_a_real_linear_timestamp() {
        let got = parse_ms("2024-06-15T12:34:56.789Z").unwrap();
        let want = chrono::DateTime::parse_from_rfc3339("2024-06-15T12:34:56.789Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(got, want);
    }

    #[test]
    fn parse_ms_rejects_a_non_rfc3339_string() {
        assert_eq!(parse_ms("not-a-timestamp"), None);
    }

    // ── triage_meta ───────────────────────────────────────────────────────

    #[test]
    fn triage_meta_joins_assignee_and_first_label() {
        let labels = vec!["bug".to_string(), "p1".to_string()];
        assert_eq!(triage_meta(Some("Alice"), &labels), "Alice · bug");
    }

    #[test]
    fn triage_meta_defaults_to_unassigned_with_no_labels() {
        assert_eq!(triage_meta(None, &[]), "unassigned");
    }

    // ── map_issue / map_related ───────────────────────────────────────────

    fn state(name: &str, type_: &str) -> StateNode {
        StateNode {
            id: None,
            name: name.into(),
            type_: type_.into(),
        }
    }

    fn related(identifier: &str, state_type: &str) -> RelatedIssue {
        RelatedIssue {
            identifier: identifier.into(),
            title: format!("{identifier} title"),
            state: Some(state("Some State", state_type)),
            project: None,
            assignee: None,
        }
    }

    #[test]
    fn map_issue_maps_status_project_assignee_and_open_blockers() {
        let node = IssueNode {
            identifier: "ENG-10".into(),
            title: "Do the thing".into(),
            state: Some(state("Todo", "unstarted")),
            project: Some(ProjectNode {
                name: Some("Roadmap".into()),
                color: Some("#fff".into()),
                icon: None,
            }),
            assignee: Some(UserNode {
                id: Some("u1".into()),
                name: Some("Ada Lovelace".into()),
                display_name: Some("ada".into()),
                avatar_url: Some("https://example.com/a.png".into()),
            }),
            inverse_relations: Connection {
                nodes: vec![
                    RelationNode {
                        type_: "blocks".into(),
                        issue: Some(related("ENG-1", "completed")),
                    },
                    RelationNode {
                        type_: "blocks".into(),
                        issue: Some(related("ENG-2", "unstarted")),
                    },
                    // A non-"blocks" relation (e.g. duplicate) must be ignored.
                    RelationNode {
                        type_: "duplicate".into(),
                        issue: Some(related("ENG-3", "completed")),
                    },
                ],
                page_info: PageInfo::default(),
            },
        };

        let (task, blockers) = map_issue(node);

        assert_eq!(task.id, "ENG-10");
        assert_eq!(task.project, "Roadmap");
        assert_eq!(task.assignee.as_deref(), Some("Ada Lovelace"));
        assert_eq!(
            task.assignee_avatar_url.as_deref(),
            Some("https://example.com/a.png")
        );
        assert_eq!(
            task.blocked_by,
            vec!["ENG-1".to_string(), "ENG-2".to_string()]
        );
        // One of the two "blocks" blockers is still open -> not ready.
        assert!(!task.ready);
        assert!(task.actionable);
        assert_eq!(blockers.len(), 2);
    }

    #[test]
    fn map_issue_is_ready_when_every_blocker_is_done() {
        let node = IssueNode {
            identifier: "ENG-11".into(),
            title: "Unblocked".into(),
            state: Some(state("Todo", "unstarted")),
            project: None,
            assignee: None,
            inverse_relations: Connection {
                nodes: vec![RelationNode {
                    type_: "blocks".into(),
                    issue: Some(related("ENG-1", "completed")),
                }],
                page_info: PageInfo::default(),
            },
        };
        let (task, _) = map_issue(node);
        assert!(task.ready);
        assert_eq!(task.project, "No Project");
        assert_eq!(task.assignee, None);
    }

    #[test]
    fn map_issue_in_progress_is_never_ready_even_with_no_blockers() {
        // Ready means "not yet started AND unblocked" — an already-started
        // ticket is never re-offered as ready to start.
        let node = IssueNode {
            identifier: "ENG-12".into(),
            title: "Already going".into(),
            state: Some(state("In Progress", "started")),
            project: None,
            assignee: None,
            inverse_relations: Connection::default(),
        };
        let (task, _) = map_issue(node);
        assert!(!task.ready);
    }

    #[test]
    fn map_issue_defaults_missing_state_to_unstarted_unknown() {
        let node = IssueNode {
            identifier: "ENG-13".into(),
            title: "No state on the wire".into(),
            state: None,
            project: None,
            assignee: None,
            inverse_relations: Connection::default(),
        };
        let (task, _) = map_issue(node);
        // TaskStatus::Todo is map_status("Unknown", "unstarted"); ready because
        // there are no blockers and the status is startable.
        assert!(task.ready);
    }
}
