-- Per-file "Viewed" marks for the Reviews tab (GitHub-style). A row means the
-- user marked that PR file as reviewed at blob `sha`. The UI treats the file as
-- reviewed only while its current head blob SHA still equals this `sha`, so a new
-- commit that changes the file (new SHA) automatically drops it back to
-- unreviewed — no explicit unmark needed. Local-only, never synced. Keyed by the
-- PR's own repo ("owner/name", since the Reviews inbox spans repos in an org) +
-- number + path.
CREATE TABLE IF NOT EXISTS reviewed_files (
    pr_repo    TEXT NOT NULL,
    pr_number  INTEGER NOT NULL,
    path       TEXT NOT NULL,
    sha        TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (pr_repo, pr_number, path)
);
