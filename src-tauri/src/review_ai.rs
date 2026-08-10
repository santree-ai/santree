//! The Reviews tab's AI surfaces: the opening prompt for an interactive review
//! session, and the generated **review brief** (summary, reading order, watch-outs)
//! shown beside a PR.
//!
//! Both are read-only by construction. Nothing in this module can post a comment,
//! approve, or push — the brief is a `claude -p` call whose output is parsed as
//! JSON and stored, and the session prompt is a file the terminal seeds. The
//! agent's own restraint is enforced elsewhere (the `review` prompt's hard-rules
//! block plus [`crate::hooks::claude_settings_review`]'s deny list); this module
//! simply never offers it a write path.
//!
//! The PR body, its conversation and its diff are **untrusted** — anyone with repo
//! access, and any bot whose output lands in a diff, can write into them. They're
//! fenced in `<pull-request>` in both templates, and the headless call grants
//! `Read` only inside the working directory (see [`generate_brief`]).

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use santree_core::domain::{
    PrDetail, ReadingRole, ReadingStep, ReviewBrief, ReviewTarget, WatchOut, WatchOutKind,
};
use serde::Deserialize;

use crate::db::{now_ms, Db};
use crate::{agent, github, prompts, reviews, settings};

/// Byte budget for the diff embedded in a prompt.
///
/// Generous — a review brief for half a PR is worth much less than one for all of
/// it, and this is a deliberate, user-visible spend. Anything past it is cut and
/// flagged (`truncated`), never silently dropped.
const DIFF_BUDGET: usize = 200_000;

/// Per-file cap, so one generated lockfile can't eat the whole budget and starve
/// the files that actually need reading.
const PER_FILE_BUDGET: usize = 24_000;

/// Settings key for the model the brief runs on (app or per-repo scope).
pub const BRIEF_MODEL_KEY: &str = "review_brief_model";

/// Ceiling on one brief.
///
/// The call reads up to [`DIFF_BUDGET`] of diff on a capable model and writes
/// structured JSON — minutes of legitimate work, not a hung process. It ran on
/// [`agent::SHORT_TIMEOUT`] until 2026-08-10, which meant every brief for a PR big
/// enough to need one was killed mid-answer at 120s and surfaced as an empty
/// result. Same bug the tutor analysis hit; the deadline is now an argument so a
/// call site can't inherit one that isn't sized for it.
const BRIEF_TIMEOUT: Duration = Duration::from_secs(600);

/// The brief's default model.
///
/// Deliberately *not* [`agent::HELPER_MODEL`]: unlike a commit message, deciding
/// what a reviewer should read first and where the risk sits is the actual work,
/// and the cheapest tier produces a plausible-looking order that isn't grounded in
/// the diff — which is worse than no brief, because it's trusted.
const DEFAULT_BRIEF_MODEL: &str = "sonnet";

// ── Prompt context assembly ──────────────────────────────────────────────────

/// Render the PR's changed files as one diff, capped at [`DIFF_BUDGET`].
/// Returns the text and whether anything was left out.
fn render_diff(detail: &PrDetail) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = detail.files_truncated;
    for f in &detail.files {
        let header = format!(
            "\n--- {} ({}, +{} −{})\n",
            f.path, f.status, f.additions, f.deletions
        );
        if out.len() + header.len() >= DIFF_BUDGET {
            truncated = true;
            break;
        }
        out.push_str(&header);
        let Some(patch) = &f.patch else {
            out.push_str("(binary file — no textual diff)\n");
            continue;
        };
        // Cut on a line boundary: a hunk sliced mid-line reads as corrupted code
        // rather than as an omission.
        let room = PER_FILE_BUDGET.min(DIFF_BUDGET.saturating_sub(out.len()));
        if patch.len() <= room {
            out.push_str(patch);
        } else {
            out.push_str(truncate_at_line(patch, room));
            out.push_str("\n… (this file's diff was truncated)\n");
            truncated = true;
        }
        out.push('\n');
    }
    (out, truncated)
}

