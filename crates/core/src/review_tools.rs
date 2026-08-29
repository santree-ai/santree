//! The names of the review MCP server's tools, in one place.
//!
//! Two processes have to agree on this list and they are built from different
//! crates: `crates/hook` implements the tools, and `src-tauri` names them in the
//! allowlist it hands Codex. Codex's review thread runs `approvalPolicy = never`,
//! so a tool missing from that allowlist is not merely un-approved — it is
//! *rejected*, silently, at the moment the model tries to use it.
//!
//! That drift already happened once: the two work-item tools were added to the
//! server and never to the allowlist, so on Codex the review could not complete a
//! work item its own prompt told it to complete, and nothing said why. One
//! canonical list plus a test on each side is what stops the third process from
//! repeating it.

/// Every tool the `santree-review` MCP server exposes.
///
/// Adding one here is not enough to make it usable — see the module note: it must
/// also be reachable from the server's dispatch, and both sides have tests that
/// fail when this list and their own view of it disagree.
pub const REVIEW_TOOL_NAMES: [&str; 7] = [
    "set_review_brief",
    "add_review_comment",
    "list_review_comments",
    "update_review_comment",
    "delete_review_comment",
    "list_review_work_items",
    "complete_review_work_item",
];
