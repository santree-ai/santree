-- A resumable Claude session for a terminal that auto-launches `claude`
-- (Trees "work", Triage "investigate"). `term_key` is the frontend's logical
-- terminal id (e.g. 'tree:AK-1', 'triage:AK-1'); `cwd` is where claude runs,
-- needed to locate the on-disk transcript when deciding whether the session is
-- still resumable. One session per logical terminal.
CREATE TABLE terminal_sessions (
    repo       TEXT NOT NULL,
    term_key   TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (repo, term_key)
);

-- Supersede the never-wired-up worktree_links.session_id: this registry also
-- covers Triage investigations, which have no worktree row.
ALTER TABLE worktree_links DROP COLUMN session_id;
