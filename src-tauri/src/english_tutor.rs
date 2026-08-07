//! The **English tutor**: an optional writing coach that rides along on the Claude
//! sessions santree launches.
//!
//! Three pieces, deliberately decoupled:
//!  - the **instruction** ([`instruction`]) — rendered from the `english-tutor`
//!    prompt and injected as a synchronous `UserPromptSubmit` hook by
//!    [`crate::hooks`], so every turn the agent opens with any corrections and
//!    appends them to the practice log itself;
//!  - the **log** ([`read_log`]) — a plain markdown file the agent appends to, read
//!    back read-only for the Settings pane;
//!  - the **analysis** ([`analyze`]) — an explicit, user-triggered `claude -p` pass
//!    over the whole log. Nothing here runs on session start: the log is data the
//!    user reads when they choose to, not context every session has to pay for.
//!
//! The log lives at `$XDG_CONFIG_HOME/santree/english-practice-log.md` (else
//! `~/.config/…`) — the same path santree-cli used when it owned this feature, so
//! an existing practice history carries straight over.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use santree_core::domain::{EnglishAnalysis, EnglishLog};

use crate::db::{now_ms, Db};
use crate::{agent, prompts, settings};

/// Settings key (app scope) for whether the tutor is on. Absent or anything but
/// `"true"` means off — the tutor changes what the agent *says* every turn, so it
/// only ever runs when explicitly asked for.
pub const ENABLED_KEY: &str = "english_tutor";

/// Settings key for the model the analysis runs on (app scope).
pub const ANALYSIS_MODEL_KEY: &str = "english_tutor_model";

/// The analysis's default model.
///
/// Deliberately *not* [`agent::HELPER_MODEL`]: telling a 30-times-repeated habit
/// apart from a one-off typo across a thousand entries — and, harder, noticing
/// which patterns have *stopped* — is real reasoning, and the cheapest tier
/// produces a confident-sounding list that isn't grounded in the log. A wrong
/// priority order is worse than none, because the user acts on it.
const DEFAULT_ANALYSIS_MODEL: &str = "sonnet";

/// Byte budget for the log text handed to the analysis. ~4× a log of a thousand
/// entries, so in practice nothing is cut; if it ever is, the **newest** entries
/// are kept (see [`tail_within`]) — current habits are what the user can act on.
const LOG_BUDGET: usize = 400_000;

/// Header written when the log is created. The file must exist and be non-empty
/// before the agent's first correction: `Edit` can't operate on a missing file, so
/// without this the first append fails silently and the tutor looks broken.
const LOG_STUB: &str = "# English Practice Log\n\nTracks grammar/spelling mistakes spotted during Claude Code sessions.\nAppended to by santree's English tutor hook.\n";

/// `$XDG_CONFIG_HOME/santree/english-practice-log.md`, else
/// `~/.config/santree/english-practice-log.md`. `None` when neither variable is
/// set (no home, no config root — nothing to write to).
pub fn log_path() -> Option<PathBuf> {
    let dir = if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(xdg)
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".config")
    };
    Some(dir.join("santree").join("english-practice-log.md"))
}

/// The log path, creating the file (and its directory) with [`LOG_STUB`] when it
/// doesn't exist yet. Blocking.
fn ensure_log() -> Result<PathBuf> {
    let path = log_path().ok_or_else(|| anyhow!("no HOME or XDG_CONFIG_HOME to store the log in"))?;
    if !path.exists() {
        let dir = path
            .parent()
            .ok_or_else(|| anyhow!("log path has no parent directory"))?;
        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating {}", dir.display()))?;
        std::fs::write(&path, LOG_STUB)
            .with_context(|| format!("creating {}", path.display()))?;
    }
    Ok(path)
}

/// Corrections in the log — the `- ` bullets, which is the one line shape the
/// instruction tells the agent to append.
fn count_entries(text: &str) -> usize {
    text.lines().filter(|l| l.starts_with("- ")).count()
}

/// The practice log, read-only, for the Settings pane. Creates the file if it's
/// missing so the pane shows an empty log rather than an error on a fresh install.
/// Blocking — call from `spawn_blocking`.
pub fn read_log() -> Result<EnglishLog> {
    let path = ensure_log()?;
    let text = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let updated_at_ms = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64);
    Ok(EnglishLog {
        entry_count: count_entries(&text) as f64,
        path: path.to_string_lossy().into_owned(),
        text,
        updated_at_ms,
    })
}

/// Whether the tutor is enabled (app scope).
pub async fn enabled(db: &Db) -> bool {
    matches!(
        settings::get(db, "app", ENABLED_KEY).await,
        Ok(Some(v)) if v == "true"
    )
}