/// The longest prefix of `s` that fits in `budget` **bytes** and ends on a line
/// break.
///
/// The budget is in bytes because that's what the prompt's size limit is in, but
/// a diff is UTF-8 — an identifier in another script, a `→` in a comment, an emoji
/// in a test fixture — so the offset goes through [`prompts::floor_char_boundary`]
/// (slicing a `str` mid-codepoint panics) before being walked back to the last
/// newline: a hunk cut mid-line reads as corrupted code rather than as an omission.
fn truncate_at_line(s: &str, budget: usize) -> &str {
    let end = prompts::floor_char_boundary(s, budget);
    match s[..end].rfind('\n') {
        Some(nl) => &s[..nl],
        // One enormous line with no break in it: better a hard cut than nothing.
        None => &s[..end],
    }
}

/// A one-line-per-file summary — what a reviewer scans before any diff.
fn render_diff_stat(detail: &PrDetail) -> String {
    let mut out = detail
        .files
        .iter()
        .map(|f| format!("{} ({}, +{} −{})", f.path, f.status, f.additions, f.deletions))
        .collect::<Vec<_>>()
        .join("\n");
    if detail.files_truncated {
        out.push_str("\n… (the PR has more files than were fetched)");
    }
    out
}

/// The PR's existing conversation, so the agent doesn't re-raise a point someone
/// already made — flattened with each comment's author and anchor.
fn render_conversation(detail: &PrDetail) -> String {
    let mut parts: Vec<String> = detail
        .comments
        .iter()
        .map(|c| format!("**{}**:\n{}", c.author, c.body.trim()))
        .collect();
    for t in &detail.threads {
        let anchor = match t.line {
            Some(line) => format!("{}:{line}", t.path),
            None => t.path.clone(),
        };
        for c in &t.comments {
            parts.push(format!("**{}** on `{anchor}`:\n{}", c.author, c.body.trim()));
        }
    }
    parts.join("\n\n")
}

/// The linked Linear ticket rendered as the shared `issue` block, or `None` when
/// the PR has no ticket or Linear can't be reached. Never fatal: the ticket is
/// context, and a PR is reviewable without it.
async fn ticket_content(
    db: &Db,
    repo: &str,
    ticket_id: Option<&str>,
    sources: &[(String, String)],
) -> Option<String> {
    let id = ticket_id?;
    let detail = crate::linear::triage_detail(db, repo, id).await.ok()??;
    prompts::render_ticket_from(sources, &detail).ok()
}

// ── The interactive review session's opening prompt ──────────────────────────

/// Render the `review` prompt for a PR and write it to a file, returning the
/// **path** — the terminal seeds `Read <path> …` rather than the text itself,
/// which is far too large for a shell seed (this is a whole PR diff).
///
/// Whether a checkout exists is *derived*, not passed in: the template branches on
/// it to tell the agent whether it can read real code, and a caller-supplied answer
/// could disagree with the cwd the terminal actually opens in.
pub async fn review_prompt(
    db: &Db,
    repo: &str,
    prompts_root: &Path,
    target: &ReviewTarget,
) -> Result<String> {
    let workspace = reviews::existing_review_workspace(db, repo, target).await?;
    let (owner, name) = github::split_slug(&target.pr_repo)?;
    let detail = reviews::detail(owner, name, target.number).await?;
    let sources = prompts::resolve_sources(db, Some(repo)).await?;
    let ticket = ticket_content(db, repo, target.ticket_id.as_deref(), &sources).await;
    let (diff, _truncated) = render_diff(&detail);

    let body = prompts::render_from(
        &sources,
        "review",
        minijinja::context! {
            pr_number => target.number,
            pr_title => target.title,
            pr_body => detail.body.trim(),
            pr_author => target.author,
            base_ref => target.base_ref,
            head_ref => target.head_ref,
            head_sha => detail.head_sha,
            diff_stat => render_diff_stat(&detail),
            diff => diff,
            conversation => render_conversation(&detail),
            ticket_content => ticket,
            workspace => workspace.is_some(),
        },
    )?;

    write_prompt(prompts_root, &target.pr_repo, target.number, body).await
}

