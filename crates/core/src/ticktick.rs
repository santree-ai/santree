//! Pure helpers for translating TickTick data into santree's domain model.
//! Network/auth concerns live in `src-tauri`; this stays side-effect-free.
//!
//! A TickTick task is addressed by a list (its API calls a "project") and a task
//! id, so santree's one-string ticket id is `<projectId>.<taskId>`. The dot is
//! deliberate: `:` would break the `tree:<id>:tab:` keys, `/` is a path separator,
//! and both parts are alphanumeric, so the whole id survives branch names,
//! `to_lowercase()` and the terminal key charset.

use crate::domain::Priority;

/// The longest either half of an id may be. TickTick's are 24 hex characters.
const PART_MAX: usize = 64;

/// How many trailing characters of the task id the display handle keeps.
const HANDLE_LEN: usize = 6;

/// Whether `part` is shaped like one half of a ticket id: what a TickTick list or
/// task id is, and what may be put in a request path.
pub fn is_id_part(part: &str) -> bool {
    !part.is_empty() && part.len() <= PART_MAX && part.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Join a list id and a task id into a ticket id. Both halves are used as given:
/// callers hold ids TickTick returned, and anything that crosses IPC goes through
/// [`split_id`] before it reaches a request path.
pub fn compose_id(project: &str, task: &str) -> String {
    format!("{project}.{task}")
}

/// Split a ticket id into `(list id, task id)`, or `None` when it isn't exactly
/// that shape. This is the guard before any request path is built, the way
/// `jira::is_issue_key` is for Jira: an id from a branch slug, a quote or a path
/// segment never gets through.
pub fn split_id(id: &str) -> Option<(&str, &str)> {
    let (project, task) = id.split_once('.')?;
    (is_id_part(project) && is_id_part(task)).then_some((project, task))
}

/// The short name a ticket goes by on screen and in its branch: `tt-` plus the
/// last six characters of the task id, lowercased. Taken from the real id, so it
/// is stable for the life of the task.
pub fn handle(id: &str) -> Option<String> {
    let (_, task) = split_id(id)?;
    let start = task.len().saturating_sub(HANDLE_LEN);
    Some(format!("tt-{}", task[start..].to_lowercase()))
}

/// TickTick's priority values: none 0, low 1, medium 3, high 5.
pub fn map_priority(value: i64) -> Priority {
    match value {
        5 => Priority::High,
        3 => Priority::Medium,
        1 => Priority::Low,
        _ => Priority::None,
    }
}

/// The state ids `set_issue_state` accepts, as TickTick's own `status` values.
pub const STATE_TODO: &str = "0";
pub const STATE_DONE: &str = "2";
pub const STATE_WONT_DO: &str = "-1";

/// The state name for a task's `status`: normal 0, completed 2, abandoned -1.
pub fn state_name(status: i64) -> &'static str {
    match status {
        2 => "Done",
        -1 => "Won't do",
        _ => "Todo",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_split_only_in_the_shape_that_may_reach_a_request_path() {
        let id = compose_id("6226ff9877acee87727f6bca", "63b7bebb91c0a5474805fcd4");
        assert_eq!(
            split_id(&id),
            Some(("6226ff9877acee87727f6bca", "63b7bebb91c0a5474805fcd4"))
        );
        assert_eq!(handle(&id).as_deref(), Some("tt-05fcd4"));
        assert_eq!(handle("a.AbC").as_deref(), Some("tt-abc"));

        let long = "a".repeat(PART_MAX + 1);
        for bad in [
            "",
            "SAN-12",
            "feature-login",
            "abc",
            "abc.",
            ".abc",
            "a.b.c",
            "a:b.c",
            "a/b.c",
            "a.b/../c",
            "a.b?x=1",
            "a.b c",
            &format!("{long}.x"),
        ] {
            assert_eq!(split_id(bad), None, "{bad}");
            assert_eq!(handle(bad), None, "{bad}");
        }
    }

    #[test]
    fn priorities_and_states_follow_ticktick_values() {
        for (value, want) in [
            (0, Priority::None),
            (1, Priority::Low),
            (3, Priority::Medium),
            (5, Priority::High),
            (2, Priority::None),
        ] {
            assert_eq!(map_priority(value), want, "{value}");
        }
        assert_eq!(state_name(0), "Todo");
        assert_eq!(state_name(2), "Done");
        assert_eq!(state_name(-1), "Won't do");
    }
}
