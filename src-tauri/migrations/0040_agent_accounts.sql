-- Several Claude Code / Codex accounts, each its own config folder under
-- ~/.config/santree/accounts (src-tauri/src/accounts.rs). Additive only:
-- santree-hook writes both tables, and an older hook binary must keep working.
--
-- `account` is the account a session was launched on, fixed at launch so a
-- resume runs under the same one. NULL is the Default account: whatever the
-- CLI uses with no config-folder override.
ALTER TABLE terminal_sessions ADD COLUMN account TEXT;

-- The named accounts' rate-limit windows. `claude_rate_limits` stays the
-- Default account's, unchanged, so a hook that predates accounts still writes
-- the right rows.
CREATE TABLE claude_account_rate_limits (
    account       TEXT NOT NULL,
    window        TEXT NOT NULL,
    used_pct      REAL NOT NULL,
    resets_at_ms  INTEGER,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (account, window)
);
