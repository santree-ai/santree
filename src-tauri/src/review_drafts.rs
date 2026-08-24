//! "santree drafts": the review comments the AI-review session writes, held here
//! until the user decides they're worth sending.
//!
//! Only the `santree-review` MCP server ([`crates/hook`]) inserts; this module is
//! the app's half — read them, edit one, drop one, and **publish** the keepers into
//! the user's own pending review on GitHub. That split is the point of the feature:
//! an agent can be wrong in public exactly once before nobody trusts the reviews
//! coming from that account, so nothing it writes leaves the machine until a person
//! has read it.
//!
//! Publishing goes through the same [`reviews::add_inline_comment`] the diff's `+`
//! button uses — a draft becomes an ordinary pending-review comment, and the
//! existing "Finish review" bar sends it.

use anyhow::{anyhow, Result};

use santree_core::domain::{
    AgentKind, NewInlineComment, ReviewDraft, ReviewPublishFailure, ReviewPublishOutcome,
};

use crate::db::{now_ms, Db};
use crate::{github, reviews};

/// How long drafts outlive the last time anyone touched them. Same reasoning as
/// [`crate::reviewed::prune_stale`], shorter window: a draft written against a head
/// that moved months ago describes code that no longer exists.
const STALE_DRAFT_DAYS: i64 = 30;

/// The stored columns, in the order every query below selects them.
type Row = (
    String,
    String,
    i64,
    String,
    String,
    i64,
    Option<i64>,
    bool,
    String,
    Option<String>,
    i64,
    i64,
    String,
);

const COLUMNS: &str = "id, pr_repo, pr_number, head_sha, path, line, start_line, on_right, body, \
                       suggestion, created_at, updated_at, agent_kind";

fn to_draft(r: Row) -> ReviewDraft {
    ReviewDraft {
        id: r.0,
        pr_repo: r.1,
        pr_number: r.2 as u32,
        head_sha: r.3,
        path: r.4,
        line: r.5 as u32,
        start_line: r.6.map(|s| s as u32),
        on_right: r.7,
        body: r.8,
        suggestion: r.9,
        created_at_ms: r.10 as f64,
        updated_at_ms: r.11 as f64,
        agent_kind: r.12.parse().unwrap_or(AgentKind::Claude),
    }
}

/// Every draft on a PR, in reading order (by file, then by line) — the order the
/// diff shows them in, so the batch publishes top-down.
pub async fn list(db: &Db, pr_repo: &str, number: u32) -> Result<Vec<ReviewDraft>> {
    github::split_slug(pr_repo)?;
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM review_drafts WHERE pr_repo = ? AND pr_number = ? \
         ORDER BY path, line, created_at"
    ))
    .bind(pr_repo)
    .bind(number)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(to_draft).collect())
}

async fn get(db: &Db, id: &str) -> Result<ReviewDraft> {
    let row: Option<Row> =
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM review_drafts WHERE id = ?"))
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(to_draft)
        .ok_or_else(|| anyhow!("that draft is no longer there"))
}

/// Rewrite a draft the user edited. The anchor stays put: moving a comment to
/// another line is a new comment, and the diff has no affordance for it.
pub async fn update(
    db: &Db,
    id: &str,
    body: &str,
    suggestion: Option<&str>,
) -> Result<ReviewDraft> {
    let body = body.trim();
    if body.is_empty() {
        return Err(anyhow!("a comment needs a body"));
    }
    // An empty suggestion is how the composer clears one, not a blank fence.
    let suggestion = suggestion.map(str::trim).filter(|s| !s.is_empty());
    let done = sqlx::query(
        "UPDATE review_drafts SET body = ?, suggestion = ?, updated_at = ? WHERE id = ?",
    )
    .bind(body)
    .bind(suggestion)
    .bind(now_ms())
    .bind(id)
    .execute(db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(anyhow!("that draft is no longer there"));
    }
    get(db, id).await
}

