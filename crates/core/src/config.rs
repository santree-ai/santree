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
            true,
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
/// so a specific version wins over its family fallback — e.g. `claude-opus-4-1`
/// matches `opus-4-1` ($15/$75), while `claude-opus-4-8` falls back to `opus`
/// ($5/$25). Opus dropped to $5/$25 starting at 4.5, so *current* Opus is the
/// fallback and the older, pricier ids are the ones spelled out.
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
/// still counted).
///
/// The *current* generation of each family is the family fallback, so a new point
/// release (say `claude-opus-4-9`) resolves to today's rates on its own. Only the
/// closed set of older, differently-priced ids is enumerated — enumerating the
/// cheap ones instead would silently overcharge every future release by 3× and push
/// its context meter past 100%, and nothing would fail until someone noticed.
pub fn model_pricing() -> &'static [ModelPrice] {
    &[
        // Opus 4.5+: $5/$25 at 1M — a third of earlier Opus. The family fallback,
        // so unreleased point versions inherit it.
        ModelPrice {
            key: "opus",
            input_per_mtok: 5.0,
            output_per_mtok: 25.0,
            cache_write_per_mtok: 6.25,
            cache_read_per_mtok: 0.50,
            context_tokens: 1_000_000.0,
        },
        // Pre-4.5 Opus — $15/$75 at 200K. A closed set (Opus 4, 4.1, Claude 3 Opus):
        // longest-key matching lets each beat the `opus` fallback above. Opus 4 ships
        // under both an undated alias and a dated id, hence two keys for it.
        //
        // Substring matching can't anchor, so `opus-4-1` would also capture a
        // two-digit minor like `claude-opus-4-12`. Anthropic has never shipped one
        // (4 → 4.1 → 4.5 → …), and pricing the *shipped* Opus 4.1 correctly matters
        // more than a version that doesn't exist; the daily LiteLLM fetch resolves
        // exact ids anyway, so this table is only consulted offline.
        ModelPrice {
            key: "opus-4-0",
            input_per_mtok: 15.0,
            output_per_mtok: 75.0,
            cache_write_per_mtok: 18.75,
            cache_read_per_mtok: 1.50,
            context_tokens: 200_000.0,
        },
        ModelPrice {
            key: "opus-4-2025",
            input_per_mtok: 15.0,
            output_per_mtok: 75.0,
            cache_write_per_mtok: 18.75,
            cache_read_per_mtok: 1.50,
            context_tokens: 200_000.0,
        },
        ModelPrice {
            key: "opus-4-1",
            input_per_mtok: 15.0,
            output_per_mtok: 75.0,
            cache_write_per_mtok: 18.75,
            cache_read_per_mtok: 1.50,
            context_tokens: 200_000.0,
        },
        ModelPrice {
            key: "3-opus",
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
        default_agent: AgentKind::Codex,
        integrations: Integrations {
            linear: true,
            triage: true,
        },
        // `exec` is the user's override path (empty ⇒ use the one detected on
        // PATH, reported by `agent_auth`). Model is the per-agent default.
        agents: vec![
            agent(AgentKind::Claude, "", "sonnet"),
            agent(AgentKind::Codex, "", ""),
            agent(AgentKind::Cursor, "", "auto"),
            agent(AgentKind::Opencode, "", "claude-sonnet-4.5"),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Resolve a model id exactly as `src-tauri`'s `PriceTable::lookup` does — the
    /// longest key that is a substring of the lowercased id wins. Mirrored here so
    /// the table can be checked against the rule it's actually matched by.
    fn lookup(model: &str) -> Option<&'static ModelPrice> {
        let m = model.to_ascii_lowercase();
        model_pricing()
            .iter()
            .filter(|p| m.contains(p.key))
            .max_by_key(|p| p.key.len())
    }

    /// The bug this guards: with each cheap Opus point release enumerated and the
    /// family fallback left on legacy rates, the *next* release fell through to
    /// $15/$75 at 200K — a 3× cost overstatement and a context meter that reads
    /// past 100%. A new point release must inherit current-generation pricing
    /// without anyone editing this table.
    #[test]
    fn unreleased_opus_versions_price_as_current_generation() {
        for id in ["claude-opus-4-9", "claude-opus-5", "claude-opus-6-1"] {
            let p = lookup(id).unwrap_or_else(|| panic!("{id} matched no price key"));
            assert_eq!(p.input_per_mtok, 5.0, "{id} input");
            assert_eq!(p.output_per_mtok, 25.0, "{id} output");
            assert_eq!(p.context_tokens, 1_000_000.0, "{id} context window");
        }
    }

    /// The shipped Opus 4.5+ ids keep current-generation rates…
    #[test]
    fn current_opus_ids_price_at_the_cheap_rate() {
        for id in ["claude-opus-4-5", "claude-opus-4-7", "claude-opus-4-8"] {
            let p = lookup(id).unwrap();
            assert_eq!((p.input_per_mtok, p.output_per_mtok), (5.0, 25.0), "{id}");
            assert_eq!(p.context_tokens, 1_000_000.0, "{id}");
        }
    }

    /// …and the pricier pre-4.5 Opus ids still resolve to legacy rates and a 200K
    /// window, beating the family fallback by longest-key match.
    #[test]
    fn legacy_opus_ids_keep_legacy_rates() {
        for id in [
            "claude-opus-4-20250514",
            "claude-opus-4-0",
            "claude-opus-4-1",
            "claude-opus-4-1-20250805",
            "claude-3-opus-20240229",
        ] {
            let p = lookup(id).unwrap_or_else(|| panic!("{id} matched no price key"));
            assert_eq!(
                (p.input_per_mtok, p.output_per_mtok),
                (15.0, 75.0),
                "{id} should keep legacy Opus pricing"
            );
            assert_eq!(p.context_tokens, 200_000.0, "{id} context window");
        }
    }

    /// The non-Opus families the fallback ordering also depends on.
    #[test]
    fn other_families_resolve_to_their_own_rates() {
        let rate = |id| {
            let p = lookup(id).unwrap();
            (p.input_per_mtok, p.output_per_mtok, p.context_tokens)
        };
        assert_eq!(rate("claude-sonnet-5"), (2.0, 10.0, 1_000_000.0));
        assert_eq!(rate("claude-sonnet-4-6"), (3.0, 15.0, 1_000_000.0));
        assert_eq!(rate("claude-haiku-4-5-20251001"), (1.0, 5.0, 200_000.0));
        assert_eq!(rate("claude-fable-5"), (10.0, 50.0, 1_000_000.0));
        // An unpriced vendor's model contributes 0 cost, not a bogus Claude rate.
        assert!(lookup("gpt-5-codex").is_none());
    }
}
