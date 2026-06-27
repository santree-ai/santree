-- Local, per-task free-text notes: context the user attaches to a task. Stored
-- only here (never synced to Linear); later fed to agents as prompt context.
-- Keyed by (repo, task_id) since task ids are scoped to a repo's Linear org.
CREATE TABLE IF NOT EXISTS task_notes (
    repo       TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    body       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (repo, task_id)
);
