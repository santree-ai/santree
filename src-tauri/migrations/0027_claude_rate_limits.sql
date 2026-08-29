-- Claude's account-level subscription rate-limit windows, captured from the same
-- status-line stdin that feeds `session_usage_live` (see crates/hook's
-- `statusline` mode). The payload's optional `rate_limits` object carries one
-- member per window (`five_hour`, `seven_day`, ... — one row per member, keyed by
-- its name so a window this build doesn't know is kept rather than dropped).
-- The limits belong to the account, not a session, so the table is app-wide:
-- every santree-launched session reports the same numbers and the latest write
-- wins. Display-only — read by the app, never written back toward a session.
CREATE TABLE IF NOT EXISTS claude_rate_limits (
    -- The payload member name: `five_hour`, `seven_day`, ...
    window        TEXT    PRIMARY KEY,
    -- Claude's own `used_percentage`, 0..100.
    used_pct      REAL    NOT NULL,
    -- Epoch ms when the window resets (the payload's epoch-seconds `resets_at`),
    -- NULL when the payload carried none.
    resets_at_ms  INTEGER,
    updated_at_ms INTEGER NOT NULL
);