pub async fn delete(db: &Db, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM review_drafts WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Drop every draft on a PR — "I've read these and none of them are worth
/// sending", which is a real outcome of an AI review.
pub async fn clear(db: &Db, pr_repo: &str, number: u32) -> Result<u32> {
    github::split_slug(pr_repo)?;
    let done = sqlx::query("DELETE FROM review_drafts WHERE pr_repo = ? AND pr_number = ?")
        .bind(pr_repo)
        .bind(number)
        .execute(db)
        .await?;
    Ok(done.rows_affected() as u32)
}

/// The comment body GitHub receives: what the agent wrote, plus its suggestion as
/// a ```suggestion block (the same fence github.com's own "Add a suggestion"
/// produces, which is what makes the "Commit suggestion" button appear).
///
/// The fence grows past any run of backticks inside the suggested code, so
/// suggesting a Markdown file — or code with a fenced block in a doc comment —
/// can't end the block early.
pub fn compose_body(body: &str, suggestion: Option<&str>) -> String {
    let body = body.trim();
    let Some(s) = suggestion.map(str::trim).filter(|s| !s.is_empty()) else {
        return body.to_string();
    };
    // The longest run of backticks anywhere in the suggestion. Markdown only ends a
    // fence at the start of a line, so scanning the whole text is more than
    // strictly needed — and cheaper than being subtly wrong about indentation.
    let longest = s.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    if body.is_empty() {
        format!("{fence}suggestion\n{s}\n{fence}")
    } else {
        format!("{body}\n\n{fence}suggestion\n{s}\n{fence}")
    }
}

/// Send the named drafts to GitHub as comments in the user's pending review, and
/// delete each one that lands.
///
/// The PR's node id, its current head, and any open pending review are read from
/// GitHub here rather than taken from the caller. The head is what the staleness
/// refusal below compares against, and a check against a value the caller supplied
/// is one the caller can pass by supplying the draft's own — which is precisely
/// what that refusal exists to stop.
///
/// Sequential, and it stops at the first failure. GitHub *can* take many threads in
/// one `addPullRequestReview`, but its error doesn't say which thread it choked on,
/// and "5 comments failed" when 4 were fine is not an answer anyone can act on.
/// Whatever didn't go is still a draft, and [`ReviewPublishOutcome`] says how far it
/// got — a partial result reported honestly beats an all-or-nothing lie.
pub async fn publish(
    db: &Db,
    pr_repo: &str,
    number: u32,
    ids: &[String],
) -> Result<ReviewPublishOutcome> {
    let (owner, name) = github::split_slug(pr_repo)?;
    let token = github::token()
        .await
        .ok_or_else(|| anyhow!("GitHub (gh) isn't authenticated"))?;
    let anchor = github::pr_publish_anchor(&token, owner, name, number).await?;
    publish_with(db, pr_repo, number, &anchor, ids, |c| async move {
        reviews::add_inline_comment(c).await
    })
    .await
}

/// [`publish`] with the GitHub call injected, so the ordering and the bookkeeping
/// can be tested without a network.
async fn publish_with<F, Fut>(
    db: &Db,
    pr_repo: &str,
    number: u32,
    anchor: &github::PrPublishAnchor,
    ids: &[String],
    mut post: F,
) -> Result<ReviewPublishOutcome>
where
    F: FnMut(NewInlineComment) -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>>>,
{
    if anchor.head_sha.is_empty() {
        return Err(anyhow!(
            "this pull request has no head commit to comment on"
        ));
    }
    let mut out = ReviewPublishOutcome {
        published: 0,
        review_id: anchor.pending_review_id.clone(),
        failed: None,
    };

    for id in ids {
        let draft = match get(db, id).await {
            Ok(d) => d,
            Err(e) => {
                out.failed = Some(ReviewPublishFailure {
                    draft_id: id.clone(),
                    error: format!("{e:#}"),
                });
                break;
            }
        };
        // Scoped like every other read: an id from another PR isn't reachable
        // through this target's pending review.
        if draft.pr_repo != pr_repo || draft.pr_number != number {
            out.failed = Some(ReviewPublishFailure {
                draft_id: id.clone(),
                error: "that draft belongs to a different pull request".into(),
            });
            break;
        }
        // Its line numbers describe the head it was written against. Posting it
        // anyway would put the user's name on a comment pointing at whatever code
        // now sits at that line, which is the one failure worth refusing outright.
        if draft.head_sha != anchor.head_sha {
            out.failed = Some(ReviewPublishFailure {
                draft_id: id.clone(),
                error: format!(
                    "'{}' was written against an earlier commit, and the pull request has moved \
                     since. Re-run the AI review, or delete it.",
                    draft.path
                ),
            });
            break;
        }

        let comment = NewInlineComment {
            pr_repo: pr_repo.to_string(),
            number,
            pr_id: anchor.pr_id.clone(),
            head_sha: anchor.head_sha.clone(),
            path: draft.path.clone(),
            line: draft.line,
            start_line: draft.start_line,
            on_right: draft.on_right,
            body: compose_body(&draft.body, draft.suggestion.as_deref()),
            // Always a draft in the user's review, never a comment posted on its
            // own: the user still gets the last word, in the Finish review bar.
            pending: true,
            review_id: out.review_id.clone(),
        };
        match post(comment).await {
            Ok(opened) => {
                if let Some(review) = opened {
                    // The first comment opened the review; the rest join it.
                    out.review_id = Some(review);
                }
                delete(db, id).await?;
                out.published += 1;
            }
            Err(e) => {
                out.failed = Some(ReviewPublishFailure {
                    draft_id: id.clone(),
                    error: format!("{e:#}"),
                });
                break;
            }
        }
    }
    Ok(out)
}

/// Drop drafts for PRs nobody has touched in [`STALE_DRAFT_DAYS`]. Grouped by PR
/// for the same reason as the viewed marks: one old draft on an active PR is still
/// live. Returns how many rows it dropped.
pub async fn gc(db: &Db) -> Result<u64> {
    let cutoff = now_ms() - STALE_DRAFT_DAYS * 24 * 60 * 60 * 1_000;
    let done = sqlx::query(
        "DELETE FROM review_drafts WHERE (pr_repo, pr_number) IN (
             SELECT pr_repo, pr_number FROM review_drafts
             GROUP BY pr_repo, pr_number
             HAVING MAX(updated_at) < ?
         )",
    )
    .bind(cutoff)
    .execute(db)
    .await?;
    Ok(done.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    async fn db_with(name: &str, drafts: &[(&str, &str, u32, &str, &str)]) -> Db {
        let base = std::env::temp_dir().join(format!(
            "santree-review-drafts-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        for (id, repo, number, head, path) in drafts {
            sqlx::query(
                "INSERT INTO review_drafts (id, pr_repo, pr_number, head_sha, path, line, \
                 start_line, on_right, body, suggestion, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, 10, NULL, 1, 'says something', NULL, 0, ?)",
            )
            .bind(id)
            .bind(repo)
            .bind(number)
            .bind(head)
            .bind(path)
            .bind(now_ms())
            .execute(&db)
            .await
            .unwrap();
        }
        db
    }

    fn anchor() -> github::PrPublishAnchor {
        github::PrPublishAnchor {
            pr_id: "PR_node".into(),
            head_sha: "abc1234".into(),
            pending_review_id: None,
        }
    }

    #[test]
    fn a_suggestion_is_fenced_past_any_backticks_inside_it() {
        assert_eq!(compose_body("  just prose  ", None), "just prose");
        assert_eq!(
            compose_body("fix", Some("let x = 1;")),
            "fix\n\n```suggestion\nlet x = 1;\n```"
        );
        // A suggestion containing a fenced block would otherwise end the
        // suggestion early and leak the rest into the comment as prose — the case
        // that shows up the moment someone reviews a Markdown file.
        let nested = compose_body("fix", Some("```rust\nlet x = 1;\n```"));
        assert!(nested.starts_with("fix\n\n````suggestion\n"), "{nested}");
        assert!(nested.ends_with("\n````"), "{nested}");
        // Blank suggestions are absent, not an empty block.
        assert_eq!(compose_body("fix", Some("   ")), "fix");
    }

    #[tokio::test]
    async fn publishing_threads_the_new_review_id_through_the_batch() {
        let db = db_with(
            "batch",
            &[
                ("d1", "acme/web", 42, "abc1234", "src/a.rs"),
                ("d2", "acme/web", 42, "abc1234", "src/b.rs"),
            ],
        )
        .await;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let calls = seen.clone();
        let out = publish_with(
            &db,
            "acme/web",
            42,
            &anchor(),
            &["d1".into(), "d2".into()],
            move |c| {
                let calls = calls.clone();
                async move {
                    let first = calls.lock().unwrap().is_empty();
                    calls.lock().unwrap().push(c);
                    // The first comment opens the review, as GitHub's API does.
                    Ok(first.then(|| "REVIEW_node".to_string()))
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(out.published, 2);
        assert_eq!(out.review_id.as_deref(), Some("REVIEW_node"));
        assert!(out.failed.is_none());
        let calls: Vec<NewInlineComment> = seen.lock().unwrap().clone();
        assert_eq!(calls[0].review_id, None, "the first one opens the review");
        assert_eq!(
            calls[1].review_id.as_deref(),
            Some("REVIEW_node"),
            "the rest must join it, not open a second review"
        );
        assert!(calls.iter().all(|c| c.pending), "never posted on its own");
        assert!(list(&db, "acme/web", 42).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failure_stops_the_batch_and_keeps_what_did_not_go() {
        let db = db_with(
            "partial",
            &[
                ("d1", "acme/web", 42, "abc1234", "src/a.rs"),
                ("d2", "acme/web", 42, "abc1234", "src/b.rs"),
                ("d3", "acme/web", 42, "abc1234", "src/c.rs"),
            ],
        )
        .await;
        let n = Arc::new(Mutex::new(0));
        let out = publish_with(
            &db,
            "acme/web",
            42,
            &anchor(),
            &["d1".into(), "d2".into(), "d3".into()],
            move |_| {
                let n = n.clone();
                async move {
                    let mut n = n.lock().unwrap();
                    *n += 1;
                    if *n == 2 {
                        Err(anyhow!("GitHub said no"))
                    } else {
                        Ok(None)
                    }
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(out.published, 1, "the count is the truth, not a guess");
        assert_eq!(out.failed.unwrap().draft_id, "d2");
        // d1 went, d2 and d3 are still drafts — nothing was lost.
        let left: Vec<String> = list(&db, "acme/web", 42)
            .await
            .unwrap()
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(left, vec!["d2".to_string(), "d3".to_string()]);
    }

    #[tokio::test]
    async fn a_draft_from_an_older_head_is_refused_rather_than_misplaced() {
        let db = db_with("stale", &[("d1", "acme/web", 42, "0000000", "src/a.rs")]).await;
        let out = publish_with(&db, "acme/web", 42, &anchor(), &["d1".into()], |_| async {
            panic!("must never reach GitHub")
        })
        .await
        .unwrap();
        assert_eq!(out.published, 0);
        assert!(out.failed.unwrap().error.contains("earlier commit"));
        assert_eq!(list(&db, "acme/web", 42).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_draft_from_another_pull_request_is_not_reachable() {
        let db = db_with("scoped", &[("d1", "acme/other", 7, "abc1234", "src/a.rs")]).await;
        let out = publish_with(&db, "acme/web", 42, &anchor(), &["d1".into()], |_| async {
            panic!("must never reach GitHub")
        })
        .await
        .unwrap();
        assert_eq!(out.published, 0);
        assert!(out.failed.unwrap().error.contains("different pull request"));
    }

    #[tokio::test]
    async fn editing_trims_the_body_and_clears_a_blank_suggestion() {
        let db = db_with("edit", &[("d1", "acme/web", 42, "abc1234", "src/a.rs")]).await;
        let d = update(&db, "d1", "  tightened  ", Some("let x = 1;"))
            .await
            .unwrap();
        assert_eq!(d.body, "tightened");
        assert_eq!(d.suggestion.as_deref(), Some("let x = 1;"));
        let d = update(&db, "d1", "tightened", Some("  ")).await.unwrap();
        assert_eq!(d.suggestion, None);
        assert!(update(&db, "d1", "   ", None).await.is_err());
        assert!(update(&db, "gone", "x", None).await.is_err());
    }

    #[tokio::test]
    async fn gc_drops_a_quiet_pr_and_leaves_an_active_one() {
        let db = db_with(
            "gc",
            &[
                ("old", "acme/web", 1, "abc1234", "src/a.rs"),
                ("new", "acme/web", 2, "abc1234", "src/a.rs"),
            ],
        )
        .await;
        let ancient = now_ms() - (STALE_DRAFT_DAYS + 1) * 24 * 60 * 60 * 1_000;
        sqlx::query("UPDATE review_drafts SET updated_at = ? WHERE id = 'old'")
            .bind(ancient)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(gc(&db).await.unwrap(), 1);
        assert!(list(&db, "acme/web", 1).await.unwrap().is_empty());
        assert_eq!(list(&db, "acme/web", 2).await.unwrap().len(), 1);
    }
}
