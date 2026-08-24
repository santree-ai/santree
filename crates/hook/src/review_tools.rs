//! The five tools an AI-review session gets, and everything they refuse.
//!
//! All they can do is write santree's own rows: a review brief, and draft review
//! comments for the one pull request named in argv. No GitHub, no network, no
//! `git`. A draft is invisible until the human publishes it from the app.
//!
//! Two rules shape the code here. **Scope comes from argv, never from the model**:
//! every statement carries `pr_repo`/`pr_number`, so "edit a draft on another PR"
//! isn't expressible. And **a refusal is written to be acted on**: the model is
//! told what was wrong and what would be valid, because the alternative to a good
//! error message is a finding quietly dropped.

use std::time::Duration;

use santree_core::diff_index::DiffIndex;
use santree_core::domain::{ReadingStep, ReviewBrief, WatchOut};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, SqliteConnection};

use crate::mcp::{args_object, read_diff_index, McpScope, ToolError, ToolHost, ToolReply};

/// Drafts one session can pile up on a PR. Far past any real review; it exists so
/// a loop can't fill the table.
const MAX_DRAFTS_PER_PR: i64 = 200;

/// Byte budget for a comment body or a suggestion. GitHub's own limit is larger;
/// this is about not storing a runaway generation.
const MAX_TEXT_BYTES: usize = 65_536;

/// Longest path we'll store. Anything past it is a mistake, not a file.
const MAX_PATH_BYTES: usize = 1024;

pub(crate) struct ReviewTools {
    rt: tokio::runtime::Runtime,
    db_path: String,
    scope: McpScope,
}

impl ReviewTools {
    pub fn new(rt: tokio::runtime::Runtime, db_path: String, scope: McpScope) -> Self {
        Self { rt, db_path, scope }
    }

    /// Open the app's database. Never creates it: if santree isn't installed here,
    /// that's a failure to report, not a fresh empty database to write into.
    async fn connect(db_path: &str) -> Result<SqliteConnection, ToolError> {
        SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(false)
            .busy_timeout(Duration::from_secs(3))
            .connect()
            .await
            .map_err(|e| {
                ToolError::Failed(format!(
                    "santree's database isn't reachable at {db_path}: {e}. Nothing was saved."
                ))
            })
    }

    /// Run a unit of database work, then nudge the app so the UI updates live.
    ///
    /// The connection is closed *before* the nudge, not dropped after it: the app
    /// reads the row the moment the signal lands, and a background close can still
    /// be racing that read (same reasoning as the hook path's `record`).
    fn with_db<T>(
        &self,
        work: impl AsyncFnOnce(&mut SqliteConnection) -> Result<T, ToolError>,
    ) -> Result<T, ToolError> {
        let out = self.rt.block_on(async {
            let mut conn = Self::connect(&self.db_path).await?;
            let out = work(&mut conn).await;
            let _ = conn.close().await;
            out
        })?;
        crate::ping_socket(&self.db_path, b'r');
        Ok(out)
    }

    fn index(&self) -> Result<DiffIndex, ToolError> {
        read_diff_index(&self.scope.diff_index)
    }
}

// ── Argument validation ──────────────────────────────────────────────────────

/// A path that can safely be stored and later handed to GitHub as a comment
/// anchor. Never touches the filesystem here, but it is a path everywhere else, so
/// it is checked like one.
pub(crate) fn validate_path(raw: &str) -> Result<String, String> {
    let p = raw.trim();
    if p.is_empty() {
        return Err("'path' is required: the file the comment is about.".into());
    }
    if p.len() > MAX_PATH_BYTES {
        return Err("'path' is implausibly long.".into());
    }
    if p.contains('\0') || p.contains('\\') {
        return Err(format!("'{p}' isn't a usable path."));
    }
    if p.starts_with('/') {
        return Err(format!(
            "'{p}' is an absolute path. Use the path as it appears in the diff, \
             relative to the repository root."
        ));
    }
    if p.split('/').any(|c| c == ".." || c == "." || c.is_empty()) {
        return Err(format!(
            "'{p}' isn't a plain repository path. Use the path exactly as the diff lists it."
        ));
    }
    Ok(p.to_string())
}

fn text(args: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn number(args: &serde_json::Map<String, Value>, key: &str) -> Result<Option<u32>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .filter(|n| *n >= 1 && *n <= u32::MAX as u64)
            .map(|n| Some(n as u32))
            .ok_or_else(|| {
                ToolError::InvalidParams(format!("'{key}' must be a line number, 1 or greater."))
            }),
    }
}

fn side(args: &serde_json::Map<String, Value>) -> Result<Option<bool>, ToolError> {
    match text(args, "side") {
        None => Ok(None),
        Some(s) => match s.trim().to_ascii_uppercase().as_str() {
            "RIGHT" => Ok(Some(true)),
            "LEFT" => Ok(Some(false)),
            other => Err(ToolError::InvalidParams(format!(
                "'side' must be RIGHT (the new file, the usual case) or LEFT (the old file); got '{other}'."
            ))),
        },
    }
}

