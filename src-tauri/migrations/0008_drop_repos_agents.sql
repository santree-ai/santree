-- `repos.agents` was always inserted as 0 and never updated after the mock
-- era was deleted, leaving the RepoSelector agent-count badge permanently
-- unreachable. The count is now derived live in repo::list from
-- worktree_links (one row per active issue<->worktree link), so the stored
-- column is no longer needed.
ALTER TABLE repos DROP COLUMN agents;
