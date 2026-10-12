//! Pure helpers for translating Linear data into santree's domain model.
//! Network/auth concerns live in `src-tauri`; this stays side-effect-free.

use crate::domain::{Priority, TaskStatus};

/// Map a Linear workflow state to our coarse status.
///
/// Linear state *types* are `triage | backlog | unstarted | started |
/// completed | canceled | duplicate`. We also honour a state *named* "…review…"
/// as In Review, and one named "…blocked…" as Blocked, since Linear has no native
/// type for either — workspaces model them as custom states in whichever open
/// category they choose.
pub fn map_status(state_name: &str, state_type: &str) -> TaskStatus {
    let name = state_name.to_lowercase();
    match state_type {
        // A custom "Blocked" state has no type of its own, so workspaces park it in
        // whichever open category they like — including `backlog`, which is
        // startable. Name therefore takes precedence over type across *every* open
        // category. Terminal types are excluded so a closed state can never be
        // mis-read as Blocked (and thus as still-open work).
        "backlog" | "triage" | "unstarted" | "started" if means_blocked(&name) => {
            TaskStatus::Blocked
        }
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

/// True when a lowercased state name really means *blocked*.
///
/// A bare substring test would read "Unblocked" — a state that means the exact
/// opposite, and is startable — as Blocked. So a "block…" match only counts when it
/// isn't negated by the word right before it. Separators are squashed first so
/// "Un-blocked" and "Unblocked" are judged the same way.
fn means_blocked(name: &str) -> bool {
    let squashed: String = name.chars().filter(|c| c.is_alphanumeric()).collect();
    squashed.match_indices("block").any(|(at, _)| {
        !["un", "not", "non"]
            .iter()
            .any(|neg| squashed[..at].ends_with(neg))
    })
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

    /// Name refines type across every open category: a custom "Blocked" state is
    /// Blocked (and not startable) wherever a workspace parks it, backlog included,
    /// while "Unblocked" — which contains "block" but means the opposite — keeps its
    /// category. Terminal types are never re-read from the name.
    #[test]
    fn a_state_maps_by_type_refined_by_a_review_or_blocked_name() {
        use TaskStatus::*;
        for (name, state_type, want) in [
            ("In Progress", "started", InProgress),
            ("Code Review", "started", InReview),
            ("Reviewed", "completed", Done),
            ("Duplicate", "duplicate", Done),
            ("Blocked (won't do)", "canceled", Done),
            ("Blocked", "backlog", Blocked),
            ("Blocked", "triage", Blocked),
            ("Blocked on design", "unstarted", Blocked),
            ("External blocker", "started", Blocked),
            ("Unblocked", "backlog", Backlog),
            ("Un-blocked", "unstarted", Todo),
            ("Not blocked", "started", InProgress),
        ] {
            assert_eq!(map_status(name, state_type), want, "{name} / {state_type}");
        }
        assert!(!map_status("Blocked", "backlog").is_startable());
        assert!(map_status("Unblocked", "unstarted").is_startable());
    }
}
