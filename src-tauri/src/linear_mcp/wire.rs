//! What Linear's MCP tools answer with, and the pure mapping from it to
//! santree's domain types.
//!
//! The shapes are as measured (`docs/linear-mcp.md`, "Measured"). The output is
//! written for a model to read, not versioned, so almost every field is optional
//! or defaulted — a field Linear stops sending costs that field, never the read —
//! and a `null` where a list was reads as an empty list. The exceptions are the
//! list a response exists to carry and the ids a read keys on: a response missing
//! those was reshaped, and has to fail naming the tool rather than read as "no
//! tickets".

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use santree_core::domain::{
    CycleRef, Priority, ProjectMilestoneRef, Task, TaskStatus, TeamRef, TicketRef, TriageTicket,
    WorkflowState,
};
use santree_core::linear as core_linear;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};

use super::client;
use crate::linear::{self, NameStyle, TeamFacts, TeamNode, TriageTeamRules};

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/// A `{ value, name }` pair — how the tools send priority and estimate.
#[derive(Deserialize, Clone, Default)]
pub(crate) struct Valued {
    #[serde(default)]
    pub(crate) value: Option<f64>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct MilestoneLink {
    pub(crate) id: String,
}

#[derive(Deserialize, Clone)]
pub(crate) struct StateLink {
    #[serde(default)]
    pub(crate) id: Option<String>,
}

/// One stretch of an issue's state history; the open one (`endedAt: null`) is
/// the state it is in now.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StateSpan {
    #[serde(default)]
    pub(crate) state: Option<StateLink>,
    #[serde(default)]
    pub(crate) ended_at: Option<String>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct IssueLink {
    pub(crate) id: String,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Relations {
    #[serde(default, deserialize_with = "null_as_default")]
    pub(crate) blocked_by: Vec<IssueLink>,
}

/// An issue as `list_issues` (with `fields`) and `get_issue` send it. `id` is the
/// human identifier (`ENG-123`).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpIssue {
    pub(crate) id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) priority: Option<Valued>,
    #[serde(default)]
    pub(crate) estimate: Option<Valued>,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
    #[serde(default)]
    pub(crate) due_date: Option<String>,
    #[serde(default)]
    pub(crate) sla_breaches_at: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) status_type: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub(crate) labels: Vec<String>,
    /// The assignee's name.
    #[serde(default)]
    pub(crate) assignee: Option<String>,
    #[serde(default)]
    pub(crate) assignee_id: Option<String>,
    /// The creator, as an email address.
    #[serde(default)]
    pub(crate) created_by: Option<String>,
    #[serde(default)]
    pub(crate) created_by_id: Option<String>,
    /// The project's name.
    #[serde(default)]
    pub(crate) project: Option<String>,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    #[serde(default)]
    pub(crate) project_milestone: Option<MilestoneLink>,
    #[serde(default)]
    pub(crate) parent_id: Option<String>,
    /// The team's name.
    #[serde(default)]
    pub(crate) team: Option<String>,
    #[serde(default)]
    pub(crate) team_id: Option<String>,
    #[serde(default)]
    pub(crate) cycle_id: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub(crate) state_history: Vec<StateSpan>,
    #[serde(default)]
    pub(crate) relations: Option<Relations>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct Author {
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(default)]
    pub(crate) name: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpComment {
    pub(crate) id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) parent_id: Option<String>,
    #[serde(default)]
    pub(crate) author: Option<Author>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct McpStatus {
    #[serde(default)]
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default, rename = "type")]
    pub(crate) type_: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpCycle {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) number: f64,
    #[serde(default)]
    pub(crate) starts_at: Option<String>,
    #[serde(default)]
    pub(crate) ends_at: Option<String>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct McpTeam {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) key: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpUser {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) display_name: Option<String>,
    #[serde(default)]
    pub(crate) avatar_url: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub(crate) teams: Vec<McpTeam>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectMilestoneDate {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) target_date: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpProject {
    #[serde(default)]
    pub(crate) color: Option<String>,
    #[serde(default)]
    pub(crate) icon: Option<String>,
    #[serde(default)]
    pub(crate) target_date: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub(crate) milestones: Vec<ProjectMilestoneDate>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpMilestone {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) sort_order: Option<f64>,
}

