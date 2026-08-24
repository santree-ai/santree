//! What an AI-review session is allowed to anchor a comment to.
//!
//! The `santree-review` MCP server ([`crates/hook`](../../hook)) runs as its own
//! process with no network and no GitHub token, so it cannot ask GitHub whether a
//! line is commentable. Instead the app writes this index beside the server's
//! config at launch — one entry per changed file, holding the hunk spans on each
//! side — and passes its path in argv.
//!
//! Validating there rather than at publish time is the point: a model that names a
//! line outside the diff gets told so **while it is still writing**, with the
//! ranges that would work, and retries. The alternative is a draft that looks fine
//! for an hour and then 422s under the user's name.
//!
//! Every line inside a hunk is commentable on GitHub, context included; what isn't
//! allowed is a line outside every hunk, or a range that spans the gap between two.
//! That mirrors the frontend's `patchLines.ts` (`hunkRanges` / `clampToHunk`),
//! which enforces the same rule for the diff's own gutter drag.

use serde::{Deserialize, Serialize};

/// How many file names / ranges a rejection message lists before it stops. Long
/// enough to be useful, short enough that the model reads it.
const LIST_CAP: usize = 12;

/// An inclusive `[start, end]` line span, in one side's numbering.
pub type Span = [u32; 2];

/// The commentable geometry of a PR, as of one head commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffIndex {
    pub head_sha: String,
    /// GitHub's file list was capped, so an unknown path may still be a real file
    /// of this PR. Said out loud in the rejection rather than asserted away.
    pub files_truncated: bool,
    pub files: Vec<DiffFileIndex>,
}

/// One changed file's hunk spans. Both lists are empty for a binary file (no
/// textual diff to anchor to).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileIndex {
    pub path: String,
    /// Spans in the **old** file's numbering (GitHub's LEFT).
    pub old: Vec<Span>,
    /// Spans in the **new** file's numbering (GitHub's RIGHT).
    pub new: Vec<Span>,
}

/// Read the hunk spans out of a unified-diff patch, as `(old, new)`.
///
/// Only the `@@ -a,b +c,d @@` headers matter: every line of a hunk exists on a
/// side unless that side's count is zero (a pure addition has `-0,0`), so the
/// header alone gives the exact commentable range. An omitted count means 1,
/// which is the format's own default.
pub fn hunk_spans(patch: &str) -> (Vec<Span>, Vec<Span>) {
    let mut old = Vec::new();
    let mut new = Vec::new();
    for line in patch.lines() {
        let Some(rest) = line.strip_prefix("@@ ") else {
            continue;
        };
        // "-a,b +c,d @@ …" — take the two ranges and ignore the section heading.
        let Some((ranges, _)) = rest.split_once("@@") else {
            continue;
        };
        let mut parts = ranges.split_whitespace();
        let (Some(o), Some(n)) = (parts.next(), parts.next()) else {
            continue;
        };
        if let Some(span) = parse_range(o.strip_prefix('-').unwrap_or(o)) {
            old.push(span);
        }
        if let Some(span) = parse_range(n.strip_prefix('+').unwrap_or(n)) {
            new.push(span);
        }
    }
    (old, new)
}

/// `"12,5"` → `[12, 16]`, `"12"` → `[12, 12]`. `None` when the count is zero (the
/// side contributes no lines to this hunk) or the numbers don't parse.
fn parse_range(s: &str) -> Option<Span> {
    let (start, count) = match s.split_once(',') {
        Some((a, b)) => (a.parse::<u32>().ok()?, b.parse::<u32>().ok()?),
        None => (s.parse::<u32>().ok()?, 1),
    };
    if count == 0 {
        return None;
    }
    Some([start, start + count - 1])
}

impl DiffIndex {
    pub fn file(&self, path: &str) -> Option<&DiffFileIndex> {
        self.files.iter().find(|f| f.path == path)
    }

    /// Whether a comment can anchor here, or a message written **for the model**:
    /// what was wrong and what would have worked, so the next call is right.
    ///
    /// `start_line` is the first line of a range and `line` its last; `None` is the
    /// ordinary single-line comment.
    pub fn check_anchor(
        &self,
        path: &str,
        on_right: bool,
        start_line: Option<u32>,
        line: u32,
    ) -> Result<(), String> {
        let side = if on_right { "RIGHT" } else { "LEFT" };
        let Some(file) = self.file(path) else {
            let mut msg = format!("'{path}' isn't a changed file in this pull request.");
            if self.files_truncated {
                msg.push_str(
                    " The PR's file list was capped, so it may exist but can't be checked here.",
                );
            }
            msg.push_str(&format!(" Changed files: {}", self.file_list()));
            return Err(msg);
        };
        let spans = if on_right { &file.new } else { &file.old };
        if spans.is_empty() {
            return Err(format!(
                "'{path}' has no textual diff on the {side} side, so nothing there can be commented on. \
                 A binary file, or a file with no lines on that side."
            ));
        }

        let start = start_line.unwrap_or(line);
        let Some(hunk) = spans.iter().find(|s| start >= s[0] && start <= s[1]) else {
            return Err(format!(
                "Line {start} of '{path}' isn't in the diff on the {side} side. \
                 Commentable ranges there: {}.",
                render_spans(spans)
            ));
        };
        if line < hunk[0] || line > hunk[1] {
            return Err(format!(
                "Lines {start}-{line} of '{path}' cross a gap between hunks (this one covers {}-{}). \
                 GitHub can't anchor a comment across unchanged code that isn't in the diff, \
                 so keep the range inside one hunk. Commentable ranges: {}.",
                hunk[0],
                hunk[1],
                render_spans(spans)
            ));
        }
        Ok(())
    }

