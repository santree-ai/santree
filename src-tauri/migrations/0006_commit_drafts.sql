-- Persisted commit-message drafts, so an in-progress message survives closing
-- the tab, switching worktrees, or an app crash. Keyed by (repo, issue_id) like
-- the worktree it belongs to; cleared when the worktree commits. Local-only.
CREATE TABLE IF NOT EXISTS commit_drafts (
    repo       TEXT NOT NULL,
    issue_id   TEXT NOT NULL,
    message    TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (repo, issue_id)
);
