-- Worktree identity remains stable for tabs and sessions; tickets are associations.
ALTER TABLE worktree_links ADD COLUMN ticket_id TEXT;
CREATE TABLE split_stacks (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    source_id TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE(repo_path, source_id)
);
