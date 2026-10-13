//! Provider-neutral ticket dispatch.
//!
//! [`TicketTracker`] is implemented by Linear, Jira and TickTick; the free functions
//! resolve which provider a repo's connection belongs to and delegate.

use anyhow::Result;
use async_trait::async_trait;
use santree_core::domain::{
    LinearConnection, Task, TicketProvider, TicketRef, TriageDetail, TriageSchedule, TriageTicket,
};

use crate::db::Db;

// ── Trait ───────────────────────────────────────────────────────────────────

#[async_trait]
pub trait TicketTracker: Send + Sync {
    async fn list_issues(&self, db: &Db, repo: &str) -> Result<Option<Vec<Task>>>;
    async fn triage_tickets(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>>;
    async fn triage_detail(&self, db: &Db, repo: &str, id: &str) -> Result<Option<TriageDetail>>;
    async fn set_issue_state(
        &self,
        db: &Db,
        repo: &str,
        id: &str,
        state: &str,
    ) -> Result<Option<()>>;
    async fn create_comment(
        &self,
        db: &Db,
        repo: &str,
        id: &str,
        parent: Option<&str>,
        body: &str,
    ) -> Result<Option<()>>;
    async fn tickets_by_id(
        &self,
        db: &Db,
        repo: &str,
        ids: &[String],
    ) -> Result<Option<Vec<TicketRef>>>;
    async fn triage_schedule(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>>;
    async fn move_to_started(&self, db: &Db, repo: &str, id: &str) -> Result<Option<()>>;
}

// ── Linear ──────────────────────────────────────────────────────────────────

struct LinearTracker;

#[async_trait]
impl TicketTracker for LinearTracker {
    async fn list_issues(&self, db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
        crate::linear::list_issues(db, repo).await
    }
    async fn triage_tickets(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>> {
        crate::linear::triage_tickets(db, repo).await
    }
    async fn triage_detail(&self, db: &Db, repo: &str, id: &str) -> Result<Option<TriageDetail>> {
        crate::linear::triage_detail(db, repo, id).await
    }
    async fn set_issue_state(
        &self,
        db: &Db,
        repo: &str,
        id: &str,
        state: &str,
    ) -> Result<Option<()>> {
        crate::linear::set_issue_state(db, repo, id, state).await
    }
    async fn create_comment(
        &self,
        db: &Db,
        repo: &str,
        id: &str,
        parent: Option<&str>,
        body: &str,
    ) -> Result<Option<()>> {
        crate::linear::create_comment(db, repo, id, parent, body).await
    }
    async fn tickets_by_id(
        &self,
        db: &Db,
        repo: &str,
        ids: &[String],
    ) -> Result<Option<Vec<TicketRef>>> {
        crate::linear::tickets_by_identifier(db, repo, ids).await
    }
    async fn triage_schedule(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
        crate::linear::triage_schedule(db, repo).await
    }
    async fn move_to_started(&self, db: &Db, repo: &str, id: &str) -> Result<Option<()>> {
        crate::linear::move_issue_to_started(db, repo, id).await
    }
}

// ── Jira ────────────────────────────────────────────────────────────────────

struct JiraTracker;

#[async_trait]
impl TicketTracker for JiraTracker {
    async fn list_issues(&self, db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
        crate::jira::list_issues(db, repo).await
    }
    async fn triage_tickets(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>> {
        crate::jira::triage_tickets(db, repo).await
    }
    async fn triage_detail(&self, db: &Db, repo: &str, id: &str) -> Result<Option<TriageDetail>> {
        crate::jira::triage_detail(db, repo, id).await
    }
    async fn set_issue_state(
        &self,
        db: &Db,
        repo: &str,
        id: &str,
        state: &str,
    ) -> Result<Option<()>> {
        crate::jira::set_issue_state(db, repo, id, state).await
    }
    async fn create_comment(
        &self,
        db: &Db,
        repo: &str,
        id: &str,
        parent: Option<&str>,
        body: &str,
    ) -> Result<Option<()>> {
        crate::jira::create_comment(db, repo, id, parent, body).await
    }
    async fn tickets_by_id(
        &self,
        db: &Db,
        repo: &str,
        ids: &[String],
    ) -> Result<Option<Vec<TicketRef>>> {
        crate::jira::tickets_by_identifier(db, repo, ids).await
    }
    async fn triage_schedule(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
        crate::jira::triage_schedule(db, repo).await
    }
    async fn move_to_started(&self, db: &Db, repo: &str, id: &str) -> Result<Option<()>> {
        crate::jira::move_issue_to_started(db, repo, id).await
    }
}

// ── TickTick ────────────────────────────────────────────────────────────────

struct TickTickTracker;

#[async_trait]
impl TicketTracker for TickTickTracker {
    async fn list_issues(&self, db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
        crate::ticktick::list_issues(db, repo).await
    }
    async fn triage_tickets(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>> {
        crate::ticktick::triage_tickets(db, repo).await
    }
    async fn triage_detail(&self, db: &Db, repo: &str, id: &str) -> Result<Option<TriageDetail>> {
        crate::ticktick::triage_detail(db, repo, id).await
    }
    async fn set_issue_state(
        &self,
        db: &Db,
        repo: &str,
        id: &str,
        state: &str,
    ) -> Result<Option<()>> {
        crate::ticktick::set_issue_state(db, repo, id, state).await
    }
    async fn create_comment(
        &self,
        db: &Db,
        repo: &str,
        id: &str,
        parent: Option<&str>,
        body: &str,
    ) -> Result<Option<()>> {
        crate::ticktick::create_comment(db, repo, id, parent, body).await
    }
    async fn tickets_by_id(
        &self,
        db: &Db,
        repo: &str,
        ids: &[String],
    ) -> Result<Option<Vec<TicketRef>>> {
        crate::ticktick::tickets_by_id(db, repo, ids).await
    }
    async fn triage_schedule(&self, db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
        crate::ticktick::triage_schedule(db, repo).await
    }
    async fn move_to_started(&self, db: &Db, repo: &str, id: &str) -> Result<Option<()>> {
        crate::ticktick::move_to_started(db, repo, id).await
    }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/// The provider's name as prompts and ticket details spell it.
pub fn name(provider: TicketProvider) -> &'static str {
    match provider {
        TicketProvider::Linear => "Linear",
        TicketProvider::Jira => "Jira",
        TicketProvider::TickTick => "TickTick",
    }
}

/// Which provider a repo's tickets come from: the one its connection belongs to.
/// There is no guess for a repo without a connection (see [`crate::connection`]).
pub async fn provider(db: &Db, repo: &str) -> Result<Option<TicketProvider>> {
    Ok(crate::connection::of(db, repo).await?.map(|c| c.provider))
}

async fn repo_tracker(db: &Db, repo: &str) -> Result<Option<Box<dyn TicketTracker>>> {
    let tracker: Box<dyn TicketTracker> = match provider(db, repo).await? {
        None => return Ok(None),
        Some(TicketProvider::Jira) => Box::new(JiraTracker),
        Some(TicketProvider::TickTick) => Box::new(TickTickTracker),
        // A Linear repo reads through however its org is connected: GraphQL, or
        // the MCP server (`docs/linear-mcp.md`).
        Some(TicketProvider::Linear) => match crate::linear::repo_connection(db, repo).await? {
            Some(LinearConnection::Mcp) => Box::new(crate::linear_mcp::tracker::LinearMcpTracker),
            _ => Box::new(LinearTracker),
        },
    };
    Ok(Some(tracker))
}

pub async fn list_issues(db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
    match repo_tracker(db, repo).await? {
        Some(t) => t.list_issues(db, repo).await,
        None => Ok(None),
    }
}

pub async fn triage_tickets(db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>> {
    match repo_tracker(db, repo).await? {
        Some(t) => t.triage_tickets(db, repo).await,
        None => Ok(None),
    }
}

pub async fn triage_detail(db: &Db, repo: &str, id: &str) -> Result<Option<TriageDetail>> {
    match repo_tracker(db, repo).await? {
        Some(t) => t.triage_detail(db, repo, id).await,
        None => Ok(None),
    }
}

pub async fn set_issue_state(db: &Db, repo: &str, id: &str, state: &str) -> Result<Option<()>> {
    match repo_tracker(db, repo).await? {
        Some(t) => t.set_issue_state(db, repo, id, state).await,
        None => Ok(None),
    }
}

pub async fn create_comment(
    db: &Db,
    repo: &str,
    id: &str,
    parent: Option<&str>,
    body: &str,
) -> Result<Option<()>> {
    match repo_tracker(db, repo).await? {
        Some(t) => t.create_comment(db, repo, id, parent, body).await,
        None => Ok(None),
    }
}

pub async fn tickets_by_id(db: &Db, repo: &str, ids: &[String]) -> Result<Option<Vec<TicketRef>>> {
    match repo_tracker(db, repo).await? {
        Some(t) => t.tickets_by_id(db, repo, ids).await,
        None => Ok(None),
    }
}

pub async fn triage_schedule(db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
    match repo_tracker(db, repo).await? {
        Some(t) => t.triage_schedule(db, repo).await,
        None => Ok(None),
    }
}

pub async fn move_to_started(db: &Db, repo: &str, id: &str) -> Result<Option<()>> {
    match repo_tracker(db, repo).await? {
        Some(t) => t.move_to_started(db, repo, id).await,
        None => Ok(None),
    }
}

pub fn invalidate_all_caches() {
    crate::linear::invalidate_all_caches();
    crate::linear_mcp::tracker::invalidate_all_caches();
    crate::jira::invalidate_all_caches();
    crate::ticktick::invalidate_all_caches();
}
