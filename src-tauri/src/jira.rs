//! Jira Cloud integration: multi-site token store (OS keychain), OAuth 3LO +
//! PKCE connect flow, and REST API calls that turn Jira issues into the same
//! domain types the Linear integration produces. OAuth tokens live in the OS
//! keychain; the site's non-secret metadata and the repo↔site links live in the
//! app database; pure mapping lives in `santree_core::jira`.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use santree_core::domain::{
    JiraSite, JiraStatus, Task, TeamRef, TicketRef, TriageComment, TriageDetail, TriageSchedule,
    TriageTicket, WorkflowState,
};
use santree_core::jira as core_jira;

use crate::db::{now_ms, Db};
use crate::gql;
use crate::oauth::{self, Tokens};

// ── Provider constants ─────────────────────────────────────────────────────

const CLIENT_ID: &str = "bkJ1zlBHu7FSAVuHBxFT3L5qyS1aAGIb";
const CLIENT_SECRET: &str =
    "ATOA18BvHeCPhhWd_TvFt2OnlK1V95wd6Hq0vvui1rjQwIvqEZarPNFfiFPKQqPCJlLj0927EC81";
const AUTHORIZE_URL: &str = "https://auth.atlassian.com/authorize";
const TOKEN_URL: &str = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL: &str = "https://api.atlassian.com/oauth/token/accessible-resources";

fn api_url(cloud_id: &str, path: &str) -> String {
    format!("https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/{path}")
}

/// Status-category key → hex color for the status-picker dots.
fn status_category_color(key: &str) -> String {
    match key {
        "new" => "#42526E".into(),
        "indeterminate" => "#0052CC".into(),
        "done" => "#00875A".into(),
        _ => "#42526E".into(),
    }
}

// ── DB layer ───────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct SiteRow {
    cloud_id: String,
    site_name: String,
    site_url: String,
    expires_at: i64,
    scopes: String,
}

async fn site_row(db: &Db, cloud_id: &str) -> Result<Option<SiteRow>> {
    Ok(sqlx::query_as::<_, SiteRow>(
        "SELECT cloud_id, site_name, site_url, expires_at, scopes FROM jira_sites WHERE cloud_id = ?",
    )
    .bind(cloud_id)
    .fetch_optional(db)
    .await?)
}

async fn upsert_site(db: &Db, site: &SiteRow, tokens: Tokens) -> Result<()> {
    save_tokens(&site.cloud_id, tokens).await?;
    sqlx::query(
        "INSERT INTO jira_sites (cloud_id, site_name, site_url, expires_at, scopes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cloud_id) DO UPDATE SET
           site_name = excluded.site_name,
           site_url  = excluded.site_url,
           expires_at = excluded.expires_at,
           scopes = excluded.scopes",
    )
    .bind(&site.cloud_id)
    .bind(&site.site_name)
    .bind(&site.site_url)
    .bind(site.expires_at)
    .bind(&site.scopes)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn sites_by_name(db: &Db) -> Result<Vec<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT cloud_id, site_name FROM jira_sites ORDER BY site_name",
    )
    .fetch_all(db)
    .await?)
}

pub async fn list_sites(db: &Db) -> Result<Vec<JiraSite>> {
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT cloud_id, site_name, site_url, scopes FROM jira_sites ORDER BY site_name",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(cloud_id, site_name, site_url, scopes)| JiraSite {
            can_write: scopes_allow_write(&scopes),
            cloud_id,
            site_name,
            site_url,
        })
        .collect())
}

fn scopes_allow_write(scopes: &str) -> bool {
    scopes.split(',').any(|s| s.trim() == "write:jira-work")
}

pub(crate) fn resolved_site<'a>(
    sites: &'a [(String, String)],
    linked: Option<&str>,
) -> Option<&'a (String, String)> {
    linked
        .and_then(|id| sites.iter().find(|(cid, _)| cid == id))
        .or_else(|| sites.first())
}

async fn resolve_cloud_id(db: &Db, repo: &str) -> Result<Option<String>> {
    let linked: Option<Option<String>> =
        sqlx::query_scalar("SELECT jira_cloud_id FROM repos WHERE name = ?")
            .bind(repo)
            .fetch_optional(db)
            .await?;
    let sites = sites_by_name(db).await?;
    Ok(resolved_site(&sites, linked.flatten().as_deref()).map(|(id, _)| id.clone()))
}

pub async fn set_repo_site(db: &Db, repo: &str, cloud_id: Option<String>) -> Result<()> {
    // A repo has one tracker: linking a site takes it off Linear, while clearing
    // the link leaves a Linear link alone.
    let affected = sqlx::query(
        "UPDATE repos SET jira_cloud_id = ?,
           linear_org_slug = CASE WHEN ? IS NULL THEN linear_org_slug ELSE NULL END
         WHERE name = ?",
    )
    .bind(cloud_id.clone())
    .bind(cloud_id)
    .bind(repo)
    .execute(db)
    .await?
    .rows_affected();
    if affected == 0 {
        bail!("repo '{repo}' is not registered");
    }
    Ok(())
}

pub async fn auth_status(db: &Db, repo: &str) -> Result<JiraStatus> {
    let sites = list_sites(db).await?;
    let cloud_id = resolve_cloud_id(db, repo).await?;
    let resolved = cloud_id
        .as_ref()
        .and_then(|id| sites.iter().find(|s| &s.cloud_id == id));
    Ok(JiraStatus {
        authenticated: !sites.is_empty(),
        site_name: resolved.map(|s| s.site_name.clone()),
        site_url: resolved.map(|s| s.site_url.clone()),
        cloud_id,
        can_write: resolved.is_some_and(|s| s.can_write),
    })
}

// ── Token wrappers ─────────────────────────────────────────────────────────

async fn load_tokens(cloud_id: &str) -> Result<Option<Tokens>> {
    oauth::load_tokens("jira", cloud_id).await
}

async fn save_tokens(cloud_id: &str, tokens: Tokens) -> Result<()> {
    oauth::save_tokens("jira", cloud_id, tokens).await
}

/// One lock for every Jira site, not one per site: the sites connected in one
/// authorization share a refresh token, and two of them rotating it at once would
/// spend it twice — the second refresh failing on a token the first revoked.
fn refresh_lock(_cloud_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    oauth::refresh_lock("jira", "*")
}

