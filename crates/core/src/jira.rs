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

    /// The category decides, the name refines: "…review…" in progress is In
    /// Review, a negation-aware "…blocked…" in any open category is Blocked, and a
    /// done status is never re-read from its name.
    #[test]
    fn a_status_maps_by_category_refined_by_a_review_or_blocked_name() {
        use TaskStatus::*;
        for (category, name, want) in [
            ("new", "To Do", Todo),
            ("indeterminate", "In Progress", InProgress),
            ("indeterminate", "Code Review", InReview),
            ("done", "Resolved", Done),
            ("new", "Blocked", Blocked),
            ("indeterminate", "Blocked on design", Blocked),
            ("done", "Blocked (won't do)", Done),
            ("new", "Unblocked", Todo),
            ("indeterminate", "Not blocked", InProgress),
        ] {
            assert_eq!(map_status(category, name), want, "{category} / {name}");
        }
    }
}
