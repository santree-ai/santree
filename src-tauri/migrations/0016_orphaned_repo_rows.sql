-- Five tables key their rows on a repo's *name* (`repos.name`, or the settings
-- scope `repo:<name>` built from it) with no foreign key to enforce it. Migration
-- 0015 collapsed repos that shared a path, deleting the losing rows — and their
-- name-keyed rows stayed behind, unreachable: every read of them starts from a
-- `repos` row, so a name that isn't in `repos` names nothing. Sweep them up.
--
-- `repos` rows are only ever *inserted* (there is no remove-repo path in the app,
-- and `repo::add` keeps the stored name across a remote rename precisely so its
-- settings scope survives), so "no row in `repos` with that name" is the whole of
-- what makes one of these orphaned. Rows for a live repo, and every non-repo
-- settings scope (`app`, and `price_cache`, which `pricing.rs` owns), are left
-- exactly as they are.
--
-- `name IS NOT NULL` because SQLite lets a TEXT PRIMARY KEY hold NULL: without it
-- one NULL name would make every `NOT IN` NULL and quietly delete nothing.
DELETE FROM settings
WHERE scope LIKE 'repo:%'
  AND substr(scope, 6) NOT IN (SELECT name FROM repos WHERE name IS NOT NULL);

DELETE FROM task_notes
WHERE repo NOT IN (SELECT name FROM repos WHERE name IS NOT NULL);

DELETE FROM commit_drafts
WHERE repo NOT IN (SELECT name FROM repos WHERE name IS NOT NULL);

DELETE FROM terminal_sessions
WHERE repo NOT IN (SELECT name FROM repos WHERE name IS NOT NULL);

DELETE FROM worktree_tabs
WHERE repo NOT IN (SELECT name FROM repos WHERE name IS NOT NULL);