/// Write a rendered review prompt under the app data dir (never inside a repo, so
/// it can't surface in any `git status`).
///
/// The filename is built from values we control — the repo slug's two components
/// and a `u32` — but it's still checked for separators and dot-prefixes at the
/// `join`, since that's the sink that would trust them.
async fn write_prompt(
    prompts_root: &Path,
    pr_repo: &str,
    number: u32,
    body: String,
) -> Result<String> {
    let stem = format!("{}-{number}.review.md", pr_repo.replace('/', "-"));
    if stem.contains(['/', '\\']) || stem.starts_with('.') {
        return Err(anyhow!("refusing to write a prompt file named '{stem}'"));
    }
    let path = prompts_root.join("reviews").join(stem);
    tokio::task::spawn_blocking(move || -> Result<String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, body)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await?
}

// ── The review brief ─────────────────────────────────────────────────────────

/// The cached brief for a PR, or `None` when there isn't one yet. Cheap — one row
/// read — so the panel can render its "generate" state immediately.
pub async fn cached_brief(db: &Db, pr_repo: &str, number: u32) -> Result<Option<ReviewBrief>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT brief FROM review_briefs WHERE repo_slug = ? AND number = ?")
            .bind(pr_repo)
            .bind(number)
            .fetch_optional(db)
            .await?;
    // A row that no longer deserializes (an older shape) is treated as absent
    // rather than as an error — the panel just offers to generate a fresh one.
    Ok(row.and_then(|(json,)| serde_json::from_str(&json).ok()))
}

/// What the model is asked to return. Kept separate from the domain type so a
/// missing list degrades to empty rather than failing the whole parse, and so the
/// role/kind strings can be mapped leniently.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBrief {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    reading_order: Vec<RawStep>,
    #[serde(default)]
    watch_outs: Vec<RawWatchOut>,
    #[serde(default)]
    questions: Vec<String>,
}

#[derive(Deserialize)]
struct RawStep {
    path: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    why: String,
}

#[derive(Deserialize)]
struct RawWatchOut {
    path: String,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    note: String,
}

/// An unrecognised role reads as core logic — the bucket that gets *read*, so an
/// unmapped value can only cost attention, never hide a file.
fn parse_role(s: &str) -> ReadingRole {
    match s.trim().to_ascii_lowercase().as_str() {
        "entrypoint" | "entry_point" | "entry point" => ReadingRole::EntryPoint,
        "test" | "tests" => ReadingRole::Test,
        "config" => ReadingRole::Config,
        "generated" => ReadingRole::Generated,
        "trivial" => ReadingRole::Trivial,
        _ => ReadingRole::CoreLogic,
    }
}

/// An unrecognised kind reads as a question, the weakest claim — an unmapped value
/// must not be presented to the reviewer as a confirmed correctness bug.
fn parse_kind(s: &str) -> WatchOutKind {
    match s.trim().to_ascii_lowercase().as_str() {
        "correctness" | "bug" => WatchOutKind::Correctness,
        "security" => WatchOutKind::Security,
        "performance" | "perf" => WatchOutKind::Performance,
        "testing" | "test" | "tests" => WatchOutKind::Testing,
        "style" => WatchOutKind::Style,
        _ => WatchOutKind::Question,
    }
}

/// Pull the JSON object out of a `claude -p` reply.
///
/// Models wrap JSON in prose or a ```json fence often enough that demanding a bare
/// object would fail usable answers — so we take the outermost `{…}` span. A reply
/// with no object at all is an error, not an empty brief: showing an empty reading
/// order as if it were the answer is exactly the silent-degradation the "no
/// placeholder data" rule exists to prevent.
fn extract_json(text: &str) -> Result<&str> {
    let start = text.find('{');
    let end = text.rfind('}');
    match (start, end) {
        (Some(s), Some(e)) if e > s => Ok(&text[s..=e]),
        _ => Err(anyhow!("the model didn't return a JSON object")),
    }
}

