//! Runtime model pricing for the Usage panel's cost estimates.
//!
//! The price table is fetched once a day from LiteLLM's public model-price JSON,
//! cached in SQLite (the generic `settings` KV store, scope `price_cache`), and
//! layered over the static built-in table (`santree_core::config::model_pricing`)
//! as an offline fallback. Design constraints from the request: fetch at most
//! once per day; a fetch failure is silent (keep using the cached or built-in
//! prices); and retry in the future without an app restart (a short backoff after
//! a failure, then another attempt on the next call).
//! The fetch runs in the background so opening the panel never waits on the
//! network (CLAUDE.md: never block the UI on a round-trip); it refreshes the DB
//! for the *next* read.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use santree_core::config;

use crate::db::Db;
use crate::settings;

const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/// Refresh the price table at most once a day.
const REFRESH_INTERVAL_MS: i64 = 86_400_000;
/// After a failed fetch, wait at least this long before trying again — so an
/// offline machine retries roughly hourly rather than on every single refetch.
const RETRY_BACKOFF_MS: i64 = 60 * 60_000;
/// Settings scope for the cached price table and its timestamps.
const SCOPE: &str = "price_cache";

/// Per-MTok USD rates for one model, plus its context-window size. `cache_write`
/// is the 5-minute cache-creation rate; 1-hour cache creation is derived as 2×
/// input at the cost site. `context` is the model's max input tokens (200K or 1M)
/// — the real denominator for the session "before compaction" meter.
#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct ModelRate {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
    #[serde(default)]
    pub context: f64,
}

/// A price table resolved by the longest match-key that is a substring of the
/// (lowercased) model id — so a specific fetched id (`claude-opus-4-8`) beats a
/// built-in family fallback (`opus`).
pub struct PriceTable {
    entries: Vec<(String, ModelRate)>,
}

impl PriceTable {
    /// The static built-in table only — used by tests for a deterministic,
    /// network-free price table. (The live path calls `build_table`, which folds
    /// `builtin_entries` in as a fallback directly.)
    #[cfg(test)]
    pub fn builtin() -> Self {
        PriceTable {
            entries: builtin_entries(),
        }
    }

    /// The rate for a model id, or `None` (→ 0 cost) if nothing matches.
    pub fn lookup(&self, model: &str) -> Option<&ModelRate> {
        let m = model.to_ascii_lowercase();
        self.entries
            .iter()
            .filter(|(k, _)| m.contains(k.as_str()))
            .max_by_key(|(k, _)| k.len())
            .map(|(_, r)| r)
    }
}