#[derive(Deserialize)]
pub(crate) struct MilestonesList {
    #[serde(deserialize_with = "null_as_default")]
    pub(crate) milestones: Vec<McpMilestone>,
}

/// A page of a paged list tool: its items, and the cursor to the next page when
/// there is one.
pub(crate) trait Paged: DeserializeOwned + Send {
    type Item: Send;
    fn into_parts(self) -> (Vec<Self::Item>, Option<String>);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssuesPage {
    #[serde(deserialize_with = "null_as_default")]
    pub(crate) issues: Vec<McpIssue>,
    #[serde(default)]
    pub(crate) has_next_page: bool,
    #[serde(default)]
    pub(crate) cursor: Option<String>,
}

impl Paged for IssuesPage {
    type Item = McpIssue;
    fn into_parts(self) -> (Vec<McpIssue>, Option<String>) {
        let more = self.has_next_page;
        (self.issues, self.cursor.filter(|_| more))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommentsPage {
    #[serde(deserialize_with = "null_as_default")]
    pub(crate) comments: Vec<McpComment>,
    #[serde(default)]
    pub(crate) has_next_page: bool,
    #[serde(default)]
    pub(crate) cursor: Option<String>,
}

impl Paged for CommentsPage {
    type Item = McpComment;
    fn into_parts(self) -> (Vec<McpComment>, Option<String>) {
        let more = self.has_next_page;
        (self.comments, self.cursor.filter(|_| more))
    }
}

// ── Mapping ─────────────────────────────────────────────────────────────────

/// What an issue read needs beyond the issue: the cycles, projects and people it
/// points at by id. Looked up separately and best effort, so each map holds only
/// what could be read.
#[derive(Default)]
pub(crate) struct Enrichment {
    /// By cycle id.
    pub(crate) cycles: HashMap<String, CycleRef>,
    /// By project id.
    pub(crate) projects: HashMap<String, Arc<ProjectInfo>>,
    /// By user id.
    pub(crate) users: HashMap<String, Arc<McpUser>>,
}

/// A project's presentation and its milestones, from `get_project` and
/// `list_milestones` together.
#[derive(Clone, Default)]
pub(crate) struct ProjectInfo {
    pub(crate) color: Option<String>,
    pub(crate) icon: Option<String>,
    pub(crate) target_date: Option<String>,
    /// By milestone id.
    pub(crate) milestones: HashMap<String, ProjectMilestoneRef>,
}

/// Each tool has half a milestone: the project's list carries target dates but
/// no order, `list_milestones` the order but no dates. A milestone without an
/// order is left out rather than given one.
pub(crate) fn project_info(project: McpProject, milestones: Vec<McpMilestone>) -> ProjectInfo {
    let dates: HashMap<String, Option<String>> = project
        .milestones
        .into_iter()
        .map(|m| (m.id, m.target_date))
        .collect();
    ProjectInfo {
        color: project.color,
        icon: project.icon,
        target_date: project.target_date,
        milestones: milestones
            .into_iter()
            .filter_map(|m| {
                let sort_order = m.sort_order?;
                Some((
                    m.id.clone(),
                    ProjectMilestoneRef {
                        target_date: dates.get(&m.id).cloned().flatten(),
                        id: m.id,
                        name: m.name,
                        sort_order,
                    },
                ))
            })
            .collect(),
    }
}

pub(crate) fn cycle_ref(cycle: &McpCycle) -> CycleRef {
    CycleRef {
        number: cycle.number,
        // MCP cycles carry no name.
        name: None,
        starts_at_ms: cycle
            .starts_at
            .as_deref()
            .and_then(linear::parse_ms)
            .map(|v| v as f64),
        ends_at_ms: cycle
            .ends_at
            .as_deref()
            .and_then(linear::parse_ms)
            .map(|v| v as f64),
    }
}

pub(crate) fn priority_of(issue: &McpIssue) -> Priority {
    core_linear::map_priority(
        issue
            .priority
            .as_ref()
            .and_then(|p| p.value)
            .map_or(0, |v| v as i64),
    )
}

fn status_of(issue: &McpIssue) -> TaskStatus {
    core_linear::map_status(
        issue.status.as_deref().unwrap_or("Unknown"),
        issue.status_type.as_deref().unwrap_or("unstarted"),
    )
}

/// The team key comes off the identifier (Linear's ids are `<KEY>-<number>`):
/// no tool sends a team's key beside its issues.
fn team_of(issue: &McpIssue) -> Option<TeamRef> {
    linear::split_identifier(&issue.id).map(|(key, _)| TeamRef {
        key: key.to_string(),
        name: issue.team.clone(),
    })
}

fn project_of<'a>(issue: &McpIssue, known: &'a Enrichment) -> Option<&'a ProjectInfo> {
    issue
        .project_id
        .as_ref()
        .and_then(|id| known.projects.get(id))
        .map(Arc::as_ref)
}

fn milestone_of(issue: &McpIssue, project: Option<&ProjectInfo>) -> Option<ProjectMilestoneRef> {
    let link = issue.project_milestone.as_ref()?;
    project?.milestones.get(&link.id).cloned()
}

fn project_name(issue: &McpIssue) -> String {
    issue
        .project
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "No Project".into())
}

