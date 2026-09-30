-- Daedalus through the local agent (docs/remote.md): santree no longer keeps
-- a URL, an API token, ssh connection info or an identity file — it reaches
-- the box through the Daedalus agent's socket on this machine, which needs no
-- configuration. What stays is where the app is in the session host's hook
-- queue: `hook_cursor`, the last seq applied and acked, and `boot_id`, the
-- host boot that seq belongs to (seqs restart at 1 with every boot, so the two
-- are only read together). The row is written with the first ack.
ALTER TABLE daedalus_connection DROP COLUMN url;
ALTER TABLE daedalus_connection DROP COLUMN ssh_user;
ALTER TABLE daedalus_connection DROP COLUMN ssh_host;
ALTER TABLE daedalus_connection DROP COLUMN ssh_port;
ALTER TABLE daedalus_connection DROP COLUMN projects_root;
ALTER TABLE daedalus_connection DROP COLUMN identity_file;
ALTER TABLE daedalus_connection DROP COLUMN fetched_at;
