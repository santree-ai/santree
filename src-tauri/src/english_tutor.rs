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
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::{Local, NaiveDate};
use santree_core::domain::{AnalysisScope, EnglishAnalysis, EnglishDay, EnglishEntry, EnglishLog};

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

/// Ceiling on one analysis run.
///
/// Deliberately far above [`agent::SHORT_TIMEOUT`]: that ceiling is sized for
/// a one-line commit message, and a thousand corrections in with a structured
/// answer out ran straight past it (observed: killed at exactly 120s with empty
/// stderr, which reads as "Claude returned nothing" rather than as a deadline).
/// This is a button the user pressed and is watching a spinner for, so the ceiling
/// only needs to be short enough that a genuinely hung call can't wait forever.
const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(600);

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
    let path =
        log_path().ok_or_else(|| anyhow!("no HOME or XDG_CONFIG_HOME to store the log in"))?;
    if !path.exists() {
        let dir = path
            .parent()
            .ok_or_else(|| anyhow!("log path has no parent directory"))?;
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        std::fs::write(&path, LOG_STUB).with_context(|| format!("creating {}", path.display()))?;
    }
    Ok(path)
}

/// Split one `- original -> correction (reason)` bullet into its parts.
///
/// Both separators are found from the ends the ambiguity can't reach: the **first**
/// ` -> ` (a correction may itself contain an arrow — `a -> b -> c`), and the
/// **last balanced** trailing `(…)` (reasons routinely quote parentheses and
/// punctuation, as in `("allow" needs an object; use a gerund)`). A bullet with no
/// trailing group keeps an empty reason rather than being discarded.
fn parse_entry(line: &str) -> Option<EnglishEntry> {
    let body = line.strip_prefix("- ")?.trim();
    let (original, rest) = body.split_once(" -> ")?;

    let (correction, reason) = match split_trailing_group(rest) {
        Some((c, r)) => (c, r),
        None => (rest, ""),
    };
    let (original, correction) = (original.trim(), correction.trim());
    if original.is_empty() || correction.is_empty() {
        return None;
    }
    Some(EnglishEntry {
        original: original.to_string(),
        correction: correction.to_string(),
        reason: reason.trim().to_string(),
    })
}

/// Split `"text (reason)"` into `("text", "reason")` by scanning back from a
/// trailing `)` to its balanced `(`. `None` when the string doesn't end in a
/// balanced group.
fn split_trailing_group(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_end();
    if !s.ends_with(')') {
        return None;
    }
    let mut depth = 0usize;
    // Byte indices from `char_indices` are always char boundaries, so slicing on
    // them is safe even though reasons contain multi-byte characters.
    for (i, c) in s.char_indices().rev() {
        match c {
            ')' => depth += 1,
            '(' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&s[..i], &s[i + 1..s.len() - 1]));
                }
            }
            _ => {}
        }
    }
    None
}

/// Parse the log into days. Returns the days oldest-first (the file's own order)
/// and the number of content lines that didn't parse.
///
/// A bullet under no heading, or under a heading that isn't a valid ISO date, is
/// counted as unparsed rather than dropped — the count is surfaced in the UI, so a
/// format drift shows up instead of silently shrinking the log.
fn parse_log(text: &str) -> (Vec<EnglishDay>, usize) {
    let mut days: Vec<EnglishDay> = Vec::new();
    let mut unparsed = 0usize;
    let mut open = false;

    for line in text.lines() {
        if let Some(date) = line.strip_prefix("## ") {
            let date = date.trim();
            open = NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok();
            if open {
                days.push(EnglishDay {
                    date: date.to_string(),
                    entries: Vec::new(),
                });
            }
            continue;
        }
        if !line.starts_with("- ") {
            continue;
        }
        match (open, parse_entry(line)) {
            (true, Some(entry)) => days
                .last_mut()
                .expect("open implies a day")
                .entries
                .push(entry),
            _ => unparsed += 1,
        }
    }
    days.retain(|d| !d.entries.is_empty());
    (days, unparsed)
}