/// An issue as a Task. `blocked_by` and `blockers_done` are its blockers' ids and
/// whether each is closed; `actionable` is whether it is the viewer's own work
/// (a blocker pulled in for context is not).
pub(crate) fn task_of(
    issue: &McpIssue,
    blocked_by: Vec<String>,
    blockers_done: &[bool],
    actionable: bool,
    known: &Enrichment,
) -> Task {
    let status = status_of(issue);
    let project = project_of(issue, known);
    Task {
        id: issue.id.clone(),
        title: issue.title.clone(),
        priority: priority_of(issue),
        team: team_of(issue),
        estimate: issue.estimate.as_ref().and_then(|e| e.value),
        cycle: issue
            .cycle_id
            .as_ref()
            .and_then(|id| known.cycles.get(id))
            .cloned(),
        due_date: issue.due_date.clone(),
        project: project_name(issue),
        project_color: project.and_then(|p| p.color.clone()),
        project_icon: project.and_then(|p| p.icon.clone()),
        project_target_date: project.and_then(|p| p.target_date.clone()),
        project_milestone: milestone_of(issue, project),
        parent_id: issue.parent_id.clone(),
        status,
        // As the GraphQL read: ready only when every blocker is done and the work
        // hasn't started — and never for a blocker pulled in as context.
        ready: actionable && core_linear::is_ready(blockers_done) && status.is_startable(),
        blocked_by,
        actionable,
        assignee: issue.assignee.clone().filter(|name| !name.is_empty()),
        assignee_avatar_url: issue
            .assignee_id
            .as_ref()
            .and_then(|id| known.users.get(id))
            .and_then(|u| u.avatar_url.clone()),
        x: 0,
        y: 0,
    }
}

pub(crate) fn ticket_ref(issue: &McpIssue, known: &Enrichment) -> TicketRef {
    let project = project_of(issue, known);
    TicketRef {
        identifier: issue.id.clone(),
        title: issue.title.clone(),
        priority: priority_of(issue),
        project: project_name(issue),
        project_color: project.and_then(|p| p.color.clone()),
        project_icon: project.and_then(|p| p.icon.clone()),
        project_target_date: project.and_then(|p| p.target_date.clone()),
        project_milestone: milestone_of(issue, project),
    }
}

/// A triage row. Never snoozed: the server doesn't say.
pub(crate) fn triage_ticket(issue: &McpIssue, viewer_id: Option<&str>) -> TriageTicket {
    TriageTicket {
        id: issue.id.clone(),
        title: issue.title.clone(),
        priority: priority_of(issue),
        team: linear::split_identifier(&issue.id).map(|(key, _)| key.to_string()),
        sla_breach_ms: issue
            .sla_breaches_at
            .as_deref()
            .and_then(linear::parse_ms)
            .map(|v| v as f64),
        snoozed_until_ms: None,
        mine: viewer_id.is_some() && issue.assignee_id.as_deref() == viewer_id,
    }
}

/// The id of the state an issue is in: its open history span, else its latest.
pub(crate) fn current_state_id(issue: &McpIssue) -> Option<String> {
    issue
        .state_history
        .iter()
        .rev()
        .find(|span| span.ended_at.is_none())
        .or(issue.state_history.last())
        .and_then(|span| span.state.as_ref()?.id.clone())
}

/// Linear's category order. MCP statuses carry no position, so the picker lists
/// them by category, in the order the server sent them within one.
const STATE_TYPE_ORDER: [&str; 7] = [
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "duplicate",
];