// ── Token refresh ──────────────────────────────────────────────────────────

async fn site_credentials(db: &Db, cloud_id: &str) -> Result<(SiteRow, Tokens)> {
    let row = site_row(db, cloud_id)
        .await?
        .ok_or_else(|| anyhow!("Jira site {cloud_id} not connected"))?;
    let tokens = load_tokens(cloud_id).await?.ok_or_else(|| {
        anyhow!(
            "no Jira credential for site {cloud_id} in the OS keychain — reconnect it in Settings"
        )
    })?;
    Ok((row, tokens))
}

async fn valid_token(db: &Db, cloud_id: &str) -> Result<String> {
    let (row, tokens) = site_credentials(db, cloud_id).await?;
    if oauth::usable_at(row.expires_at, now_ms()) {
        return Ok(tokens.access);
    }
    let lock = refresh_lock(cloud_id);
    let _guard = lock.lock().await;
    let (row, tokens) = site_credentials(db, cloud_id).await?;
    if oauth::usable_at(row.expires_at, now_ms()) {
        return Ok(tokens.access);
    }
    rotate(db, row, tokens).await
}

async fn force_refresh(db: &Db, cloud_id: &str, spent: &str) -> Result<String> {
    let lock = refresh_lock(cloud_id);
    let _guard = lock.lock().await;
    let (row, tokens) = site_credentials(db, cloud_id).await?;
    if tokens.access != spent {
        return Ok(tokens.access);
    }
    rotate(db, row, tokens).await
}

async fn rotate(db: &Db, row: SiteRow, tokens: Tokens) -> Result<String> {
    let body = oauth::token_request(
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("refresh_token", tokens.refresh.as_str()),
        ],
        "Jira token refresh",
    )
    .await?;
    let updated = SiteRow {
        cloud_id: row.cloud_id,
        site_name: row.site_name,
        site_url: row.site_url,
        expires_at: now_ms() + body.expires_in * 1000,
        scopes: body
            .scope
            .as_ref()
            .map(oauth::GrantedScope::as_csv)
            .unwrap_or(row.scopes),
    };
    let rotated = Tokens {
        access: body.access_token,
        refresh: body.refresh_token,
    };
    // Atlassian revokes the spent refresh token for the whole grant, and `connect`
    // stored that one grant under every site it reaches — so each site still
    // holding the spent token takes the new pair, or it is left with a dead one.
    for (cloud_id, _) in sites_by_name(db).await? {
        if cloud_id == updated.cloud_id {
            continue;
        }
        if load_tokens(&cloud_id)
            .await?
            .is_some_and(|t| t.refresh == tokens.refresh)
        {
            save_tokens(&cloud_id, rotated.clone()).await?;
            sqlx::query("UPDATE jira_sites SET expires_at = ? WHERE cloud_id = ?")
                .bind(updated.expires_at)
                .bind(&cloud_id)
                .execute(db)
                .await?;
        }
    }
    upsert_site(db, &updated, rotated.clone()).await?;
    Ok(rotated.access)
}

// ── REST session ───────────────────────────────────────────────────────────

struct Session<'a> {
    db: &'a Db,
    cloud_id: String,
    site_url: String,
    token: tokio::sync::RwLock<String>,
}

impl Session<'_> {
    async fn token(&self) -> String {
        self.token.read().await.clone()
    }

    fn api_url(&self, path: &str) -> String {
        api_url(&self.cloud_id, path)
    }

    fn issue_url(&self, key: &str) -> String {
        format!("{}/browse/{key}", self.site_url)
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let spent = self.token().await;
        let url = self.api_url(path);
        let req = gql::client().get(&url).bearer_auth(&spent);
        let res = gql::send(req, "Jira").await?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            log::warn!(
                "Jira rejected the stored access token for site {} — refreshing and retrying",
                self.cloud_id
            );
            let fresh = force_refresh(self.db, &self.cloud_id, &spent).await?;
            *self.token.write().await = fresh.clone();
            let req = gql::client().get(&url).bearer_auth(&fresh);
            let res = gql::send(req, "Jira").await?;
            return decode_response(res).await;
        }
        decode_response(res).await
    }

    async fn get_with_query<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, &str)],
    ) -> Result<T> {
        let spent = self.token().await;
        let url = self.api_url(path);
        let req = gql::client().get(&url).bearer_auth(&spent).query(params);
        let res = gql::send(req, "Jira").await?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            log::warn!(
                "Jira rejected the stored access token for site {} — refreshing and retrying",
                self.cloud_id
            );
            let fresh = force_refresh(self.db, &self.cloud_id, &spent).await?;
            *self.token.write().await = fresh.clone();
            let req = gql::client().get(&url).bearer_auth(&fresh).query(params);
            let res = gql::send(req, "Jira").await?;
            return decode_response(res).await;
        }
        decode_response(res).await
    }

    async fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T> {
        let spent = self.token().await;
        let url = self.api_url(path);
        let req = gql::client().post(&url).bearer_auth(&spent).json(body);
        let res = gql::send(req, "Jira").await?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            log::warn!(
                "Jira rejected the stored access token for site {} — refreshing and retrying",
                self.cloud_id
            );
            let fresh = force_refresh(self.db, &self.cloud_id, &spent).await?;
            *self.token.write().await = fresh.clone();
            let req = gql::client().post(&url).bearer_auth(&fresh).json(body);
            let res = gql::send(req, "Jira").await?;
            return decode_response(res).await;
        }
        decode_response(res).await
    }

    async fn post_no_content(&self, path: &str, body: &serde_json::Value) -> Result<()> {
        let spent = self.token().await;
        let url = self.api_url(path);
        let req = gql::client().post(&url).bearer_auth(&spent).json(body);
        let res = gql::send(req, "Jira").await?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            log::warn!(
                "Jira rejected the stored access token for site {} — refreshing and retrying",
                self.cloud_id
            );
            let fresh = force_refresh(self.db, &self.cloud_id, &spent).await?;
            *self.token.write().await = fresh.clone();
            let req = gql::client().post(&url).bearer_auth(&fresh).json(body);
            let res = gql::send(req, "Jira").await?;
            check_status(&res)?;
            return Ok(());
        }
        check_status(&res)?;
        Ok(())
    }
}