/// The practice log, parsed, for the Settings pane. Creates the file if it's
/// missing so the pane shows an empty log rather than an error on a fresh install.
/// Blocking — call from `spawn_blocking`.
pub fn read_log() -> Result<EnglishLog> {
    let path = ensure_log()?;
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let updated_at_ms = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64);
    let (days, unparsed) = parse_log(&text);
    Ok(EnglishLog {
        entry_count: days.iter().map(|d| d.entries.len()).sum::<usize>() as f64,
        unparsed: unparsed as f64,
        days,
        path: path.to_string_lossy().into_owned(),
        updated_at_ms,
    })
}

/// The days a scope covers, given the whole log oldest-first.
///
/// `SinceLast` slices by **entry count**, not by date: the log is chronological and
/// append-only, so "everything past the first N" is exact, where a date cutoff
/// would miss corrections added later the same day the last analysis ran.
fn days_in_scope(days: &[EnglishDay], scope: AnalysisScope, analyzed: usize) -> Vec<EnglishDay> {
    let cutoff = |back: i64| {
        (Local::now().date_naive() - chrono::Duration::days(back))
            .format("%Y-%m-%d")
            .to_string()
    };
    // ISO dates sort lexically exactly as they sort chronologically.
    let from =
        |c: String| -> Vec<EnglishDay> { days.iter().filter(|d| d.date >= c).cloned().collect() };

    match scope {
        AnalysisScope::Everything => days.to_vec(),
        AnalysisScope::LastWeek => from(cutoff(7)),
        AnalysisScope::LastMonth => from(cutoff(30)),
        AnalysisScope::SinceLast => {
            let mut skip = analyzed;
            let mut out = Vec::new();
            for day in days {
                if skip >= day.entries.len() {
                    skip -= day.entries.len();
                    continue;
                }
                out.push(EnglishDay {
                    date: day.date.clone(),
                    entries: day.entries[skip..].to_vec(),
                });
                skip = 0;
            }
            out
        }
    }
}

