-- Review checkouts become ordinary worktrees, told apart by a table instead of
-- by their id.
--
-- They used to be a separate species: detached at a commit, parked in
-- `.santree/reviews/`, budgeted to five, and kept out of the Trees list by a
-- reserved `review-checkout-` id prefix that six different readers had to filter
-- on. A reviewer could not run the code they were reading, because the setup
-- script never ran there and the directory was deleted on a schedule.
--
-- Now a PR's checkout is a real worktree on the PR's branch, and this table is
-- the only thing that distinguishes it: a membership row saying "this
-- `worktree_links` row is a review". That keeps every worktree-scoped read —
-- files, git status, tabs, session history, setup — addressing it exactly as
-- before, and leaves `worktree::list` as the one place that filters.
--
-- It also holds the PR identity that used to be encoded in the directory name,
-- so finding a PR's checkout is a lookup rather than a string built from a
-- length-prefixed slug.
CREATE TABLE review_worktrees (
    repo_path TEXT    NOT NULL,
    issue_id  TEXT    NOT NULL,
    -- "owner/name", as GitHub spells it.
    pr_repo   TEXT    NOT NULL,
    number    INTEGER NOT NULL,
    created_at TEXT   NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo_path, issue_id)
);

-- One checkout per pull request per clone: the lookup direction the Reviews view
-- asks in, and the constraint that keeps a second one from being cut beside it.
CREATE UNIQUE INDEX review_worktrees_pr ON review_worktrees (repo_path, pr_repo, number);

-- The old species, forgotten. The directories under `.santree/reviews/` are git
-- worktrees, so SQL can't unregister them — `reviews::sweep_legacy_checkouts`
-- does that on the next launch, and these rows would otherwise show up in Trees
-- as worktrees the moment the id-prefix filter came out.
DELETE FROM worktree_links WHERE issue_id LIKE 'review-checkout-%';
