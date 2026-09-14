//! Provider-neutral ticket dispatch.
//!
//! [`TicketTracker`] is implemented by both Linear and Jira; the free functions
//! resolve which provider a repo uses and delegate.

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

// ── Dispatch ────────────────────────────────────────────────────────────────

/// Which provider a repo's tickets come from. An explicit link wins; an unlinked
/// repo uses whichever provider is connected, Linear first when both are — so
/// installs that predate Jira keep resolving exactly as they did.
pub fn resolve(
    jira_linked: bool,
    linear_linked: bool,
    has_linear: bool,
    has_jira: bool,
) -> Option<TicketProvider> {
    if jira_linked {
        Some(TicketProvider::Jira)
    } else if linear_linked || has_linear {
        Some(TicketProvider::Linear)
    } else if has_jira {
        Some(TicketProvider::Jira)
    } else {
        None
    }
}

/// The provider's name as prompts and ticket details spell it.
pub fn name(provider: TicketProvider) -> &'static str {
    match provider {
        TicketProvider::Linear => "Linear",
        TicketProvider::Jira => "Jira",
    }
}

pub async fn provider(db: &Db, repo: &str) -> Result<Option<TicketProvider>> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT jira_cloud_id, linear_org_slug FROM repos WHERE name = ?")
            .bind(repo)
            .fetch_optional(db)
            .await?;
    let (jira_link, linear_link) = row.unwrap_or((None, None));
    let has_linear = !crate::linear::orgs_by_name(db).await?.is_empty();
    let has_jira = !crate::jira::sites_by_name(db).await?.is_empty();
    Ok(resolve(
        jira_link.is_some(),
        linear_link.is_some(),
        has_linear,
        has_jira,
    ))
}

async fn repo_tracker(db: &Db, repo: &str) -> Result<Option<Box<dyn TicketTracker>>> {
    let tracker: Box<dyn TicketTracker> = match provider(db, repo).await? {
        None => return Ok(None),
        Some(TicketProvider::Jira) => Box::new(JiraTracker),
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_link_decides_the_tracker() {
        assert_eq!(resolve(true, false, true, true), Some(TicketProvider::Jira));
        assert_eq!(
            resolve(false, true, false, true),
            Some(TicketProvider::Linear)
        );
    }

    /// An install that predates Jira must keep reading Linear once a Jira site
    /// is connected too, until a repo is linked to that site.
    #[test]
    fn an_unlinked_repo_prefers_linear_then_jira() {
        assert_eq!(
            resolve(false, false, true, true),
            Some(TicketProvider::Linear)
        );
        assert_eq!(
            resolve(false, false, false, true),
            Some(TicketProvider::Jira)
        );
        assert_eq!(resolve(false, false, false, false), None);
    }
}