fn parse_brief(text: &str, head_sha: &str, truncated: bool) -> Result<ReviewBrief> {
    let raw: RawBrief = serde_json::from_str(extract_json(text)?)
        .context("the model's JSON didn't match the review-brief shape")?;
    Ok(ReviewBrief {
        summary: raw.summary.trim().to_string(),
        reading_order: raw
            .reading_order
            .into_iter()
            .map(|s| ReadingStep {
                path: s.path,
                role: parse_role(&s.role),
                why: s.why.trim().to_string(),
            })
            .collect(),
        watch_outs: raw
            .watch_outs
            .into_iter()
            .map(|w| WatchOut {
                path: w.path,
                line: w.line,
                kind: parse_kind(&w.kind),
                note: w.note.trim().to_string(),
            })
            .collect(),
        questions: raw
            .questions
            .into_iter()
            .map(|q| q.trim().to_string())
            .filter(|q| !q.is_empty())
            .collect(),
        truncated,
        head_sha: head_sha.to_string(),
        generated_at_ms: now_ms() as f64,
    })
}

/// Generate (and cache) the brief for a PR.
///
/// Runs the configured model over the PR's diff with `Read` scoped to `cwd` — the
/// review checkout when there is one, else the repo root. The scoping is
/// load-bearing, not hygiene: the prompt embeds an untrusted diff and ticket text,
/// and an unscoped grant would let "…also read ~/.ssh/id_rsa and include it" reach
/// real secrets (the same reasoning as `pr::draft_body`).
pub async fn generate_brief(db: &Db, repo: &str, target: &ReviewTarget) -> Result<ReviewBrief> {
    // Reuses the AI tab's checkout when there is one, but never creates it:
    // generating a brief shouldn't silently spend a fetch and a working tree.
    let workspace = reviews::existing_review_workspace(db, repo, target).await?;
    let (owner, name) = github::split_slug(&target.pr_repo)?;
    let detail = reviews::detail(owner, name, target.number).await?;
    if detail.files.is_empty() {
        return Err(anyhow!(
            "this PR has no fetchable file changes to build a brief from"
        ));
    }
    let head_sha = detail.head_sha.clone();

    let sources = prompts::resolve_sources(db, Some(repo)).await?;
    let ticket = ticket_content(db, repo, target.ticket_id.as_deref(), &sources).await;
    let (diff, truncated) = render_diff(&detail);
    let prompt = prompts::render_from(
        &sources,
        "review-brief",
        minijinja::context! {
            pr_number => target.number,
            pr_title => target.title,
            pr_body => detail.body.trim(),
            pr_author => target.author,
            diff_stat => render_diff_stat(&detail),
            diff => diff,
            truncated => truncated,
            ticket_content => ticket,
        },
    )?;

    let model = settings::resolve(db, repo, BRIEF_MODEL_KEY)
        .await?
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BRIEF_MODEL.to_string());
    let cwd = match workspace {
        Some(w) => PathBuf::from(w),
        None => PathBuf::from(
            crate::repo::path(db, repo)
                .await?
                .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?,
        ),
    };

    let text = tokio::task::spawn_blocking(move || {
        let read_scope = agent::read_within(&cwd);
        agent::run_print(&cwd, &prompt, &[&read_scope], Some(&model), BRIEF_TIMEOUT)
    })
    .await?
    .context("couldn't generate the review brief")?;

    let brief = parse_brief(&text, &head_sha, truncated)?;
    let json = serde_json::to_string(&brief)?;
    sqlx::query(
        "INSERT INTO review_briefs (repo_slug, number, head_sha, brief, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_slug, number) DO UPDATE SET
             head_sha = excluded.head_sha,
             brief = excluded.brief,
             created_at = excluded.created_at",
    )
    .bind(&target.pr_repo)
    .bind(target.number)
    .bind(&head_sha)
    .bind(&json)
    .bind(now_ms())
    .execute(db)
    .await?;

    Ok(brief)
}