fn body_text(raw: &str) -> Result<String, ToolError> {
    let b = raw.trim();
    if b.is_empty() {
        return Err(ToolError::InvalidParams(
            "'body' is required: what the comment actually says.".into(),
        ));
    }
    if b.len() > MAX_TEXT_BYTES {
        return Err(ToolError::InvalidParams(
            "'body' is too long for a review comment. Say the point in a few lines.".into(),
        ));
    }
    Ok(b.to_string())
}

/// A validated anchor: which file, which side, which line(s).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Anchor {
    pub path: String,
    pub line: u32,
    pub start_line: Option<u32>,
    pub on_right: bool,
}

/// Check an anchor's shape, then check it against the PR's actual diff.
///
/// Order matters: a nonsense range should be named as such before the diff is
/// consulted, so the model isn't told about hunks when the real problem is that it
/// passed `start_line` after `line`.
pub(crate) fn resolve_anchor(
    index: &DiffIndex,
    path: &str,
    line: u32,
    start_line: Option<u32>,
    on_right: bool,
) -> Result<Anchor, ToolError> {
    let path = validate_path(path).map_err(ToolError::InvalidParams)?;
    // A "range" that ends where it starts is a single-line comment, and GitHub
    // rejects a start that isn't strictly before the end.
    let start_line = start_line.filter(|s| *s != line);
    if let Some(start) = start_line {
        if start > line {
            return Err(ToolError::InvalidParams(format!(
                "'start_line' ({start}) must come before 'line' ({line}): a range runs \
                 start_line..line, and 'line' is its last line."
            )));
        }
    }
    index
        .check_anchor(&path, on_right, start_line, line)
        .map_err(ToolError::InvalidParams)?;
    Ok(Anchor {
        path,
        line,
        start_line,
        on_right,
    })
}

/// Every path a brief points at has to exist in the diff: the UI turns each one
/// into a jump, so an invented path is a dead link the user finds by clicking it.
fn check_brief_paths(index: &DiffIndex, brief: &ReviewBrief) -> Result<(), ToolError> {
    let bad = brief
        .reading_order
        .iter()
        .map(|s| &s.path)
        .chain(brief.watch_outs.iter().map(|w| &w.path))
        .find(|p| index.file(p).is_none());
    match bad {
        None => Ok(()),
        Some(p) => Err(ToolError::InvalidParams(format!(
            "'{p}' isn't a changed file in this pull request, so the reader couldn't jump to it. \
             Use paths exactly as the diff lists them."
        ))),
    }
}

// ── The tools ────────────────────────────────────────────────────────────────

