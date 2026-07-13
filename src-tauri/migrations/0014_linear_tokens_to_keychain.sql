-- Linear's OAuth access + refresh tokens moved to the OS keychain (macOS
-- Keychain / freedesktop Secret Service); see `linear.rs`. `linear_orgs` now
-- holds only non-secret metadata.
--
-- The keychain half of the move can't happen here — SQL can't reach a keychain —
-- so `linear::migrate_tokens_to_keychain` drains these columns at startup, just
-- before this migration runs (see `db::init`). By the time this executes the
-- tokens are already in the keychain; dropping the columns unconditionally is
-- what guarantees no plaintext token survives, even if the keychain was
-- unreachable (the user then reconnects the org).
ALTER TABLE linear_orgs DROP COLUMN access_token;
ALTER TABLE linear_orgs DROP COLUMN refresh_token;
