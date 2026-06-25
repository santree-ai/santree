//! Pure domain logic and mocked data for santree.
//!
//! This crate has **no** Tauri dependency on purpose: the types and the mock
//! data source can be unit-tested without a webview or an event loop. The Tauri
//! command layer (`src-tauri`) is a thin adapter that calls into here.

pub mod domain;
pub mod layout;
pub mod linear;
pub mod mock;

pub use domain::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_blocked_by_points_at_a_real_task() {
        let tasks = mock::tasks();
        let ids: std::collections::HashSet<_> = tasks.iter().map(|t| t.id.as_str()).collect();
        for t in &tasks {
            for dep in &t.blocked_by {
                assert!(
                    ids.contains(dep.as_str()),
                    "{} blocked by unknown {}",
                    t.id,
                    dep
                );
            }
        }
    }

    #[test]
    fn worktrees_reference_real_tasks() {
        let ids: std::collections::HashSet<_> = mock::tasks().into_iter().map(|t| t.id).collect();
        for w in mock::worktrees() {
            assert!(
                ids.contains(&w.id),
                "worktree {} has no matching task",
                w.id
            );
        }
    }

    #[test]
    fn triage_answer_matches_on_keywords() {
        let plan = mock::triage_answer("can you draft a fix plan?");
        assert!(plan.text.starts_with("Plan:"));
        assert!(!plan.refs.is_empty());

        let estimate = mock::triage_answer("what's the complexity estimate?");
        assert!(estimate.text.starts_with("Low-to-medium"));
    }

    #[test]
    fn each_worktree_has_a_terminal() {
        for w in mock::worktrees() {
            let term = mock::terminal(&w.id);
            assert_eq!(term.worktree_id, w.id);
            assert!(!term.lines.is_empty());
        }
    }
}