impl ToolHost for ReviewTools {
    fn list(&self) -> Vec<Value> {
        let pr = format!("{}#{}", self.scope.pr_repo, self.scope.number);
        vec![
            json!({
                "name": "set_review_brief",
                "description": format!(
                    "Save the reading brief for {pr}: what the PR does, what order to read it in, \
                     where to look hardest, and what to ask the author. Shown beside the diff in \
                     santree. Call this once, first, before reading in depth. Calling it again \
                     replaces the brief."
                ),
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["summary", "readingOrder", "watchOuts", "questions"],
                    "properties": {
                        "summary": { "type": "string", "description": "Two or three sentences: what this PR changes and why." },
                        "readingOrder": {
                            "type": "array",
                            "description": "Every non-trivial changed file once, ordered so each makes sense given the ones before it.",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["path", "role", "why"],
                                "properties": {
                                    "path": { "type": "string", "description": "Exactly as the diff lists it." },
                                    "role": { "type": "string", "enum": ["entryPoint", "coreLogic", "test", "config", "generated", "trivial"] },
                                    "why": { "type": "string", "description": "One line on why it sits here." }
                                }
                            }
                        },
                        "watchOuts": {
                            "type": "array",
                            "maxItems": 6,
                            "description": "Places worth extra attention, most important first. An empty list is a real answer: a PR that reads clean is clean.",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["path", "kind", "note"],
                                "properties": {
                                    "path": { "type": "string" },
                                    "line": { "type": ["integer", "null"], "minimum": 1, "description": "Line in the new file, when one can be named." },
                                    "kind": { "type": "string", "enum": ["correctness", "security", "performance", "testing", "style", "question"] },
                                    "note": { "type": "string" }
                                }
                            }
                        },
                        "questions": {
                            "type": "array",
                            "maxItems": 4,
                            "description": "Questions the diff genuinely doesn't answer, phrased so they could be pasted as-is.",
                            "items": { "type": "string" }
                        },
                        "truncated": { "type": "boolean", "description": "Pass true when the diff you were given was truncated, so the reader knows this covers part of the PR." }
                    }
                }
            }),
            json!({
                "name": "add_review_comment",
                "description": format!(
                    "Save one draft review comment on {pr}. This is the ONLY way to record a \
                     finding. The draft stays in santree and is invisible on GitHub until the \
                     human adds it to their review, so write it as the comment you'd want them to \
                     send. Line numbers are the diff's, on the side you name."
                ),
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["path", "line", "body"],
                    "properties": {
                        "path": { "type": "string", "description": "The changed file, exactly as the diff lists it." },
                        "line": { "type": "integer", "minimum": 1, "description": "The line to anchor to, or the LAST line of a range." },
                        "startLine": { "type": "integer", "minimum": 1, "description": "First line of a multi-line range; must be before 'line' and in the same hunk. Omit for a single-line comment." },
                        "side": { "type": "string", "enum": ["RIGHT", "LEFT"], "description": "RIGHT (default) numbers the new file, LEFT the old one." },
                        "body": { "type": "string", "description": "The comment, in Markdown." },
                        "suggestion": { "type": "string", "description": "Exact replacement text for the lines covered, without a fence. Only when you are certain it compiles and is complete; leave it out otherwise." }
                    }
                }
            }),
            json!({
                "name": "list_review_comments",
                "description": format!("Every draft currently saved on {pr}, with its id."),
                "inputSchema": { "type": "object", "additionalProperties": false, "properties": {} }
            }),
            json!({
                "name": "update_review_comment",
                "description": "Rewrite or re-anchor a draft you saved. Pass only what changes.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string" },
                        "body": { "type": "string" },
                        "suggestion": { "type": "string", "description": "An empty string removes the suggestion." },
                        "path": { "type": "string" },
                        "line": { "type": "integer", "minimum": 1 },
                        "startLine": { "type": ["integer", "null"], "minimum": 1 },
                        "side": { "type": "string", "enum": ["RIGHT", "LEFT"] }
                    }
                }
            }),
            json!({
                "name": "delete_review_comment",
                "description": "Drop a draft you saved, when it turned out not to be worth the human's time.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id"],
                    "properties": { "id": { "type": "string" } }
                }
            }),
        ]
    }

    fn call(&mut self, name: &str, args: &Value) -> Result<ToolReply, ToolError> {
        let args = args_object(args);
        match name {
            "set_review_brief" => self.set_brief(&args),
            "add_review_comment" => self.add_comment(&args),
            "list_review_comments" => self.list_comments(),
            "update_review_comment" => self.update_comment(&args),
            "delete_review_comment" => self.delete_comment(&args),
            _ => Err(ToolError::UnknownTool),
        }
    }
}

impl ReviewTools {
    fn set_brief(&self, args: &serde_json::Map<String, Value>) -> Result<ToolReply, ToolError> {
        let index = self.index()?;
        let summary = args
            .get("summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidParams("'summary' is required: what this PR changes.".into())
            })?
            .to_string();

        let brief = ReviewBrief {
            agent_kind: self.scope.agent_kind,
            summary,
            reading_order: parse_list::<ReadingStep>(args, "readingOrder")?,
            watch_outs: parse_list::<WatchOut>(args, "watchOuts")?,
            questions: parse_list::<String>(args, "questions")?
                .into_iter()
                .map(|q| q.trim().to_string())
                .filter(|q| !q.is_empty())
                .collect(),
            truncated: args
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            head_sha: self.scope.head_sha.clone(),
            generated_at_ms: crate::now_ms() as f64,
        };
        check_brief_paths(&index, &brief)?;
        let json = serde_json::to_string(&brief)
            .map_err(|e| ToolError::Failed(format!("couldn't store the brief: {e}")))?;

        self.with_db(async |conn| {
            sqlx::query(
                "INSERT INTO review_briefs (repo_slug, number, head_sha, brief, created_at, agent_kind) \
                 VALUES (?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(repo_slug, number) DO UPDATE SET \
                   head_sha = excluded.head_sha, \
                   brief = excluded.brief, \
                   created_at = excluded.created_at, \
                   agent_kind = excluded.agent_kind",
            )
            .bind(&self.scope.pr_repo)
            .bind(self.scope.number)
            .bind(&self.scope.head_sha)
            .bind(&json)
            .bind(crate::now_ms())
            .bind(self.scope.agent_kind.as_str())
            .execute(conn)
            .await
            .map_err(db_err)?;
            Ok(())
        })?;