/// A team's statuses for the picker. MCP statuses carry no colour, so each gets
/// Linear's default colour for its type — as Jira's statuses are coloured by
/// their category — rather than none.
pub(crate) fn workflow_states(mut statuses: Vec<McpStatus>) -> Vec<WorkflowState> {
    statuses.sort_by_key(|s| {
        STATE_TYPE_ORDER
            .iter()
            .position(|t| *t == s.type_)
            .unwrap_or(STATE_TYPE_ORDER.len())
    });
    statuses
        .into_iter()
        .map(|s| WorkflowState {
            color: state_type_color(&s.type_).to_string(),
            id: s.id,
            name: s.name,
            type_: s.type_,
        })
        .collect()
}

/// The colour Linear gives a new state of each type.
fn state_type_color(state_type: &str) -> &'static str {
    match state_type {
        "triage" => "#fc7840",
        "backlog" => "#bec2c8",
        "unstarted" => "#e2e2e2",
        "started" => "#f2c94c",
        "completed" => "#5e6ad2",
        _ => "#95a2b3",
    }
}

/// Comments as threads, oldest first: each top-level comment with its replies.
/// A reply to a reply joins its root's thread (the pane draws one level), and a
/// reply whose parent isn't in the list stands as a thread of its own.
pub(crate) fn threads(comments: Vec<McpComment>) -> Vec<(McpComment, Vec<McpComment>)> {
    let parents: HashMap<String, Option<String>> = comments
        .iter()
        .map(|c| (c.id.clone(), c.parent_id.clone()))
        .collect();
    let root_of = |comment: &McpComment| -> Option<String> {
        let mut parent = comment.parent_id.clone()?;
        let mut seen = HashSet::new();
        // Walk up while the parent is known; a cycle can't happen, but a bad
        // payload mustn't hang the read.
        while let Some(Some(grand)) = parents.get(&parent) {
            if !seen.insert(parent.clone()) {
                break;
            }
            parent = grand.clone();
        }
        parents.contains_key(&parent).then_some(parent)
    };
    let created = |c: &McpComment| {
        c.created_at
            .as_deref()
            .and_then(linear::parse_ms)
            .unwrap_or(0)
    };

    let mut roots: Vec<McpComment> = Vec::new();
    let mut replies: HashMap<String, Vec<McpComment>> = HashMap::new();
    for comment in comments {
        match root_of(&comment) {
            Some(root) => replies.entry(root).or_default().push(comment),
            None => roots.push(comment),
        }
    }
    roots.sort_by_key(created);
    roots
        .into_iter()
        .map(|root| {
            let mut children = replies.remove(&root.id).unwrap_or_default();
            children.sort_by_key(created);
            (root, children)
        })
        .collect()
}

/// A person's `(name, avatar)`: from the user record when it could be read, named
/// by the display-name setting, else the name the payload carried beside the id.
pub(crate) fn person(
    id: Option<&str>,
    fallback: Option<&str>,
    users: &HashMap<String, Arc<McpUser>>,
    style: NameStyle,
) -> (Option<String>, Option<String>) {
    let fallback = fallback.filter(|s| !s.is_empty()).map(str::to_owned);
    match id.and_then(|id| users.get(id)) {
        Some(user) => (
            linear::pick_name(user.name.clone(), user.display_name.clone(), style).or(fallback),
            user.avatar_url.clone(),
        ),
        None => (fallback, None),
    }
}

/// Whether a failed tool call failed because the thing named doesn't exist — the
/// server's own words on an `isError` result, which come as "… not found" or (as
/// measured for users) "Could not find referenced User.". Anything else still
/// fails.
pub(crate) fn is_not_found(err: &anyhow::Error) -> bool {
    client::tool_error(err).is_some_and(|e| {
        let message = e.message.to_ascii_lowercase();
        message.contains("not found") || message.contains("could not find")
    })
}

/// The Team-scope facts an MCP org can offer: the viewer's own teams (the only
/// place a team's key comes from) and the teams holding a triage ticket of
/// theirs (keyed off the identifier). No rotations — the server has none.
pub(crate) struct McpTeamFacts {
    pub(crate) facts: TeamFacts,
    /// Team key → id. `list_issues` filters by a team's id or name, not its key.
    pub(crate) team_ids: HashMap<String, String>,
}

