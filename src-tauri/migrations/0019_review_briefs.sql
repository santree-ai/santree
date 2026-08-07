-- Cached AI review briefs (the reading order / watch-outs panel beside a PR).
--
-- Keyed on (repo_slug, number) *without* head_sha, so a new head commit REPLACES
-- the row rather than piling up one brief per push — a brief for code that has
-- since changed has no value, and the stored head_sha is what tells the UI the
-- cached one is stale. `brief` is the serialized ReviewBrief.
CREATE TABLE review_briefs (
    repo_slug  TEXT    NOT NULL,
    number     INTEGER NOT NULL,
    head_sha   TEXT    NOT NULL,
    brief      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (repo_slug, number)
);
