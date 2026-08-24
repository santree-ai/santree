-- A logical surface can host one durable conversation per provider. Defaults
-- choose which provider opens next; they do not evict another provider's thread.
CREATE TABLE terminal_sessions_new (
    repo       TEXT NOT NULL,
    term_key   TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    agent_kind TEXT NOT NULL DEFAULT 'Claude'
        CHECK (agent_kind IN ('Claude', 'Codex', 'Cursor', 'Opencode')),
    PRIMARY KEY (repo, term_key, agent_kind)
);

INSERT INTO terminal_sessions_new
    (repo, term_key, cwd, session_id, created_at, agent_kind)
SELECT repo, term_key, cwd, session_id, created_at, agent_kind
FROM terminal_sessions;

DROP TABLE terminal_sessions;
ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;

CREATE INDEX idx_terminal_sessions_session_id
    ON terminal_sessions (session_id);
