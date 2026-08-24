//! The Reviews tab's AI surfaces: the opening prompts for the two review sessions,
//! and the cached **review brief** (summary, reading order, watch-outs) shown
//! beside a PR.
//!
//! Two sessions, deliberately different. **Ask AI** (`review`) is a reading
//! partner: it explains the PR and answers questions, and writes nothing anywhere.
//! **AI review** (`pr-review`) is asked to produce something — a brief and draft
//! comments — and gets santree's own MCP tools to put them in, which is the only
//! write path it has ([`launch`] is what wires those up).
//!
//! Neither can post to GitHub. That isn't a promise about the model's behaviour: a
//! review goes out under the user's name, so it goes out when the user sends it.
//! The deny list ([`crate::hooks::claude_settings_review`] and its AI-review twin)
//! blocks the `gh` routes, the prompts state the rule, and everything the AI review
//! writes lands in `review_drafts` until a person publishes it.
//!
//! The PR body, its conversation and its diff are **untrusted** — anyone with repo
//! access, and any bot whose output lands in a diff, can write into them. They're
//! fenced in `<pull-request>` in both templates.

use std::path::Path;

use anyhow::{anyhow, Result};
use santree_core::diff_index::{hunk_spans, DiffFileIndex, DiffIndex};
use santree_core::domain::{AiReviewLaunch, PrDetail, ReviewBrief, ReviewDraft, ReviewTarget};
use tauri::{AppHandle, Manager};

use crate::db::{now_ms, Db};
use crate::{github, hooks, prompts, review_drafts, reviews};

/// Byte budget for the diff embedded in a prompt.
///
/// Generous — a review brief for half a PR is worth much less than one for all of
/// it, and this is a deliberate, user-visible spend. Anything past it is cut and
/// flagged (`truncated`), never silently dropped.
const DIFF_BUDGET: usize = 200_000;

/// Per-file cap, so one generated lockfile can't eat the whole budget and starve
/// the files that actually need reading.
const PER_FILE_BUDGET: usize = 24_000;

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
        .map(|f| {
            format!(
                "{} ({}, +{} −{})",
                f.path, f.status, f.additions, f.deletions
            )
        })
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
            parts.push(format!(
                "**{}** on `{anchor}`:\n{}",
                c.author,
                c.body.trim()
            ));
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

// ── The review sessions' opening prompts ─────────────────────────────────────

/// Everything both prompts are rendered from, gathered once.
///
/// Whether a checkout exists is *derived* here, not passed in: both templates
/// branch on it to tell the agent whether it can read real code, and a
/// caller-supplied answer could disagree with the cwd the terminal opens in.
struct PromptInputs {
    detail: PrDetail,
    sources: Vec<(String, String)>,
    ticket: Option<String>,
    diff: String,
    truncated: bool,
    has_workspace: bool,
}

async fn prompt_inputs(db: &Db, repo: &str, target: &ReviewTarget) -> Result<PromptInputs> {
    let workspace = reviews::existing_review_workspace(db, repo, target).await?;
    let (owner, name) = github::split_slug(&target.pr_repo)?;
    let detail = reviews::detail(owner, name, target.number).await?;
    let sources = prompts::resolve_sources(db, Some(repo)).await?;
    let ticket = ticket_content(db, repo, target.ticket_id.as_deref(), &sources).await;
    let (diff, truncated) = render_diff(&detail);
    Ok(PromptInputs {
        detail,
        sources,
        ticket,
        diff,
        truncated,
        has_workspace: workspace.is_some(),
    })
}

/// The variables both templates share.
fn shared_context(target: &ReviewTarget, i: &PromptInputs) -> minijinja::Value {
    minijinja::context! {
        pr_number => target.number,
        pr_title => target.title,
        pr_body => i.detail.body.trim(),
        pr_author => target.author,
        base_ref => target.base_ref,
        head_ref => target.head_ref,
        head_sha => i.detail.head_sha,
        diff_stat => render_diff_stat(&i.detail),
        diff => i.diff,
        conversation => render_conversation(&i.detail),
        ticket_content => i.ticket,
        workspace => i.has_workspace,
        truncated => i.truncated,
    }
}

/// Render the **Ask AI** session's opening prompt and write it to a file, returning
/// the **path** — the terminal seeds `Read <path> …` rather than the text itself,
/// which is far too large for a shell seed (this is a whole PR diff).
pub async fn review_prompt(
    db: &Db,
    repo: &str,
    prompts_root: &Path,
    target: &ReviewTarget,
) -> Result<String> {
    let inputs = prompt_inputs(db, repo, target).await?;
    let body = prompts::render_from(&inputs.sources, "review", shared_context(target, &inputs))?;
    write_prompt(prompts_root, &target.pr_repo, target.number, "review", body).await
}