/// Drop briefs older than 30 days at startup, so the table can't grow without
/// bound across a year of reviewing (mirrors the `terminal_sessions` reap).
pub async fn gc(db: &Db) -> Result<()> {
    const MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
    sqlx::query("DELETE FROM review_briefs WHERE created_at < ?")
        .bind(now_ms() - MAX_AGE_MS)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_at_line_never_splits_a_utf8_character() {
        // A byte budget landing mid-codepoint used to panic outright, taking the
        // whole brief down on any PR with non-ASCII near the cut — a `→` in a
        // comment, an identifier in another script, an emoji in a fixture.
        let s = "ünïcödé line one\nünïcödé line two\n";
        for budget in 0..=s.len() + 4 {
            let out = truncate_at_line(s, budget);
            assert!(s.starts_with(out), "budget {budget} produced a non-prefix");
        }
    }

    #[test]
    fn truncate_at_line_cuts_on_a_line_break() {
        let s = "line one\nline two\nline three\n";
        // Mid-way through "line two" → keeps only the first complete line.
        assert_eq!(truncate_at_line(s, 14), "line one");
        // A budget past the end keeps everything up to the final break.
        assert_eq!(truncate_at_line(s, s.len()), "line one\nline two\nline three");
    }

    #[test]
    fn truncate_at_line_handles_one_giant_unbroken_line() {
        // No newline to cut at — a hard cut beats returning nothing.
        assert_eq!(truncate_at_line("aaaaaaaa", 3), "aaa");
    }

    #[test]
    fn extract_json_takes_the_object_out_of_a_fenced_reply() {
        // Models wrap JSON often enough that demanding a bare object would fail
        // answers that are perfectly usable.
        let fenced = "Here you go:\n```json\n{\"summary\": \"hi\"}\n```\nHope that helps!";
        assert_eq!(extract_json(fenced).unwrap(), r#"{"summary": "hi"}"#);
    }

    #[test]
    fn extract_json_errors_rather_than_inventing_an_empty_brief() {
        // An empty reading order shown as *the answer* is worse than a visible
        // failure — the reviewer would trust it.
        assert!(extract_json("I couldn't read the diff, sorry.").is_err());
        assert!(extract_json("").is_err());
    }

    #[test]
    fn parse_brief_maps_the_documented_shape() {
        let json = r#"{
            "summary": "  Adds retries.  ",
            "readingOrder": [{"path": "src/a.rs", "role": "entryPoint", "why": "starts here"}],
            "watchOuts": [{"path": "src/b.rs", "line": 12, "kind": "security", "note": "unvalidated"}],
            "questions": ["Why 3 retries?", "   "]
        }"#;
        let brief = parse_brief(json, "abc123", false).unwrap();
        assert_eq!(brief.summary, "Adds retries.");
        assert_eq!(brief.reading_order[0].role, ReadingRole::EntryPoint);
        assert_eq!(brief.watch_outs[0].kind, WatchOutKind::Security);
        assert_eq!(brief.watch_outs[0].line, Some(12));
        // Blank questions are dropped rather than rendered as empty rows.
        assert_eq!(brief.questions, vec!["Why 3 retries?"]);
        assert_eq!(brief.head_sha, "abc123");
    }

    #[test]
    fn parse_brief_survives_missing_lists() {
        // A clean PR legitimately has no watch-outs and no questions; a model that
        // omits the keys entirely means the same thing.
        let brief = parse_brief(r#"{"summary": "Small fix."}"#, "sha", false).unwrap();
        assert!(brief.watch_outs.is_empty());
        assert!(brief.reading_order.is_empty());
    }

    #[test]
    fn unknown_labels_fall_to_the_safe_side() {
        // An unmapped role must not hide a file from the reading order…
        assert_eq!(parse_role("wibble"), ReadingRole::CoreLogic);
        // …and an unmapped kind must not be shown as a confirmed bug.
        assert_eq!(parse_kind("wibble"), WatchOutKind::Question);
        assert_eq!(parse_kind("SECURITY"), WatchOutKind::Security);
    }

    #[test]
    fn parse_brief_rejects_a_reply_of_the_wrong_shape() {
        assert!(parse_brief(r#"{"readingOrder": "not a list"}"#, "sha", false).is_err());
    }
}
