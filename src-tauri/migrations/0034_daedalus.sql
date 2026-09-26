-- Daedalus: the user's home server, where some projects live and run
-- (docs/remote.md).
--
-- One row, at most: santree talks to one Daedalus. `url` is what the user typed;
-- the rest is the connection info last fetched from its API (`fetched_at`,
-- RFC 3339), plus an optional identity file the user picks for ssh. The API
-- bearer lives in the OS keychain (service com.santree.desktop, account
-- `daedalus`), never here.
--
-- `hook_cursor` / `boot_id`: where the app is in santree-remote's hook queue —
-- the last seq it applied and acked, and the daemon boot that seq belongs to.
-- Seqs restart at 1 with every boot, so the two are only read together. NULL
-- until the first ack; cleared with the fetched info when the URL changes.
CREATE TABLE IF NOT EXISTS daedalus_connection (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    url           TEXT NOT NULL,
    ssh_user      TEXT,
    ssh_host      TEXT,
    ssh_port      INTEGER,
    projects_root TEXT,
    identity_file TEXT,
    fetched_at    TEXT,
    hook_cursor   INTEGER,
    boot_id       TEXT
);

-- Where a registered repo's checkout lives. 'local' is every repo registered
-- before this migration: a folder on this machine. 'daedalus' is a checkout on
-- the server, whose `path` is a path there and must never be read locally.
ALTER TABLE repos ADD COLUMN location TEXT NOT NULL DEFAULT 'local'
    CHECK (location IN ('local', 'daedalus'));
