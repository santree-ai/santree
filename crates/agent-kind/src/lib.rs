//! Which coding agent ("harness") runs a task.
//!
//! Its own crate because two reusable crates need it and neither may depend on
//! `santree-core`: `santree-pty` (half of a session's identity) and
//! `santree-remote-proto` (a remote session carries the same identity on the
//! wire). `santree-core` re-exports it from `domain`, so the app names it there.

use serde::{Deserialize, Serialize};

/// Which coding agent ("harness") runs a task.
///
/// `Hash` because this is half of a terminal's identity: a surface hosts one
/// PTY *per provider* (the pair `terminal_sessions` is keyed by), so the live-
/// terminal set is a set of pairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum AgentKind {
    Claude,
    Codex,
    Cursor,
    Opencode,
}

impl Default for AgentKind {
    /// Used only as a `#[serde(default)]` fallback inside `AgentSetting` (e.g. a
    /// future new field added to that struct) — never as a semantic "the" default
    /// agent, which is `Settings::default_agent`.
    fn default() -> Self {
        AgentKind::Claude
    }
}

impl AgentKind {
    /// Stable string form for persistence (matches the serde discriminant name).
    /// Exhaustive, so adding a variant forces this to be updated.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude",
            AgentKind::Codex => "Codex",
            AgentKind::Cursor => "Cursor",
            AgentKind::Opencode => "Opencode",
        }
    }
}

/// A persisted agent name that matched no `AgentKind`. Carries the offending
/// string so a caller that hits stale or hand-edited data can say *what* it found
/// instead of only that something failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownAgentKind(pub String);

impl std::fmt::Display for UnknownAgentKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown agent kind {:?}", self.0)
    }
}

impl std::error::Error for UnknownAgentKind {}

impl std::str::FromStr for AgentKind {
    type Err = UnknownAgentKind;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "Claude" => AgentKind::Claude,
            "Codex" => AgentKind::Codex,
            "Cursor" => AgentKind::Cursor,
            "Opencode" => AgentKind::Opencode,
            _ => return Err(UnknownAgentKind(s.to_string())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// `as_str` is the persisted form, so it must round-trip back through
    /// `FromStr` — a drift between the two silently resets a worktree's agent.
    #[test]
    fn agent_kinds_round_trip_through_their_persisted_form() {
        for kind in [
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Cursor,
            AgentKind::Opencode,
        ] {
            assert_eq!(AgentKind::from_str(kind.as_str()), Ok(kind));
        }
    }

    /// The parse error names what it actually found, so a caller reading stale or
    /// hand-edited data can log it instead of just "failed".
    #[test]
    fn unknown_agent_kind_reports_the_offending_input() {
        let err = AgentKind::from_str("Aider").unwrap_err();
        assert_eq!(err, UnknownAgentKind("Aider".into()));
        assert!(err.to_string().contains("Aider"), "{err}");
        // Case-sensitive: the persisted form is exactly `as_str`.
        assert!(AgentKind::from_str("claude").is_err());
    }
}
