//! Pure helpers for translating Linear data into santree's domain model.
//! Network/auth concerns live in `src-tauri`; this stays side-effect-free.

use crate::domain::TaskStatus;

/// Map a Linear workflow state to our coarse status.
///
/// Linear state *types* are `triage | backlog | unstarted | started |
/// completed | canceled`. We also honour a state *named* "…review…" as
/// In Review, since many workspaces model review as a custom started state.
pub fn map_status(state_name: &str, state_type: &str) -> TaskStatus {
    if state_name.to_lowercase().contains("review") {
        return TaskStatus::InReview;
    }
    match state_type {
        "started" => TaskStatus::InProgress,
        "unstarted" => TaskStatus::Todo,
        "backlog" | "triage" => TaskStatus::Backlog,
        _ => TaskStatus::Todo,
    }
}

/// An issue is ready to start when it has no blockers, or all of them are done.
pub fn is_ready(blocker_done_flags: &[bool]) -> bool {
    blocker_done_flags.iter().all(|done| *done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_states() {
        assert_eq!(map_status("In Progress", "started"), TaskStatus::InProgress);
        assert_eq!(map_status("Todo", "unstarted"), TaskStatus::Todo);
        assert_eq!(map_status("Backlog", "backlog"), TaskStatus::Backlog);
        assert_eq!(map_status("Code Review", "started"), TaskStatus::InReview);
    }

    #[test]
    fn readiness_from_blockers() {
        assert!(is_ready(&[]));
        assert!(is_ready(&[true, true]));
        assert!(!is_ready(&[true, false]));
    }
}