async fn decode_response<T: DeserializeOwned>(res: reqwest::Response) -> Result<T> {
    if !res.status().is_success() {
        let status = res.status();
        let body: String = res
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect();
        bail!("Jira API error ({status}): {body}");
    }
    res.json().await.context("decoding Jira response")
}

fn check_status(res: &reqwest::Response) -> Result<()> {
    if res.status().is_success() {
        Ok(())
    } else {
        bail!("Jira API error ({})", res.status());
    }
}

async fn repo_session<'a>(db: &'a Db, repo: &str) -> Result<Option<Session<'a>>> {
    let Some(cloud_id) = resolve_cloud_id(db, repo).await? else {
        return Ok(None);
    };
    site_session(db, cloud_id).await.map(Some)
}

async fn site_session(db: &Db, cloud_id: String) -> Result<Session<'_>> {
    let row = site_row(db, &cloud_id)
        .await?
        .ok_or_else(|| anyhow!("Jira site {cloud_id} not connected"))?;
    let token = valid_token(db, &cloud_id).await?;
    Ok(Session {
        db,
        cloud_id,
        site_url: row.site_url,
        token: tokio::sync::RwLock::new(token),
    })
}

// ── Read caches ────────────────────────────────────────────────────────────

type Slot<T> = std::sync::Arc<tokio::sync::Mutex<Option<(Instant, std::sync::Arc<T>)>>>;

struct TtlCache<T> {
    ttl: Duration,
    slots: std::sync::Mutex<HashMap<String, Slot<T>>>,
}

