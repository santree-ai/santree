-- A repo's ticket connection: which Linear org or Jira site its tickets come
-- from, as one provider-qualified id ('linear:<slug>', 'jira:<cloud_id>').
--
-- It replaces the pair `repos.linear_org_slug` / `repos.jira_cloud_id`, which are
-- left in place and no longer read or written (SQLite can't drop a column that
-- carries a REFERENCES clause). One column is what lets a third provider join
-- without another column, and what makes "a repo has exactly one tracker" true by
-- construction instead of by two UPDATEs that must each clear the other's column.
ALTER TABLE repos ADD COLUMN connection TEXT;

-- Freeze what every repo resolved to until now, so nothing moves on upgrade. The
-- old rule: a Jira link, else a Linear link, else the first Linear org by name,
-- else the first Jira site by name. From here on there is no fallback: a repo
-- reads the connection it is linked to, or none.
UPDATE repos SET connection = COALESCE(
    CASE WHEN jira_cloud_id IS NOT NULL THEN 'jira:' || jira_cloud_id END,
    CASE WHEN linear_org_slug IS NOT NULL THEN 'linear:' || linear_org_slug END,
    (SELECT 'linear:' || slug FROM linear_orgs ORDER BY name LIMIT 1),
    (SELECT 'jira:' || cloud_id FROM jira_sites ORDER BY site_name LIMIT 1)
);

-- The two foreign keys this replaces cleared a link when its org or site went
-- away. A string can't carry one, so the same guarantee is a trigger.
CREATE TRIGGER linear_orgs_unlink_repos AFTER DELETE ON linear_orgs
BEGIN
    UPDATE repos SET connection = NULL WHERE connection = 'linear:' || OLD.slug;
END;

CREATE TRIGGER jira_sites_unlink_repos AFTER DELETE ON jira_sites
BEGIN
    UPDATE repos SET connection = NULL WHERE connection = 'jira:' || OLD.cloud_id;
END;

-- The first connection an install makes is the only answer there is, so every
-- repo waiting for one takes it. Any later connection leaves the repos where
-- they are: with two to choose from, which one is the user's to say.
CREATE TRIGGER linear_orgs_first_adopts_repos AFTER INSERT ON linear_orgs
WHEN (SELECT (SELECT COUNT(*) FROM linear_orgs) + (SELECT COUNT(*) FROM jira_sites)) = 1
BEGIN
    UPDATE repos SET connection = 'linear:' || NEW.slug WHERE connection IS NULL;
END;

CREATE TRIGGER jira_sites_first_adopts_repos AFTER INSERT ON jira_sites
WHEN (SELECT (SELECT COUNT(*) FROM linear_orgs) + (SELECT COUNT(*) FROM jira_sites)) = 1
BEGIN
    UPDATE repos SET connection = 'jira:' || NEW.cloud_id WHERE connection IS NULL;
END;
