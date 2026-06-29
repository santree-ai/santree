-- Links an agent worktree to the issue it was created for.
--
-- The app creates the worktree under <repo>/.santree/worktrees/<issue_id> and
-- records the mapping here. The santree CLI infers this relationship from the
-- branch name + an on-disk .santree/metadata.json; we keep it in the DB instead
-- so the issue <-> worktree link is explicit, queryable, and survives branch
-- renames. `session_id` is the agent's resumable session (e.g. Claude Code's
-- --session-id); `setup_ran` records whether .santree/init.sh has been run.
CREATE TABLE worktree_links (
    repo_path     TEXT NOT NULL,
    issue_id      TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    project       TEXT,
    branch        TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    base_branch   TEXT NOT NULL,
    agent         TEXT,
    session_id    TEXT,
    setup_ran     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo_path, issue_id)
);
