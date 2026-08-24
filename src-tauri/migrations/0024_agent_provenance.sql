-- Provider identity is historical state: changing an action default must never
-- reinterpret an existing Claude conversation as a Codex thread.
ALTER TABLE terminal_sessions ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'Claude'
    CHECK (agent_kind IN ('Claude', 'Codex', 'Cursor', 'Opencode'));

CREATE TABLE worktree_tabs_new (
    id          TEXT NOT NULL PRIMARY KEY,
    repo        TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('agent', 'terminal', 'fixci')),
    agent_kind  TEXT CHECK (agent_kind IN ('Claude', 'Codex', 'Cursor', 'Opencode')),
    title       TEXT NOT NULL,
    position    INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((kind = 'terminal' AND agent_kind IS NULL) OR
           (kind != 'terminal' AND agent_kind IS NOT NULL))
);

INSERT INTO worktree_tabs_new
    (id, repo, worktree_id, kind, agent_kind, title, position, created_at)
SELECT id, repo, worktree_id,
       CASE WHEN kind = 'claude' THEN 'agent' ELSE kind END,
       CASE WHEN kind = 'terminal' THEN NULL ELSE 'Claude' END,
       title, position, created_at
FROM worktree_tabs;

DROP TABLE worktree_tabs;
ALTER TABLE worktree_tabs_new RENAME TO worktree_tabs;
CREATE INDEX idx_worktree_tabs_repo ON worktree_tabs (repo, worktree_id, position);

ALTER TABLE review_drafts ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'Claude'
    CHECK (agent_kind IN ('Claude', 'Codex'));
ALTER TABLE review_briefs ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'Claude'
    CHECK (agent_kind IN ('Claude', 'Codex'));
