-- The Agents panel resolves every live session back to the surface that owns it
-- (worktree / triage investigation / dev) by joining `session_state` against
-- `terminal_sessions.session_id`. That table is keyed by (repo, term_key), so
-- the reverse lookup was a full scan on every session-state read (a ~10s poll
-- while any agent is unsettled).
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_session_id
    ON terminal_sessions (session_id);
