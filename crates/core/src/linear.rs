//! Pure helpers for translating Linear data into santree's domain model.
//! Network/auth concerns live in `src-tauri`; this stays side-effect-free.

use crate::domain::{Priority, TaskStatus};

/// Map a Linear workflow state to our coarse status.
///
/// Linear state *types* are `triage | backlog | unstarted | started |
/// completed | canceled | duplicate`. We also honour a state *named* "…review…"
/// as In Review, and one named "…block…" as Blocked, since Linear has no native
/// type for either — workspaces model them as custom `unstarted`/`started` states.
pub fn map_status(state_name: &str, state_type: &str) -> TaskStatus {
    let name = state_name.to_lowercase();
    match state_type {
        // A custom "Blocked" state can be typed `unstarted` or `started`; either
        // way it's not actionable, so name takes precedence over type here. Guard
        // on the open types so a terminal state can never be mis-read as Blocked.
        "unstarted" | "started" if name.contains("block") => TaskStatus::Blocked,
        // Only a *started* state named "…review…" is In Review; a completed
        // state like "Reviewed" stays Done, driven by its type.
        "started" if name.contains("review") => TaskStatus::InReview,
        "started" => TaskStatus::InProgress,
        "unstarted" => TaskStatus::Todo,
        "backlog" | "triage" => TaskStatus::Backlog,
        // `duplicate` is its own terminal type in Linear (distinct from
        // `canceled`); all three are closed/non-actionable → Done.
        "completed" | "canceled" | "duplicate" => TaskStatus::Done,
        _ => TaskStatus::Todo,
    }
}

/// An issue is ready to start when it has no blockers, or all of them are done.
pub fn is_ready(blocker_done_flags: &[bool]) -> bool {
    blocker_done_flags.iter().all(|done| *done)
}

/// Map Linear's numeric priority (0 none, 1 urgent … 4 low) to our `Priority`.
pub fn map_priority(n: i64) -> Priority {
    match n {
        1 => Priority::Urgent,
        2 => Priority::High,
        3 => Priority::Medium,
        4 => Priority::Low,
        // 0 is Linear's explicit "no priority"; anything unexpected also lands
        // here rather than silently rendering as Low.
        _ => Priority::None,
    }
}

/// True when an issue is snoozed past `now` — parked below active work.
pub fn is_snoozed(snooze_ms: Option<i64>, now_ms: i64) -> bool {
    snooze_ms.is_some_and(|t| t > now_ms)
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
        // A completed state named "Reviewed" is Done, not In Review.
        assert_eq!(map_status("Reviewed", "completed"), TaskStatus::Done);
        // Linear's `duplicate` type is terminal — Done, never an actionable Todo.
        assert_eq!(map_status("Duplicate", "duplicate"), TaskStatus::Done);
        assert_eq!(map_status("Canceled", "canceled"), TaskStatus::Done);
        // A custom "Blocked" state is not actionable, whether Linear types it
        // `unstarted` or `started` — it must not collapse into Todo/In Progress.
        assert_eq!(map_status("Blocked", "unstarted"), TaskStatus::Blocked);
        assert_eq!(map_status("Blocked", "started"), TaskStatus::Blocked);
        assert!(!map_status("Blocked", "unstarted").is_startable());
    }

    #[test]
    fn readiness_from_blockers() {
        assert!(is_ready(&[]));
        assert!(is_ready(&[true, true]));
        assert!(!is_ready(&[true, false]));
    }

    #[test]
    fn priorities_map() {
        assert_eq!(map_priority(1), Priority::Urgent);
        assert_eq!(map_priority(4), Priority::Low);
        // "No priority" (0) is its own variant, never Low.
        assert_eq!(map_priority(0), Priority::None);
    }

    #[test]
    fn snoozed_from_absolute_time() {
        let now = 1_000_000_000_000;
        assert!(is_snoozed(Some(now + 1), now));
        assert!(!is_snoozed(Some(now - 1), now));
        assert!(!is_snoozed(None, now));
    }
}
