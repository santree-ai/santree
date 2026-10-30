-- Who put a pending prompt on screen, for a `permission` / `waiting` row:
-- 'main' (the session's own thread asked), 'agent:<id>' (a subagent did —
-- Claude fires a subagent's hooks on its parent session), or NULL when the
-- event can't say (a Notification) or the row predates this column. The app
-- resolves a pending prompt by the progress of the thread that asked, and
-- santree-hook keeps a subagent's dialog on record past the main thread's
-- `Stop`. Written by santree-hook, so additive only: an older hook binary
-- still writes rows without it.
ALTER TABLE session_state ADD COLUMN asker TEXT;