fn builtin_entries() -> Vec<(String, ModelRate)> {
    config::model_pricing()
        .iter()
        .map(|p| {
            (
                p.key.to_string(),
                ModelRate {
                    input: p.input_per_mtok,
                    output: p.output_per_mtok,
                    cache_write: p.cache_write_per_mtok,
                    cache_read: p.cache_read_per_mtok,
                    context: p.context_tokens,
                },
            )
        })
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn get_ms(db: &Db, key: &str) -> i64 {
    settings::get(db, SCOPE, key)
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Return the current price table, first kicking off a background refresh if the
/// cached table is a day old (and we're past the post-failure backoff). Never
/// blocks on the network: the refresh updates the DB for the *next* call, so the
/// first-ever open uses built-in prices and later opens use the fetched ones.
pub async fn ensure_fresh(db: &Db) -> PriceTable {
    let now = now_ms();
    let fetched = get_ms(db, "fetched_ms").await;
    let attempt = get_ms(db, "attempt_ms").await;
    if now - fetched > REFRESH_INTERVAL_MS && now - attempt > RETRY_BACKOFF_MS {
        // Stamp the attempt up front so concurrent calls don't each spawn a fetch,
        // and so a failure backs off for `RETRY_BACKOFF_MS` before the next try.
        let _ = settings::set(db, SCOPE, "attempt_ms", Some(now.to_string())).await;
        let db = db.clone();
        tokio::spawn(async move {
            match fetch_litellm().await {
                Ok(entries) => match serde_json::to_string(&entries) {
                    Ok(json) => {
                        let _ = settings::set(&db, SCOPE, "table_json", Some(json)).await;
                        let _ = settings::set(&db, SCOPE, "fetched_ms", Some(now_ms().to_string()))
                            .await;
                        log::info!(
                            "refreshed model pricing from LiteLLM ({} models)",
                            entries.len()
                        );
                    }
                    Err(e) => log::warn!("could not serialize fetched pricing: {e}"),
                },
                Err(e) => {
                    log::warn!("model price fetch failed: {e:#}; keeping cached/built-in prices");
                }
            }
        });
    }
    build_table(db).await
}

/// The Claude models to suggest in the app's model pickers — the **current
/// lineup**, derived live from the fetched LiteLLM catalog (cached in SQLite) so it
/// tracks Anthropic's releases instead of a hardcoded, quickly-stale list. We keep
/// the latest non-dated version of each family (opus/sonnet/haiku/fable) — as of
/// this writing `claude-opus-4-8` / `claude-sonnet-5` / `claude-haiku-4-5` /
/// `claude-fable-5` — so a new release (e.g. `claude-opus-5`) is picked up on the
/// next daily refresh with no code change. Kicks the same background refresh the
/// price table uses and reads its cache; falls back to a current static set when
/// nothing's been fetched yet (first run / offline), mirroring the price table's
/// own offline fallback. Compliant: LiteLLM's JSON is public (no agent creds).
pub async fn claude_models(db: &Db) -> Vec<String> {
    // Trigger the (non-blocking, once-daily) refresh, then read the cached ids.
    let _ = ensure_fresh(db).await;
    let picked = latest_per_family(&cached_model_ids(db).await);
    if picked.is_empty() {
        return [
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-haiku-4-5",
            "claude-fable-5",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    }
    picked
}

/// The `claude-*` model ids in the cached LiteLLM table (empty before the first
/// successful fetch). Ids only — rates aren't needed for the picker.
async fn cached_model_ids(db: &Db) -> Vec<String> {
    let Ok(Some(json)) = settings::get(db, SCOPE, "table_json").await else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<(String, ModelRate)>>(&json)
        .map(|fetched| fetched.into_iter().map(|(id, _)| id).collect())
        .unwrap_or_default()
}

/// From a list of `claude-*` ids, keep the latest non-dated version of each current
/// family, returned in `opus, sonnet, haiku, fable` order. Only ids of the form
/// `claude-<family>-<numeric-version>` count: dated snapshots (`…-4-7-20260416`),
/// regional variants (`…-v1:0`), and legacy `claude-3-*` names are all ignored, so
/// version comparison never trips over a date.
fn latest_per_family(ids: &[String]) -> Vec<String> {
    const FAMILIES: [&str; 4] = ["opus", "sonnet", "haiku", "fable"];
    // Highest (version, id) seen per family so far.
    let mut best: [Option<(Vec<u32>, String)>; 4] = Default::default();
    for id in ids {
        let lower = id.to_ascii_lowercase();
        for (i, fam) in FAMILIES.iter().enumerate() {
            let Some(rest) = lower.strip_prefix(&format!("claude-{fam}-")) else {
                continue;
            };
            let Some(ver) = parse_model_version(rest) else {
                continue;
            };
            if best[i].as_ref().is_none_or(|(v, _)| ver > *v) {
                best[i] = Some((ver, lower.clone()));
            }
        }
    }
    best.into_iter().flatten().map(|(_, id)| id).collect()
}

/// Parse a clean model version like `4-8` or `5` into comparable components. Returns
/// `None` for any segment that isn't a 1–2 digit number, which rejects 8-digit date
/// snapshots and `vN` variant suffixes (so `4-7-20260416` and `4-5-…-v1:0` don't
/// parse as versions and are dropped by the caller).
fn parse_model_version(rest: &str) -> Option<Vec<u32>> {
    rest.split('-')
        .map(|p| {
            (!p.is_empty() && p.len() <= 2 && p.bytes().all(|b| b.is_ascii_digit()))
                .then(|| p.parse().ok())
                .flatten()
        })
        .collect()
}

/// Build the effective table: cached fetched entries (if any) plus the built-in
/// entries as a fallback for anything the fetch didn't cover. Longest-key matching
/// means a specific fetched id still wins over a built-in family key.
async fn build_table(db: &Db) -> PriceTable {
    let mut entries = Vec::new();
    if let Ok(Some(json)) = settings::get(db, SCOPE, "table_json").await {
        if let Ok(fetched) = serde_json::from_str::<Vec<(String, ModelRate)>>(&json) {
            // Ignore a pre-`context`-field cache (all-zero context) so the built-in
            // table's real context limits apply until the next daily refresh.
            if fetched.iter().any(|(_, r)| r.context > 0.0) {
                entries.extend(fetched);
            }
        }
    }
    entries.extend(builtin_entries());
    PriceTable { entries }
}

/// Fetch LiteLLM's price JSON and extract the plain `claude-*` model rates
/// (per-MTok). Ignores provider-prefixed/regional variants — the transcripts
/// record plain ids, whose entries carry base list prices.
async fn fetch_litellm() -> anyhow::Result<Vec<(String, ModelRate)>> {
    let text = crate::gql::client()
        .get(LITELLM_URL)
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    parse_litellm(&text)
}

fn parse_litellm(text: &str) -> anyhow::Result<Vec<(String, ModelRate)>> {
    use serde_json::Value;
    let map: std::collections::HashMap<String, Value> = serde_json::from_str(text)?;
    let mut out = Vec::new();
    for (name, v) in map {
        // Plain Anthropic ids only: "claude-…", no provider prefix or path.
        if !name.starts_with("claude-") {
            continue;
        }
        let Some(input) = v.get("input_cost_per_token").and_then(Value::as_f64) else {
            continue;
        };
        // Source is per-token; store per-MTok. Fall back to the universal Claude
        // multipliers when a field is absent (output 5×, cache-write 1.25×,
        // cache-read 0.1× input).
        let per_mtok = |field: &str, mult: f64| {
            v.get(field).and_then(Value::as_f64).unwrap_or(input * mult) * 1_000_000.0
        };
        out.push((
            name.to_ascii_lowercase(),
            ModelRate {
                input: input * 1_000_000.0,
                output: per_mtok("output_cost_per_token", 5.0),
                cache_write: per_mtok("cache_creation_input_token_cost", 1.25),
                cache_read: per_mtok("cache_read_input_token_cost", 0.1),
                // The model's context window (max input tokens) — 200K or 1M.
                context: v
                    .get("max_input_tokens")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
            },
        ));
    }
    if out.is_empty() {
        anyhow::bail!("no claude models found in LiteLLM pricing response");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_lookup_prefers_longest_key() {
        let t = PriceTable::builtin();
        assert_eq!(t.lookup("claude-opus-4-8").unwrap().input, 5.0);
        assert_eq!(t.lookup("claude-opus-4-1").unwrap().input, 15.0);
        assert_eq!(t.lookup("claude-sonnet-5").unwrap().input, 2.0);
        assert_eq!(t.lookup("claude-sonnet-4-6").unwrap().input, 3.0);
        assert!(t.lookup("gpt-5").is_none());
    }

    #[test]
    fn fetched_entry_overrides_builtin_via_longest_key() {
        // A fetched exact id beats the built-in family key for the same model.
        let entries = vec![(
            "claude-opus-4-8".to_string(),
            ModelRate {
                input: 9.0,
                output: 0.0,
                cache_write: 0.0,
                cache_read: 0.0,
                context: 0.0,
            },
        )];
        let mut all = entries;
        all.extend(builtin_entries());
        let t = PriceTable { entries: all };
        assert_eq!(
            t.lookup("claude-opus-4-8").unwrap().input,
            9.0,
            "fetched wins"
        );
        assert_eq!(
            t.lookup("claude-opus-4-1").unwrap().input,
            15.0,
            "falls back to builtin"
        );
    }

    #[test]
    fn latest_per_family_picks_current_lineup() {
        // The real LiteLLM claude catalog shape: many versions + dated snapshots.
        let ids: Vec<String> = [
            "claude-opus-4-1",
            "claude-opus-4-5",
            "claude-opus-4-7",
            "claude-opus-4-7-20260416", // dated snapshot — ignored
            "claude-opus-4-8",
            "claude-sonnet-4-5",
            "claude-sonnet-4-6",
            "claude-sonnet-5",
            "claude-sonnet-4-5-20250929-v1:0", // variant — ignored
            "claude-haiku-4-5",
            "claude-haiku-4-5-20251001", // dated — ignored
            "claude-fable-5",
            "claude-3-opus-20240229",   // legacy claude-3-* — ignored
            "claude-3-5-sonnet-latest", // legacy — ignored
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            latest_per_family(&ids),
            vec![
                "claude-opus-4-8".to_string(),
                "claude-sonnet-5".to_string(),
                "claude-haiku-4-5".to_string(),
                "claude-fable-5".to_string(),
            ],
            "latest non-dated version of each family, opus/sonnet/haiku/fable order"
        );
    }

    #[test]
    fn version_5_beats_4_x_and_dates_dont_parse() {
        assert!(parse_model_version("5") > parse_model_version("4-6"));
        assert!(parse_model_version("4-8") > parse_model_version("4-7"));
        assert_eq!(parse_model_version("4-7-20260416"), None, "date rejected");
        assert_eq!(
            parse_model_version("4-5-20250929-v1:0"),
            None,
            "variant rejected"
        );
        assert_eq!(parse_model_version("5"), Some(vec![5]));
    }

    #[test]
    fn parse_litellm_extracts_claude_and_converts_to_mtok() {
        let json = r#"{
            "claude-opus-4-8": {"input_cost_per_token": 5e-6, "output_cost_per_token": 25e-6, "cache_creation_input_token_cost": 6.25e-6, "cache_read_input_token_cost": 0.5e-6, "max_input_tokens": 1000000},
            "gpt-5": {"input_cost_per_token": 1e-6},
            "some-comment": "not an object"
        }"#;
        let out = parse_litellm(json).unwrap();
        assert_eq!(out.len(), 1, "only claude-* kept");
        let (name, r) = &out[0];
        assert_eq!(name, "claude-opus-4-8");
        assert_eq!(
            (r.input, r.output, r.cache_write, r.cache_read),
            (5.0, 25.0, 6.25, 0.5)
        );
        assert_eq!(
            r.context, 1_000_000.0,
            "context window from max_input_tokens"
        );
    }

    /// Exercises the real LiteLLM endpoint + parse. Ignored by default (network);
    /// run with `cargo test -- --ignored live_fetch_smoke`.
    #[test]
    #[ignore = "hits the network"]
    fn live_fetch_smoke() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let entries = rt
            .block_on(fetch_litellm())
            .expect("fetch should succeed online");
        let n = entries.len();
        let t = PriceTable { entries };
        let opus = t.lookup("claude-opus-4-8").expect("opus-4-8 present");
        assert!(
            (opus.input - 5.0).abs() < 0.01,
            "opus-4-8 input ~$5, got {}",
            opus.input
        );
        assert!(n > 10, "expected many claude models, got {n}");
    }

    #[test]
    fn parse_litellm_derives_missing_fields_from_input() {
        let out = parse_litellm(r#"{"claude-x-1": {"input_cost_per_token": 2e-6}}"#).unwrap();
        let (_, r) = &out[0];
        let approx = |a: f64, b: f64| (a - b).abs() < 1e-9;
        assert!(approx(r.input, 2.0));
        assert!(approx(r.output, 10.0), "output defaults to 5x input");
        assert!(
            approx(r.cache_write, 2.5),
            "cache-write defaults to 1.25x input"
        );
        assert!(
            approx(r.cache_read, 0.2),
            "cache-read defaults to 0.1x input"
        );
    }
}
