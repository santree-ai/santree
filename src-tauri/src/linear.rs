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
use serde::Deserialize;
use sha2::{Digest, Sha256};

use santree_core::domain::{LinearOrg, LinearStatus, Task, TaskStatus};
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
        ("scope", "read"),
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