/// The instruction text to inject as a `UserPromptSubmit` hook, or `None` when the
/// tutor is off (or the log path can't be resolved, since the instruction's whole
/// second half is "append to this file").
///
/// Rendering it here — rather than in [`crate::hooks`] — keeps that module free of
/// the db: the instruction is an editable prompt with a per-scope override, so it
/// needs an async read that the sync settings-file builder can't do.
pub async fn instruction(db: &Db) -> Result<Option<String>> {
    if !enabled(db).await {
        return Ok(None);
    }
    let Some(path) = log_path() else {
        return Ok(None);
    };
    // Create it now, at enable time, rather than leaving the agent's first Edit to
    // fail against a missing file mid-turn.
    ensure_log()?;
    let text = prompts::render(
        db,
        None,
        "english-tutor",
        minijinja::context! { log_path => path.to_string_lossy() },
    )
    .await?;
    Ok(Some(text))
}

/// The longest **suffix** of `s` that fits in `budget` bytes and starts on a line
/// boundary — the newest entries, since the log grows by appending.
fn tail_within(s: &str, budget: usize) -> &str {
    if s.len() <= budget {
        return s;
    }
    // Snap up to a char boundary FIRST: `s[start..]` panics outright when `start`
    // lands inside a multi-byte character, and the log is full of them (`é`, curly
    // quotes, `…`). Finding the line break afterwards isn't enough — the panic
    // happens on the slice that does the finding.
    let mut start = s.len() - budget;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    // Then forward to the next line break, so the slice can't start mid-entry.
    match s[start..].find('\n') {
        Some(off) => &s[start + off + 1..],
        None => "",
    }
}

/// Run the analysis over the whole practice log and store the result, replacing
/// any previous one. The log is the user's own writing, so no tool grants are
/// needed — and none are given.
pub async fn analyze(db: &Db) -> Result<EnglishAnalysis> {
    let log = tokio::task::spawn_blocking(read_log).await??;
    if log.entry_count < 1.0 {
        return Err(anyhow!(
            "the practice log has no corrections yet — enable the tutor and write a few messages first"
        ));
    }

    let prompt = prompts::render(
        db,
        None,
        "english-analysis",
        minijinja::context! {
            log => tail_within(&log.text, LOG_BUDGET),
            entry_count => log.entry_count,
        },
    )
    .await?;
    let model = settings::get(db, "app", ANALYSIS_MODEL_KEY)
        .await?
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ANALYSIS_MODEL.to_string());

    // The log's own directory: a real, always-present cwd that isn't a repo. With
    // no tools granted there's nothing to reach from it either way.
    let cwd = PathBuf::from(&log.path)
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("log path has no parent directory"))?;
    let text = tokio::task::spawn_blocking(move || agent::run_print(&cwd, &prompt, &[], Some(&model)))
        .await?
        .ok_or_else(|| anyhow!("Claude didn't return an analysis — see the app log for why"))?;

    let analysis = EnglishAnalysis {
        text,
        entry_count: log.entry_count,
        created_at_ms: now_ms() as f64,
    };
    sqlx::query(
        "INSERT INTO english_analysis (id, analysis, entry_count, created_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             analysis = excluded.analysis,
             entry_count = excluded.entry_count,
             created_at = excluded.created_at",
    )
    .bind(&analysis.text)
    .bind(analysis.entry_count as i64)
    .bind(analysis.created_at_ms as i64)
    .execute(db)
    .await?;
    Ok(analysis)
}

/// The stored analysis, or `None` if none has been run. `entry_count` is what the
/// log held *when it ran*, so the UI can say how stale it is.
pub async fn stored(db: &Db) -> Result<Option<EnglishAnalysis>> {
    let row: Option<(String, i64, i64)> =
        sqlx::query_as("SELECT analysis, entry_count, created_at FROM english_analysis WHERE id = 1")
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(text, entry_count, created_at)| EnglishAnalysis {
        text,
        entry_count: entry_count as f64,
        created_at_ms: created_at as f64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_only_correction_bullets() {
        let log = "# English Practice Log\n\n## 2026-07-30\n- a -> b (reason)\n- c -> d (reason)\n\nnot a bullet\n";
        assert_eq!(count_entries(log), 2);
    }

    #[test]
    fn tail_keeps_whole_lines_and_the_newest_entries() {
        let log = "## old\n- first -> 1 (r)\n- second -> 2 (r)\n- third -> 3 (r)\n";
        let cut = tail_within(log, 24);
        assert!(cut.starts_with("- "), "must start on a line boundary: {cut:?}");
        assert!(cut.ends_with("- third -> 3 (r)\n"), "must keep the newest: {cut:?}");
        assert!(!cut.contains("first"), "must drop the oldest: {cut:?}");
    }

    #[test]
    fn tail_is_a_noop_under_budget() {
        let log = "- only -> one (r)\n";
        assert_eq!(tail_within(log, 400), log);
    }

    /// The slice must never split a UTF-8 sequence — the log is full of `->` and
    /// curly quotes, and a byte-indexed cut through one panics.
    #[test]
    fn tail_never_splits_a_multibyte_char() {
        let log = "- á -> b (reason)\n- é -> f (reason)\n";
        for budget in 1..log.len() {
            let _ = tail_within(log, budget); // must not panic
        }
    }
}
