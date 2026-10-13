//! TickTick integration: the one-account token store (OS keychain), the OAuth
//! connect flow and the personal-API-token fallback, and the Open API reads and
//! writes that turn TickTick tasks into the same domain types Linear and Jira
//! produce. Pure id/priority/state mapping lives in `santree_core::ticktick`.
//!
//! What TickTick is not, next to the other two trackers: it has no workflow
//! states beyond open / done / won't-do, no triage, no estimates or cycles, and no
//! comment threads. Its "projects" are lists; santree calls them lists everywhere
//! except the wire.
//!
//! A TickTick access token does not expire on a schedule the API documents and
//! there is no refresh token, so there is no refresh machinery: a 401 means the
//! user reconnects.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, FixedOffset, Utc};
use futures::stream::{self, StreamExt};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};

use santree_core::domain::{
    Task, TaskStatus, TickTickList, TickTickStatus, TicketProvider, TicketRef, TriageComment,
    TriageDetail, TriageSchedule, TriageTicket, WorkflowState,
};
use santree_core::ticktick as core_tt;

use crate::connection;
use crate::db::{now_ms, Db};
use crate::gql;
use crate::jira::TtlCache;
use crate::oauth::{self, Tokens};

// ── Provider constants ─────────────────────────────────────────────────────

// The TickTick app's client id, and its secret, read at build time rather than
// committed: a desktop app cannot keep a secret from its own binary (TickTick
// offers no PKCE), but it can keep it out of a public repo. Release builds get it
// from the `release` environment's `TICKTICK_CLIENT_SECRET`; a local build gets
// it from the developer's cargo config, or goes without OAuth (the personal-token
// path still works).
const CLIENT_ID: &str = "rWy1d6BN8N1SoHDsB0";
const CLIENT_SECRET: Option<&str> = option_env!("TICKTICK_CLIENT_SECRET");
const AUTHORIZE_URL: &str = "https://ticktick.com/oauth/authorize";
const TOKEN_URL: &str = "https://ticktick.com/oauth/token";
const REVOKE_URL: &str = "https://api.ticktick.com/oauth/revoke";
const API_URL: &str = "https://api.ticktick.com/open/v1";
const SCOPE: &str = "tasks:read tasks:write";

/// The keychain entry's provider half; the account half is [`ACCOUNT`].
const KEYCHAIN_PROVIDER: &str = "ticktick";
/// The one account an install has (`ticktick_accounts.id`).
const ACCOUNT: &str = connection::TICKTICK_KEY;

/// The pseudo list the account's Inbox is selected by. The Inbox is not in
/// `GET /project`; it is reached through `/project/inbox/data`.
const INBOX: &str = "inbox";

/// Repo setting holding the JSON array of list ids that repo reads; unset or empty
/// means every open task list.
pub const LISTS_KEY: &str = "ticktick_lists";

const RECONNECT: &str =
    "TickTick rejected the stored credential. Reconnect it in Settings > TickTick.";

/// Most tickets one `tickets_by_id` call looks up.
const TICKET_LOOKUP_CAP: usize = 50;
/// Requests in flight at once when a read fans out over lists or tickets.
const CONCURRENCY: usize = 4;
/// Pages of `GET /project` followed before giving up; 200 lists a page.
const LIST_PAGES_MAX: i64 = 10;
const LIST_PAGE: i64 = 200;
/// Longest personal token accepted. TickTick's are short; this only stops a
/// pasted document from becoming a header.
const TOKEN_MAX: usize = 512;

// ── Account (DB + keychain) ────────────────────────────────────────────────

struct AccountRow {
    via: String,
    expires_at: Option<i64>,
}

async fn account(db: &Db) -> Result<Option<AccountRow>> {
    let row: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT via, expires_at FROM ticktick_accounts WHERE id = ?")
            .bind(ACCOUNT)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(via, expires_at)| AccountRow { via, expires_at }))
}

/// `(key, display name)` of the connected account, for the repo list's labels. The
/// account has no name of its own, so the display half is empty.
pub(crate) async fn accounts_by_name(db: &Db) -> Result<Vec<(String, String)>> {
    Ok(account(db)
        .await?
        .map(|_| (ACCOUNT.to_string(), String::new()))
        .into_iter()
        .collect())
}

pub async fn auth_status(db: &Db) -> Result<TickTickStatus> {
    let row = account(db).await?;
    Ok(TickTickStatus {
        connected: row.is_some(),
        can_write: row.is_some(),
        via: row.map(|r| r.via),
        oauth_available: CLIENT_SECRET.is_some(),
    })
}

