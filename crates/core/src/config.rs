//! Static application config — real, canonical data (not sample/mock): the
//! catalog of supported coding agents, the agent-run stage metadata, and the
//! seeded default settings a fresh install starts from.

use crate::domain::*;

/// The supported coding agents and their selectable models (the catalog the
/// Settings cards and the launch panel render).
pub fn agents() -> Vec<AgentDef> {
    let def = |key, label: &str, short: &str, models: &[&str], available: bool| AgentDef {
        key,
        label: label.into(),
        short: short.into(),
        models: models.iter().map(|s| (*s).into()).collect(),
        available,
    };
    vec![
        def(
            AgentKind::Claude,
            "Claude Code",
            "Claude",
            // CLI aliases (`claude --help`), not dotted model ids — the CLI
            // rejects e.g. "claude-sonnet-4.5" outright and aliases always
            // resolve to the vendor's current model for that tier.
            &["opus", "sonnet", "haiku"],
            true,
        ),
        def(
            AgentKind::Codex,
            "Codex",
            "Codex",
            &["gpt-5-codex", "gpt-5", "o4-mini"],
            false,
        ),
        def(
            AgentKind::Cursor,
            "Cursor",
            "Cursor",
            &["claude-sonnet-4.5", "gpt-5", "auto"],
            false,
        ),
        def(
            AgentKind::Opencode,
            "OpenCode",
            "OpenCode",
            &[
                "claude-sonnet-4.5",
                "gpt-5",
                "qwen2.5-coder:32b",
                "llama3.3:70b",
            ],
            false,
        ),
    ]
}

/// The seeded default settings for a fresh install (before the user edits any).
pub fn default_settings() -> Settings {
    let agent = |key, exec: &str, model: &str| AgentSetting {
        key,
        exec: exec.into(),
        model: model.into(),
    };
    Settings {
        default_agent: AgentKind::Claude,
        integrations: Integrations {
            linear: true,
            triage: true,
        },
        // `exec` is the user's override path (empty ⇒ use the one detected on
        // PATH, reported by `agent_auth`). Model is the per-agent default.
        agents: vec![
            agent(AgentKind::Claude, "", "sonnet"),
            agent(AgentKind::Codex, "", "gpt-5-codex"),
            agent(AgentKind::Cursor, "", "auto"),
            agent(AgentKind::Opencode, "", "claude-sonnet-4.5"),
        ],
    }
}