pub(crate) fn team_facts(me: McpUser, assigned_triage: &[McpIssue]) -> McpTeamFacts {
    let member: HashSet<String> = me
        .teams
        .iter()
        .filter(|t| !t.key.is_empty())
        .map(|t| t.key.clone())
        .collect();
    let mut team_ids: HashMap<String, String> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut teams: Vec<TeamNode> = Vec::new();
    for team in me.teams {
        if team.key.is_empty() {
            continue;
        }
        team_ids.insert(team.key.clone(), team.id);
        if seen.insert(team.key.clone()) {
            teams.push(TeamNode {
                key: team.key,
                name: team.name,
                triage_responsibility: None,
            });
        }
    }
    let mut assigned: HashSet<String> = HashSet::new();
    for issue in assigned_triage {
        let Some((key, _)) = linear::split_identifier(&issue.id) else {
            continue;
        };
        assigned.insert(key.to_string());
        if let Some(id) = &issue.team_id {
            team_ids
                .entry(key.to_string())
                .or_insert_with(|| id.clone());
        }
        if seen.insert(key.to_string()) {
            teams.push(TeamNode {
                key: key.to_string(),
                name: issue.team.clone().unwrap_or_else(|| key.to_string()),
                triage_responsibility: None,
            });
        }
    }
    McpTeamFacts {
        facts: TeamFacts {
            viewer_id: (!me.id.is_empty()).then_some(me.id),
            teams,
            member,
            assigned,
        },
        team_ids,
    }
}

/// The Triage team rules an MCP org is read under: the teams the viewer is a
/// member of, and nothing wider (`docs/linear-mcp.md`, "Triage scope"). There
/// are no rotations to read, and a team where they only hold a ticket isn't
/// theirs to triage. What the user saved can only narrow it — a team they hid
/// stays hidden; the rules that would widen it don't apply here.
pub(crate) fn mcp_triage_rules(saved: Option<TriageTeamRules>) -> TriageTeamRules {
    TriageTeamRules {
        rotation: false,
        assigned: false,
        member: true,
        picked: Vec::new(),
        hidden: saved.map(|rules| rules.hidden).unwrap_or_default(),
    }
}

/// The tags Linear's MCP markdown carries mentions as, where GraphQL sends
/// markdown.
const MENTION_TAGS: [&str; 5] = ["issue", "user", "project", "document", "initiative"];