    /// The changed paths, for a rejection message. Capped: a 400-file PR would
    /// otherwise bury the actual reason.
    fn file_list(&self) -> String {
        let shown: Vec<&str> = self
            .files
            .iter()
            .take(LIST_CAP)
            .map(|f| f.path.as_str())
            .collect();
        let mut out = shown.join(", ");
        if self.files.len() > LIST_CAP {
            out.push_str(&format!(", and {} more", self.files.len() - LIST_CAP));
        }
        if out.is_empty() {
            out.push_str("(none)");
        }
        out
    }
}

fn render_spans(spans: &[Span]) -> String {
    let mut out = spans
        .iter()
        .take(LIST_CAP)
        .map(|s| {
            if s[0] == s[1] {
                s[0].to_string()
            } else {
                format!("{}-{}", s[0], s[1])
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    if spans.len() > LIST_CAP {
        out.push_str(&format!(", and {} more", spans.len() - LIST_CAP));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two hunks, one of them a pure addition (no old-side lines).
    const PATCH: &str =
        "@@ -40,13 +40,13 @@ fn a() {\n ctx\n-old\n+new\n@@ -0,0 +80,6 @@ fn b() {\n+added\n";

    fn index() -> DiffIndex {
        let (old, new) = hunk_spans(PATCH);
        DiffIndex {
            head_sha: "abc1234".into(),
            files_truncated: false,
            files: vec![
                DiffFileIndex {
                    path: "src/a.rs".into(),
                    old,
                    new,
                },
                DiffFileIndex {
                    path: "logo.png".into(),
                    old: vec![],
                    new: vec![],
                },
            ],
        }
    }

    #[test]
    fn hunk_spans_reads_both_sides() {
        let (old, new) = hunk_spans(PATCH);
        // The second hunk is `-0,0`: nothing on the old side, so no span for it.
        assert_eq!(old, vec![[40, 52]]);
        assert_eq!(new, vec![[40, 52], [80, 85]]);
    }

    #[test]
    fn hunk_spans_defaults_an_omitted_count_to_one() {
        let (old, new) = hunk_spans("@@ -7 +7 @@\n-a\n+b\n");
        assert_eq!(old, vec![[7, 7]]);
        assert_eq!(new, vec![[7, 7]]);
    }

    #[test]
    fn hunk_spans_ignores_body_lines_that_look_like_headers() {
        // A diff of a diff: a body line can start with "@@" but never with "@@ "
        // at the start of the *line* after the leading +/- marker.
        let (_, new) = hunk_spans("@@ -1,2 +1,2 @@\n+@@ -9,9 +9,9 @@\n ctx\n");
        assert_eq!(new, vec![[1, 2]]);
    }

    #[test]
    fn a_line_inside_a_hunk_is_fine_on_either_side() {
        let idx = index();
        assert!(idx.check_anchor("src/a.rs", true, None, 44).is_ok());
        assert!(idx.check_anchor("src/a.rs", false, None, 44).is_ok());
        assert!(idx.check_anchor("src/a.rs", true, Some(41), 44).is_ok());
        // A single-line comment on the added-only hunk.
        assert!(idx.check_anchor("src/a.rs", true, None, 82).is_ok());
    }

    #[test]
    fn an_unknown_path_names_the_files_that_do_exist() {
        let err = index()
            .check_anchor("src/nope.rs", true, None, 1)
            .unwrap_err();
        assert!(err.contains("isn't a changed file"), "{err}");
        assert!(err.contains("src/a.rs"), "{err}");
    }

    #[test]
    fn a_truncated_file_list_says_so_rather_than_asserting() {
        let mut idx = index();
        idx.files_truncated = true;
        let err = idx.check_anchor("src/nope.rs", true, None, 1).unwrap_err();
        assert!(err.contains("capped"), "{err}");
    }

    #[test]
    fn a_binary_file_has_nothing_to_anchor_to() {
        let err = index().check_anchor("logo.png", true, None, 1).unwrap_err();
        assert!(err.contains("no textual diff"), "{err}");
    }

    #[test]
    fn a_line_outside_every_hunk_lists_the_ranges_that_work() {
        let err = index()
            .check_anchor("src/a.rs", true, None, 70)
            .unwrap_err();
        assert!(err.contains("isn't in the diff"), "{err}");
        assert!(err.contains("40-52, 80-85"), "{err}");
    }

    #[test]
    fn the_old_side_of_an_addition_only_hunk_is_rejected() {
        // Line 82 exists on the RIGHT (it was added) but the LEFT has no such hunk.
        let err = index()
            .check_anchor("src/a.rs", false, None, 82)
            .unwrap_err();
        assert!(err.contains("LEFT"), "{err}");
    }

    #[test]
    fn a_range_may_not_cross_the_gap_between_hunks() {
        let err = index()
            .check_anchor("src/a.rs", true, Some(50), 82)
            .unwrap_err();
        assert!(err.contains("cross a gap"), "{err}");
        // It must say which hunk the start landed in, or the retry is a guess.
        assert!(err.contains("40-52"), "{err}");
    }
}