impl<T> TtlCache<T> {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            slots: Default::default(),
        }
    }

    fn slot(&self, key: &str) -> Slot<T> {
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    async fn get_or_fetch<F, Fut>(&self, key: &str, fetch: F) -> Result<(std::sync::Arc<T>, bool)>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let slot = self.slot(key);
        let mut entry = slot.lock().await;
        if let Some((at, value)) = entry.as_ref() {
            if at.elapsed() < self.ttl {
                return Ok((value.clone(), true));
            }
        }
        let value = std::sync::Arc::new(fetch().await?);
        *entry = Some((Instant::now(), value.clone()));
        Ok((value, false))
    }

    fn invalidate(&self, key: &str) {
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(key);
    }

    fn clear(&self) {
        self.slots.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

const ASSIGNED_ISSUES_TTL: Duration = Duration::from_secs(15);
const VIEWER_TTL: Duration = Duration::from_secs(300);

static ASSIGNED_ISSUES: std::sync::LazyLock<TtlCache<Vec<Task>>> =
    std::sync::LazyLock::new(|| TtlCache::new(ASSIGNED_ISSUES_TTL));

static VIEWER_CACHE: std::sync::LazyLock<TtlCache<ViewerInfo>> =
    std::sync::LazyLock::new(|| TtlCache::new(VIEWER_TTL));

fn issues_changed(cloud_id: &str) {
    ASSIGNED_ISSUES.invalidate(cloud_id);
}

fn invalidate_site_caches(cloud_id: &str) {
    ASSIGNED_ISSUES.invalidate(cloud_id);
    VIEWER_CACHE.invalidate(cloud_id);
}

pub fn invalidate_all_caches() {
    ASSIGNED_ISSUES.clear();
    VIEWER_CACHE.clear();
}

// ── Jira API response types ────────────────────────────────────────────────

#[derive(Deserialize)]
struct JiraIssue {
    #[serde(default)]
    key: String,
    #[serde(default)]
    fields: JiraFields,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraFields {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    status: Option<JiraStatusField>,
    #[serde(default)]
    priority: Option<JiraPriorityField>,
    #[serde(default)]
    project: Option<JiraProjectField>,
    #[serde(default)]
    assignee: Option<JiraUser>,
    #[serde(default)]
    reporter: Option<JiraUser>,
    #[serde(default)]
    creator: Option<JiraUser>,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    duedate: Option<String>,
    #[serde(default)]
    parent: Option<JiraParent>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    description: Option<serde_json::Value>,
    #[serde(default)]
    comment: Option<JiraCommentPage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraStatusField {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status_category: Option<JiraStatusCategory>,
}

#[derive(Deserialize)]
struct JiraStatusCategory {
    #[serde(default)]
    key: String,
}

#[derive(Deserialize)]
struct JiraPriorityField {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct JiraProjectField {
    #[serde(default)]
    key: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraUser {
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    avatar_urls: Option<JiraAvatarUrls>,
}

#[derive(Deserialize)]
struct JiraAvatarUrls {
    #[serde(default, rename = "48x48")]
    size_48: Option<String>,
}

#[derive(Deserialize)]
struct JiraParent {
    #[serde(default)]
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraCommentPage {
    #[serde(default)]
    comments: Vec<JiraCommentNode>,
    #[serde(default)]
    total: i64,
    #[serde(default)]
    start_at: i64,
}

#[derive(Deserialize)]
struct JiraCommentNode {
    #[serde(default)]
    id: String,
    #[serde(default)]
    author: Option<JiraUser>,
    #[serde(default)]
    body: Option<serde_json::Value>,
    #[serde(default)]
    created: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransitionsResponse {
    #[serde(default)]
    transitions: Vec<JiraTransition>,
}

#[derive(Deserialize)]
struct JiraTransition {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    to: Option<JiraTransitionTarget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraTransitionTarget {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status_category: Option<JiraStatusCategory>,
}

#[derive(Clone)]
struct ViewerInfo {
    account_id: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MyselfResponse {
    #[serde(default)]
    account_id: String,
    #[serde(default)]
    display_name: String,
}

#[derive(Deserialize)]
struct AccessibleResource {
    id: String,
    name: String,
    url: String,
}

// ── Viewer ─────────────────────────────────────────────────────────────────

async fn viewer(session: &Session<'_>) -> Result<std::sync::Arc<ViewerInfo>> {
    let (info, from_cache) = VIEWER_CACHE
        .get_or_fetch(&session.cloud_id, || fetch_viewer(session))
        .await?;
    if !from_cache {
        log::info!(
            "fetched Jira viewer for site {}: {}",
            session.cloud_id,
            info.display_name
        );
    }
    Ok(info)
}

async fn fetch_viewer(session: &Session<'_>) -> Result<ViewerInfo> {
    let res: MyselfResponse = session.get("myself").await?;
    Ok(ViewerInfo {
        account_id: res.account_id,
        display_name: res.display_name,
    })
}

// ── Issue mapping ──────────────────────────────────────────────────────────

fn map_issue(issue: &JiraIssue) -> Task {
    let status_name = issue
        .fields
        .status
        .as_ref()
        .map(|s| s.name.as_str())
        .unwrap_or("Unknown");
    let category_key = issue
        .fields
        .status
        .as_ref()
        .and_then(|s| s.status_category.as_ref())
        .map(|c| c.key.as_str())
        .unwrap_or("new");
    let priority_name = issue
        .fields
        .priority
        .as_ref()
        .map(|p| p.name.as_str())
        .unwrap_or_default();

    let project_key = issue
        .fields
        .project
        .as_ref()
        .map(|p| p.key.clone())
        .unwrap_or_default();
    let project_name = issue
        .fields
        .project
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_default();

    let team = if !project_key.is_empty() {
        Some(TeamRef {
            key: project_key,
            name: Some(project_name.clone()),
        })
    } else {
        None
    };

    let status = core_jira::map_status(category_key, status_name);
    let assignee = issue
        .fields
        .assignee
        .as_ref()
        .and_then(|u| u.display_name.clone());
    let assignee_avatar_url = issue
        .fields
        .assignee
        .as_ref()
        .and_then(|u| u.avatar_urls.as_ref())
        .and_then(|a| a.size_48.clone());

    Task {
        id: issue.key.clone(),
        title: issue.fields.summary.clone(),
        priority: core_jira::map_priority(priority_name),
        team,
        estimate: None,
        cycle: None,
        due_date: issue.fields.duedate.clone(),
        project: project_name,
        project_color: None,
        project_icon: None,
        project_target_date: None,
        project_milestone: None,
        parent_id: issue.fields.parent.as_ref().and_then(|p| p.key.clone()),
        status,
        ready: status.is_startable(),
        blocked_by: vec![],
        actionable: true,
        assignee,
        assignee_avatar_url,
        x: 0,
        y: 0,
    }
}

// ── Public reads ───────────────────────────────────────────────────────────

pub async fn list_issues(db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
    let Some(cloud_id) = resolve_cloud_id(db, repo).await? else {
        return Ok(None);
    };
    let (tasks, from_cache) = ASSIGNED_ISSUES
        .get_or_fetch(&cloud_id, || fetch_assigned_issues(db, cloud_id.clone()))
        .await?;
    if from_cache {
        log::debug!(
            "served {} Jira issues for {repo} from the {cloud_id} cache",
            tasks.len()
        );
    } else {
        log::info!(
            "fetched {} Jira issues for {repo} (site {cloud_id})",
            tasks.len()
        );
    }
    Ok(Some(tasks.as_ref().clone()))
}

async fn fetch_assigned_issues(db: &Db, cloud_id: String) -> Result<Vec<Task>> {
    let session = site_session(db, cloud_id).await?;
    let jql = "assignee = currentUser() AND statusCategory != \"Done\" ORDER BY updated DESC";
    let fields = "summary,status,priority,project,assignee,duedate,parent,labels";
    let issues = search_all(&session, jql, fields, 100).await?;

    let mut tasks: Vec<Task> = issues.iter().map(map_issue).collect();
    apply_subtask_dependencies(&mut tasks);
    santree_core::layout::layout_tasks(&mut tasks);
    Ok(tasks)
}

/// One page of `GET /search/jql`, the enhanced search that replaced `/search`
/// (Atlassian CHANGE-2046). It pages by an opaque token instead of an offset and
/// reports no total, so "is there more" is the token and `isLast`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JqlSearchPage {
    #[serde(default)]
    issues: Vec<JiraIssue>,
    #[serde(default)]
    next_page_token: Option<String>,
    #[serde(default)]
    is_last: Option<bool>,
}

/// Every issue a JQL query matches, page by page. `fields` must be spelled out:
/// the enhanced search returns bare ids unless asked for more.
async fn search_all(
    session: &Session<'_>,
    jql: &str,
    fields: &str,
    page_size: i64,
) -> Result<Vec<JiraIssue>> {
    let max_results = page_size.to_string();
    let mut all = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut params = vec![
            ("jql", jql),
            ("fields", fields),
            ("maxResults", max_results.as_str()),
        ];
        if let Some(token) = token.as_deref() {
            params.push(("nextPageToken", token));
        }
        let page: JqlSearchPage = session.get_with_query("search/jql", &params).await?;
        let empty = page.issues.is_empty();
        all.extend(page.issues);
        // A repeated token would loop forever; an empty page has nothing after it.
        match page.next_page_token {
            Some(next)
                if !empty && page.is_last != Some(true) && token.as_deref() != Some(&next) =>
            {
                token = Some(next);
            }
            _ => break,
        }
    }
    Ok(all)
}

fn apply_subtask_dependencies(tasks: &mut [Task]) {
    let children: Vec<(String, String, bool)> = tasks
        .iter()
        .filter_map(|task| {
            task.parent_id.as_ref().map(|parent| {
                (
                    parent.clone(),
                    task.id.clone(),
                    task.status == santree_core::domain::TaskStatus::Done,
                )
            })
        })
        .collect();
    let by_id: HashMap<String, usize> = tasks
        .iter()
        .enumerate()
        .map(|(index, task)| (task.id.clone(), index))
        .collect();
    for (parent_id, child_id, child_done) in children {
        let Some(&parent_index) = by_id.get(&parent_id) else {
            continue;
        };
        let parent = &mut tasks[parent_index];
        if !parent.blocked_by.contains(&child_id) {
            parent.blocked_by.push(child_id);
        }
        if !child_done {
            parent.ready = false;
        }
    }
}

const TICKET_LOOKUP_CAP: usize = 100;

/// Whether `id` is shaped like a Jira issue key (`PROJ-123`). What a PR title
/// yields is untrusted and gets spliced into JQL, so anything else is dropped
/// before the query is built.
fn is_issue_key(id: &str) -> bool {
    let Some((project, number)) = id.split_once('-') else {
        return false;
    };
    project.starts_with(|c: char| c.is_ascii_alphabetic())
        && project
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

pub async fn tickets_by_identifier(
    db: &Db,
    repo: &str,
    ids: &[String],
) -> Result<Option<Vec<TicketRef>>> {
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    let keys: Vec<&str> = ids
        .iter()
        .map(String::as_str)
        .filter(|id| is_issue_key(id))
        .take(TICKET_LOOKUP_CAP)
        .collect();
    if keys.is_empty() {
        return Ok(Some(vec![]));
    }
    let jql = format!("key in ({})", keys.join(", "));
    let issues = search_all(&session, &jql, "summary,priority,project", 100).await?;
    Ok(Some(
        issues
            .iter()
            .map(|issue| {
                let project_name = issue
                    .fields
                    .project
                    .as_ref()
                    .map(|p| p.name.clone())
                    .unwrap_or_default();
                let priority_name = issue
                    .fields
                    .priority
                    .as_ref()
                    .map(|p| p.name.as_str())
                    .unwrap_or_default();
                TicketRef {
                    identifier: issue.key.clone(),
                    title: issue.fields.summary.clone(),
                    priority: core_jira::map_priority(priority_name),
                    project: project_name,
                    project_color: None,
                    project_icon: None,
                    project_target_date: None,
                    project_milestone: None,
                }
            })
            .collect(),
    ))
}

/// Repo setting holding the JQL that defines that repo's Jira triage queue.
pub const TRIAGE_JQL_KEY: &str = "jira_triage_jql";

/// Jira has no triage state of its own, so the queue is whatever the repo's
/// query matches. A repo that sets none gets its assigned, not-yet-started issues.
pub const DEFAULT_TRIAGE_JQL: &str =
    "assignee = currentUser() AND statusCategory = \"To Do\" ORDER BY created DESC";

/// Longer than any hand-written query, and short enough that a pasted blob fails
/// here with a reason rather than as an opaque URI-too-long from Atlassian.
const TRIAGE_JQL_MAX: usize = 2000;

fn effective_triage_jql(stored: Option<&str>) -> Result<String> {
    match stored.map(str::trim).filter(|q| !q.is_empty()) {
        None => Ok(DEFAULT_TRIAGE_JQL.to_string()),
        Some(q) if q.len() > TRIAGE_JQL_MAX => {
            bail!("the Jira triage query is longer than {TRIAGE_JQL_MAX} characters")
        }
        Some(q) => Ok(q.to_string()),
    }
}

async fn triage_jql(db: &Db, repo: &str) -> Result<String> {
    let stored = crate::settings::get(db, &format!("repo:{repo}"), TRIAGE_JQL_KEY).await?;
    effective_triage_jql(stored.as_deref())
}

pub async fn triage_tickets(db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>> {
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    let me = viewer(&session).await?;
    let jql = triage_jql(db, repo).await?;
    let fields = "summary,status,priority,project,assignee,created";
    let issues = search_all(&session, &jql, fields, 100).await?;

    let tickets: Vec<TriageTicket> = issues
        .iter()
        .map(|issue| {
            let priority_name = issue
                .fields
                .priority
                .as_ref()
                .map(|p| p.name.as_str())
                .unwrap_or_default();
            let project_key = issue.fields.project.as_ref().map(|p| p.key.clone());
            let is_mine = issue
                .fields
                .assignee
                .as_ref()
                .and_then(|u| u.account_id.as_deref())
                .is_some_and(|id| id == me.account_id);
            TriageTicket {
                id: issue.key.clone(),
                title: issue.fields.summary.clone(),
                priority: core_jira::map_priority(priority_name),
                team: project_key,
                sla_breach_ms: None,
                snoozed_until_ms: None,
                mine: is_mine,
            }
        })
        .collect();
    log::info!("fetched {} Jira triage tickets for {repo}", tickets.len());
    Ok(Some(tickets))
}

pub async fn triage_detail(db: &Db, repo: &str, ticket_id: &str) -> Result<Option<TriageDetail>> {
    // A worktree cut from a plain branch hands over its slug as the id: that is
    // "no such issue", and only a real key may be placed in the request path.
    if !is_issue_key(ticket_id) {
        return Ok(None);
    }
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };

    let fields =
        "summary,status,priority,project,assignee,reporter,creator,created,duedate,description,comment,labels";
    let issue_res: Result<JiraIssue> = session
        .get(&format!("issue/{ticket_id}?fields={fields}"))
        .await;
    let issue = match issue_res {
        Ok(i) => i,
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("404") {
                return Ok(None);
            }
            return Err(e);
        }
    };

    let transitions_res: TransitionsResponse = session
        .get(&format!("issue/{ticket_id}/transitions"))
        .await?;

    let mut comments = Vec::new();
    if let Some(page) = &issue.fields.comment {
        for c in &page.comments {
            comments.push(map_comment(c));
        }
        let mut fetched = page.start_at + page.comments.len() as i64;
        while fetched < page.total {
            let more: JiraCommentPage = session
                .get_with_query(
                    &format!("issue/{ticket_id}/comment"),
                    &[("startAt", &fetched.to_string()), ("maxResults", "100")],
                )
                .await?;
            for c in &more.comments {
                comments.push(map_comment(c));
            }
            fetched += more.comments.len() as i64;
            if more.comments.is_empty() {
                break;
            }
        }
    }

    let status_name = issue
        .fields
        .status
        .as_ref()
        .map(|s| s.name.clone())
        .unwrap_or_else(|| "To Do".into());
    let priority_name = issue
        .fields
        .priority
        .as_ref()
        .map(|p| p.name.as_str())
        .unwrap_or_default();

    let author = issue
        .fields
        .creator
        .as_ref()
        .or(issue.fields.reporter.as_ref())
        .and_then(|u| u.display_name.clone())
        .unwrap_or_else(|| "Unknown".into());
    let author_avatar_url = issue
        .fields
        .creator
        .as_ref()
        .or(issue.fields.reporter.as_ref())
        .and_then(|u| u.avatar_urls.as_ref())
        .and_then(|a| a.size_48.clone());

    let (assignee, assignee_avatar_url) = match &issue.fields.assignee {
        Some(user) => (
            user.display_name.clone(),
            user.avatar_urls.as_ref().and_then(|a| a.size_48.clone()),
        ),
        None => (None, None),
    };

    let states: Vec<WorkflowState> = transitions_res
        .transitions
        .iter()
        .map(|t| {
            let cat_key =
                t.to.as_ref()
                    .and_then(|to| to.status_category.as_ref())
                    .map(|c| c.key.as_str())
                    .unwrap_or("new");
            let target_name =
                t.to.as_ref()
                    .map(|to| to.name.clone())
                    .unwrap_or_else(|| t.name.clone());
            WorkflowState {
                id: t.id.clone(),
                name: target_name,
                type_: cat_key.to_string(),
                color: status_category_color(cat_key),
            }
        })
        .collect();

    let description = issue
        .fields
        .description
        .as_ref()
        .map(adf_to_markdown)
        .unwrap_or_default();

    let created_at_ms = issue
        .fields
        .created
        .as_deref()
        .and_then(parse_jira_datetime)
        .map(|v| v as f64)
        .unwrap_or_default();

    let project = issue.fields.project.as_ref().map(|p| p.name.clone());

    Ok(Some(TriageDetail {
        id: issue.key.clone(),
        title: issue.fields.summary.clone(),
        priority: core_jira::map_priority(priority_name),
        tracker_name: "Jira".into(),
        state: status_name,
        state_id: None,
        states,
        url: session.issue_url(&issue.key),
        author,
        author_avatar_url,
        created_at_ms,
        labels: issue.fields.labels.clone(),
        project,
        project_milestone: None,
        assignee,
        assignee_avatar_url,
        estimate: None,
        cycle: None,
        due_date: issue.fields.duedate.clone(),
        sla_breach_ms: None,
        snoozed_until_ms: None,
        description,
        comments,
    }))
}

fn map_comment(c: &JiraCommentNode) -> TriageComment {
    let author = c
        .author
        .as_ref()
        .and_then(|u| u.display_name.clone())
        .unwrap_or_else(|| "Unknown".into());
    let avatar_url = c
        .author
        .as_ref()
        .and_then(|u| u.avatar_urls.as_ref())
        .and_then(|a| a.size_48.clone());
    let body = c.body.as_ref().map(adf_to_markdown).unwrap_or_default();
    let created_at_ms = c
        .created
        .as_deref()
        .and_then(parse_jira_datetime)
        .map(|v| v as f64)
        .unwrap_or_default();
    TriageComment {
        id: c.id.clone(),
        author,
        avatar_url,
        created_at_ms,
        body,
        children: vec![],
    }
}

pub async fn triage_schedule(db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
    let Some(_) = resolve_cloud_id(db, repo).await? else {
        return Ok(None);
    };
    Ok(Some(Vec::new()))
}

// ── Public mutations ───────────────────────────────────────────────────────

pub async fn set_issue_state(
    db: &Db,
    repo: &str,
    ticket_id: &str,
    transition_id: &str,
) -> Result<Option<()>> {
    if !is_issue_key(ticket_id) {
        bail!("not a Jira issue key: {ticket_id}");
    }
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    let body = serde_json::json!({ "transition": { "id": transition_id } });
    session
        .post_no_content(&format!("issue/{ticket_id}/transitions"), &body)
        .await?;
    issues_changed(&session.cloud_id);
    Ok(Some(()))
}

pub async fn create_comment(
    db: &Db,
    repo: &str,
    ticket_id: &str,
    parent_id: Option<&str>,
    body: &str,
) -> Result<Option<()>> {
    if !is_issue_key(ticket_id) {
        bail!("not a Jira issue key: {ticket_id}");
    }
    // Jira comments are flat: a reply posted here would land unattached, reading
    // as a new comment. The UI offers no Reply on a Jira ticket; this holds it.
    if parent_id.is_some() {
        bail!("Jira comments can't be replied to in a thread");
    }
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    let adf = text_to_adf(body);
    let payload = serde_json::json!({ "body": adf });
    let _: serde_json::Value = session
        .post_json(&format!("issue/{ticket_id}/comment"), &payload)
        .await?;
    issues_changed(&session.cloud_id);
    Ok(Some(()))
}

/// Move a not-yet-started issue into progress when a worktree begins, so Jira
/// shows what is being worked on. Statuses are per-workflow, so the move is the
/// first transition whose target sits in the "in progress" category; an issue
/// already started or done, or a workflow with no such transition, stays where it
/// is. Needs a write-scoped site.
pub async fn move_issue_to_started(db: &Db, repo: &str, ticket_id: &str) -> Result<Option<()>> {
    if !is_issue_key(ticket_id) {
        return Ok(None);
    }
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    let issue: JiraIssue = session
        .get(&format!("issue/{ticket_id}?fields=status"))
        .await?;
    let category = issue
        .fields
        .status
        .as_ref()
        .and_then(|s| s.status_category.as_ref())
        .map(|c| c.key.as_str());
    if category != Some("new") {
        return Ok(Some(()));
    }
    let transitions: TransitionsResponse = session
        .get(&format!("issue/{ticket_id}/transitions"))
        .await?;
    let Some(start) = transitions.transitions.iter().find(|t| {
        t.to.as_ref()
            .and_then(|to| to.status_category.as_ref())
            .is_some_and(|c| c.key == "indeterminate")
    }) else {
        log::info!("{ticket_id} has no transition into an in-progress status; leaving it");
        return Ok(Some(()));
    };
    let body = serde_json::json!({ "transition": { "id": start.id } });
    session
        .post_no_content(&format!("issue/{ticket_id}/transitions"), &body)
        .await?;
    issues_changed(&session.cloud_id);
    Ok(Some(()))
}

// ── ADF (Atlassian Document Format) helpers ────────────────────────────────

fn adf_to_markdown(value: &serde_json::Value) -> String {
    let Some(content) = value.get("content").and_then(|c| c.as_array()) else {
        if let Some(text) = value.as_str() {
            return text.to_string();
        }
        return String::new();
    };
    content
        .iter()
        .map(adf_node_to_md)
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn adf_node_to_md(node: &serde_json::Value) -> String {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match node_type {
        "paragraph" => adf_inline_content(node),
        "heading" => {
            let level = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(1);
            let prefix = "#".repeat(level as usize);
            format!("{prefix} {}", adf_inline_content(node))
        }
        "bulletList" => node
            .get("content")
            .and_then(|c| c.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|item| format!("- {}", adf_inline_content(item)))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        "orderedList" => node
            .get("content")
            .and_then(|c| c.as_array())
            .map(|items| {
                items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| format!("{}. {}", i + 1, adf_inline_content(item)))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        "codeBlock" => {
            let lang = node
                .get("attrs")
                .and_then(|a| a.get("language"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            let text = adf_inline_content(node);
            format!("```{lang}\n{text}\n```")
        }
        "blockquote" => {
            let inner = node
                .get("content")
                .and_then(|c| c.as_array())
                .map(|items| {
                    items
                        .iter()
                        .map(adf_node_to_md)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            inner
                .lines()
                .map(|l| format!("> {l}"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        "rule" => "---".to_string(),
        "mediaSingle" | "mediaGroup" => node
            .get("content")
            .and_then(|c| c.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("attrs")
                            .and_then(|a| a.get("url"))
                            .and_then(|u| u.as_str())
                            .map(|url| format!("![image]({url})"))
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        _ => adf_inline_content(node),
    }
}

fn adf_inline_content(node: &serde_json::Value) -> String {
    let Some(content) = node.get("content").and_then(|c| c.as_array()) else {
        return node
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
    };
    content
        .iter()
        .map(|child| {
            let child_type = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match child_type {
                "text" => {
                    let text = child.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    apply_marks(text, child)
                }
                "hardBreak" => "\n".to_string(),
                "mention" => child
                    .get("attrs")
                    .and_then(|a| a.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("@someone")
                    .to_string(),
                "inlineCard" => child
                    .get("attrs")
                    .and_then(|a| a.get("url"))
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string(),
                "emoji" => child
                    .get("attrs")
                    .and_then(|a| a.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
                _ => adf_node_to_md(child),
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

fn apply_marks(text: &str, node: &serde_json::Value) -> String {
    let Some(marks) = node.get("marks").and_then(|m| m.as_array()) else {
        return text.to_string();
    };
    let mut result = text.to_string();
    for mark in marks {
        let mark_type = mark.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match mark_type {
            "strong" => result = format!("**{result}**"),
            "em" => result = format!("*{result}*"),
            "code" => result = format!("`{result}`"),
            "strike" => result = format!("~~{result}~~"),
            "link" => {
                if let Some(href) = mark
                    .get("attrs")
                    .and_then(|a| a.get("href"))
                    .and_then(|h| h.as_str())
                {
                    result = format!("[{result}]({href})");
                }
            }
            _ => {}
        }
    }
    result
}

fn text_to_adf(text: &str) -> serde_json::Value {
    // An ADF text node may not be empty, so a run of blank lines is one break
    // between paragraphs rather than a paragraph of nothing.
    let paragraphs: Vec<serde_json::Value> = text
        .split("\n\n")
        .map(|p| p.trim_matches('\n'))
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            serde_json::json!({
                "type": "paragraph",
                "content": [{ "type": "text", "text": p }]
            })
        })
        .collect();
    serde_json::json!({
        "type": "doc",
        "version": 1,
        "content": paragraphs
    })
}

// ── Timestamp helpers ──────────────────────────────────────────────────────

fn parse_jira_datetime(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .or_else(|| chrono::DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.3f%z").ok())
        .map(|dt| dt.timestamp_millis())
}

// ── OAuth PKCE connect flow ────────────────────────────────────────────────

pub async fn connect(db: &Db) -> Result<Vec<JiraSite>> {
    let verifier = oauth::b64url(&oauth::random_bytes(32));
    let challenge = oauth::pkce_challenge(&verifier);
    let state = oauth::hex(&oauth::random_bytes(16));

    let redirect_uri = format!("http://localhost:{}", oauth::OAUTH_PORT);
    let scope = "read:jira-work write:jira-work read:jira-user offline_access";
    let params = [
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri.as_str()),
        ("response_type", "code"),
        ("scope", scope),
        ("audience", "api.atlassian.com"),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("prompt", "consent"),
    ];
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={}", oauth::urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    oauth::open_browser(&format!("{AUTHORIZE_URL}?{query}"));

    let expected_state = state.clone();
    let code = tokio::task::spawn_blocking(move || oauth::wait_for_code(&expected_state, "Jira"))
        .await
        .context("oauth listener task")??;

    let (access_token, refresh_token, expires_at, scopes) =
        exchange_code(&code, &redirect_uri, &verifier).await?;

    let resources = fetch_accessible_resources(&access_token).await?;
    if resources.is_empty() {
        bail!("no Jira Cloud sites found for this Atlassian account");
    }

    // The tokens this account's previous grant was stored under, read before they
    // are replaced: a site still holding one of them but missing from the reply is
    // a site this account can no longer reach.
    let mut prior_grants = std::collections::HashSet::new();
    for resource in &resources {
        if let Some(tokens) = load_tokens(&resource.id).await? {
            prior_grants.insert(tokens.refresh);
        }
    }

    for resource in &resources {
        let site = SiteRow {
            cloud_id: resource.id.clone(),
            site_name: resource.name.clone(),
            site_url: resource.url.clone(),
            expires_at,
            scopes: scopes.clone(),
        };
        upsert_site(
            db,
            &site,
            Tokens {
                access: access_token.clone(),
                refresh: refresh_token.clone(),
            },
        )
        .await?;
        invalidate_site_caches(&resource.id);
        log::info!(
            "connected Jira Cloud site: {} ({})",
            resource.name,
            resource.id
        );
    }

    // Only sites on this account's own grant: another account's sites never held
    // these tokens, and are not this reply's to remove.
    let reached: std::collections::HashSet<&str> =
        resources.iter().map(|r| r.id.as_str()).collect();
    for (cloud_id, site_name) in sites_by_name(db).await? {
        if reached.contains(cloud_id.as_str()) {
            continue;
        }
        let same_grant = load_tokens(&cloud_id)
            .await?
            .is_some_and(|t| prior_grants.contains(&t.refresh));
        if !same_grant {
            continue;
        }
        sqlx::query("UPDATE repos SET jira_cloud_id = NULL WHERE jira_cloud_id = ?")
            .bind(&cloud_id)
            .execute(db)
            .await?;
        sqlx::query("DELETE FROM jira_sites WHERE cloud_id = ?")
            .bind(&cloud_id)
            .execute(db)
            .await?;
        invalidate_site_caches(&cloud_id);
        log::info!(
            "removed Jira site {site_name} ({cloud_id}): this account can no longer reach it"
        );
    }

    list_sites(db).await
}

async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<(String, String, i64, String)> {
    let body = oauth::token_request(
        TOKEN_URL,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ],
        "Jira token exchange",
    )
    .await?;
    Ok((
        body.access_token,
        body.refresh_token,
        now_ms() + body.expires_in * 1000,
        body.scope
            .as_ref()
            .map(oauth::GrantedScope::as_csv)
            .unwrap_or_default(),
    ))
}

async fn fetch_accessible_resources(token: &str) -> Result<Vec<AccessibleResource>> {
    let req = gql::client().get(RESOURCES_URL).bearer_auth(token);
    let res = gql::send(req, "Atlassian").await?;
    decode_response(res).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_category_colors() {
        assert_eq!(status_category_color("new"), "#42526E");
        assert_eq!(status_category_color("indeterminate"), "#0052CC");
        assert_eq!(status_category_color("done"), "#00875A");
        assert_eq!(status_category_color("unknown"), "#42526E");
    }

    #[test]
    fn scopes_write_detection() {
        assert!(scopes_allow_write("read:jira-work,write:jira-work"));
        assert!(scopes_allow_write("write:jira-work"));
        assert!(!scopes_allow_write("read:jira-work,read:jira-user"));
        assert!(!scopes_allow_write(""));
    }

    /// Keys reach JQL and URL paths, so only the `PROJ-123` shape gets through —
    /// a branch slug, a quote or a path segment never does.
    #[test]
    fn issue_keys_are_the_only_ids_that_reach_jira() {
        assert!(is_issue_key("SAN-12"));
        assert!(is_issue_key("A1_B-7"));
        assert!(!is_issue_key("feature-login"));
        assert!(!is_issue_key("SAN-"));
        assert!(!is_issue_key("1SAN-2"));
        assert!(!is_issue_key("SAN-1\") OR key in (\"X-1"));
        assert!(!is_issue_key("SAN-1/../../myself"));
        assert!(!is_issue_key("SAN-1?fields=*all"));
    }

    /// A repo that sets no query keeps the queue it always had, and a pasted blob
    /// is refused with a reason instead of reaching Atlassian.
    #[test]
    fn triage_query_falls_back_to_the_default_and_caps_its_length() {
        assert_eq!(effective_triage_jql(None).unwrap(), DEFAULT_TRIAGE_JQL);
        assert_eq!(
            effective_triage_jql(Some("   ")).unwrap(),
            DEFAULT_TRIAGE_JQL
        );
        assert_eq!(
            effective_triage_jql(Some(" project = KAN ")).unwrap(),
            "project = KAN"
        );
        assert!(effective_triage_jql(Some(&"x".repeat(TRIAGE_JQL_MAX + 1))).is_err());
    }

    /// A run of blank lines is one paragraph break, never an empty text node:
    /// Jira rejects the whole comment if one reaches it.
    #[test]
    fn text_to_adf_drops_empty_paragraphs() {
        let adf = text_to_adf("\n\nSee the issue.\n\n\n\nMore below.\n\n");
        let content = adf["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["content"][0]["text"], "See the issue.");
        assert_eq!(content[1]["content"][0]["text"], "More below.");
    }

    #[test]
    fn adf_paragraph_to_markdown() {
        let adf = serde_json::json!({
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": "Hello world" }]
            }]
        });
        assert_eq!(adf_to_markdown(&adf), "Hello world");
    }

    #[test]
    fn adf_heading_to_markdown() {
        let adf = serde_json::json!({
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "heading",
                "attrs": { "level": 2 },
                "content": [{ "type": "text", "text": "Title" }]
            }]
        });
        assert_eq!(adf_to_markdown(&adf), "## Title");
    }

    #[test]
    fn adf_bold_italic_to_markdown() {
        let adf = serde_json::json!({
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "bold", "marks": [{ "type": "strong" }] },
                    { "type": "text", "text": " and " },
                    { "type": "text", "text": "italic", "marks": [{ "type": "em" }] }
                ]
            }]
        });
        assert_eq!(adf_to_markdown(&adf), "**bold** and *italic*");
    }

    #[test]
    fn adf_link_to_markdown() {
        let adf = serde_json::json!({
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "text",
                    "text": "click here",
                    "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }]
                }]
            }]
        });
        assert_eq!(adf_to_markdown(&adf), "[click here](https://example.com)");
    }

    #[test]
    fn adf_bullet_list_to_markdown() {
        let adf = serde_json::json!({
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "bulletList",
                "content": [
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "one" }] }] },
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "two" }] }] }
                ]
            }]
        });
        assert_eq!(adf_to_markdown(&adf), "- one\n- two");
    }

    #[test]
    fn adf_code_block_to_markdown() {
        let adf = serde_json::json!({
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "codeBlock",
                "attrs": { "language": "rust" },
                "content": [{ "type": "text", "text": "let x = 1;" }]
            }]
        });
        assert_eq!(adf_to_markdown(&adf), "```rust\nlet x = 1;\n```");
    }

    #[test]
    fn text_to_adf_roundtrip() {
        let text = "First paragraph\n\nSecond paragraph";
        let adf = text_to_adf(text);
        assert_eq!(adf["type"], "doc");
        assert_eq!(adf["version"], 1);
        let content = adf["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["content"][0]["text"], "First paragraph");
        assert_eq!(content[1]["content"][0]["text"], "Second paragraph");
    }

    #[test]
    fn parse_jira_datetimes() {
        let rfc3339 = "2024-01-15T10:30:00.000+00:00";
        assert!(parse_jira_datetime(rfc3339).is_some());

        let jira_format = "2024-01-15T10:30:00.000+0000";
        assert!(parse_jira_datetime(jira_format).is_some());
    }

    #[test]
    fn empty_adf_produces_empty_string() {
        assert_eq!(adf_to_markdown(&serde_json::json!({})), "");
        assert_eq!(adf_to_markdown(&serde_json::json!(null)), "");
    }

    #[test]
    fn resolved_site_picks_linked_then_first() {
        let sites = vec![
            ("cloud1".to_string(), "Alpha".to_string()),
            ("cloud2".to_string(), "Beta".to_string()),
        ];
        assert_eq!(resolved_site(&sites, Some("cloud2")).unwrap().0, "cloud2");
        assert_eq!(resolved_site(&sites, Some("gone")).unwrap().0, "cloud1");
        assert_eq!(resolved_site(&sites, None).unwrap().0, "cloud1");
        let empty: Vec<(String, String)> = vec![];
        assert!(resolved_site(&empty, None).is_none());
    }
}