/// Render days back to the log's own markdown, which is what the analysis prompt
/// reads. Rendering from the parse (rather than slicing the raw file) means the
/// model always sees one canonical shape, whatever the file on disk looks like.
fn render_days(days: &[EnglishDay]) -> String {
    let mut out = String::new();
    for day in days {
        out.push_str(&format!("\n## {}\n\n", day.date));
        for e in &day.entries {
            out.push_str(&format!("- {} -> {}", e.original, e.correction));
            if !e.reason.is_empty() {
                out.push_str(&format!(" ({})", e.reason));
            }
            out.push('\n');
        }
    }
    out
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

/// Run the analysis over `scope` of the practice log and store the result,
/// replacing any previous one. The log is the user's own writing, so no tool grants
/// are needed — and none are given.
pub async fn analyze(db: &Db, scope: AnalysisScope) -> Result<EnglishAnalysis> {
    let log = tokio::task::spawn_blocking(read_log).await??;
    if log.entry_count < 1.0 {
        return Err(anyhow!(
            "the practice log has no corrections yet — enable the tutor and write a few messages first"
        ));
    }

    let analyzed = stored(db).await?.map_or(0, |a| a.entry_count as usize);
    let days = days_in_scope(&log.days, scope, analyzed);
    let count: usize = days.iter().map(|d| d.entries.len()).sum();
    if count == 0 {
        // Naming the window matters: "nothing in the last 7 days" is a fact about
        // the window, not a failure, and the user picks a wider one to fix it.
        return Err(anyhow!(match scope {
            AnalysisScope::LastWeek => "no corrections in the last 7 days — try a wider window",
            AnalysisScope::LastMonth => "no corrections in the last 30 days — try a wider window",
            AnalysisScope::SinceLast => "no new corrections since the last analysis",
            AnalysisScope::Everything => "the practice log has no corrections yet",
        }));
    }

    let text = render_days(&days);
    let prompt = prompts::render(
        db,
        None,
        "english-analysis",
        minijinja::context! {
            log => tail_within(&text, LOG_BUDGET),
            entry_count => count,
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
    let text = tokio::task::spawn_blocking(move || {
        agent::run_print(&cwd, &prompt, &[], Some(&model), ANALYSIS_TIMEOUT)
    })
    .await?
    .context("the analysis didn't finish — try a narrower window if the log is large")?;

    let analysis = EnglishAnalysis {
        text,
        // The whole log's count, NOT the scope's — this doubles as the anchor
        // `SinceLast` slices from, so a "last 7 days" run must still record where
        // the log as a whole had reached.
        entry_count: log.entry_count,
        scope,
        created_at_ms: now_ms() as f64,
    };
    sqlx::query(
        "INSERT INTO english_analysis (id, analysis, entry_count, scope, created_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             analysis = excluded.analysis,
             entry_count = excluded.entry_count,
             scope = excluded.scope,
             created_at = excluded.created_at",
    )
    .bind(&analysis.text)
    .bind(analysis.entry_count as i64)
    .bind(scope_str(scope))
    .bind(analysis.created_at_ms as i64)
    .execute(db)
    .await?;
    Ok(analysis)
}

/// The persisted form of a scope. Explicit rather than derived from the enum's
/// name, so renaming a variant can't silently reinterpret stored rows.
fn scope_str(scope: AnalysisScope) -> &'static str {
    match scope {
        AnalysisScope::LastWeek => "last_week",
        AnalysisScope::LastMonth => "last_month",
        AnalysisScope::SinceLast => "since_last",
        AnalysisScope::Everything => "everything",
    }
}

/// Inverse of [`scope_str`]. An unknown value reads as `Everything` — the widest,
/// least misleading claim to make about advice we can't attribute to a window.
fn scope_from(s: &str) -> AnalysisScope {
    match s {
        "last_week" => AnalysisScope::LastWeek,
        "last_month" => AnalysisScope::LastMonth,
        "since_last" => AnalysisScope::SinceLast,
        _ => AnalysisScope::Everything,
    }
}

/// The stored analysis, or `None` if none has been run. `entry_count` is what the
/// log held *when it ran*, so the UI can say how stale it is.
pub async fn stored(db: &Db) -> Result<Option<EnglishAnalysis>> {
    let row: Option<(String, i64, String, i64)> = sqlx::query_as(
        "SELECT analysis, entry_count, scope, created_at FROM english_analysis WHERE id = 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(
        row.map(|(text, entry_count, scope, created_at)| EnglishAnalysis {
            text,
            entry_count: entry_count as f64,
            scope: scope_from(&scope),
            created_at_ms: created_at as f64,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real log's shape: preamble, dated sections, `- x -> y (why)` bullets.
    const LOG: &str = "# English Practice Log\n\nblurb\n\n## 2026-07-29\n\n- a -> b (first)\n- c -> d (second)\n\n## 2026-07-30\n\n- e -> f (third)\n";

    #[test]
    fn parses_days_and_entries_in_file_order() {
        let (days, unparsed) = parse_log(LOG);
        assert_eq!(unparsed, 0);
        assert_eq!(
            days.iter().map(|d| d.date.as_str()).collect::<Vec<_>>(),
            ["2026-07-29", "2026-07-30"]
        );
        assert_eq!(days[0].entries.len(), 2);
        assert_eq!(days[0].entries[0].original, "a");
        assert_eq!(days[0].entries[0].correction, "b");
        assert_eq!(days[0].entries[0].reason, "first");
    }

    /// Reasons routinely contain quotes, semicolons and their own parentheses —
    /// splitting on the *first* `(` would cut them in half.
    #[test]
    fn reason_split_survives_nested_parentheses() {
        let e = parse_entry(r#"- allow to select -> allow selecting ("allow" needs an object (a noun); use a gerund)"#).unwrap();
        assert_eq!(e.original, "allow to select");
        assert_eq!(e.correction, "allow selecting");
        assert_eq!(
            e.reason,
            r#""allow" needs an object (a noun); use a gerund"#
        );
    }

    /// A correction can itself contain an arrow, so the *first* ` -> ` is the
    /// separator — taking the last one would swallow the correction.
    #[test]
    fn arrow_split_takes_the_first_arrow() {
        let e = parse_entry("- a -> b -> c (reason)").unwrap();
        assert_eq!(e.original, "a");
        assert_eq!(e.correction, "b -> c");
    }

    #[test]
    fn entry_without_a_reason_still_parses() {
        let e = parse_entry("- teh -> the").unwrap();
        assert_eq!((e.correction.as_str(), e.reason.as_str()), ("the", ""));
    }

    /// Nothing may vanish: a bullet the parser can't split, or one sitting under a
    /// heading that isn't a date, has to show up in the unparsed count.
    #[test]
    fn unparseable_content_is_counted_never_dropped() {
        let (days, unparsed) = parse_log("## 2026-07-30\n\n- a -> b (r)\n- no separator here\n");
        assert_eq!(days[0].entries.len(), 1);
        assert_eq!(unparsed, 1);

        let (days, unparsed) = parse_log("## not-a-date\n\n- a -> b (r)\n");
        assert!(days.is_empty());
        assert_eq!(unparsed, 1);
    }

    #[test]
    fn since_last_resumes_mid_day_from_the_stored_count() {
        let (days, _) = parse_log(LOG);
        // Two entries analyzed: all of the 29th. The 30th is what's new.
        let out = days_in_scope(&days, AnalysisScope::SinceLast, 2);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].date, "2026-07-30");

        // One analyzed: the 29th's *second* entry is still new, so that day comes
        // back partially — a date-based cutoff would drop it entirely.
        let out = days_in_scope(&days, AnalysisScope::SinceLast, 1);
        assert_eq!(out[0].date, "2026-07-29");
        assert_eq!(out[0].entries.len(), 1);
        assert_eq!(out[0].entries[0].original, "c");

        // Nothing new.
        assert!(days_in_scope(&days, AnalysisScope::SinceLast, 3).is_empty());
    }

    #[test]
    fn windows_cut_by_date_and_everything_keeps_all() {
        let today = Local::now().date_naive();
        let day = |back: i64, orig: &str| EnglishDay {
            date: (today - chrono::Duration::days(back))
                .format("%Y-%m-%d")
                .to_string(),
            entries: vec![EnglishEntry {
                original: orig.into(),
                correction: "x".into(),
                reason: String::new(),
            }],
        };
        let days = vec![day(90, "old"), day(20, "mid"), day(2, "new")];

        let names = |s| {
            days_in_scope(&days, s, 0)
                .iter()
                .map(|d| d.entries[0].original.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(AnalysisScope::LastWeek), ["new"]);
        assert_eq!(names(AnalysisScope::LastMonth), ["mid", "new"]);
        assert_eq!(names(AnalysisScope::Everything), ["old", "mid", "new"]);
    }

    /// The rendered text is what the model reads, so it must round-trip back to
    /// the same entries — a lossy render is advice about the wrong data.
    #[test]
    fn render_round_trips_through_the_parser() {
        let (days, _) = parse_log(LOG);
        let (again, unparsed) = parse_log(&render_days(&days));
        assert_eq!(unparsed, 0);
        assert_eq!(again.len(), days.len());
        assert_eq!(again[0].entries[0].reason, days[0].entries[0].reason);
        assert_eq!(again[1].entries[0].original, days[1].entries[0].original);
    }

    #[test]
    fn tail_keeps_whole_lines_and_the_newest_entries() {
        let log = "## old\n- first -> 1 (r)\n- second -> 2 (r)\n- third -> 3 (r)\n";
        let cut = tail_within(log, 24);
        assert!(
            cut.starts_with("- "),
            "must start on a line boundary: {cut:?}"
        );
        assert!(
            cut.ends_with("- third -> 3 (r)\n"),
            "must keep the newest: {cut:?}"
        );
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