/// Turn the MCP server's mention tags back into what the renderer and the agents
/// read: `<issue id="…" href="https://…">ENG-1</issue>` becomes a link,
/// `<user id="…">ada</user>` becomes `@ada`, and a tag without an https `href`
/// becomes its text. Anything that isn't such a tag is left exactly as it was.
pub(crate) fn plain_mentions(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        match mention(tail) {
            Some((replacement, consumed)) => {
                out.push_str(&replacement);
                rest = &tail[consumed..];
            }
            None => {
                out.push('<');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// One mention tag at the start of `tail`: its replacement and how many bytes it
/// spans.
fn mention(tail: &str) -> Option<(String, usize)> {
    let name_len = tail[1..]
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(tail.len() - 1);
    let tag = &tail[1..1 + name_len];
    if !MENTION_TAGS.contains(&tag) {
        return None;
    }
    // Neither the opening tag nor the label may hold a `<`, so each search stops at
    // the next one. Searching the whole rest of the text for every `<` would make
    // a long description quadratic.
    let tag_end = tail[1..].find('<').map_or(tail.len(), |at| at + 1);
    let open_end = tail[..tag_end].find('>')?;
    let attrs = &tail[1 + name_len..open_end];
    if !(attrs.is_empty() || attrs.starts_with(' ')) {
        return None;
    }
    let close = format!("</{tag}>");
    let label_start = open_end + 1;
    let label_len = tail[label_start..].find('<')?;
    if !tail[label_start + label_len..].starts_with(close.as_str()) {
        return None;
    }
    let label = &tail[label_start..label_start + label_len];
    let replacement = if tag == "user" {
        format!("@{label}")
    } else {
        match attr(attrs, "href").filter(|href| is_https_link(href)) {
            Some(href) => format!("[{label}]({href})"),
            None => label.to_string(),
        }
    };
    Some((replacement, label_start + label_len + close.len()))
}

/// Whether `href` can be a markdown link target: an https url by parse, with
/// nothing in it that would end the link early.
fn is_https_link(href: &str) -> bool {
    reqwest::Url::parse(href).is_ok_and(|url| url.scheme() == "https")
        && !href.contains(|c: char| c.is_whitespace() || c == '(' || c == ')')
}

fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let start = attrs.find(&key)? + key.len();
    let len = attrs[start..].find('"')?;
    Some(&attrs[start..start + len])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn issue(value: serde_json::Value) -> McpIssue {
        serde_json::from_value(value).expect("issue")
    }

    #[test]
    fn an_assigned_issue_maps_with_what_its_lookups_found() {
        let page: IssuesPage = serde_json::from_value(json!({
            "issues": [{
                "id": "ENG-12",
                "title": "Fix the importer",
                "priority": { "value": 2, "name": "High" },
                "estimate": { "value": 3, "name": "3 Points" },
                "status": "Todo",
                "statusType": "unstarted",
                "labels": null,
                "assignee": "Ada Lovelace",
                "assigneeId": "u1",
                "project": "Importer",
                "projectId": "p1",
                "projectMilestone": { "id": "m1", "name": "Beta" },
                "parentId": "ENG-10",
                "team": "Engineering",
                "teamId": "t1",
                "cycleId": "c1",
                "dueDate": "2026-10-01",
                "updatedAt": "2026-09-01T00:00:00.000Z"
            }],
            "hasNextPage": true,
            "cursor": "next"
        }))
        .unwrap();
        let (issues, cursor) = page.into_parts();
        assert_eq!(cursor.as_deref(), Some("next"));

        let mut known = Enrichment::default();
        let cycle: McpCycle = serde_json::from_value(json!({
            "id": "c1", "number": 7,
            "startsAt": "2026-09-01T00:00:00.000Z", "endsAt": "2026-09-15T00:00:00.000Z",
            "isCurrent": true
        }))
        .unwrap();
        known.cycles.insert("c1".into(), cycle_ref(&cycle));
        let project: McpProject = serde_json::from_value(json!({
            "color": "#5e6ad2", "icon": "Rocket", "targetDate": "2026-12-01",
            "milestones": [{ "id": "m1", "name": "Beta", "targetDate": "2026-10-15" }]
        }))
        .unwrap();
        let milestones: MilestonesList = serde_json::from_value(json!({
            "milestones": [{ "id": "m1", "name": "Beta", "sortOrder": 12.5 }]
        }))
        .unwrap();
        known.projects.insert(
            "p1".into(),
            Arc::new(project_info(project, milestones.milestones)),
        );
        known.users.insert(
            "u1".into(),
            Arc::new(
                serde_json::from_value(json!({
                    "id": "u1", "name": "Ada Lovelace", "avatarUrl": "https://example.com/ada.png"
                }))
                .unwrap(),
            ),
        );

        let task = task_of(&issues[0], vec!["ENG-9".into()], &[true], true, &known);
        assert_eq!(task.id, "ENG-12");
        assert_eq!(task.priority, Priority::High);
        assert_eq!(task.status, TaskStatus::Todo);
        assert!(task.ready, "its only blocker is done and it hasn't started");
        let team = task.team.as_ref().expect("team");
        assert_eq!(
            (team.key.as_str(), team.name.as_deref()),
            ("ENG", Some("Engineering"))
        );
        assert_eq!(task.estimate, Some(3.0));
        assert_eq!(task.cycle.as_ref().map(|c| c.number), Some(7.0));
        assert_eq!(task.project, "Importer");
        assert_eq!(task.project_color.as_deref(), Some("#5e6ad2"));
        let milestone = task.project_milestone.as_ref().expect("milestone");
        assert_eq!(milestone.sort_order, 12.5);
        assert_eq!(milestone.target_date.as_deref(), Some("2026-10-15"));
        assert_eq!(task.parent_id.as_deref(), Some("ENG-10"));
        assert_eq!(
            task.assignee_avatar_url.as_deref(),
            Some("https://example.com/ada.png")
        );

        // A blocker that isn't done keeps it from being ready; as context it never is.
        assert!(!task_of(&issues[0], vec!["ENG-9".into()], &[false], true, &known).ready);
        assert!(!task_of(&issues[0], vec![], &[], false, &known).ready);
    }

    #[test]
    fn lookups_that_failed_leave_their_fields_empty() {
        let issue = issue(json!({
            "id": "ENG-3", "title": "t", "statusType": "started", "status": "In Progress",
            "projectId": "p9", "projectMilestone": { "id": "m9", "name": "Later" }, "cycleId": "c9"
        }));
        let task = task_of(&issue, vec![], &[], true, &Enrichment::default());
        assert_eq!(task.project, "No Project");
        assert_eq!(task.project_color, None);
        assert_eq!(task.project_milestone, None);
        assert_eq!(task.cycle, None);
        assert_eq!(task.status, TaskStatus::InProgress);

        // A milestone the ordered list doesn't have is dropped, never given an order.
        let info = project_info(
            serde_json::from_value(json!({ "milestones": [{ "id": "m9", "targetDate": null }] }))
                .unwrap(),
            vec![],
        );
        assert!(info.milestones.is_empty());
    }

    /// Both of the server's wordings for a missing thing count; a failure that
    /// isn't the tool's own, or says something else, doesn't.
    #[test]
    fn not_found_is_read_from_the_tools_own_words() {
        let tool_failure = |message: &str| {
            anyhow::Error::new(client::ToolError {
                tool: "get_user".into(),
                message: message.into(),
            })
        };
        assert!(is_not_found(&tool_failure(
            r#"{"error":"invalid_request","message":"Could not find referenced User.","status":400}"#
        )));
        assert!(is_not_found(&tool_failure("Issue not found")));
        assert!(!is_not_found(&tool_failure("Rate limit exceeded")));
        assert!(!is_not_found(&anyhow::anyhow!("Issue not found")));
    }

    /// A reshaped response must fail, not read as an empty queue.
    #[test]
    fn a_page_without_its_list_is_a_failure_not_an_empty_one() {
        assert!(
            serde_json::from_value::<IssuesPage>(json!({ "nodes": [], "hasNextPage": false }))
                .is_err()
        );
        assert!(serde_json::from_value::<CommentsPage>(json!({ "hasNextPage": false })).is_err());
        assert!(serde_json::from_value::<MilestonesList>(json!({})).is_err());
        assert!(serde_json::from_value::<McpUser>(json!({ "name": "Ada" })).is_err());
        // An explicit `null` list is still an empty one.
        let page: IssuesPage = serde_json::from_value(json!({ "issues": null })).unwrap();
        assert!(page.issues.is_empty());
    }

    #[test]
    fn a_triage_row_is_mine_only_when_assigned_to_the_viewer() {
        let row = issue(json!({
            "id": "OPS-7", "title": "Pager", "priority": { "value": 1 },
            "slaBreachesAt": "2026-09-14T00:00:00.000Z", "assigneeId": "me-1"
        }));
        let ticket = triage_ticket(&row, Some("me-1"));
        assert!(ticket.mine);
        assert_eq!(ticket.team.as_deref(), Some("OPS"));
        assert_eq!(ticket.priority, Priority::Urgent);
        assert!(ticket.sla_breach_ms.is_some());
        assert_eq!(ticket.snoozed_until_ms, None);
        assert!(!triage_ticket(&row, Some("someone-else")).mine);
        assert!(!triage_ticket(&row, None).mine);
    }

    #[test]
    fn the_current_state_is_the_open_history_span() {
        let issue = issue(json!({
            "id": "ENG-1",
            "stateHistory": [
                { "state": { "id": "s-triage", "name": "Triage", "type": "triage" },
                  "startedAt": "2026-08-01T00:00:00.000Z", "endedAt": "2026-08-02T00:00:00.000Z" },
                { "state": { "id": "s-todo", "name": "Todo", "type": "unstarted" },
                  "startedAt": "2026-08-02T00:00:00.000Z", "endedAt": null }
            ]
        }));
        assert_eq!(current_state_id(&issue).as_deref(), Some("s-todo"));
        assert_eq!(
            current_state_id(&self::issue(json!({ "id": "ENG-2" }))),
            None
        );
    }

    #[test]
    fn statuses_are_ordered_and_coloured_by_category() {
        let statuses: Vec<McpStatus> = serde_json::from_value(json!([
            { "id": "1", "type": "canceled", "name": "Won't do" },
            { "id": "2", "type": "started", "name": "In Progress" },
            { "id": "3", "type": "triage", "name": "Triage" },
            { "id": "4", "type": "started", "name": "In Review" },
            { "id": "5", "type": "backlog", "name": "Backlog" }
        ]))
        .unwrap();
        let states = workflow_states(statuses);
        assert_eq!(
            states.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["Triage", "Backlog", "In Progress", "In Review", "Won't do"]
        );
        assert_eq!(states[0].color, "#fc7840");
        assert_eq!(states[2].color, states[3].color, "one colour per category");
        assert!(states.iter().all(|s| s.color.starts_with('#')));
    }

    #[test]
    fn replies_hang_off_their_root_oldest_first() {
        let comments: Vec<McpComment> = serde_json::from_value(json!([
            { "id": "b", "body": "second thread", "createdAt": "2026-09-02T00:00:00.000Z", "parentId": null },
            { "id": "a2", "body": "reply to a reply", "createdAt": "2026-09-01T03:00:00.000Z", "parentId": "a1" },
            { "id": "a", "body": "first thread", "createdAt": "2026-09-01T00:00:00.000Z", "parentId": null },
            { "id": "a1", "body": "reply", "createdAt": "2026-09-01T02:00:00.000Z", "parentId": "a" },
            { "id": "x", "body": "orphan", "createdAt": "2026-09-03T00:00:00.000Z", "parentId": "gone" }
        ]))
        .unwrap();
        let threads = threads(comments);
        let shape: Vec<(&str, Vec<&str>)> = threads
            .iter()
            .map(|(root, replies)| {
                (
                    root.id.as_str(),
                    replies.iter().map(|r| r.id.as_str()).collect(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![("a", vec!["a1", "a2"]), ("b", vec![]), ("x", vec![])]
        );
    }

    #[test]
    fn mention_tags_become_markdown() {
        assert_eq!(
            plain_mentions(
                r#"Related to <issue id="6b" href="https://linear.app/acme/issue/ENG-1/title">ENG-1</issue>, ask <user id="u1">ada</user>."#
            ),
            "Related to [ENG-1](https://linear.app/acme/issue/ENG-1/title), ask @ada."
        );
        // No https href: the text alone.
        assert_eq!(
            plain_mentions(r#"<project id="p" href="javascript:alert(1)">Importer</project>"#),
            "Importer"
        );
        // Not a mention tag, or not a complete one: untouched.
        for untouched in [
            "a < b and <b>bold</b>",
            "<issue id=\"x\">never closed",
            "<issues>ENG-1</issues>",
            "trailing <",
            "`<user>` in code",
        ] {
            assert_eq!(plain_mentions(untouched), untouched);
        }
    }

    #[test]
    fn team_facts_take_keys_from_memberships_and_triage_identifiers() {
        let me: McpUser = serde_json::from_value(json!({
            "id": "me-1", "name": "Ada",
            "teams": [{ "id": "t-eng", "name": "Engineering", "key": "ENG" }]
        }))
        .unwrap();
        let assigned = vec![issue(
            json!({ "id": "OPS-4", "team": "Operations", "teamId": "t-ops" }),
        )];
        let facts = team_facts(me, &assigned);
        assert_eq!(facts.facts.viewer_id.as_deref(), Some("me-1"));
        assert_eq!(
            facts
                .facts
                .teams
                .iter()
                .map(|t| t.key.as_str())
                .collect::<Vec<_>>(),
            ["ENG", "OPS"]
        );
        assert!(facts.facts.member.contains("ENG") && !facts.facts.member.contains("OPS"));
        assert!(facts.facts.assigned.contains("OPS") && !facts.facts.assigned.contains("ENG"));
        assert_eq!(facts.team_ids.get("OPS").map(String::as_str), Some("t-ops"));

        let keys = |rules: TriageTeamRules| -> Vec<String> {
            linear::scope_of(&facts.facts, &rules)
                .teams
                .into_iter()
                .map(|t| t.key)
                .collect()
        };
        // Only the teams the viewer belongs to — not OPS, where they merely hold
        // a triage ticket.
        assert_eq!(keys(mcp_triage_rules(None)), ["ENG"]);
        // Saved rules that would widen it don't; a hidden team stays hidden.
        let widening = TriageTeamRules {
            rotation: true,
            assigned: true,
            member: false,
            picked: vec!["OPS".into()],
            hidden: Vec::new(),
        };
        assert_eq!(keys(mcp_triage_rules(Some(widening))), ["ENG"]);
        let hiding = TriageTeamRules {
            hidden: vec!["ENG".into()],
            ..TriageTeamRules::default()
        };
        assert!(keys(mcp_triage_rules(Some(hiding))).is_empty());
    }
}
