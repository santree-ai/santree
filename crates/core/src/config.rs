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

/// Per-model token prices in **USD per million tokens**, used to derive the
/// approximate cost shown alongside the exact token counts in the Usage panel.
///
/// A static snapshot of Anthropic's published API pricing — **update these when
/// vendor pricing changes**; the token counts are exact regardless of this table.
/// `cache_write_per_mtok` is the 5-minute-TTL cache-creation rate (1.25× input);
/// 1-hour cache creation is billed at 2× input and computed at the call site (see
/// `usage.rs`), not stored here.
///
/// Matched by the longest `key` that is a substring of the (lowercased) model id,
/// so specific versions win over the family fallback — e.g. `claude-opus-4-8`
/// matches `opus-4-8` ($5/$25), while `claude-opus-4-1` falls back to `opus`
/// ($15/$75). Opus dropped to $5/$25 starting at 4.5; earlier Opus stays $15/$75.
pub struct ModelPrice {
    /// Substring matched against the transcript's (lowercased) model id; the
    /// longest matching key wins.
    pub key: &'static str,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_write_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    /// The model's context-window limit in tokens — the real denominator for the
    /// session "before compaction" meter (Sonnet 5 / Opus 4.5+ / Fable 5 = 1M,
    /// Haiku 4.5 and earlier = 200K). Overridden at runtime by the fetched
    /// LiteLLM `max_input_tokens` when available.
    pub context_tokens: f64,
}

/// The price table. A model id matching no key contributes 0 cost (its tokens are
/// still counted). Opus 4.5+ are listed explicitly because they cost a third of
/// earlier Opus; everything else keys off the family fallback.
pub fn model_pricing() -> &'static [ModelPrice] {
    &[
        // Opus 4.5-4.8: $5/$25 (a third of earlier Opus).
        ModelPrice {
            key: "opus-4-5",
            input_per_mtok: 5.0,
            output_per_mtok: 25.0,
            cache_write_per_mtok: 6.25,
            cache_read_per_mtok: 0.50,
            context_tokens: 1_000_000.0,
        },
        ModelPrice {
            key: "opus-4-6",
            input_per_mtok: 5.0,
            output_per_mtok: 25.0,
            cache_write_per_mtok: 6.25,
            cache_read_per_mtok: 0.50,
            context_tokens: 1_000_000.0,
        },
        ModelPrice {
            key: "opus-4-7",
            input_per_mtok: 5.0,
            output_per_mtok: 25.0,
            cache_write_per_mtok: 6.25,
            cache_read_per_mtok: 0.50,
            context_tokens: 1_000_000.0,
        },
        ModelPrice {
            key: "opus-4-8",
            input_per_mtok: 5.0,
            output_per_mtok: 25.0,
            cache_write_per_mtok: 6.25,
            cache_read_per_mtok: 0.50,
            context_tokens: 1_000_000.0,
        },
        // Earlier Opus (4, 4.1, 3-opus): $15/$75, 200K context.
        ModelPrice {
            key: "opus",
            input_per_mtok: 15.0,
            output_per_mtok: 75.0,
            cache_write_per_mtok: 18.75,
            cache_read_per_mtok: 1.50,
            context_tokens: 200_000.0,
        },
        // Claude 5 family. Sonnet 5 ($2/$10) is cheaper than Sonnet 4.6, so it needs
        // its own key to beat the "sonnet" fallback; Fable 5 ($10/$50) is premium.
        ModelPrice {
            key: "sonnet-5",
            input_per_mtok: 2.0,
            output_per_mtok: 10.0,
            cache_write_per_mtok: 2.50,
            cache_read_per_mtok: 0.20,
            context_tokens: 1_000_000.0,
        },
        ModelPrice {
            key: "fable",
            input_per_mtok: 10.0,
            output_per_mtok: 50.0,
            cache_write_per_mtok: 12.50,
            cache_read_per_mtok: 1.00,
            context_tokens: 1_000_000.0,
        },
        // Sonnet (3.5 / 4 / 4.5 / 4.6) all share $3/$15. Current Sonnet runs 1M;
        // (the old sonnet-4 >200k-context premium tier is omitted — a shrinking case).
        ModelPrice {
            key: "sonnet",
            input_per_mtok: 3.0,
            output_per_mtok: 15.0,
            cache_write_per_mtok: 3.75,
            cache_read_per_mtok: 0.30,
            context_tokens: 1_000_000.0,
        },
        // Haiku 4.5 ($1/$5), 200K context.
        ModelPrice {
            key: "haiku",
            input_per_mtok: 1.0,
            output_per_mtok: 5.0,
            cache_write_per_mtok: 1.25,
            cache_read_per_mtok: 0.10,
            context_tokens: 200_000.0,
        },
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
