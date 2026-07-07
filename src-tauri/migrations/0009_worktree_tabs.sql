-- Extra main-area tabs opened via the Trees "+" menu, persisted so they come
-- back after an app restart. `kind` is 'claude' (a resumable agent session —
-- its session id lives in terminal_sessions under term_key
-- 'tree:<worktree_id>:tab:<id>') or 'terminal' (a plain shell, reopened fresh).
-- `worktree_id` is the linked issue id, or the '__base__' sentinel for the
-- base-branch entry.
CREATE TABLE worktree_tabs (
    id          TEXT NOT NULL PRIMARY KEY,
    repo        TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('claude', 'terminal')),
    title       TEXT NOT NULL,
    position    INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_worktree_tabs_repo ON worktree_tabs (repo, worktree_id, position);
