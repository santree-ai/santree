//! The `TicketTracker` for a Linear org connected through its hosted MCP server.
//!
//! A read that GraphQL answers in one query is a handful of tool calls here:
//! `list_issues` carries no relations and no project colours, `get_issue` no
//! estimate or cycle, and nothing looks up a list of identifiers. So the reads
//! fan out at a capped width and cache what changes slowly (projects, cycles,
//! statuses, people). What the server can't answer at all is left empty rather
//! than invented — `docs/linear-mcp.md` lists each gap.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{bail, Result};
use async_trait::async_trait;
use futures::stream::{self, StreamExt};
use santree_core::domain::{
    LinearTeam, Task, TicketRef, TriageComment, TriageDetail, TriageSchedule, TriageTicket,
};
use santree_core::layout;
use serde_json::{json, Value};

use super::client::{self, Effect};
use super::wire::{
    self, CommentsPage, Enrichment, IssuesPage, McpComment, McpCycle, McpIssue, McpProject,
    McpStatus, McpTeamFacts, McpUser, MilestonesList, Paged, ProjectInfo,
};
use crate::db::Db;
use crate::gql;
use crate::linear::{self, NameStyle, TtlCache};
use crate::tracker::TicketTracker;

/// How many tool calls one read runs at once.
const FAN_OUT: usize = 6;

/// A paged list stops here, loudly, rather than walking an unbounded org.
const MAX_PAGES: usize = 40;

/// The viewer's open work, one `list_issues` per type: `state` takes a single
/// value, and leaving it out would page through their whole closed history.
/// Triage belongs to the Triage section, as in the GraphQL read.
const OPEN_STATE_TYPES: [&str; 3] = ["backlog", "unstarted", "started"];

const ISSUE_FIELDS: &[&str] = &[
    "id",
    "title",
    "priority",
    "estimate",
    "dueDate",
    "status",
    "statusType",
    "assignee",
    "assigneeId",
    "project",
    "projectId",
    "projectMilestone",
    "parentId",
    "team",
    "teamId",
    "cycleId",
    "updatedAt",
];

const TRIAGE_FIELDS: &[&str] = &[
    "id",
    "title",
    "priority",
    "slaBreachesAt",
    "assigneeId",
    "teamId",
];

const NO_WRITES: &str = "santree can't change tickets through Linear's MCP server yet";

/// The viewer's issues as laid out, per org — the same 15-second window as the
/// GraphQL read, for the same burst of per-repo asks.
static ASSIGNED: LazyLock<TtlCache<Vec<Task>>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(15)));
/// Team-scope facts, per org, shared by the queue and the teams list.
static TEAMS: LazyLock<TtlCache<McpTeamFacts>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(60)));
/// An issue's blocker ids, keyed by its id *and* `updatedAt`, so an issue that
/// changed is read again at once. The TTL bounds what a change that doesn't touch
/// `updatedAt` could leave stale.
static RELATIONS: LazyLock<TtlCache<Vec<String>>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(10 * 60)));
/// Single issues read by id: blockers outside the viewer's list, and PR tickets.
static ISSUES: LazyLock<TtlCache<McpIssue>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(60)));

const REFERENCE_TTL: Duration = Duration::from_secs(5 * 60);
static STATUSES: LazyLock<TtlCache<Vec<McpStatus>>> =
    LazyLock::new(|| TtlCache::new(REFERENCE_TTL));
static CYCLES: LazyLock<TtlCache<Vec<McpCycle>>> = LazyLock::new(|| TtlCache::new(REFERENCE_TTL));
static PROJECTS: LazyLock<TtlCache<ProjectInfo>> = LazyLock::new(|| TtlCache::new(REFERENCE_TTL));
static USERS: LazyLock<TtlCache<McpUser>> = LazyLock::new(|| TtlCache::new(REFERENCE_TTL));

/// Drop what is cached for an org whose credential was just (re)issued — the
/// viewer behind the slug may have changed.
pub(crate) fn invalidate_org_caches(slug: &str) {
    ASSIGNED.invalidate(slug);
    TEAMS.invalidate(slug);
}

