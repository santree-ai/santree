-- Durable recovery for incremental moves; old split drafts remain untouched.
CREATE TABLE worktree_moves (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    source_id TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE(repo_path, source_id)
);
