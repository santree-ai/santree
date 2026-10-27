-- Web tabs: an in-app browser tab is a `worktree_tabs` row like an agent or a
-- shell, so it opens in the same strips, splits the same way and comes back
-- after a restart (docs/web.md).
--
--   * `kind` gains 'web'. A web tab runs no agent, so it pairs with a NULL
--     `agent_kind` exactly as a terminal does.
--   * `url` is the page the tab last showed — what it reopens on. NULL until the
--     first page loads, and only ever set on a web tab. Written by the app as
--     the page navigates, never a credential: santree keeps no page state here
--     beyond the address.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is recreated and
-- the rows copied across, as 0030 did. Nothing references worktree_tabs by
-- foreign key. Every existing row passes the new CHECKs: `kind` is a superset of
-- the old one and `url` is NULL for all of them.
CREATE TABLE worktree_tabs_new (
    id          TEXT NOT NULL PRIMARY KEY,
    repo        TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('agent', 'terminal', 'fixci', 'ai_review', 'web')),
    agent_kind  TEXT CHECK (agent_kind IN ('Claude', 'Codex', 'Cursor', 'Opencode')),
    title       TEXT NOT NULL,
    position    INTEGER NOT NULL,
    pr_repo     TEXT,
    pr_number   INTEGER CHECK (pr_number IS NULL OR pr_number > 0),
    url         TEXT CHECK (url IS NULL OR length(url) <= 8192),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((kind IN ('terminal', 'web') AND agent_kind IS NULL) OR
           (kind NOT IN ('terminal', 'web') AND agent_kind IS NOT NULL)),
    CHECK ((pr_repo IS NULL) = (pr_number IS NULL)),
    CHECK (pr_repo IS NULL OR kind IN ('fixci', 'ai_review')),
    CHECK (url IS NULL OR kind = 'web')
);

INSERT INTO worktree_tabs_new
    (id, repo, worktree_id, kind, agent_kind, title, position, pr_repo, pr_number, created_at)
    SELECT id, repo, worktree_id, kind, agent_kind, title, position, pr_repo, pr_number, created_at
      FROM worktree_tabs;

DROP TABLE worktree_tabs;
ALTER TABLE worktree_tabs_new RENAME TO worktree_tabs;

-- DROP TABLE takes the index with it and RENAME TO does not bring it back.
CREATE INDEX idx_worktree_tabs_repo ON worktree_tabs (repo, worktree_id, position);