        Ok(ToolReply {
            text: format!(
                "Brief saved for {}#{}. It's on screen beside the diff.",
                self.scope.pr_repo, self.scope.number
            ),
        })
    }

    fn add_comment(&self, args: &serde_json::Map<String, Value>) -> Result<ToolReply, ToolError> {
        let index = self.index()?;
        let line = number(args, "line")?.ok_or_else(|| {
            ToolError::InvalidParams("'line' is required: which line the comment is about.".into())
        })?;
        let anchor = resolve_anchor(
            &index,
            &text(args, "path").unwrap_or_default(),
            line,
            number(args, "startLine")?,
            side(args)?.unwrap_or(true),
        )?;
        let body = body_text(&text(args, "body").unwrap_or_default())?;
        let suggestion = suggestion_text(args, &anchor)?;

        let id = self.with_db(async |conn| {
            let (count,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM review_drafts WHERE pr_repo = ? AND pr_number = ?",
            )
            .bind(&self.scope.pr_repo)
            .bind(self.scope.number)
            .fetch_one(&mut *conn)
            .await
            .map_err(db_err)?;
            if count >= MAX_DRAFTS_PER_PR {
                return Err(ToolError::Failed(format!(
                    "This pull request already has {MAX_DRAFTS_PER_PR} drafts. Delete some before \
                     adding more."
                )));
            }
            let now = crate::now_ms();
            let (id,): (String,) = sqlx::query_as(
                "INSERT INTO review_drafts \
                   (id, pr_repo, pr_number, head_sha, path, line, start_line, on_right, body, \
                    suggestion, created_at, updated_at, agent_kind) \
                 VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 RETURNING id",
            )
            .bind(&self.scope.pr_repo)
            .bind(self.scope.number)
            .bind(&self.scope.head_sha)
            .bind(&anchor.path)
            .bind(anchor.line)
            .bind(anchor.start_line)
            .bind(anchor.on_right)
            .bind(&body)
            .bind(&suggestion)
            .bind(now)
            .bind(now)
            .bind(self.scope.agent_kind.as_str())
            .fetch_one(conn)
            .await
            .map_err(db_err)?;
            Ok(id)
        })?;

        Ok(ToolReply {
            text: format!(
                "Draft {id} saved on {}. It's a santree draft: only the human can see it, and \
                 nothing goes to GitHub until they add it to their review.",
                describe(&anchor)
            ),
        })
    }

    fn list_comments(&self) -> Result<ToolReply, ToolError> {
        let rows = self.with_db(async |conn| {
            let rows: Vec<DraftRow> = sqlx::query_as(
                "SELECT id, path, line, start_line, on_right, body, suggestion, head_sha \
                 FROM review_drafts WHERE pr_repo = ? AND pr_number = ? \
                 ORDER BY path, line, created_at",
            )
            .bind(&self.scope.pr_repo)
            .bind(self.scope.number)
            .fetch_all(conn)
            .await
            .map_err(db_err)?;
            Ok(rows
                .into_iter()
                .map(
                    |(id, path, line, start_line, on_right, body, suggestion, head)| {
                        json!({
                            "id": id,
                            "path": path,
                            "line": line,
                            "startLine": start_line,
                            "side": if on_right { "RIGHT" } else { "LEFT" },
                            "body": body,
                            "suggestion": suggestion,
                            // Written against a head that has since moved: its line
                            // numbers describe code that isn't there any more, and
                            // santree refuses to publish it.
                            "stale": head != self.scope.head_sha,
                        })
                    },
                )
                .collect::<Vec<_>>())
        })?;

        if rows.is_empty() {
            return Ok(ToolReply {
                text: "No drafts saved yet on this pull request.".into(),
            });
        }
        Ok(ToolReply {
            text: serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".into()),
        })
    }

    fn update_comment(
        &self,
        args: &serde_json::Map<String, Value>,
    ) -> Result<ToolReply, ToolError> {
        let id = required_id(args)?;
        let index = self.index()?;

        // Re-anchoring is optional, so the stored row is the starting point: an
        // update that only rewrites the body must not move the comment.
        let (cur_path, cur_line, cur_start, cur_right, cur_body, cur_suggestion) =
            self.with_db(async |conn| {
                let row: Option<EditableRow> = sqlx::query_as(
                    "SELECT path, line, start_line, on_right, body, suggestion \
                         FROM review_drafts WHERE id = ? AND pr_repo = ? AND pr_number = ?",
                )
                .bind(&id)
                .bind(&self.scope.pr_repo)
                .bind(self.scope.number)
                .fetch_optional(conn)
                .await
                .map_err(db_err)?;
                row.ok_or_else(|| ToolError::Failed(no_such_draft(&id)))
            })?;

        let anchor = resolve_anchor(
            &index,
            &text(args, "path").unwrap_or(cur_path),
            number(args, "line")?.unwrap_or(cur_line as u32),
            match args.get("startLine") {
                // An explicit null narrows a range back to a single line.
                Some(Value::Null) => None,
                Some(_) => number(args, "startLine")?,
                None => cur_start.map(|s| s as u32),
            },
            side(args)?.unwrap_or(cur_right),
        )?;
        let body = match text(args, "body") {
            Some(b) => body_text(&b)?,
            None => cur_body,
        };
        let suggestion = match args.get("suggestion") {
            None => cur_suggestion,
            Some(_) => suggestion_text(args, &anchor)?,
        };

        self.with_db(async |conn| {
            sqlx::query(
                "UPDATE review_drafts SET path = ?, line = ?, start_line = ?, on_right = ?, \
                   body = ?, suggestion = ?, updated_at = ? \
                 WHERE id = ? AND pr_repo = ? AND pr_number = ?",
            )
            .bind(&anchor.path)
            .bind(anchor.line)
            .bind(anchor.start_line)
            .bind(anchor.on_right)
            .bind(&body)
            .bind(&suggestion)
            .bind(crate::now_ms())
            .bind(&id)
            .bind(&self.scope.pr_repo)
            .bind(self.scope.number)
            .execute(conn)
            .await
            .map_err(db_err)?;
            Ok(())
        })?;

        Ok(ToolReply {
            text: format!("Draft updated, now on {}.", describe(&anchor)),
        })
    }

    fn delete_comment(
        &self,
        args: &serde_json::Map<String, Value>,
    ) -> Result<ToolReply, ToolError> {
        let id = required_id(args)?;
        self.with_db(async |conn| {
            let done = sqlx::query(
                "DELETE FROM review_drafts WHERE id = ? AND pr_repo = ? AND pr_number = ?",
            )
            .bind(&id)
            .bind(&self.scope.pr_repo)
            .bind(self.scope.number)
            .execute(conn)
            .await
            .map_err(db_err)?;
            if done.rows_affected() == 0 {
                return Err(ToolError::Failed(no_such_draft(&id)));
            }
            Ok(())
        })?;
        Ok(ToolReply {
            text: format!("Draft {id} deleted."),
        })
    }
}

