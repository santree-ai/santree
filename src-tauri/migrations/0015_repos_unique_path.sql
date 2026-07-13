-- A repo row's real identity is its *path* — that's what `worktree_links` keys
-- on. The derived name (`owner/repo`) isn't unique: a second checkout of the
-- same GitHub repo is a normal thing to have, and re-registering one under the
-- existing row's name used to repoint that row's path, orphaning every worktree
-- linked to the old checkout. Enforce uniqueness where it actually holds.
--
-- Two rows could previously share a path (a checkout whose origin remote — and
-- so its derived name — changed inserted a second row), so collapse those first,
-- keeping the oldest. `path` is still NULL-able, hence the partial index.
DELETE FROM repos
WHERE path IS NOT NULL
  AND rowid NOT IN (SELECT MIN(rowid) FROM repos WHERE path IS NOT NULL GROUP BY path);

CREATE UNIQUE INDEX IF NOT EXISTS repos_path_unique ON repos(path) WHERE path IS NOT NULL;