/// Render the **AI review** session's prompt — the one asked to produce a brief and
/// draft comments through santree's tools. Returns the file's path alongside the
/// PR detail it was built from, so the caller can index the same diff the agent is
/// reading rather than fetching the PR twice.
///
/// `drafts` are what's already saved for this PR: a resumed session that can see
/// them doesn't re-raise points it made an hour ago.
async fn ai_review_prompt(
    db: &Db,
    repo: &str,
    prompts_root: &Path,
    target: &ReviewTarget,
    drafts: &[ReviewDraft],
) -> Result<(String, PrDetail)> {
    let inputs = prompt_inputs(db, repo, target).await?;
    let existing: Vec<minijinja::Value> = drafts
        .iter()
        .map(|d| {
            minijinja::context! {
                path => d.path,
                line => d.line,
                body => d.body,
            }
        })
        .collect();
    let body = prompts::render_from(
        &inputs.sources,
        "pr-review",
        minijinja::context! { existing_drafts => existing, ..shared_context(target, &inputs) },
    )?;
    let path = write_prompt(
        prompts_root,
        &target.pr_repo,
        target.number,
        "ai-review",
        body,
    )
    .await?;
    Ok((path, inputs.detail))
}

/// Write a rendered review prompt under the app data dir (never inside a repo, so
/// it can't surface in any `git status`).
///
/// The filename is built from values we control — the repo slug's two components,
/// a `u32`, and a literal — but it's still checked for separators and dot-prefixes
/// at the `join`, since that's the sink that would trust them.
async fn write_prompt(
    prompts_root: &Path,
    pr_repo: &str,
    number: u32,
    kind: &str,
    body: String,
) -> Result<String> {
    let stem = format!("{}-{number}.{kind}.md", pr_repo.replace('/', "-"));
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

// ── Launching an AI review ───────────────────────────────────────────────────

/// Resolve everything an AI-review session launches with: its prompt, its
/// `--settings` file, and the `--mcp-config` that gives it santree's review tools.
///
/// One call for all three because the terminal seed is built **once**, at PTY
/// creation: a flag that resolves late is silently dropped, and the two ways that
/// can go wrong aren't symmetrical — a session missing its MCP config looks like
/// it's working until it has nowhere to put what it found, and one missing its
/// settings has no deny list. Either is worse than not launching.
///
/// The diff index written here is what the MCP server validates anchors against.
/// It's built from the *same* `PrDetail` the prompt embedded, so the lines the
/// agent reads and the lines it's allowed to comment on can't disagree.
pub async fn launch(
    app: &AppHandle,
    db: &Db,
    repo: &str,
    target: &ReviewTarget,
    tutor: Option<&str>,
) -> Result<AiReviewLaunch> {
    let (owner, name) = github::split_slug(&target.pr_repo)?;
    let prompts_root = crate::worktree::prompts_root(app)
        .ok_or_else(|| anyhow!("no writable data directory for the prompt file"))?;
    let drafts = review_drafts::list(db, &target.pr_repo, target.number).await?;
    let (prompt_path, detail) = ai_review_prompt(db, repo, &prompts_root, target, &drafts).await?;

    // The head the whole session is scoped to. It goes into argv, so it's checked
    // like every other value that crosses that line.
    let head_sha = detail.head_sha.clone();
    if !(7..=64).contains(&head_sha.len()) || !head_sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(anyhow!(
            "this pull request has no usable head commit to review"
        ));
    }
    let head_sha = head_sha.to_ascii_lowercase();

    let index = DiffIndex {
        head_sha: head_sha.clone(),
        files_truncated: detail.files_truncated,
        files: detail
            .files
            .iter()
            .map(|f| {
                let (old, new) = f.patch.as_deref().map(hunk_spans).unwrap_or_default();
                DiffFileIndex {
                    path: f.path.clone(),
                    old,
                    new,
                }
            })
            .collect(),
    };

    let (app2, owner, name) = (app.clone(), owner.to_string(), name.to_string());
    let tutor = tutor.map(str::to_string);
    let number = target.number;
    tokio::task::spawn_blocking(move || -> Result<AiReviewLaunch> {
        let index_path = write_diff_index(&app2, &owner, &name, number, &index)?;
        let settings_path = hooks::claude_settings_ai_review(&app2, tutor.as_deref())
            .ok_or_else(|| anyhow!("santree's Claude settings file couldn't be written"))?;
        let mcp_config_path =
            hooks::mcp_config_ai_review(&app2, &owner, &name, number, &head_sha, &index_path)?;
        Ok(AiReviewLaunch {
            prompt_path,
            settings_path,
            mcp_config_path,
        })
    })
    .await?
}

/// Write the diff index beside the MCP config it belongs to, and return its path.
/// Rewritten on every launch, so a resumed session validates against the PR as it
/// is now rather than as it was when the session started.
fn write_diff_index(
    app: &AppHandle,
    owner: &str,
    name: &str,
    number: u32,
    index: &DiffIndex,
) -> Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow!("no writable data directory: {e}"))?
        .join("mcp");
    // Same guard as the config's own name, at the same sink.
    let stem = hooks::mcp_stem(owner, name, number)?.replace(".mcp.json", ".diff.json");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(stem);
    std::fs::write(&path, serde_json::to_string(index)?)?;
    Ok(path)
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
        assert_eq!(
            truncate_at_line(s, s.len()),
            "line one\nline two\nline three"
        );
    }

    #[test]
    fn truncate_at_line_handles_one_giant_unbroken_line() {
        // No newline to cut at — a hard cut beats returning nothing.
        assert_eq!(truncate_at_line("aaaaaaaa", 3), "aaa");
    }
}
