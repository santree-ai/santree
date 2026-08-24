-- AI-authored draft review comments for the Reviews tab ("santree drafts").
--
-- Written ONLY by the `santree-review` MCP server (crates/hook, `mcp` mode) that
-- an AI-review session runs with; the app never inserts here, it only edits,
-- deletes and publishes. Nothing in this table is visible on GitHub: the user
-- reviews the drafts in the diff and explicitly adds the ones they keep to their
-- own pending review, which deletes the row. That is the whole point — a review
-- goes out under the user's name, so the user decides what it says.
--
-- `suggestion` is the exact replacement for the covered lines, kept apart from
-- `body` so the UI can edit the two independently; the ```suggestion fence is
-- composed once, at publish time (review_drafts::compose_body). `on_right` names
-- the side (GitHub's RIGHT = the new file) and `line`/`start_line` are numbered
-- within it, exactly like NewInlineComment. `head_sha` is the head the draft was
-- written against, so a draft left behind by a later push can be flagged instead
-- of silently anchoring to the wrong code.
--
-- Bounded three ways: publishing deletes rows, the MCP server caps drafts per PR,
-- and a startup sweep drops PRs untouched for 30 days (review_drafts::gc).
CREATE TABLE review_drafts (
    id          TEXT    NOT NULL PRIMARY KEY,
    pr_repo     TEXT    NOT NULL,
    pr_number   INTEGER NOT NULL,
    head_sha    TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    line        INTEGER NOT NULL CHECK (line >= 1),
    start_line  INTEGER          CHECK (start_line IS NULL OR start_line < line),
    on_right    INTEGER NOT NULL DEFAULT 1 CHECK (on_right IN (0, 1)),
    body        TEXT    NOT NULL,
    suggestion  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX review_drafts_pr ON review_drafts (pr_repo, pr_number);
