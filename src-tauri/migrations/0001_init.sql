-- Connected Linear organizations (multiple can be logged in at once).
CREATE TABLE IF NOT EXISTS linear_orgs (
    slug          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at    INTEGER NOT NULL
);

-- Repositories, each optionally bound to a Linear org.
CREATE TABLE IF NOT EXISTS repos (
    name            TEXT PRIMARY KEY,
    tracker         TEXT NOT NULL DEFAULT '',
    agents          INTEGER NOT NULL DEFAULT 0,
    linear_org_slug TEXT REFERENCES linear_orgs(slug) ON DELETE SET NULL
);

-- App + per-repo settings. `scope` is 'app' or 'repo:<name>'. A repo value
-- overrides the app value for the same key; absence falls back to the app
-- value, then to the built-in default.
CREATE TABLE IF NOT EXISTS settings (
    scope TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);
