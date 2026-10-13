-- TickTick as a third ticket tracker. One TickTick account per install (its API
-- has no identity endpoint to key a second one by), so the table holds at most
-- one row, `id = 'me'`, and a repo links to it as 'ticktick:me'.
--
-- The credential itself is in the OS keychain (entry `ticktick:me`),
-- never here; this row is only what the UI needs to say how it was connected.
CREATE TABLE ticktick_accounts (
    id           TEXT PRIMARY KEY CHECK (id = 'me'),
    via          TEXT NOT NULL CHECK (via IN ('oauth', 'token')),
    -- Epoch ms an OAuth access token stops working, when the token endpoint said.
    -- NULL for a personal token and for an OAuth reply that gave no lifetime.
    expires_at   INTEGER,
    connected_at INTEGER NOT NULL
);

-- Same guarantee 0038 gives Linear and Jira: a repo never keeps a link to a
-- connection that is gone.
CREATE TRIGGER ticktick_accounts_unlink_repos AFTER DELETE ON ticktick_accounts
BEGIN
    UPDATE repos SET connection = NULL WHERE connection = 'ticktick:' || OLD.id;
END;

-- 0038's "the first connection adopts the waiting repos" rule counted two tables.
-- It now counts three, so the two it made are replaced and a third joins them.
DROP TRIGGER linear_orgs_first_adopts_repos;
DROP TRIGGER jira_sites_first_adopts_repos;

CREATE TRIGGER linear_orgs_first_adopts_repos AFTER INSERT ON linear_orgs
WHEN (SELECT (SELECT COUNT(*) FROM linear_orgs) + (SELECT COUNT(*) FROM jira_sites)
             + (SELECT COUNT(*) FROM ticktick_accounts)) = 1
BEGIN
    UPDATE repos SET connection = 'linear:' || NEW.slug WHERE connection IS NULL;
END;

CREATE TRIGGER jira_sites_first_adopts_repos AFTER INSERT ON jira_sites
WHEN (SELECT (SELECT COUNT(*) FROM linear_orgs) + (SELECT COUNT(*) FROM jira_sites)
             + (SELECT COUNT(*) FROM ticktick_accounts)) = 1
BEGIN
    UPDATE repos SET connection = 'jira:' || NEW.cloud_id WHERE connection IS NULL;
END;

CREATE TRIGGER ticktick_accounts_first_adopts_repos AFTER INSERT ON ticktick_accounts
WHEN (SELECT (SELECT COUNT(*) FROM linear_orgs) + (SELECT COUNT(*) FROM jira_sites)
             + (SELECT COUNT(*) FROM ticktick_accounts)) = 1
BEGIN
    UPDATE repos SET connection = 'ticktick:' || NEW.id WHERE connection IS NULL;
END;
