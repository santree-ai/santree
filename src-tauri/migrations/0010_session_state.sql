-- Live Claude Code session state, captured via hooks that santree injects into
-- its own `claude` launches (`claude --settings '<JSON>'`). Each hook event
-- updates the ONE row for that session — this is a current-state table (one row
-- per session), not an event log, so it stays bounded without pruning.
--
-- `state` is the derived agent state: 'active' (a turn is running) | 'waiting'
-- (needs the user, e.g. a permission/notification) | 'idle' (turn finished) |
-- 'exited' (session ended). `event` is the raw Claude hook event that last set
-- it. The row is keyed by Claude's `session_id`, which santree itself minted via
-- `--session-id`, so it maps back to a worktree later via `terminal_sessions`
-- (or the stored `cwd`). No FK for that reason.
CREATE TABLE session_state (
    session_id      TEXT NOT NULL PRIMARY KEY,
    state           TEXT NOT NULL,
    -- Raw Claude hook event name that produced `state` (e.g. 'Stop').
    event           TEXT NOT NULL,
    -- Working directory the session ran in (the worktree path).
    cwd             TEXT NOT NULL DEFAULT '',
    -- Notification message text, when the last event carried one.
    message         TEXT,
    -- Path to the session transcript on disk, when the payload carried one.
    transcript_path TEXT,
    -- Epoch ms the state was last updated (written by the CLI).
    updated_at_ms   INTEGER NOT NULL
);

-- Recent-first reads for a global feed.
CREATE INDEX idx_session_state_updated ON session_state (updated_at_ms);