/// Drop everything — the manual refresh.
pub(crate) fn invalidate_all_caches() {
    ASSIGNED.clear();
    TEAMS.clear();
    RELATIONS.clear();
    ISSUES.clear();
    STATUSES.clear();
    CYCLES.clear();
    PROJECTS.clear();
    USERS.clear();
}

pub(crate) struct LinearMcpTracker;

#[async_trait]
impl TicketTracker for LinearMcpTracker {
    async fn list_issues(&self, db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
        let Some(slug) = linear::resolve_org_slug(db, repo).await? else {
            return Ok(None);
        };
        let (tasks, from_cache) = ASSIGNED
            .get_or_fetch(&slug, || assigned_tasks(db, &slug))
            .await?;
        if !from_cache {
            log::info!(
                "fetched {} Linear issues for {repo} through the MCP server (org {slug})",
                tasks.len()
            );
        }
        Ok(Some(tasks.as_ref().clone()))
    }

    async fn triage_tickets(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>> {
        let Some(slug) = linear::resolve_org_slug(db, repo).await? else {
            return Ok(None);
        };
        triage(db, &slug, repo).await.map(Some)
    }

    async fn triage_detail(&self, db: &Db, repo: &str, id: &str) -> Result<Option<TriageDetail>> {
        let Some(slug) = linear::resolve_org_slug(db, repo).await? else {
            return Ok(None);
        };
        detail(db, &slug, id).await
    }

    async fn set_issue_state(
        &self,
        _db: &Db,
        _repo: &str,
        _id: &str,
        _state: &str,
    ) -> Result<Option<()>> {
        bail!(NO_WRITES)
    }

    async fn create_comment(
        &self,
        _db: &Db,
        _repo: &str,
        _id: &str,
        _parent: Option<&str>,
        _body: &str,
    ) -> Result<Option<()>> {
        bail!(NO_WRITES)
    }

    async fn tickets_by_id(
        &self,
        db: &Db,
        repo: &str,
        ids: &[String],
    ) -> Result<Option<Vec<TicketRef>>> {
        let Some(slug) = linear::resolve_org_slug(db, repo).await? else {
            return Ok(None);
        };
        Ok(Some(ticket_refs(db, &slug, ids).await))
    }

    /// The server has no rotations: no schedule cards, as for Jira.
    async fn triage_schedule(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
        Ok(linear::resolve_org_slug(db, repo)
            .await?
            .map(|_| Vec::new()))
    }

    async fn move_to_started(&self, _db: &Db, _repo: &str, _id: &str) -> Result<Option<()>> {
        bail!(NO_WRITES)
    }
}

/// Every team the viewer's MCP org lets santree see, with what the viewer is to
/// it — the Triage teams setting's list. Only the viewer's own teams and those
/// holding a triage ticket of theirs: no tool lists the org's teams with keys.
pub(crate) async fn linear_teams(db: &Db, repo: &str) -> Result<Option<Vec<LinearTeam>>> {
    let Some(slug) = linear::resolve_org_slug(db, repo).await? else {
        return Ok(None);
    };
    let known = team_facts(db, &slug).await?;
    let facts = &known.facts;
    Ok(Some(
        facts
            .teams
            .iter()
            .map(|t| LinearTeam {
                key: t.key.clone(),
                name: t.name.clone(),
                member: facts.member.contains(&t.key),
                in_rotation: None,
                has_rotation: None,
                has_assigned: facts.assigned.contains(&t.key),
            })
            .collect(),
    ))
}

// ── Issues ──────────────────────────────────────────────────────────────────

async fn assigned_tasks(db: &Db, slug: &str) -> Result<Vec<Task>> {
    let pages = futures::future::try_join_all(OPEN_STATE_TYPES.iter().map(|state| {
        all_pages::<IssuesPage>(
            db,
            slug,
            "list_issues",
            json!({ "assignee": "me", "state": state, "fields": ISSUE_FIELDS }),
        )
    }))
    .await?;
    let mut seen = HashSet::new();
    let assigned: Vec<McpIssue> = pages
        .into_iter()
        .flatten()
        .filter(|issue| seen.insert(issue.id.clone()))
        .collect();
    let assigned_ids: HashSet<&str> = assigned.iter().map(|i| i.id.as_str()).collect();

    // The streams here take owned ids: a stream of borrowed items inside the
    // tracker's `Send` future trips rustc's "FnOnce is not general enough".
    let revisions: Vec<(String, String)> = assigned
        .iter()
        .map(|i| (i.id.clone(), i.updated_at.clone().unwrap_or_default()))
        .collect();
    // `None` for an issue whose blockers couldn't be read: unknown, not absent.
    let blockers: Vec<Option<Vec<String>>> = stream::iter(revisions)
        .map(|(id, updated_at)| blocked_by(db, slug, id, updated_at))
        .buffered(FAN_OUT)
        .collect()
        .await;

    // Blockers that aren't the viewer's own work join the graph as grayed context,
    // as they do from GraphQL, so every "blocked by" has a node.
    let outside_ids: BTreeSet<String> = blockers
        .iter()
        .flatten()
        .flatten()
        .filter(|id| !assigned_ids.contains(id.as_str()))
        .cloned()
        .collect();
    let outside: Vec<Arc<McpIssue>> = stream::iter(outside_ids)
        .map(|id| async move {
            issue(db, slug, &id)
                .await
                .inspect_err(|e| {
                    log::warn!("reading blocker {id} through Linear's MCP server: {e:#}")
                })
                .ok()
        })
        .buffered(FAN_OUT)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect();

    let everything: Vec<&McpIssue> = assigned
        .iter()
        .chain(outside.iter().map(Arc::as_ref))
        .collect();
    let known = enrich(db, slug, &everything, Lookups::ALL).await;
    let state_types: HashMap<&str, &str> = everything
        .iter()
        .map(|i| (i.id.as_str(), i.status_type.as_deref().unwrap_or_default()))
        .collect();

    let mut tasks: Vec<Task> = assigned
        .iter()
        .zip(blockers)
        .map(|(issue, blocked_by)| match blocked_by {
            Some(blocked_by) => {
                // A blocker that couldn't be read counts as open: readiness errs
                // toward "not yet" rather than launching work that may be blocked.
                let done: Vec<bool> = blocked_by
                    .iter()
                    .map(|id| {
                        state_types
                            .get(id.as_str())
                            .is_some_and(|t| linear::TERMINAL_STATES.contains(t))
                    })
                    .collect();
                wire::task_of(issue, blocked_by, &done, true, &known)
            }
            // Its blockers couldn't be read at all, so it is never ready: an
            // unreadable relation must not read as "nothing blocks this".
            None => wire::task_of(issue, Vec::new(), &[false], true, &known),
        })
        .collect();
    tasks.extend(
        outside
            .iter()
            .map(|issue| wire::task_of(issue, Vec::new(), &[], false, &known)),
    );
    linear::apply_subtask_dependencies(&mut tasks);
    layout::layout_tasks(&mut tasks);
    Ok(tasks)
}

/// An issue's blocker ids. A failure costs the blockers, not the list.
async fn blocked_by(db: &Db, slug: &str, id: String, updated_at: String) -> Option<Vec<String>> {
    let key = format!("{slug}/{id}@{updated_at}");
    let fetched = RELATIONS
        .get_or_fetch(&key, || async {
            let full: McpIssue = client::call_tool(
                db,
                slug,
                "get_issue",
                json!({ "id": id, "includeRelations": true }),
                Effect::Read,
            )
            .await?;
            Ok(full
                .relations
                .map(|r| r.blocked_by.into_iter().map(|link| link.id).collect())
                .unwrap_or_default())
        })
        .await;
    match fetched {
        Ok((ids, _)) => Some(ids.as_ref().clone()),
        Err(e) => {
            log::warn!("reading the blockers of {id} through Linear's MCP server: {e:#}");
            None
        }
    }
}

async fn issue(db: &Db, slug: &str, id: &str) -> Result<Arc<McpIssue>> {
    Ok(ISSUES
        .get_or_fetch(&format!("{slug}/{id}"), || {
            client::call_tool(db, slug, "get_issue", json!({ "id": id }), Effect::Read)
        })
        .await?
        .0)
}

/// How many identifiers one lookup resolves, as for GraphQL.
const TICKET_LOOKUP_CAP: usize = 200;

/// Identifiers to just enough to group PRs by project — one `get_issue` each,
/// since nothing looks up a list. An id that names nothing is skipped quietly; a
/// failure is logged and skipped, as grouping metadata is not worth an error.
/// `get_issue` carries no milestone, so these have none.
async fn ticket_refs(db: &Db, slug: &str, ids: &[String]) -> Vec<TicketRef> {
    if ids.len() > TICKET_LOOKUP_CAP {
        log::warn!(
            "Reviews: resolving only the first {TICKET_LOOKUP_CAP} of {} ticket ids through \
             Linear's MCP server; the rest group as \"No Project\"",
            ids.len()
        );
    }
    let wanted: Vec<String> = ids
        .iter()
        .take(TICKET_LOOKUP_CAP)
        .filter(|id| linear::split_identifier(id).is_some())
        .cloned()
        .collect();
    let found: Vec<Arc<McpIssue>> = stream::iter(wanted)
        .map(|id| async move {
            match issue(db, slug, &id).await {
                Ok(found) => Some(found),
                Err(e) if wire::is_not_found(&e) => None,
                Err(e) => {
                    log::warn!("looking up {id} through Linear's MCP server: {e:#}");
                    None
                }
            }
        })
        .buffered(FAN_OUT)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect();
    let issues: Vec<&McpIssue> = found.iter().map(Arc::as_ref).collect();
    let known = enrich(db, slug, &issues, Lookups::PROJECTS).await;
    issues
        .into_iter()
        .map(|issue| wire::ticket_ref(issue, &known))
        .collect()
}

// ── Enrichment ──────────────────────────────────────────────────────────────

/// Which of an issue read's lookups to run.
#[derive(Clone, Copy)]
struct Lookups {
    cycles: bool,
    users: bool,
}

impl Lookups {
    const ALL: Self = Self {
        cycles: true,
        users: true,
    };
    const PROJECTS: Self = Self {
        cycles: false,
        users: false,
    };
}

async fn enrich(db: &Db, slug: &str, issues: &[&McpIssue], lookups: Lookups) -> Enrichment {
    let mut teams_with_cycles = BTreeSet::new();
    let mut project_ids = BTreeSet::new();
    let mut user_ids = BTreeSet::new();
    for issue in issues {
        if lookups.cycles && issue.cycle_id.is_some() {
            teams_with_cycles.extend(issue.team_id.clone());
        }
        project_ids.extend(issue.project_id.clone());
        if lookups.users {
            user_ids.extend(issue.assignee_id.clone());
        }
    }
    let (cycles, projects, users) = tokio::join!(
        fan_out(teams_with_cycles, |team| cycles(db, slug, team)),
        fan_out(project_ids, |project_id| project(db, slug, project_id)),
        fan_out(user_ids, |user_id| user(db, slug, user_id)),
    );
    Enrichment {
        cycles: cycles
            .iter()
            .flat_map(|(_, list)| list.iter().map(|c| (c.id.clone(), wire::cycle_ref(c))))
            .collect(),
        projects: projects.into_iter().collect(),
        users: users.into_iter().collect(),
    }
}

/// Look each key up at a capped width and keep what succeeds. Enrichment is
/// decoration: a project colour that can't be read costs the colour, not the read.
async fn fan_out<T, F, Fut>(keys: BTreeSet<String>, lookup: F) -> Vec<(String, Arc<T>)>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Arc<T>>>,
{
    stream::iter(keys)
        .map(|key| {
            let found = lookup(key.clone());
            async move { (key, found.await) }
        })
        .buffered(FAN_OUT)
        .filter_map(|(key, found)| async move {
            match found {
                Ok(value) => Some((key, value)),
                // A comment's author can be an integration (GitHub, Slack) rather
                // than a workspace user: expected, and not a warning on every read.
                Err(e) if wire::is_not_found(&e) => {
                    log::debug!("Linear MCP lookup of {key}: {e:#}");
                    None
                }
                Err(e) => {
                    log::warn!("Linear MCP lookup of {key} failed: {e:#}");
                    None
                }
            }
        })
        .collect()
        .await
}

async fn cycles(db: &Db, slug: &str, team_id: String) -> Result<Arc<Vec<McpCycle>>> {
    Ok(CYCLES
        .get_or_fetch(&format!("{slug}/{team_id}"), || {
            client::call_tool(
                db,
                slug,
                "list_cycles",
                json!({ "teamId": team_id }),
                Effect::Read,
            )
        })
        .await?
        .0)
}

async fn project(db: &Db, slug: &str, project_id: String) -> Result<Arc<ProjectInfo>> {
    Ok(PROJECTS
        .get_or_fetch(&format!("{slug}/{project_id}"), || async {
            let (found, milestones) = tokio::try_join!(
                client::call_tool::<McpProject>(
                    db,
                    slug,
                    "get_project",
                    json!({ "query": project_id, "includeMilestones": true }),
                    Effect::Read,
                ),
                client::call_tool::<MilestonesList>(
                    db,
                    slug,
                    "list_milestones",
                    json!({ "project": project_id }),
                    Effect::Read,
                ),
            )?;
            Ok(wire::project_info(found, milestones.milestones))
        })
        .await?
        .0)
}

async fn user(db: &Db, slug: &str, query: String) -> Result<Arc<McpUser>> {
    Ok(USERS
        .get_or_fetch(&format!("{slug}/{query}"), || {
            client::call_tool(
                db,
                slug,
                "get_user",
                json!({ "query": query }),
                Effect::Read,
            )
        })
        .await?
        .0)
}

async fn statuses(db: &Db, slug: &str, team_id: &str) -> Result<Arc<Vec<McpStatus>>> {
    Ok(STATUSES
        .get_or_fetch(&format!("{slug}/{team_id}"), || {
            client::call_tool(
                db,
                slug,
                "list_issue_statuses",
                json!({ "team": team_id }),
                Effect::Read,
            )
        })
        .await?
        .0)
}

/// Every page of a paged list tool.
async fn all_pages<P: Paged>(db: &Db, slug: &str, tool: &str, args: Value) -> Result<Vec<P::Item>> {
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut page_args = args.clone();
        page_args["limit"] = json!(250);
        if let Some(cursor) = &cursor {
            page_args["cursor"] = json!(cursor);
        }
        let page: P = client::call_tool(db, slug, tool, page_args, Effect::Read).await?;
        let (found, next) = page.into_parts();
        items.extend(found);
        match next {
            Some(next) => cursor = Some(next),
            None => return Ok(items),
        }
    }
    log::warn!("stopped paging Linear MCP {tool} for org {slug} after {MAX_PAGES} pages");
    Ok(items)
}

