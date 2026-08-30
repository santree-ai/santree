-- Give a review tab an identity it can relaunch from.
--
-- A "Fix CI"/"AI review" tab launches with the review deny list and santree's
-- review MCP server, but both paths lived only in the frontend's in-memory
-- hand-off. After a restart the tab resumed from the persisted row alone and fell
-- back to the plain no-git settings: no `gh` deny rules, and no MCP server — so
-- the resumed review lost its entire output channel with no error anywhere.
--
-- The fix is to store what the configuration is *derived from*, never the derived
-- paths (a stored path is environment-dependent and goes stale on its own):
--   * `kind` gains 'ai_review', so the AI review is distinguishable from the
--     guarded "Address review" session that shares the 'fixci' value.
--   * `pr_repo` / `pr_number` pin the pull request, which is what names the MCP
--     config file (`review-<sha256(owner/name#number)>.mcp.json`).
--
-- SQLite cannot alter a CHECK constraint in place, so the table is recreated and
-- the rows copied across. 0024 is NOT edited or deleted: sqlx checksums every
-- applied migration and refuses to open a database whose stored checksum no longer
-- matches, and it also fails against a database recording an applied version the
-- resolved set no longer contains (which is why 0017_dev_todos is still on disk).
--
-- Nothing references worktree_tabs by foreign key, so the drop/rename is safe. The
-- copy revalidates every row against the new CHECKs: `kind` is a strict superset of
-- the old one, and the two new columns are NULL for every existing row, which the
-- pairing CHECK allows.
CREATE TABLE worktree_tabs_new (
    id          TEXT NOT NULL PRIMARY KEY,
    repo        TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('agent', 'terminal', 'fixci', 'ai_review')),
    agent_kind  TEXT CHECK (agent_kind IN ('Claude', 'Codex', 'Cursor', 'Opencode')),
    title       TEXT NOT NULL,
    position    INTEGER NOT NULL,
    pr_repo     TEXT,
    pr_number   INTEGER CHECK (pr_number IS NULL OR pr_number > 0),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((kind = 'terminal' AND agent_kind IS NULL) OR
           (kind != 'terminal' AND agent_kind IS NOT NULL)),
    -- Half a PR identity derives the wrong file (or none), so the pair is stored
    -- together or not at all.
    CHECK ((pr_repo IS NULL) = (pr_number IS NULL)),
    -- Only the review kinds have anything to derive from it. Rows written before
    -- this migration are all NULL, so "a review tab must carry one" can only be
    -- enforced in Rust, on the way in.
    CHECK (pr_repo IS NULL OR kind IN ('fixci', 'ai_review'))
);

INSERT INTO worktree_tabs_new
    (id, repo, worktree_id, kind, agent_kind, title, position, created_at)
    SELECT id, repo, worktree_id, kind, agent_kind, title, position, created_at
      FROM worktree_tabs;

DROP TABLE worktree_tabs;
ALTER TABLE worktree_tabs_new RENAME TO worktree_tabs;

-- Recreated by hand: DROP TABLE takes a table's indexes with it, and RENAME TO does
-- not bring them back. This is the table's only index, and `tabs::list` reads
-- straight through it (`WHERE repo = ? ORDER BY worktree_id, position`).
CREATE INDEX idx_worktree_tabs_repo ON worktree_tabs (repo, worktree_id, position);
