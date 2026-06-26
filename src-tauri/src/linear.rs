//! Linear integration: multi-org token store (SQLite), OAuth PKCE connect flow,
//! and the GraphQL fetch that turns assigned issues into a positioned dependency
//! graph. Tokens and repo↔org links live in the app database; pure mapping and
//! layout live in `santree_core`.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use rand::RngCore;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use santree_core::domain::{
    LinearOrg, LinearStatus, Task, TaskStatus, TriageComment, TriageDetail, TriageSchedule,
    TriageShift, TriageTicket, WorkflowState,
};
use santree_core::{layout, linear as core_linear};

use crate::db::Db;

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

/// Bind (or clear, with `None`) the Linear org a repo uses.
pub async fn set_repo_org(db: &Db, repo: &str, slug: Option<String>) -> Result<()> {
    sqlx::query(
        "INSERT INTO repos (name, linear_org_slug) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET linear_org_slug = excluded.linear_org_slug",
    )
    .bind(repo)
    .bind(slug)
    .execute(db)
    .await?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Token refresh ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

/// A valid access token for `slug`, refreshing + persisting if near expiry.
async fn valid_token(db: &Db, slug: &str) -> Result<String> {
    let row = org_row(db, slug)
        .await?
        .ok_or_else(|| anyhow!("org {slug} not connected"))?;
    if now_ms() < row.expires_at - REFRESH_SKEW_MS {
        return Ok(row.access_token);
    }
    let res = reqwest::Client::new()
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

const ASSIGNED_ISSUES_QUERY: &str = r#"
query AssignedIssues {
  viewer {
    assignedIssues(
      filter: { state: { type: { nin: ["completed", "canceled"] } } }
      orderBy: updatedAt
      first: 100
    ) {
      nodes {
        identifier
        title
        state { name type }
        project { name }
        inverseRelations(first: 20) { nodes { type issue { identifier state { type } } } }
      }
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

#[derive(Deserialize)]
struct RelatedIssue {
    identifier: String,
    state: Option<StateNode>,
}

#[derive(Deserialize)]
struct RelationNode {
    #[serde(default, rename = "type")]
    type_: String,
    /// The issue on the *other* side of an inverse relation (this issue's blocker).
    #[serde(default)]
    issue: Option<RelatedIssue>,
}

#[derive(Deserialize, Default)]
struct RelationConn {
    #[serde(default)]
    nodes: Vec<RelationNode>,
}

#[derive(Deserialize)]
struct ProjectNode {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueNode {
    identifier: String,
    title: String,
    state: Option<StateNode>,
    project: Option<ProjectNode>,
    #[serde(default)]
    inverse_relations: RelationConn,
}

#[derive(Deserialize)]
struct AssignedConn {
    nodes: Vec<IssueNode>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Viewer {
    assigned_issues: AssignedConn,
}
#[derive(Deserialize)]
struct QueryData {
    viewer: Viewer,
}
#[derive(Deserialize)]
struct GraphQlResponse {
    data: Option<QueryData>,
}

const TERMINAL_STATES: [&str; 2] = ["completed", "canceled"];

fn map_issue(node: IssueNode) -> Task {
    let state = node.state.unwrap_or(StateNode {
        id: None,
        name: "Unknown".into(),
        type_: "unstarted".into(),
    });
    let status: TaskStatus = core_linear::map_status(&state.name, &state.type_);

    // `inverseRelations` of type "blocks" point *at* this issue → its blockers.
    let mut blocked_by = Vec::new();
    let mut done_flags = Vec::new();
    for rel in node.inverse_relations.nodes {
        if rel.type_ != "blocks" {
            continue;
        }
        if let Some(issue) = rel.issue {
            let state_type = issue.state.map(|s| s.type_).unwrap_or_default();
            done_flags.push(TERMINAL_STATES.contains(&state_type.as_str()));
            blocked_by.push(issue.identifier);
        }
    }

    Task {
        id: node.identifier,
        title: node.title,
        project: node
            .project
            .and_then(|p| p.name)
            .unwrap_or_else(|| "No Project".into()),
        status,
        ready: core_linear::is_ready(&done_flags),
        blocked_by,
        x: 0,
        y: 0,
        add_lines: 0,
        del_lines: 0,
    }
}

/// Fetch the assigned issues for `repo`'s org and lay them out as a graph.
pub async fn list_issues(db: &Db, repo: &str) -> Result<Vec<Task>> {
    let slug = resolve_org_slug(db, repo)
        .await?
        .ok_or_else(|| anyhow!("no Linear org connected"))?;
    let token = valid_token(db, &slug).await?;
    let res = reqwest::Client::new()
        .post(GRAPHQL_URL)
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": ASSIGNED_ISSUES_QUERY }))
        .send()
        .await
        .context("Linear GraphQL request")?;
    if !res.status().is_success() {
        bail!("Linear API returned {}", res.status());
    }
    let body: GraphQlResponse = res.json().await.context("decoding Linear response")?;
    let nodes = body
        .data
        .map(|d| d.viewer.assigned_issues.nodes)
        .unwrap_or_default();
    let mut tasks: Vec<Task> = nodes.into_iter().map(map_issue).collect();
    layout::layout_tasks(&mut tasks);
    Ok(tasks)
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

/// A valid access token for the org this repo uses.
async fn repo_token(db: &Db, repo: &str) -> Result<String> {
    let slug = resolve_org_slug(db, repo)
        .await?
        .ok_or_else(|| anyhow!("no Linear org connected"))?;
    valid_token(db, &slug).await
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
}

/// POST a GraphQL query and return the typed `data` payload.
async fn graphql<T: DeserializeOwned>(
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<T> {
    let res = reqwest::Client::new()
        .post(GRAPHQL_URL)
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await
        .context("Linear GraphQL request")?;
    if !res.status().is_success() {
        bail!("Linear API returned {}", res.status());
    }
    let env: Envelope<T> = res.json().await.context("decoding Linear response")?;
    env.data.ok_or_else(|| anyhow!("empty Linear response"))
}

#[derive(Deserialize, Default)]
struct LabelConn {
    #[serde(default)]
    nodes: Vec<LabelName>,
}
#[derive(Deserialize)]
struct LabelName {
    name: String,
}
#[derive(Deserialize)]
struct UserNode {
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default, rename = "avatarUrl")]
    avatar_url: Option<String>,
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
fn actor(user: Option<UserNode>, bot: Option<BotActor>) -> (String, Option<String>) {
    if let Some(u) = user {
        return (u.display_name.unwrap_or_else(|| "Unknown".into()), u.avatar_url);
    }
    if let Some(b) = bot {
        return (b.name.unwrap_or_else(|| "Unknown".into()), b.avatar_url);
    }
    ("Unknown".into(), None)
}

// The triage queue is the team triage inbox for the teams the viewer belongs to
// — issues in a `triage` workflow state, regardless of assignee (most triage
// items are unassigned until someone picks them up). We scope to the viewer's
// teams so a large workspace's other inboxes don't flood the list; if the
// viewer is on no teams we fall back to the workspace-wide triage inbox.

const VIEWER_TEAMS_QUERY: &str =
    "query { viewer { teamMemberships(first: 100) { nodes { team { key } } } } }";

#[derive(Deserialize)]
struct VtTeam {
    key: String,
}
#[derive(Deserialize)]
struct VtMembership {
    #[serde(default)]
    team: Option<VtTeam>,
}
#[derive(Deserialize)]
struct VtConn {
    #[serde(default)]
    nodes: Vec<VtMembership>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VtViewer {
    #[serde(default)]
    team_memberships: Option<VtConn>,
}
#[derive(Deserialize)]
struct VtData {
    viewer: Option<VtViewer>,
}

async fn viewer_team_keys(token: &str) -> Result<Vec<String>> {
    let data: VtData = graphql(token, VIEWER_TEAMS_QUERY, serde_json::json!({})).await?;
    Ok(data
        .viewer
        .and_then(|v| v.team_memberships)
        .map(|c| c.nodes)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.team.map(|t| t.key))
        .collect())
}

const TRIAGE_INBOX_QUERY: &str = r#"
query TriageInbox($filter: IssueFilter) {
  issues(filter: $filter, first: 100) {
    nodes {
      identifier title priority createdAt slaBreachesAt snoozedUntilAt
      state { name type }
      team { key }
      assignee { displayName }
      labels { nodes { name } }
    }
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
    labels: LabelConn,
}
#[derive(Deserialize)]
struct IssuesConn {
    nodes: Vec<TriageRow>,
}
#[derive(Deserialize)]
struct TriageInboxData {
    issues: IssuesConn,
}

/// The triage inbox for a repo's workspace, scoped to the viewer's teams.
/// Active issues first, snoozed sunk to the bottom (by SLA breach time within).
pub async fn triage_tickets(db: &Db, repo: &str) -> Result<Vec<TriageTicket>> {
    let token = repo_token(db, repo).await?;
    let keys = viewer_team_keys(&token).await.unwrap_or_default();
    let mut filter = serde_json::json!({ "state": { "type": { "eq": "triage" } } });
    if !keys.is_empty() {
        filter["team"] = serde_json::json!({ "key": { "in": keys } });
    }
    let data: TriageInboxData =
        graphql(&token, TRIAGE_INBOX_QUERY, serde_json::json!({ "filter": filter })).await?;
    let now = now_ms();

    let mut rows: Vec<(TriageTicket, bool, i64)> = data
        .issues
        .nodes
        .into_iter()
        .map(|r| {
            let snooze_ms = r.snoozed_until_at.as_deref().and_then(parse_ms);
            let snoozed = core_linear::is_snoozed(snooze_ms, now);
            let sla_ms = r.sla_breaches_at.as_deref().and_then(parse_ms);
            let labels: Vec<String> = r.labels.nodes.into_iter().map(|l| l.name).collect();
            let team = r.team.map(|t| t.key);
            let assignee = r.assignee.and_then(|u| u.display_name);
            let age = r
                .created_at
                .as_deref()
                .and_then(parse_ms)
                .map(|c| core_linear::relative_time(c, now))
                .unwrap_or_default();
            let ticket = TriageTicket {
                id: r.identifier,
                title: r.title,
                priority: core_linear::map_priority(r.priority),
                age,
                meta: triage_meta(assignee.as_deref(), &labels),
                team,
                sla: core_linear::format_sla(sla_ms, now),
                snoozed_until: snoozed.then(|| snooze_ms.map(snooze_label)).flatten(),
            };
            (ticket, snoozed, sla_ms.unwrap_or(i64::MAX))
        })
        .collect();

    // Active first, snoozed last; within each, soonest SLA breach first.
    rows.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)));
    Ok(rows.into_iter().map(|(t, _, _)| t).collect())
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
    creator { displayName avatarUrl }
    comments(first: 100) {
      nodes {
        body createdAt parent { id }
        user { displayName avatarUrl }
        botActor { name avatarUrl }
        children {
          nodes {
            body createdAt
            user { displayName avatarUrl }
            botActor { name avatarUrl }
          }
        }
      }
    }
  }
}
"#;

#[derive(Deserialize)]
struct ParentRef {
    #[allow(dead_code)]
    id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
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
    children: Option<CommentConn>,
}
#[derive(Deserialize, Default)]
struct CommentConn {
    #[serde(default)]
    nodes: Vec<CommentNode>,
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
struct StatesConn {
    #[serde(default)]
    nodes: Vec<WorkflowStateNode>,
}
#[derive(Deserialize, Default)]
struct TeamStates {
    #[serde(default)]
    states: StatesConn,
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
    labels: LabelConn,
    project: Option<ProjectNode>,
    #[serde(default)]
    creator: Option<UserNode>,
    #[serde(default)]
    comments: CommentConn,
}
#[derive(Deserialize)]
struct IssueDetailData {
    issue: Option<IssueDetailNode>,
}

/// Map one comment (and its one level of threaded replies) into the domain
/// type, downloading inline images in each body.
async fn map_comment(
    client: &reqwest::Client,
    node: CommentNode,
    token: &str,
    now: i64,
) -> TriageComment {
    let rel = |ts: &Option<String>| {
        ts.as_deref()
            .and_then(parse_ms)
            .map(|m| core_linear::relative_time(m, now))
            .unwrap_or_default()
    };

    let mut child_nodes = node.children.map(|c| c.nodes).unwrap_or_default();
    child_nodes.sort_by_key(|c| c.created_at.as_deref().and_then(parse_ms).unwrap_or(0));
    let mut children = Vec::with_capacity(child_nodes.len());
    for ch in child_nodes {
        let (author, avatar_url) = actor(ch.user, ch.bot_actor);
        children.push(TriageComment {
            author,
            avatar_url,
            created: rel(&ch.created_at),
            body: inline_images(client, &ch.body, token).await,
            children: vec![],
        });
    }

    let (author, avatar_url) = actor(node.user, node.bot_actor);
    TriageComment {
        author,
        avatar_url,
        created: rel(&node.created_at),
        body: inline_images(client, &node.body, token).await,
        children,
    }
}

/// The full triage issue (description + comments) for the discussion pane, with
/// inline Linear-CDN images downloaded and embedded as data URIs.
pub async fn triage_detail(db: &Db, repo: &str, ticket_id: &str) -> Result<TriageDetail> {
    let token = repo_token(db, repo).await?;
    let data: IssueDetailData =
        graphql(&token, ISSUE_DETAIL_QUERY, serde_json::json!({ "id": ticket_id })).await?;
    let issue = data.issue.ok_or_else(|| anyhow!("issue {ticket_id} not found"))?;
    let now = now_ms();
    let client = reqwest::Client::new();

    let description = inline_images(&client, &issue.description.unwrap_or_default(), &token).await;

    // Top-level comments (replies hang off each via `children`), oldest first.
    let mut top: Vec<CommentNode> =
        issue.comments.nodes.into_iter().filter(|c| c.parent.is_none()).collect();
    top.sort_by_key(|c| c.created_at.as_deref().and_then(parse_ms).unwrap_or(0));
    let mut comments = Vec::with_capacity(top.len());
    for node in top {
        comments.push(map_comment(&client, node, &token, now).await);
    }

    let (author, author_avatar_url) = actor(issue.creator, None);
    let snooze_ms = issue.snoozed_until_at.as_deref().and_then(parse_ms);
    let state = issue.state;
    let state_id = state.as_ref().and_then(|s| s.id.clone());

    // The team's workflow states, ordered as in Linear, for the status picker.
    let mut state_nodes = issue.team.map(|t| t.states.nodes).unwrap_or_default();
    state_nodes.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap_or(std::cmp::Ordering::Equal));
    let states: Vec<WorkflowState> = state_nodes
        .into_iter()
        .map(|s| WorkflowState {
            id: s.id,
            name: s.name,
            type_: s.type_,
            color: s.color,
        })
        .collect();

    Ok(TriageDetail {
        id: issue.identifier,
        title: issue.title,
        priority: core_linear::map_priority(issue.priority),
        state: state.map(|s| s.name).unwrap_or_else(|| "Triage".into()),
        state_id,
        states,
        url: issue.url,
        author,
        author_avatar_url,
        created: issue
            .created_at
            .as_deref()
            .and_then(parse_ms)
            .map(|m| core_linear::relative_time(m, now))
            .unwrap_or_default(),
        labels: issue.labels.nodes.into_iter().map(|l| l.name).collect(),
        project: issue.project.and_then(|p| p.name),
        sla: core_linear::format_sla(issue.sla_breaches_at.as_deref().and_then(parse_ms), now),
        snoozed_until: core_linear::is_snoozed(snooze_ms, now)
            .then(|| snooze_ms.map(snooze_label))
            .flatten(),
        description,
        comments,
    })
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
pub async fn set_issue_state(db: &Db, repo: &str, ticket_id: &str, state_id: &str) -> Result<()> {
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
    let token = repo_token(db, repo).await?;
    let data: SetStateData = graphql(
        &token,
        SET_STATE_MUTATION,
        serde_json::json!({ "id": ticket_id, "stateId": state_id }),
    )
    .await?;
    if data.issue_update.map(|u| u.success).unwrap_or(false) {
        Ok(())
    } else {
        bail!("Linear rejected the status change (the connected token may be read-only — reconnect Linear to grant write access)")
    }
}

const TRIAGE_SCHEDULES_QUERY: &str = r#"
query TriageSchedules {
  viewer {
    id
    teamMemberships(first: 100) {
      nodes {
        team {
          key name
          triageResponsibility {
            currentUser { id }
            timeSchedule { name entries { startsAt endsAt userId userEmail } }
          }
        }
      }
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
    name: String,
    #[serde(default)]
    triage_responsibility: Option<TriageResp>,
}
#[derive(Deserialize)]
struct Membership {
    #[serde(default)]
    team: Option<TeamNode>,
}
#[derive(Deserialize)]
struct MembershipConn {
    #[serde(default)]
    nodes: Vec<Membership>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedViewer {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    team_memberships: Option<MembershipConn>,
}
#[derive(Deserialize)]
struct SchedQueryData {
    viewer: Option<SchedViewer>,
}

#[derive(Deserialize)]
struct UserIdName {
    id: String,
    #[serde(rename = "displayName")]
    display_name: String,
}
#[derive(Deserialize)]
struct UsersConn {
    #[serde(default)]
    nodes: Vec<UserIdName>,
}
#[derive(Deserialize)]
struct UsersData {
    users: UsersConn,
}

/// The viewer's triage on-call rotations — one per team that has a
/// time-schedule-backed triage responsibility (empty when none do). Rotations
/// the viewer participates in are surfaced first.
pub async fn triage_schedule(db: &Db, repo: &str) -> Result<Vec<TriageSchedule>> {
    let token = repo_token(db, repo).await?;
    let data: SchedQueryData = graphql(&token, TRIAGE_SCHEDULES_QUERY, serde_json::json!({})).await?;
    let Some(viewer) = data.viewer else {
        return Ok(Vec::new());
    };
    let viewer_id = viewer.id;

    // Teams whose triage responsibility is backed by a non-empty schedule.
    let teams: Vec<TeamNode> = viewer
        .team_memberships
        .map(|m| m.nodes)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.team)
        .filter(|t| {
            t.triage_responsibility
                .as_ref()
                .and_then(|r| r.time_schedule.as_ref())
                .is_some_and(|s| !s.entries.is_empty())
        })
        .collect();
    if teams.is_empty() {
        return Ok(Vec::new());
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
    let names = resolve_user_names(&token, &ids).await.unwrap_or_default();
    let now = now_ms();

    let mut schedules: Vec<TriageSchedule> = teams
        .into_iter()
        .map(|t| build_schedule(t, viewer_id.as_deref(), &names, now))
        .collect();
    // Surface rotations the viewer is part of first.
    schedules.sort_by_key(|s| !s.shifts.iter().any(|sh| sh.is_me));
    Ok(schedules)
}

fn build_schedule(
    team: TeamNode,
    viewer_id: Option<&str>,
    names: &std::collections::HashMap<String, String>,
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
            let name = e
                .user_id
                .as_deref()
                .and_then(|id| names.get(id).cloned())
                .or(e.user_email)
                .unwrap_or_else(|| "Unknown".into());
            (
                TriageShift {
                    name,
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
            .and_then(|id| names.get(id).cloned())
    });
    let current_is_me = current
        .map(|s| s.is_me)
        .unwrap_or_else(|| viewer_id.is_some() && current_user_id.as_deref() == viewer_id);

    TriageSchedule {
        team: team.name,
        schedule_name,
        current_name,
        current_is_me,
        shifts,
    }
}

async fn resolve_user_names(
    token: &str,
    ids: &[String],
) -> Result<std::collections::HashMap<String, String>> {
    if ids.is_empty() {
        return Ok(Default::default());
    }
    const QUERY: &str = r#"
query ResolveUsers($ids: [ID!]!) {
  users(filter: { id: { in: $ids } }, first: 250) { nodes { id displayName } }
}
"#;
    let data: UsersData = graphql(token, QUERY, serde_json::json!({ "ids": ids })).await?;
    Ok(data
        .users
        .nodes
        .into_iter()
        .map(|u| (u.id, u.display_name))
        .collect())
}

// ── Timestamp + image helpers ──────────────────────────────────────────────

/// Parse an RFC3339 timestamp (Linear's format) to epoch milliseconds.
fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Short wake label for a snoozed issue, e.g. "Jun 30".
fn snooze_label(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.format("%b %-d").to_string())
        .unwrap_or_else(|| "soon".into())
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

/// Replace `https://uploads.linear.app/...` image URLs in markdown with
/// base64 data URIs, downloading each with the access token. URLs that fail to
/// fetch are left untouched.
async fn inline_images(client: &reqwest::Client, md: &str, token: &str) -> String {
    const HOST: &str = "https://uploads.linear.app";
    if !md.contains(HOST) {
        return md.to_string();
    }
    let bytes = md.as_bytes();
    let mut urls: Vec<String> = Vec::new();
    let mut search = 0;
    while let Some(rel) = md[search..].find(HOST) {
        let start = search + rel;
        let mut end = start;
        while end < md.len()
            && !matches!(
                bytes[end],
                b')' | b' ' | b'\n' | b'\t' | b'"' | b']' | b'>' | b'<'
            )
        {
            end += 1;
        }
        let url = md[start..end].to_string();
        if !urls.contains(&url) {
            urls.push(url);
        }
        search = end;
    }
    let mut out = md.to_string();
    for url in urls {
        if let Ok(uri) = fetch_data_uri(client, &url, token).await {
            out = out.replace(&url, &uri);
        }
    }
    out
}

async fn fetch_data_uri(client: &reqwest::Client, url: &str, token: &str) -> Result<String> {
    let res = client.get(url).bearer_auth(token).send().await?;
    if !res.status().is_success() {
        bail!("image fetch returned {}", res.status());
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let data = res.bytes().await?;
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&data)
    ))
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
    let listener = TcpListener::bind(("127.0.0.1", OAUTH_PORT)).context("binding oauth port")?;
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
                let (code, returned_state) = parse_callback(path);
                let ok = code.is_some() && returned_state.as_deref() == Some(expected_state);

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
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Extract `code` and `state` from a callback path like `/?code=…&state=…`.
fn parse_callback(path: &str) -> (Option<String>, Option<String>) {
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            match k {
                "code" => code = Some(v.to_string()),
                "state" => state = Some(v.to_string()),
                _ => {}
            }
        }
    }
    (code, state)
}

/// Exchange an auth code for `(access_token, refresh_token, expires_at_ms)`.
async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<(String, String, i64)> {
    let res = reqwest::Client::new()
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
    #[derive(Deserialize)]
    struct Resp {
        data: Option<Data>,
    }

    let res = reqwest::Client::new()
        .post(GRAPHQL_URL)
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "query": "query { viewer { organization { urlKey name } } }" }))
        .send()
        .await?;
    let resp: Resp = res.json().await?;
    let org = resp
        .data
        .map(|d| d.viewer.organization)
        .ok_or_else(|| anyhow!("no organization"))?;
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