// ── Triage ──────────────────────────────────────────────────────────────────

async fn team_facts(db: &Db, slug: &str) -> Result<Arc<McpTeamFacts>> {
    Ok(TEAMS
        .get_or_fetch(slug, || async {
            let (me, assigned) = tokio::try_join!(
                client::call_tool::<McpUser>(
                    db,
                    slug,
                    "get_user",
                    json!({ "query": "me" }),
                    Effect::Read,
                ),
                all_pages::<IssuesPage>(
                    db,
                    slug,
                    "list_issues",
                    json!({ "assignee": "me", "state": "triage", "fields": ["id", "team", "teamId"] }),
                ),
            )?;
            Ok(wire::team_facts(me, &assigned))
        })
        .await?
        .0)
}

/// The triage inbox: the triage-state issues of the teams the viewer is a member
/// of — one call per team, a few at a time. Unlike the GraphQL inbox, neither the
/// viewer's tickets on other teams nor teams where they only hold one are
/// included (`wire::mcp_triage_rules`). Soonest SLA breach first.
async fn triage(db: &Db, slug: &str, repo: &str) -> Result<Vec<TriageTicket>> {
    let known = team_facts(db, slug).await?;
    let rules = wire::mcp_triage_rules(linear::saved_triage_team_rules(db).await);
    let scope = linear::scope_of(&known.facts, &rules);
    let queries: Vec<Value> = scope
        .teams
        .iter()
        .filter_map(|team| known.team_ids.get(&team.key))
        .map(|team_id| json!({ "team": team_id, "state": "triage", "fields": TRIAGE_FIELDS }))
        .collect();

    let pages: Vec<Vec<McpIssue>> = stream::iter(queries)
        .map(|query| all_pages::<IssuesPage>(db, slug, "list_issues", query))
        .buffered(FAN_OUT)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<_>>()?;
    let viewer = known.facts.viewer_id.as_deref();
    // `list_issues`' team filter isn't exact: asked for the viewer's seven teams it
    // answered with over a thousand triage tickets, many on teams they aren't in.
    // So a ticket is kept only when its own team — the key in its identifier — is
    // one of the teams in scope.
    let in_scope: HashSet<&str> = scope.teams.iter().map(|t| t.key.as_str()).collect();
    let mut seen = HashSet::new();
    let mut left_out = 0usize;
    let mut tickets: Vec<TriageTicket> = pages
        .into_iter()
        .flatten()
        .filter(|issue| seen.insert(issue.id.clone()))
        .filter(|issue| {
            let ours =
                linear::split_identifier(&issue.id).is_some_and(|(key, _)| in_scope.contains(key));
            left_out += usize::from(!ours);
            ours
        })
        .map(|issue| wire::triage_ticket(&issue, viewer))
        .collect();
    tickets.sort_by_key(|t| t.sla_breach_ms.map_or(i64::MAX, |ms| ms as i64));
    log::info!(
        "fetched {} triage tickets for {repo} through Linear's MCP server across {} teams \
         ({left_out} on other teams left out)",
        tickets.len(),
        scope.teams.len()
    );
    Ok(tickets)
}