async fn save_account(db: &Db, via: &str, expires_at: Option<i64>) -> Result<()> {
    sqlx::query(
        "INSERT INTO ticktick_accounts (id, via, expires_at, connected_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           via = excluded.via,
           expires_at = excluded.expires_at,
           connected_at = excluded.connected_at",
    )
    .bind(ACCOUNT)
    .bind(via)
    .bind(expires_at)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

async fn load_token() -> Result<Option<String>> {
    Ok(oauth::load_tokens(KEYCHAIN_PROVIDER, ACCOUNT)
        .await?
        .map(|t| t.access))
}

async fn save_token(access: String) -> Result<()> {
    // No refresh token exists for TickTick; the shared blob keeps its shape.
    oauth::save_tokens(
        KEYCHAIN_PROVIDER,
        ACCOUNT,
        Tokens {
            access,
            refresh: String::new(),
        },
    )
    .await
}

// ── REST session ───────────────────────────────────────────────────────────

struct Api {
    token: String,
}

impl Api {
    fn url(path: &str) -> String {
        format!("{API_URL}/{path}")
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let req = gql::client().get(Self::url(path)).bearer_auth(&self.token);
        decode(gql::send(req, "TickTick").await?).await
    }

    async fn get_with_query<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, &str)],
    ) -> Result<T> {
        let req = gql::client()
            .get(Self::url(path))
            .bearer_auth(&self.token)
            .query(params);
        decode(gql::send(req, "TickTick").await?).await
    }

    /// A POST whose answer is not needed (complete, update, comment): only its
    /// status is checked.
    async fn post(&self, path: &str, body: Option<&serde_json::Value>) -> Result<()> {
        let mut req = gql::client().post(Self::url(path)).bearer_auth(&self.token);
        if let Some(body) = body {
            req = req.json(body);
        }
        let res = gql::send(req, "TickTick").await?;
        check(res).await.map(|_| ())
    }
}

/// Turn a non-success response into the error a user reads. A 401 is its own
/// message: the credential is dead and only reconnecting helps.
async fn check(res: reqwest::Response) -> Result<reqwest::Response> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(anyhow::Error::new(Unauthorized));
    }
    let body = res.text().await.unwrap_or_default();
    Err(gql::http_error("TickTick", status, &body))
}

/// A 401, typed so a caller can tell a dead credential from any other failure.
#[derive(Debug)]
struct Unauthorized;
impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(RECONNECT)
    }
}
impl std::error::Error for Unauthorized {}

async fn decode<T: DeserializeOwned>(res: reqwest::Response) -> Result<T> {
    check(res)
        .await?
        .json()
        .await
        .context("decoding the TickTick response")
}

fn is_not_found(err: &anyhow::Error) -> bool {
    gql::status_of(err) == Some(reqwest::StatusCode::NOT_FOUND)
}

/// The session for the connected account, or `None` when there isn't one.
async fn api(db: &Db) -> Result<Option<Api>> {
    let Some(row) = account(db).await? else {
        return Ok(None);
    };
    if row.expires_at.is_some_and(|at| now_ms() >= at) {
        bail!(RECONNECT);
    }
    let token = load_token().await?.ok_or_else(|| {
        anyhow!("no TickTick credential in the OS keychain. Reconnect it in Settings > TickTick.")
    })?;
    Ok(Some(Api { token }))
}

/// The session for a repo's reads and writes: only when the repo is linked to the
/// TickTick account.
async fn repo_api(db: &Db, repo: &str) -> Result<Option<Api>> {
    let linked = connection::of(db, repo)
        .await?
        .is_some_and(|c| c.provider == TicketProvider::TickTick);
    if !linked {
        return Ok(None);
    }
    api(db).await
}

// ── Wire types ─────────────────────────────────────────────────────────────

/// `null` reads as the field's default, the way an absent field does.
fn nullable<'de, D, T>(d: D) -> std::result::Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TtProject {
    #[serde(deserialize_with = "nullable")]
    id: String,
    #[serde(deserialize_with = "nullable")]
    name: String,
    color: Option<String>,
    #[serde(deserialize_with = "nullable")]
    closed: bool,
    group_id: Option<String>,
    permission: Option<String>,
    kind: Option<String>,
}

