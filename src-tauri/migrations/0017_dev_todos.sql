-- The hidden Dev tab's bug/task list (dogfooding santree development inside
-- santree). `screenshots` is a JSON array of absolute file paths under the app
-- data dir's dev-shots/ folder (pasted images are written there by
-- dev_add_todo). Local-only, never synced; the whole feature may be removed
-- later, so nothing else references this table.
CREATE TABLE dev_todos (
    id          TEXT NOT NULL PRIMARY KEY,
    body        TEXT NOT NULL,
    done        INTEGER NOT NULL DEFAULT 0,
    screenshots TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL
);
