-- Widen worktree_tabs.kind to allow 'fixci' (the "Fix CI with AI" session tab)
-- alongside 'claude'/'terminal'. SQLite can't alter a CHECK constraint in place,
-- so recreate the table and copy the existing rows across. No foreign keys
-- reference this table, so the drop/rename is safe.
CREATE TABLE worktree_tabs_new (
    id          TEXT NOT NULL PRIMARY KEY,
    repo        TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('claude', 'terminal', 'fixci')),
    title       TEXT NOT NULL,
    position    INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO worktree_tabs_new (id, repo, worktree_id, kind, title, position, created_at)
    SELECT id, repo, worktree_id, kind, title, position, created_at FROM worktree_tabs;

DROP TABLE worktree_tabs;
ALTER TABLE worktree_tabs_new RENAME TO worktree_tabs;

CREATE INDEX idx_worktree_tabs_repo ON worktree_tabs (repo, worktree_id, position);
