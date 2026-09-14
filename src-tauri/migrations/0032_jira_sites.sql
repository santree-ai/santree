-- Connected Jira Cloud sites (analogous to linear_orgs).
CREATE TABLE IF NOT EXISTS jira_sites (
    cloud_id   TEXT PRIMARY KEY,
    site_name  TEXT NOT NULL,
    site_url   TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    scopes     TEXT NOT NULL DEFAULT ''
);

-- Repos can be bound to a Jira site (analogous to linear_org_slug).
ALTER TABLE repos ADD COLUMN jira_cloud_id TEXT REFERENCES jira_sites(cloud_id) ON DELETE SET NULL;