// ── Ticket detail ───────────────────────────────────────────────────────────

/// The full ticket for the ticket page and the agents' prompts. `None` when the
/// id names no ticket — a worktree cut from a plain branch carries a branch slug
/// where a ticket id goes, and that is its normal state, not a failure.
async fn detail(db: &Db, slug: &str, ticket_id: &str) -> Result<Option<TriageDetail>> {
    if linear::split_identifier(ticket_id).is_none() {
        return Ok(None);
    }
    let issue: McpIssue = match client::call_tool(
        db,
        slug,
        "get_issue",
        json!({ "id": ticket_id }),
        Effect::Read,
    )
    .await
    {
        Ok(issue) => issue,
        Err(err) if wire::is_not_found(&err) => return Ok(None),
        Err(err) => return Err(err),
    };

    let team_states = async {
        let Some(team_id) = issue.team_id.as_deref() else {
            return Vec::new();
        };
        match statuses(db, slug, team_id).await {
            Ok(found) => found.as_ref().clone(),
            Err(e) => {
                log::warn!(
                    "reading {}'s workflow states through Linear's MCP server: {e:#}",
                    issue.id
                );
                Vec::new()
            }
        }
    };
    let (comments, states, style) = tokio::join!(
        all_pages::<CommentsPage>(
            db,
            slug,
            "list_comments",
            json!({ "issueId": issue.id, "orderBy": "createdAt" }),
        ),
        team_states,
        linear::name_style(db),
    );
    let threads = wire::threads(comments?);

    let people: BTreeSet<String> = threads
        .iter()
        .flat_map(|(root, replies)| std::iter::once(root).chain(replies))
        .filter_map(|c| c.author.as_ref()?.id.clone())
        .chain(issue.created_by_id.clone())
        .chain(issue.assignee_id.clone())
        .collect();
    let users: HashMap<String, Arc<McpUser>> = fan_out(people, |id| user(db, slug, id))
        .await
        .into_iter()
        .collect();
    // What `get_issue` doesn't carry, from the viewer's own list when this ticket
    // is in it (the common case: it is their work). Otherwise empty.
    let listed: Option<Task> = ASSIGNED
        .peek(slug)
        .await
        .and_then(|tasks| tasks.iter().find(|t| t.id == issue.id).cloned());

    let description = linear::inline_images(
        gql::client(),
        &wire::plain_mentions(issue.description.as_deref().unwrap_or_default()),
        None,
    )
    .await;
    let comments = futures::future::join_all(
        threads
            .into_iter()
            .map(|(root, replies)| thread(root, replies, &users, style)),
    )
    .await;

    let (author, author_avatar_url) = wire::person(
        issue.created_by_id.as_deref(),
        issue.created_by.as_deref(),
        &users,
        style,
    );
    let (assignee, assignee_avatar_url) = wire::person(
        issue.assignee_id.as_deref(),
        issue.assignee.as_deref(),
        &users,
        style,
    );
    Ok(Some(TriageDetail {
        priority: wire::priority_of(&issue),
        tracker_name: "Linear".into(),
        state: issue.status.clone().unwrap_or_else(|| "Triage".into()),
        state_id: wire::current_state_id(&issue),
        states: wire::workflow_states(states),
        url: issue
            .url
            .clone()
            .unwrap_or_else(|| format!("https://linear.app/{slug}/issue/{}", issue.id)),
        author: author.unwrap_or_else(|| "Unknown".into()),
        author_avatar_url,
        created_at_ms: issue
            .created_at
            .as_deref()
            .and_then(linear::parse_ms)
            .map(|v| v as f64)
            .unwrap_or_default(),
        labels: issue.labels.clone(),
        project: issue.project.clone(),
        project_milestone: listed.as_ref().and_then(|t| t.project_milestone.clone()),
        assignee,
        assignee_avatar_url,
        estimate: listed.as_ref().and_then(|t| t.estimate),
        cycle: listed.as_ref().and_then(|t| t.cycle.clone()),
        due_date: issue.due_date.clone(),
        sla_breach_ms: issue
            .sla_breaches_at
            .as_deref()
            .and_then(linear::parse_ms)
            .map(|v| v as f64),
        snoozed_until_ms: None,
        description,
        comments,
        id: issue.id,
        title: issue.title,
    }))
}

async fn thread(
    root: McpComment,
    replies: Vec<McpComment>,
    users: &HashMap<String, Arc<McpUser>>,
    style: NameStyle,
) -> TriageComment {
    let (root, children) = tokio::join!(
        comment(root, users, style),
        futures::future::join_all(
            replies
                .into_iter()
                .map(|reply| comment(reply, users, style))
        ),
    );
    TriageComment { children, ..root }
}

async fn comment(
    found: McpComment,
    users: &HashMap<String, Arc<McpUser>>,
    style: NameStyle,
) -> TriageComment {
    let (author, avatar_url) = wire::person(
        found.author.as_ref().and_then(|a| a.id.as_deref()),
        found.author.as_ref().and_then(|a| a.name.as_deref()),
        users,
        style,
    );
    TriageComment {
        author: author.unwrap_or_else(|| "Unknown".into()),
        avatar_url,
        created_at_ms: found
            .created_at
            .as_deref()
            .and_then(linear::parse_ms)
            .map(|v| v as f64)
            .unwrap_or_default(),
        body: linear::inline_images(gql::client(), &wire::plain_mentions(&found.body), None).await,
        children: Vec::new(),
        id: found.id,
    }
}
