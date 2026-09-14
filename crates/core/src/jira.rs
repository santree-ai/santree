//! Pure helpers for translating Jira Cloud data into santree's domain model.
//! Network/auth concerns live in `src-tauri`; this stays side-effect-free.

use crate::domain::{Priority, TaskStatus};

/// Map a Jira status to our coarse status.
///
/// Jira statuses belong to one of three `statusCategory` keys:
/// `new` (not started), `indeterminate` (in progress), `done` (terminal).
/// Within those, the status *name* refines: "In Review" → InReview,
/// "Blocked" → Blocked (same negation-aware logic as Linear's mapper).
pub fn map_status(category_key: &str, name: &str) -> TaskStatus {
    let lower = name.to_lowercase();
    match category_key {
        "new" if means_blocked(&lower) => TaskStatus::Blocked,
        "indeterminate" if means_blocked(&lower) => TaskStatus::Blocked,
        "indeterminate" if lower.contains("review") => TaskStatus::InReview,
        "indeterminate" => TaskStatus::InProgress,
        "new" => TaskStatus::Todo,
        "done" => TaskStatus::Done,
        _ => TaskStatus::Todo,
    }
}

/// True when a lowercased status name really means *blocked*.
///
/// Same negation-aware logic as `linear.rs` — "Unblocked" must not match.
fn means_blocked(name: &str) -> bool {
    let squashed: String = name.chars().filter(|c| c.is_alphanumeric()).collect();
    squashed.match_indices("block").any(|(at, _)| {
        !["un", "not", "non"]
            .iter()
            .any(|neg| squashed[..at].ends_with(neg))
    })
}

/// Map a Jira priority name to our `Priority`.
///
/// Jira's built-in priorities: Highest, High, Medium, Low, Lowest.
/// Custom priorities fall through to `None`.
pub fn map_priority(name: &str) -> Priority {
    match name.to_lowercase().as_str() {
        "highest" | "critical" | "blocker" => Priority::Urgent,
        "high" => Priority::High,
        "medium" => Priority::Medium,
        "low" => Priority::Low,
        "lowest" | "trivial" => Priority::Low,
        _ => Priority::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_statuses() {
        assert_eq!(map_status("new", "To Do"), TaskStatus::Todo);
        assert_eq!(map_status("new", "Open"), TaskStatus::Todo);
        assert_eq!(
            map_status("indeterminate", "In Progress"),
            TaskStatus::InProgress
        );
        assert_eq!(
            map_status("indeterminate", "In Review"),
            TaskStatus::InReview
        );
        assert_eq!(
            map_status("indeterminate", "Code Review"),
            TaskStatus::InReview
        );
        assert_eq!(map_status("done", "Done"), TaskStatus::Done);
        assert_eq!(map_status("done", "Closed"), TaskStatus::Done);
        assert_eq!(map_status("done", "Resolved"), TaskStatus::Done);
    }

    #[test]
    fn blocked_detected_in_any_open_category() {
        for category in ["new", "indeterminate"] {
            assert_eq!(
                map_status(category, "Blocked"),
                TaskStatus::Blocked,
                "Blocked in {category}"
            );
            assert_eq!(
                map_status(category, "Blocked on design"),
                TaskStatus::Blocked,
                "Blocked on design in {category}"
            );
            assert!(!map_status(category, "Blocked").is_startable());
        }
        // Terminal category is never re-read as Blocked.
        assert_eq!(map_status("done", "Blocked (won't do)"), TaskStatus::Done);
    }

    #[test]
    fn unblocked_is_not_blocked() {
        assert_eq!(map_status("new", "Unblocked"), TaskStatus::Todo);
        assert_eq!(
            map_status("indeterminate", "Unblocked"),
            TaskStatus::InProgress
        );
        assert_eq!(map_status("new", "Not blocked"), TaskStatus::Todo);
    }

    #[test]
    fn priorities_map() {
        assert_eq!(map_priority("Highest"), Priority::Urgent);
        assert_eq!(map_priority("Critical"), Priority::Urgent);
        assert_eq!(map_priority("Blocker"), Priority::Urgent);
        assert_eq!(map_priority("High"), Priority::High);
        assert_eq!(map_priority("Medium"), Priority::Medium);
        assert_eq!(map_priority("Low"), Priority::Low);
        assert_eq!(map_priority("Lowest"), Priority::Low);
        assert_eq!(map_priority("Trivial"), Priority::Low);
        assert_eq!(map_priority("Custom thing"), Priority::None);
    }
}