fn required_id(args: &serde_json::Map<String, Value>) -> Result<String, ToolError> {
    text(args, "id")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ToolError::InvalidParams(
                "'id' is required. Call list_review_comments to see the drafts and their ids."
                    .into(),
            )
        })
}

fn no_such_draft(id: &str) -> String {
    format!(
        "There's no draft '{id}' on this pull request. Call list_review_comments for the current ids."
    )
}

/// One draft as `update_review_comment` needs it: the fields an edit can change.
type EditableRow = (String, i64, Option<i64>, bool, String, Option<String>);

/// One draft as `list_review_comments` reports it.
type DraftRow = (
    String,
    String,
    i64,
    Option<i64>,
    bool,
    String,
    Option<String>,
    String,
);

fn db_err(e: sqlx::Error) -> ToolError {
    ToolError::Failed(format!("santree's database refused the write: {e}"))
}

/// `src/a.rs:12` or `src/a.rs:12-18 (LEFT)` — how a draft is named back to the model.
fn describe(a: &Anchor) -> String {
    let lines = match a.start_line {
        Some(start) => format!("{start}-{}", a.line),
        None => a.line.to_string(),
    };
    if a.on_right {
        format!("{}:{lines}", a.path)
    } else {
        format!("{}:{lines} (LEFT)", a.path)
    }
}

/// A suggestion, or `None` when it's absent or explicitly cleared with `""`.
fn suggestion_text(
    args: &serde_json::Map<String, Value>,
    anchor: &Anchor,
) -> Result<Option<String>, ToolError> {
    let Some(raw) = text(args, "suggestion") else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > MAX_TEXT_BYTES {
        return Err(ToolError::InvalidParams(
            "'suggestion' is too long. Suggest the lines that change, not the whole file.".into(),
        ));
    }
    if !anchor.on_right {
        return Err(ToolError::InvalidParams(
            "A suggestion replaces lines in the new file, so it can only go on a RIGHT-side \
             comment. Anchor it to the new line, or drop the suggestion and describe the change."
                .into(),
        ));
    }
    Ok(Some(raw))
}