impl TtProject {
    /// A list of tasks, as opposed to a notes list. `kind` is absent on older
    /// lists, which are task lists.
    fn is_task_list(&self) -> bool {
        self.kind
            .as_deref()
            .is_none_or(|k| k.eq_ignore_ascii_case("TASK"))
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TtTask {
    #[serde(deserialize_with = "nullable")]
    id: String,
    #[serde(deserialize_with = "nullable")]
    project_id: String,
    #[serde(deserialize_with = "nullable")]
    title: String,
    #[serde(deserialize_with = "nullable")]
    content: String,
    #[serde(deserialize_with = "nullable")]
    desc: String,
    due_date: Option<String>,
    time_zone: Option<String>,
    #[serde(deserialize_with = "nullable")]
    priority: i64,
    #[serde(deserialize_with = "nullable")]
    status: i64,
    #[serde(deserialize_with = "nullable")]
    tags: Vec<String>,
    parent_id: Option<String>,
    // A live read returns it (`null` in an unshared list); a shared list's
    // assigned value is still unseen.
    assignee_username: Option<String>,
    // Undocumented, but a live read carries it.
    created_time: Option<String>,
    kind: Option<String>,
    #[serde(deserialize_with = "nullable")]
    items: Vec<TtItem>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct TtItem {
    #[serde(deserialize_with = "nullable")]
    title: String,
    #[serde(deserialize_with = "nullable")]
    status: i64,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct TtProjectData {
    #[serde(deserialize_with = "nullable")]
    tasks: Vec<TtTask>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TtMember {
    #[serde(deserialize_with = "nullable")]
    username: String,
    #[serde(deserialize_with = "nullable")]
    display_name: String,
    #[serde(rename = "self", deserialize_with = "nullable")]
    is_self: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TtComment {
    #[serde(deserialize_with = "nullable")]
    id: String,
    #[serde(deserialize_with = "nullable")]
    title: String,
    created_time: Option<String>,
}

// ── Caches ─────────────────────────────────────────────────────────────────

const LISTS_TTL: Duration = Duration::from_secs(300);
const DATA_TTL: Duration = Duration::from_secs(60);
const MEMBERS_TTL: Duration = Duration::from_secs(600);

static LISTS: std::sync::LazyLock<TtlCache<Vec<TtProject>>> =
    std::sync::LazyLock::new(|| TtlCache::new(LISTS_TTL));

/// A list's undone tasks, keyed by list id. `None` is a list that could not be
/// read and is allowed not to be (the Inbox).
static DATA: std::sync::LazyLock<TtlCache<Option<Vec<TtTask>>>> =
    std::sync::LazyLock::new(|| TtlCache::new(DATA_TTL));

/// A list's members, keyed by list id. `None` is "the call failed": remembered for
/// the TTL so an unshared list does not cost a request on every refresh.
static MEMBERS: std::sync::LazyLock<TtlCache<Option<Vec<TtMember>>>> =
    std::sync::LazyLock::new(|| TtlCache::new(MEMBERS_TTL));

/// After a write: the lists' task data is stale, nothing else is.
fn tasks_changed() {
    DATA.clear();
}

pub fn invalidate_all_caches() {
    LISTS.clear();
    DATA.clear();
    MEMBERS.clear();
}

// ── Lists ──────────────────────────────────────────────────────────────────

/// Every list the account has, paged. The first page is the whole answer for
/// almost every account.
async fn fetch_projects(api: &Api) -> Result<Vec<TtProject>> {
    let limit = LIST_PAGE.to_string();
    let mut all: Vec<TtProject> = Vec::new();
    for page in 0..LIST_PAGES_MAX {
        let offset = (page * LIST_PAGE).to_string();
        // UNVERIFIED: that `offset`/`limit` page this endpoint as documented.
        let batch: Vec<TtProject> = api
            .get_with_query("project", &[("offset", &offset), ("limit", &limit)])
            .await?;
        let full = batch.len() as i64 >= LIST_PAGE;
        // A server that ignores paging answers every page with the same lists.
        let repeats = batch
            .first()
            .is_some_and(|first| all.iter().any(|p| p.id == first.id));
        if repeats {
            break;
        }
        all.extend(batch);
        if !full {
            break;
        }
    }
    Ok(all)
}

async fn projects(api: &Api) -> Result<std::sync::Arc<Vec<TtProject>>> {
    Ok(LISTS.get_or_fetch(ACCOUNT, || fetch_projects(api)).await?.0)
}

/// A list's undone tasks. The Inbox is optional: it answers `None` rather than an
/// error, since nothing says its endpoint is reachable.
async fn list_tasks(api: &Api, list_id: &str) -> Result<std::sync::Arc<Option<Vec<TtTask>>>> {
    let optional = list_id == INBOX;
    Ok(DATA
        .get_or_fetch(list_id, || async {
            // UNVERIFIED: `/project/inbox/data`. The docs name `inbox` as a
            // project id for `task/undone` only, never for `/data`.
            let data: Result<TtProjectData> = api.get(&format!("project/{list_id}/data")).await;
            match data {
                Ok(data) => Ok(Some(data.tasks)),
                Err(e) if optional && e.downcast_ref::<Unauthorized>().is_none() => {
                    log::debug!("TickTick Inbox is not readable: {e:#}");
                    Ok(None)
                }
                Err(e) => Err(e),
            }
        })
        .await?
        .0)
}

/// A list's members, or `None` when they can't be read.
async fn list_members(api: &Api, list_id: &str) -> std::sync::Arc<Option<Vec<TtMember>>> {
    let fetched = MEMBERS
        .get_or_fetch(list_id, || async {
            // UNVERIFIED: that the members endpoint answers for a list nobody
            // shares; a failure is read as "just me".
            let members: Result<Vec<TtMember>> =
                api.get(&format!("project/{list_id}/members")).await;
            Ok(match members {
                Ok(m) => Some(m),
                Err(e) => {
                    log::debug!("TickTick members of {list_id} unavailable: {e:#}");
                    None
                }
            })
        })
        .await;
    match fetched {
        Ok((members, _)) => members,
        Err(_) => std::sync::Arc::new(None),
    }
}

pub async fn lists(db: &Db) -> Result<Vec<TickTickList>> {
    let Some(api) = api(db).await? else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    if list_tasks(&api, INBOX).await?.is_some() {
        out.push(TickTickList {
            id: INBOX.into(),
            name: "Inbox".into(),
            color: None,
            closed: false,
            group: None,
            permission: None,
        });
    }
    out.extend(
        projects(&api)
            .await?
            .iter()
            .filter(|p| p.is_task_list() && core_tt::is_id_part(&p.id))
            .map(|p| TickTickList {
                id: p.id.clone(),
                name: p.name.clone(),
                color: p.color.clone().filter(|c| !c.is_empty()),
                closed: p.closed,
                group: p.group_id.clone().filter(|g| !g.is_empty()),
                permission: p.permission.clone().filter(|p| !p.is_empty()),
            }),
    );
    Ok(out)
}

/// The list ids a repo restricts itself to; empty means every open task list.
async fn selected_lists(db: &Db, repo: &str) -> Vec<String> {
    let stored = crate::settings::get(db, &format!("repo:{repo}"), LISTS_KEY)
        .await
        .ok()
        .flatten();
    stored
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

/// What a task needs to know about its list.
#[derive(Clone)]
struct ListMeta {
    id: String,
    name: String,
    color: Option<String>,
}

/// The lists a repo reads, in the account's order, the Inbox first.
async fn target_lists(api: &Api, selected: &[String]) -> Result<Vec<ListMeta>> {
    let wants = |id: &str| selected.is_empty() || selected.iter().any(|s| s == id);
    let mut out = Vec::new();
    if wants(INBOX) {
        out.push(ListMeta {
            id: INBOX.into(),
            name: "Inbox".into(),
            color: None,
        });
    }
    out.extend(
        projects(api)
            .await?
            .iter()
            .filter(|p| p.is_task_list() && !p.closed && core_tt::is_id_part(&p.id) && wants(&p.id))
            .map(|p| ListMeta {
                id: p.id.clone(),
                name: p.name.clone(),
                color: p.color.clone().filter(|c| !c.is_empty()),
            }),
    );
    Ok(out)
}

// ── Mapping ────────────────────────────────────────────────────────────────

fn parse_instant(s: &str) -> Option<DateTime<FixedOffset>> {
    // TickTick spells offsets `+0000` and sometimes carries milliseconds; `%.f`
    // takes the fraction when it is there and nothing when it is not.
    DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f%z")
        .ok()
        .or_else(|| DateTime::parse_from_rfc3339(s).ok())
}

fn instant_ms(s: &str) -> Option<i64> {
    parse_instant(s).map(|dt| dt.timestamp_millis())
}

/// The calendar day (`YYYY-MM-DD`) an instant falls on in the task's own zone. An
/// all-day task's due instant is midnight in that zone, so the viewer's zone
/// would show the neighbouring day. An unknown or missing zone reads as UTC.
fn due_day(due: &str, zone: Option<&str>) -> Option<String> {
    let utc = parse_instant(due)?.with_timezone(&Utc);
    let day = match zone.and_then(|z| z.parse::<chrono_tz::Tz>().ok()) {
        Some(tz) => utc.with_timezone(&tz).date_naive(),
        None => utc.date_naive(),
    };
    Some(day.format("%Y-%m-%d").to_string())
}

/// The ticket id of `task_id` in the list `project_id`, if the pair is shaped like
/// one. Ids come from the API, but they become request paths later.
fn ticket_id(project_id: &str, task_id: &str) -> Option<String> {
    let id = core_tt::compose_id(project_id, task_id);
    core_tt::split_id(&id).is_some().then_some(id)
}

/// Whether the viewer is the one to do this task: it is assigned to them, or it is
/// unassigned in a list that has nobody else in it (or whose members could not be
/// read, which is a list nobody shares).
fn is_actionable(assignee: Option<&str>, members: Option<&[TtMember]>) -> bool {
    let assignee = assignee.filter(|a| !a.is_empty());
    let me = members.and_then(|m| m.iter().find(|m| m.is_self));
    match (assignee, me) {
        (Some(assignee), Some(me)) => assignee == me.username,
        (Some(_), None) => false,
        (None, _) => members.is_none_or(|m| m.len() <= 1),
    }
}

struct Candidate {
    task: Task,
    actionable: bool,
}

fn map_task(t: &TtTask, list: &ListMeta, members: Option<&[TtMember]>) -> Option<Candidate> {
    let project_id = if t.project_id.is_empty() {
        list.id.as_str()
    } else {
        t.project_id.as_str()
    };
    let id = ticket_id(project_id, &t.id)?;
    let assignee_name = t
        .assignee_username
        .as_deref()
        .filter(|a| !a.is_empty())
        .map(|username| {
            members
                .and_then(|m| m.iter().find(|m| m.username == username))
                .map(|m| m.display_name.clone())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| username.to_string())
        });
    Some(Candidate {
        actionable: is_actionable(t.assignee_username.as_deref(), members),
        task: Task {
            id,
            title: t.title.clone(),
            priority: core_tt::map_priority(t.priority),
            team: None,
            estimate: None,
            cycle: None,
            due_date: t
                .due_date
                .as_deref()
                .and_then(|due| due_day(due, t.time_zone.as_deref())),
            project: list.name.clone(),
            project_color: list.color.clone(),
            project_icon: None,
            project_target_date: None,
            project_milestone: None,
            parent_id: t
                .parent_id
                .as_deref()
                .filter(|p| !p.is_empty())
                .and_then(|p| ticket_id(project_id, p)),
            // `/data` answers undone tasks only, so every task here is open.
            status: TaskStatus::Todo,
            ready: true,
            blocked_by: vec![],
            actionable: false,
            assignee: assignee_name,
            assignee_avatar_url: None,
            x: 0,
            y: 0,
        },
    })
}

type LoadedList = (ListMeta, Vec<TtTask>, Option<Vec<TtMember>>);

/// The viewer's tasks as a dependency graph. A subtask blocks its parent, so a
/// task's undone children are its blockers, and the children of a task the viewer
/// owns are pulled in as grayed-out context even when someone else owns them.
fn assemble(lists: Vec<LoadedList>) -> Vec<Task> {
    let mut candidates: Vec<Candidate> = lists
        .iter()
        .flat_map(|(list, tasks, members)| {
            tasks
                .iter()
                .filter_map(|t| map_task(t, list, members.as_deref()))
        })
        .collect();

    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for c in &candidates {
        if let Some(parent) = &c.task.parent_id {
            children
                .entry(parent.clone())
                .or_default()
                .push(c.task.id.clone());
        }
    }
    let index: HashMap<String, usize> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (c.task.id.clone(), i))
        .collect();

    let mut keep: Vec<bool> = candidates.iter().map(|c| c.actionable).collect();
    let mut stack: Vec<usize> = (0..keep.len()).filter(|&i| keep[i]).collect();
    while let Some(i) = stack.pop() {
        for child in children.get(&candidates[i].task.id).into_iter().flatten() {
            if let Some(&j) = index.get(child) {
                if !keep[j] {
                    keep[j] = true;
                    stack.push(j);
                }
            }
        }
    }

    let mut tasks: Vec<Task> = Vec::new();
    for (i, c) in candidates.drain(..).enumerate() {
        if !keep[i] {
            continue;
        }
        let mut task = c.task;
        task.actionable = c.actionable;
        task.blocked_by = children.get(&task.id).cloned().unwrap_or_default();
        task.ready = task.blocked_by.is_empty();
        tasks.push(task);
    }
    santree_core::layout::layout_tasks(&mut tasks);
    tasks
}

// ── Public reads ───────────────────────────────────────────────────────────

pub async fn list_issues(db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
    let Some(api) = repo_api(db, repo).await? else {
        return Ok(None);
    };
    let selected = selected_lists(db, repo).await;
    let targets = target_lists(&api, &selected).await?;

    let api = &api;
    let loaded: Vec<Result<Option<LoadedList>>> = stream::iter(targets)
        .map(|list| async move {
            let Some(tasks) = list_tasks(api, &list.id).await?.as_ref().clone() else {
                return Ok(None);
            };
            // Members only matter to a list that has tasks, and `inbox` is not a
            // list id the members endpoint is known to take.
            let members = if tasks.is_empty() || list.id == INBOX {
                None
            } else {
                list_members(api, &list.id).await.as_ref().clone()
            };
            Ok(Some((list, tasks, members)))
        })
        .buffered(CONCURRENCY)
        .collect()
        .await;
    let mut lists = Vec::new();
    for entry in loaded {
        if let Some(entry) = entry? {
            lists.push(entry);
        }
    }

    let tasks = assemble(lists);
    log::info!("fetched {} TickTick tasks for {repo}", tasks.len());
    Ok(Some(tasks))
}

/// TickTick has no triage state, team inbox or SLA: there is no queue to show.
pub async fn triage_tickets(_db: &Db, _repo: &str) -> Result<Option<Vec<TriageTicket>>> {
    Ok(None)
}

/// TickTick has no triage rotations.
pub async fn triage_schedule(_db: &Db, _repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
    Ok(None)
}

/// TickTick has no "started" state to move a task into.
pub async fn move_to_started(_db: &Db, _repo: &str, _id: &str) -> Result<Option<()>> {
    Ok(None)
}

/// A checklist's items as markdown task-list lines.
fn checklist_markdown(items: &[TtItem]) -> String {
    items
        .iter()
        .map(|i| {
            let mark = if i.status == 0 { " " } else { "x" };
            format!("- [{mark}] {}", i.title)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A task's body: its content, then its checklist. A checklist task keeps its
/// text in `desc`, so that stands in when `content` is empty.
fn description(t: &TtTask) -> String {
    let text = if t.content.trim().is_empty() {
        t.desc.as_str()
    } else {
        t.content.as_str()
    };
    let mut out = text.trim_end().to_string();
    if !t.items.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&checklist_markdown(&t.items));
    }
    out
}

fn workflow_states() -> Vec<WorkflowState> {
    vec![
        WorkflowState {
            id: core_tt::STATE_TODO.into(),
            name: core_tt::state_name(0).into(),
            type_: "unstarted".into(),
            color: "#8A8F98".into(),
        },
        WorkflowState {
            id: core_tt::STATE_DONE.into(),
            name: core_tt::state_name(2).into(),
            type_: "completed".into(),
            color: "#2EA043".into(),
        },
        WorkflowState {
            id: core_tt::STATE_WONT_DO.into(),
            name: core_tt::state_name(-1).into(),
            type_: "canceled".into(),
            color: "#6E7681".into(),
        },
    ]
}

/// A list's name from the cached lists. The Inbox is not among them.
async fn list_name(api: &Api, project_id: &str) -> String {
    if project_id.starts_with(INBOX) {
        return "Inbox".into();
    }
    match projects(api).await {
        Ok(projects) => projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.name.clone())
            .unwrap_or_default(),
        Err(_) => String::new(),
    }
}

pub async fn triage_detail(db: &Db, repo: &str, id: &str) -> Result<Option<TriageDetail>> {
    // A worktree cut from a plain branch hands over its slug as the id: that is
    // "no such task", and only a real id may be placed in a request path.
    let Some((project_id, task_id)) = core_tt::split_id(id) else {
        return Ok(None);
    };
    let Some(api) = repo_api(db, repo).await? else {
        return Ok(None);
    };

    let task: TtTask = match api
        .get(&format!("project/{project_id}/task/{task_id}"))
        .await
    {
        Ok(t) => t,
        Err(e) if is_not_found(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let comments: Vec<TtComment> = match api
        .get(&format!("project/{project_id}/task/{task_id}/comments"))
        .await
    {
        Ok(c) => c,
        Err(e) if is_not_found(&e) => vec![],
        Err(e) => return Err(e),
    };

    let project = list_name(&api, project_id).await;
    let assignee = match task.assignee_username.as_deref().filter(|a| !a.is_empty()) {
        Some(username) => {
            let members = list_members(&api, project_id).await;
            Some(
                members
                    .as_deref()
                    .and_then(|m| m.iter().find(|m| m.username == username))
                    .map(|m| m.display_name.clone())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| username.to_string()),
            )
        }
        None => None,
    };

    let mut comments: Vec<TriageComment> = comments
        .into_iter()
        .map(|c| TriageComment {
            id: c.id,
            // The API gives a numeric user id and nothing to name the author by.
            author: "TickTick".into(),
            avatar_url: None,
            created_at_ms: c
                .created_time
                .as_deref()
                .and_then(instant_ms)
                .unwrap_or_default() as f64,
            body: c.title,
            children: vec![],
        })
        .collect();
    comments.sort_by(|a, b| a.created_at_ms.total_cmp(&b.created_at_ms));

    let created_at_ms = task
        .created_time
        .as_deref()
        .and_then(instant_ms)
        .unwrap_or_else(now_ms);

    Ok(Some(TriageDetail {
        id: id.to_string(),
        title: task.title.clone(),
        priority: core_tt::map_priority(task.priority),
        tracker_name: "TickTick".into(),
        state: core_tt::state_name(task.status).into(),
        state_id: Some(task.status.to_string()),
        states: workflow_states(),
        url: format!("https://ticktick.com/webapp/#p/{project_id}/tasks/{task_id}"),
        author: String::new(),
        author_avatar_url: None,
        created_at_ms: created_at_ms as f64,
        labels: task.tags.clone(),
        project: Some(project).filter(|p| !p.is_empty()),
        project_milestone: None,
        assignee,
        assignee_avatar_url: None,
        estimate: None,
        cycle: None,
        due_date: task
            .due_date
            .as_deref()
            .and_then(|due| due_day(due, task.time_zone.as_deref())),
        sla_breach_ms: None,
        snoozed_until_ms: None,
        description: description(&task),
        comments,
    }))
}

pub async fn tickets_by_id(db: &Db, repo: &str, ids: &[String]) -> Result<Option<Vec<TicketRef>>> {
    let Some(api) = repo_api(db, repo).await? else {
        return Ok(None);
    };
    let mut seen = HashSet::new();
    let wanted: Vec<String> = ids
        .iter()
        .filter(|id| core_tt::split_id(id).is_some() && seen.insert(id.as_str()))
        .take(TICKET_LOOKUP_CAP)
        .cloned()
        .collect();
    if wanted.is_empty() {
        return Ok(Some(vec![]));
    }

    let api = &api;
    let found: Vec<Option<TicketRef>> = stream::iter(wanted)
        .map(|id| async move {
            let (project_id, task_id) = core_tt::split_id(&id)?;
            let task: TtTask = match api
                .get(&format!("project/{project_id}/task/{task_id}"))
                .await
            {
                Ok(t) => t,
                Err(e) => {
                    log::debug!("TickTick task {id} not readable: {e:#}");
                    return None;
                }
            };
            let project = list_name(api, project_id).await;
            Some(TicketRef {
                identifier: id.clone(),
                title: task.title,
                priority: core_tt::map_priority(task.priority),
                project,
                project_color: None,
                project_icon: None,
                project_target_date: None,
                project_milestone: None,
            })
        })
        .buffered(CONCURRENCY)
        .collect()
        .await;
    Ok(Some(found.into_iter().flatten().collect()))
}

// ── Public mutations ───────────────────────────────────────────────────────

pub async fn set_issue_state(db: &Db, repo: &str, id: &str, state: &str) -> Result<Option<()>> {
    let Some((project_id, task_id)) = core_tt::split_id(id) else {
        bail!("not a TickTick task id: {id}");
    };
    let Some(api) = repo_api(db, repo).await? else {
        return Ok(None);
    };
    match state {
        core_tt::STATE_DONE => {
            api.post(
                &format!("project/{project_id}/task/{task_id}/complete"),
                None,
            )
            .await?;
        }
        // UNVERIFIED: that `POST /task/{id}` with `status` 0 (reopen) or -1
        // (won't do) changes the status. The docs only show `complete` for
        // completion and list -1 / 0 / 2 as the values of the field.
        core_tt::STATE_TODO | core_tt::STATE_WONT_DO => {
            let status: i64 = state.parse().context("TickTick status")?;
            let body = serde_json::json!({
                "id": task_id,
                "projectId": project_id,
                "status": status,
            });
            api.post(&format!("task/{task_id}"), Some(&body)).await?;
        }
        other => bail!("not a TickTick state: {other}"),
    }
    tasks_changed();
    Ok(Some(()))
}

pub async fn create_comment(
    db: &Db,
    repo: &str,
    id: &str,
    _parent: Option<&str>,
    body: &str,
) -> Result<Option<()>> {
    let Some((project_id, task_id)) = core_tt::split_id(id) else {
        bail!("not a TickTick task id: {id}");
    };
    let Some(api) = repo_api(db, repo).await? else {
        return Ok(None);
    };
    // TickTick comments are flat; a reply posts as a new comment.
    let payload = serde_json::json!({ "title": body });
    api.post(
        &format!("project/{project_id}/task/{task_id}/comment"),
        Some(&payload),
    )
    .await?;
    Ok(Some(()))
}

// ── Connecting ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    // UNVERIFIED: the docs show `access_token` and elide the rest ("..."). A
    // lifetime may or may not be sent; none is assumed.
    #[serde(default)]
    expires_in: Option<i64>,
}

/// Run the OAuth authorization-code flow in the browser and store the account.
pub async fn connect(db: &Db) -> Result<TickTickStatus> {
    let Some(secret) = CLIENT_SECRET else {
        bail!("this build has no TickTick sign-in; connect with a personal API token instead");
    };
    let state = oauth::hex(&oauth::random_bytes(16));
    let redirect_uri = format!("http://localhost:{}", oauth::OAUTH_PORT);
    let params = [
        ("client_id", CLIENT_ID),
        ("scope", SCOPE),
        ("state", state.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("response_type", "code"),
    ];
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={}", oauth::urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let authorize_url = format!("{AUTHORIZE_URL}?{query}");

    let expected_state = state.clone();
    let code = tokio::task::spawn_blocking(move || {
        oauth::wait_for_code(&expected_state, "TickTick", &authorize_url)
    })
    .await
    .context("oauth listener task")??;

    // UNVERIFIED: the exchange as documented: form-encoded, client id and secret
    // as HTTP Basic auth, no PKCE, no refresh token in the reply.
    let res = gql::credential_client()
        .post(TOKEN_URL)
        .basic_auth(CLIENT_ID, Some(secret))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("scope", SCOPE),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .context("TickTick token exchange request")?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(gql::http_error("TickTick token exchange", status, &body));
    }
    let reply: TokenReply = res
        .json()
        .await
        .context("decoding the TickTick token exchange response")?;

    let expires_at = reply
        .expires_in
        .filter(|s| *s > 0)
        .map(|s| now_ms() + s * 1000);
    save_token(reply.access_token).await?;
    save_account(db, "oauth", expires_at).await?;
    invalidate_all_caches();
    log::info!("connected TickTick through OAuth");
    auth_status(db).await
}

/// Connect with a personal API token pasted from TickTick's Settings > Account >
/// API Token. It is checked with a real read before anything is stored.
pub async fn connect_token(db: &Db, token: &str) -> Result<TickTickStatus> {
    let token = token.trim();
    if token.is_empty() {
        bail!("paste the API token from TickTick's Settings > Account > API Token");
    }
    if token.len() > TOKEN_MAX || token.chars().any(|c| c.is_control() || c.is_whitespace()) {
        bail!("that doesn't look like a TickTick API token");
    }
    // UNVERIFIED: that `GET /project` accepts a personal API token as a bearer
    // exactly like an OAuth one (the docs say it does, with the same header).
    let probe = Api {
        token: token.to_string(),
    };
    if let Err(e) = fetch_projects(&probe).await {
        if e.downcast_ref::<Unauthorized>().is_some() {
            bail!("TickTick rejected that token. Check it and try again.");
        }
        return Err(e);
    }
    save_token(token.to_string()).await?;
    save_account(db, "token", None).await?;
    invalidate_all_caches();
    log::info!("connected TickTick with a personal API token");
    auth_status(db).await
}

pub async fn disconnect(db: &Db) -> Result<()> {
    let row = account(db).await?;
    if row.as_ref().is_some_and(|r| r.via == "oauth") {
        if let Ok(Some(token)) = load_token().await {
            revoke(&token).await;
        }
    }
    oauth::delete_tokens(KEYCHAIN_PROVIDER, ACCOUNT).await?;
    sqlx::query("DELETE FROM ticktick_accounts WHERE id = ?")
        .bind(ACCOUNT)
        .execute(db)
        .await?;
    invalidate_all_caches();
    log::info!("disconnected TickTick");
    Ok(())
}

/// Ask TickTick to kill an OAuth token. Best effort: the local credential goes
/// either way, and a failure here only leaves the token alive on their side.
async fn revoke(token: &str) {
    // UNVERIFIED: the docs show a multipart form on `api.ticktick.com`; this
    // sends it urlencoded, which a form parser normally also accepts.
    let sent = gql::credential_client()
        .post(REVOKE_URL)
        .form(&[("token", token)])
        .send()
        .await;
    match sent {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => log::warn!("TickTick token revoke answered {}", res.status()),
        Err(e) => log::warn!("TickTick token revoke failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use santree_core::domain::Priority;
    use serde_json::json;

    /// Shaped exactly like the documented `GET /project/{id}/data` example plus a
    /// subtask and a task someone else owns. A live account's `/data` (checked
    /// 2026-10-13) has the same fields plus `childIds`, `columnId`, `columnName`,
    /// `createdTime` and `modifiedTime`, and sends `null` for unset lists and flags.
    fn data() -> TtProjectData {
        serde_json::from_value(json!({
            "project": { "id": "6226ff9877acee87727f6bca", "name": "project name" },
            "tasks": [
                {
                    "id": "6247ee29630c800f064fd145",
                    "isAllDay": true,
                    "projectId": "6226ff9877acee87727f6bca",
                    "title": "Task Title",
                    "content": "Task Content",
                    "desc": "Task Description",
                    "timeZone": "America/Los_Angeles",
                    "repeatFlag": "RRULE:FREQ=DAILY;INTERVAL=1",
                    "startDate": "2019-11-13T03:00:00+0000",
                    "dueDate": "2019-11-14T03:00:00+0000",
                    "reminders": ["TRIGGER:P0DT9H0M0S", "TRIGGER:PT0S"],
                    "priority": 5,
                    "status": 0,
                    "completedTime": "2019-11-13T03:00:00+0000",
                    "sortOrder": 12345,
                    "kind": "CHECKLIST",
                    "tags": null,
                    "items": [
                        { "id": "6435074647fd2e6387145f20", "status": 0, "title": "Subtask Title" },
                        { "id": "6435074647fd2e6387145f21", "status": 1, "title": "Done item" }
                    ]
                },
                {
                    "id": "6247ee29630c800f064fd146",
                    "projectId": "6226ff9877acee87727f6bca",
                    "title": "A subtask someone else owns",
                    "parentId": "6247ee29630c800f064fd145",
                    "assigneeUsername": "other@example.com",
                    "status": 0
                },
                {
                    "id": "6247ee29630c800f064fd147",
                    "projectId": "6226ff9877acee87727f6bca",
                    "title": "Not mine",
                    "assigneeUsername": "other@example.com"
                }
            ]
        }))
        .unwrap()
    }

    fn members() -> Vec<TtMember> {
        serde_json::from_value(json!([
            { "username": "me@example.com", "displayName": "Me", "self": true },
            { "username": "other@example.com", "displayName": "Other", "self": false }
        ]))
        .unwrap()
    }

    /// The decode of a documented task, and what the graph makes of it: the due day
    /// is the day in the task's own zone, an owned task's subtask blocks it and
    /// comes along as context, and a task of someone else's stays out.
    #[test]
    fn a_documented_project_maps_to_a_graph_with_subtasks_as_blockers() {
        let list = ListMeta {
            id: "6226ff9877acee87727f6bca".into(),
            name: "project name".into(),
            color: Some("#F18181".into()),
        };
        // The viewer owns nothing by assignment, so the unassigned task is theirs
        // only where the list has one member: make that list one of one.
        let solo = vec![TtMember {
            username: "me@example.com".into(),
            display_name: "Me".into(),
            is_self: true,
        }];
        let mut tasks_in = data().tasks;
        tasks_in[1].assignee_username = None;
        let tasks = assemble(vec![(list.clone(), tasks_in, Some(solo))]);

        // 03:00 UTC on the 14th is the evening of the 13th in Los Angeles.
        assert_eq!(
            tasks.len(),
            2,
            "the task and its subtask, not the stranger's"
        );
        let parent = &tasks[0];
        assert_eq!(
            parent.id,
            "6226ff9877acee87727f6bca.6247ee29630c800f064fd145"
        );
        assert_eq!(parent.priority, Priority::High);
        assert_eq!(parent.due_date.as_deref(), Some("2019-11-13"));
        assert_eq!(parent.project, "project name");
        assert_eq!(parent.project_color.as_deref(), Some("#F18181"));
        assert!(parent.actionable && !parent.ready);
        assert_eq!(parent.blocked_by, [tasks[1].id.clone()]);
        assert_eq!(tasks[1].parent_id.as_deref(), Some(parent.id.as_str()));

        // In a shared list, a subtask someone else owns rides along as context
        // while an unrelated task of theirs does not appear at all.
        let mut tasks_in = data().tasks;
        tasks_in[0].assignee_username = Some("me@example.com".into());
        let tasks = assemble(vec![(list, tasks_in, Some(members()))]);
        assert_eq!(tasks.len(), 2);
        assert!(tasks[0].actionable);
        assert_eq!(tasks[1].assignee.as_deref(), Some("Other"));
        assert!(!tasks[1].actionable && tasks[1].ready);

        // The checklist reads as markdown beneath the content.
        assert_eq!(
            description(&data().tasks[0]),
            "Task Content\n\n- [ ] Subtask Title\n- [x] Done item"
        );
        // A TickTick offset, with and without milliseconds; an unknown zone is UTC.
        assert!(parse_instant("2019-11-13T03:00:00+0000").is_some());
        // Captured from a live account (a task's `createdTime`).
        assert!(parse_instant("2022-07-26T17:05:56-0600").is_some());
        assert!(parse_instant("2026-03-05T00:00:00.000+0000").is_some());
        assert_eq!(
            due_day("2019-11-14T03:00:00+0000", Some("Not/AZone")).as_deref(),
            Some("2019-11-14")
        );
    }
}