/// Read one of the brief's lists, turning a shape mismatch into a message that
/// names the field and the values that would work.
fn parse_list<T: serde::de::DeserializeOwned>(
    args: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<T>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| {
            ToolError::InvalidParams(format!(
                "'{key}' isn't the expected shape: {e}. Check the tool's schema — 'role' is one of \
                 entryPoint, coreLogic, test, config, generated, trivial; 'kind' is one of \
                 correctness, security, performance, testing, style, question."
            ))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use santree_core::diff_index::{DiffFileIndex, DiffIndex};

    fn index() -> DiffIndex {
        DiffIndex {
            head_sha: "abc1234".into(),
            files_truncated: false,
            files: vec![DiffFileIndex {
                path: "src/a.rs".into(),
                old: vec![[40, 52]],
                new: vec![[40, 52], [80, 85]],
            }],
        }
    }

    fn msg(e: ToolError) -> String {
        match e {
            ToolError::InvalidParams(m) | ToolError::Failed(m) => m,
            ToolError::UnknownTool => "unknown tool".into(),
        }
    }

    #[test]
    fn a_path_is_checked_like_a_path_even_though_we_never_open_it() {
        assert!(validate_path("src/a.rs").is_ok());
        assert!(validate_path("  src/a.rs  ").unwrap() == "src/a.rs");
        for bad in ["", "/etc/passwd", "../secrets", "a/./b", "a//b", "a\\b"] {
            assert!(validate_path(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn a_valid_anchor_survives_and_a_pointless_range_collapses() {
        let a = resolve_anchor(&index(), "src/a.rs", 44, Some(41), true).unwrap();
        assert_eq!(a.start_line, Some(41));
        // start == line is a single-line comment, and GitHub 422s on it as a range.
        let a = resolve_anchor(&index(), "src/a.rs", 44, Some(44), true).unwrap();
        assert_eq!(a.start_line, None);
    }

    #[test]
    fn a_backwards_range_is_named_before_the_diff_is_consulted() {
        let e = msg(resolve_anchor(&index(), "src/a.rs", 41, Some(44), true).unwrap_err());
        assert!(e.contains("must come before"), "{e}");
    }

    #[test]
    fn an_anchor_outside_the_diff_says_what_would_work() {
        let e = msg(resolve_anchor(&index(), "src/a.rs", 70, None, true).unwrap_err());
        assert!(e.contains("40-52, 80-85"), "{e}");
        let e = msg(resolve_anchor(&index(), "src/b.rs", 1, None, true).unwrap_err());
        assert!(e.contains("isn't a changed file"), "{e}");
        let e = msg(resolve_anchor(&index(), "src/a.rs", 82, Some(50), true).unwrap_err());
        assert!(e.contains("cross a gap"), "{e}");
    }

    #[test]
    fn a_suggestion_only_makes_sense_on_the_new_file() {
        let right = Anchor {
            path: "src/a.rs".into(),
            line: 44,
            start_line: None,
            on_right: true,
        };
        let left = Anchor {
            on_right: false,
            ..right.clone()
        };
        let args: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "suggestion": "let x = 1;" })).unwrap();
        assert_eq!(
            suggestion_text(&args, &right).unwrap(),
            Some("let x = 1;".into())
        );
        let e = msg(suggestion_text(&args, &left).unwrap_err());
        assert!(e.contains("RIGHT-side"), "{e}");
        // An empty string is how the model clears one.
        let empty: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "suggestion": "" })).unwrap();
        assert_eq!(suggestion_text(&empty, &right).unwrap(), None);
    }

    #[test]
    fn a_brief_may_not_point_at_files_the_pr_does_not_touch() {
        let brief = ReviewBrief {
            agent_kind: santree_core::domain::AgentKind::Claude,
            summary: "s".into(),
            reading_order: vec![ReadingStep {
                path: "src/ghost.rs".into(),
                role: santree_core::domain::ReadingRole::CoreLogic,
                why: "w".into(),
            }],
            watch_outs: vec![],
            questions: vec![],
            truncated: false,
            head_sha: "abc1234".into(),
            generated_at_ms: 0.0,
        };
        let e = msg(check_brief_paths(&index(), &brief).unwrap_err());
        assert!(e.contains("src/ghost.rs"), "{e}");
    }

    #[test]
    fn a_bad_enum_value_lists_the_ones_that_work() {
        let args: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "readingOrder": [{ "path": "a", "role": "wibble", "why": "w" }]
        }))
        .unwrap();
        let e = msg(parse_list::<ReadingStep>(&args, "readingOrder").unwrap_err());
        assert!(e.contains("entryPoint"), "{e}");
    }

    #[test]
    fn side_and_line_arguments_are_read_leniently_but_not_loosely() {
        let args: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "side": "left", "line": 4 })).unwrap();
        assert_eq!(side(&args).unwrap(), Some(false));
        assert_eq!(number(&args, "line").unwrap(), Some(4));
        let bad: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "side": "middle", "line": 0 })).unwrap();
        assert!(side(&bad).is_err());
        assert!(number(&bad, "line").is_err());
    }

    // ── Against a real database ──────────────────────────────────────────────

    /// A temp db with just the two tables these tools touch (mirrors migrations
    /// 0019 and 0023), plus a `ReviewTools` scoped to one PR.
    fn tools(name: &str) -> (ReviewTools, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "santree-review-tools-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");
        let diff_path = base.join("diff.json");
        std::fs::write(&diff_path, serde_json::to_string(&index()).unwrap()).unwrap();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            for ddl in [
                "CREATE TABLE review_briefs (repo_slug TEXT NOT NULL, number INTEGER NOT NULL, \
                 head_sha TEXT NOT NULL, brief TEXT NOT NULL, created_at INTEGER NOT NULL, \
                 agent_kind TEXT NOT NULL DEFAULT 'Claude', \
                 PRIMARY KEY (repo_slug, number))",
                "CREATE TABLE review_drafts (id TEXT NOT NULL PRIMARY KEY, pr_repo TEXT NOT NULL, \
                 pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, path TEXT NOT NULL, \
                 line INTEGER NOT NULL, start_line INTEGER, on_right INTEGER NOT NULL DEFAULT 1, \
                 body TEXT NOT NULL, suggestion TEXT, created_at INTEGER NOT NULL, \
                 updated_at INTEGER NOT NULL, agent_kind TEXT NOT NULL DEFAULT 'Claude')",
            ] {
                sqlx::query(ddl).execute(&mut c).await.unwrap();
            }
            c.close().await.unwrap();
        });

        let scope = McpScope::new(
            "acme/web".into(),
            "42".into(),
            "abc1234".into(),
            diff_path.to_string_lossy().into_owned(),
        )
        .unwrap();
        (
            ReviewTools::new(rt, db_path.to_string_lossy().into_owned(), scope),
            base,
        )
    }

    fn call(t: &mut ReviewTools, name: &str, args: Value) -> Result<String, String> {
        t.call(name, &args).map(|r| r.text).map_err(msg)
    }

    fn ids(t: &mut ReviewTools) -> Vec<String> {
        let text = call(t, "list_review_comments", json!({})).unwrap();
        let parsed: Value = serde_json::from_str(&text).unwrap_or(json!([]));
        parsed
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|d| d["id"].as_str().unwrap().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn a_draft_round_trips_through_add_list_update_and_delete() {
        let (mut t, _dir) = tools("round-trip");
        assert!(call(&mut t, "list_review_comments", json!({}))
            .unwrap()
            .contains("No drafts"));

        let saved = call(
            &mut t,
            "add_review_comment",
            json!({ "path": "src/a.rs", "line": 44, "startLine": 41, "body": "  this leaks  " }),
        )
        .unwrap();
        assert!(saved.contains("src/a.rs:41-44"), "{saved}");
        // The reply has to say the draft is not on GitHub, or the model will
        // believe it has commented.
        assert!(saved.contains("nothing goes to GitHub"), "{saved}");

        let listed = call(&mut t, "list_review_comments", json!({})).unwrap();
        let rows: Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(rows[0]["body"], "this leaks");
        assert_eq!(rows[0]["startLine"], 41);
        assert_eq!(rows[0]["side"], "RIGHT");
        assert_eq!(rows[0]["stale"], false);

        let id = rows[0]["id"].as_str().unwrap().to_string();
        call(
            &mut t,
            "update_review_comment",
            json!({ "id": id, "body": "rewritten", "line": 82, "startLine": null }),
        )
        .unwrap();
        let rows: Value =
            serde_json::from_str(&call(&mut t, "list_review_comments", json!({})).unwrap())
                .unwrap();
        assert_eq!(rows[0]["body"], "rewritten");
        assert_eq!(rows[0]["line"], 82);
        assert_eq!(rows[0]["startLine"], Value::Null);

        call(&mut t, "delete_review_comment", json!({ "id": id })).unwrap();
        assert!(ids(&mut t).is_empty());
    }

    #[test]
    fn an_update_that_only_rewrites_the_body_leaves_the_anchor_alone() {
        let (mut t, _dir) = tools("partial-update");
        call(
            &mut t,
            "add_review_comment",
            json!({ "path": "src/a.rs", "line": 44, "startLine": 41, "side": "LEFT", "body": "b" }),
        )
        .unwrap();
        let id = ids(&mut t)[0].clone();
        call(
            &mut t,
            "update_review_comment",
            json!({ "id": id, "body": "b2" }),
        )
        .unwrap();
        let rows: Value =
            serde_json::from_str(&call(&mut t, "list_review_comments", json!({})).unwrap())
                .unwrap();
        assert_eq!(rows[0]["line"], 44);
        assert_eq!(rows[0]["startLine"], 41);
        assert_eq!(rows[0]["side"], "LEFT");
    }

    #[test]
    fn nothing_is_stored_when_the_anchor_does_not_exist() {
        let (mut t, _dir) = tools("bad-anchor");
        for args in [
            json!({ "path": "src/ghost.rs", "line": 44, "body": "b" }),
            json!({ "path": "src/a.rs", "line": 70, "body": "b" }),
            json!({ "path": "src/a.rs", "line": 82, "startLine": 50, "body": "b" }),
            json!({ "path": "src/a.rs", "line": 44, "body": "   " }),
            json!({ "path": "src/a.rs", "line": 44, "side": "LEFT", "body": "b", "suggestion": "x" }),
        ] {
            assert!(
                call(&mut t, "add_review_comment", args.clone()).is_err(),
                "{args}"
            );
        }
        assert!(ids(&mut t).is_empty(), "a refused call must save nothing");
    }

    #[test]
    fn a_draft_on_another_pull_request_cannot_be_touched() {
        // The scope is argv, so the only way to reach a foreign row is by id — and
        // every statement carries the PR, so it misses.
        let (mut t, _dir) = tools("scoped");
        call(
            &mut t,
            "add_review_comment",
            json!({ "path": "src/a.rs", "line": 44, "body": "b" }),
        )
        .unwrap();
        let id = ids(&mut t)[0].clone();
        t.scope.number = 99;
        assert!(call(
            &mut t,
            "update_review_comment",
            json!({ "id": id, "body": "x" })
        )
        .is_err());
        assert!(call(&mut t, "delete_review_comment", json!({ "id": id })).is_err());
        t.scope.number = 42;
        assert_eq!(ids(&mut t).len(), 1, "the original row is untouched");
    }

    #[test]
    fn a_draft_written_against_an_older_head_is_listed_as_stale() {
        let (mut t, _dir) = tools("stale");
        call(
            &mut t,
            "add_review_comment",
            json!({ "path": "src/a.rs", "line": 44, "body": "b" }),
        )
        .unwrap();
        // A push: the session is relaunched with the new head.
        t.scope.head_sha = "def5678".into();
        let rows: Value =
            serde_json::from_str(&call(&mut t, "list_review_comments", json!({})).unwrap())
                .unwrap();
        assert_eq!(rows[0]["stale"], true);
    }

    #[test]
    fn the_brief_is_replaced_rather_than_stacked_and_checks_its_paths() {
        let (mut t, _dir) = tools("brief");
        let good = json!({
            "summary": "Adds retries.",
            "readingOrder": [{ "path": "src/a.rs", "role": "coreLogic", "why": "the change" }],
            "watchOuts": [{ "path": "src/a.rs", "line": 44, "kind": "security", "note": "unvalidated" }],
            "questions": ["Why three?", "   "]
        });
        assert!(call(&mut t, "set_review_brief", good.clone())
            .unwrap()
            .contains("Brief saved"));

        let mut bad = good.clone();
        bad["readingOrder"][0]["path"] = json!("src/ghost.rs");
        assert!(call(&mut t, "set_review_brief", bad).is_err());

        let mut second = good;
        second["summary"] = json!("Adds retries and a test.");
        call(&mut t, "set_review_brief", second).unwrap();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let db_path = t.db_path.clone();
        let (count, stored): (i64, String) = rt.block_on(async move {
            let mut c = SqliteConnectOptions::new()
                .filename(&db_path)
                .connect()
                .await
                .unwrap();
            let row: (i64, String) =
                sqlx::query_as("SELECT COUNT(*), MAX(brief) FROM review_briefs")
                    .fetch_one(&mut c)
                    .await
                    .unwrap();
            c.close().await.unwrap();
            row
        });
        assert_eq!(count, 1, "a second brief replaces the first");
        let brief: ReviewBrief = serde_json::from_str(&stored).unwrap();
        assert_eq!(brief.summary, "Adds retries and a test.");
        assert_eq!(brief.head_sha, "abc1234");
        // Blank questions are dropped rather than rendered as empty rows.
        assert_eq!(brief.questions, vec!["Why three?"]);
    }

    #[test]
    fn a_missing_database_is_reported_and_never_created() {
        let (mut t, dir) = tools("no-db");
        std::fs::remove_file(dir.join("santree.db")).unwrap();
        let e = call(
            &mut t,
            "add_review_comment",
            json!({ "path": "src/a.rs", "line": 44, "body": "b" }),
        )
        .unwrap_err();
        assert!(e.contains("isn't reachable"), "{e}");
        assert!(e.contains("Nothing was saved"), "{e}");
        assert!(
            !dir.join("santree.db").exists(),
            "must never create the app's db"
        );
    }

    #[test]
    fn an_unreadable_diff_index_fails_loudly_rather_than_waving_the_anchor_through() {
        let (mut t, _dir) = tools("no-index");
        t.scope.diff_index = std::path::PathBuf::from("/nope/diff.json");
        let e = call(
            &mut t,
            "add_review_comment",
            json!({ "path": "src/a.rs", "line": 44, "body": "b" }),
        )
        .unwrap_err();
        assert!(e.contains("diff index isn't readable"), "{e}");
    }

    #[test]
    fn an_unknown_tool_name_is_refused() {
        let (mut t, _dir) = tools("unknown");
        assert!(matches!(
            t.call("post_to_github", &json!({})),
            Err(ToolError::UnknownTool)
        ));
    }

    #[test]
    fn describe_names_the_range_and_the_side() {
        let a = Anchor {
            path: "src/a.rs".into(),
            line: 18,
            start_line: Some(12),
            on_right: true,
        };
        assert_eq!(describe(&a), "src/a.rs:12-18");
        assert_eq!(
            describe(&Anchor {
                start_line: None,
                on_right: false,
                ..a
            }),
            "src/a.rs:18 (LEFT)"
        );
    }
}
