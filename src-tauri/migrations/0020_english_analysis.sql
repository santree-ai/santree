-- The English tutor's stored log analysis.
--
-- A single row (id = 1): the analysis is a snapshot of one file at one moment, and
-- keeping a history of them would just be a slower way to read the log itself.
-- Re-running replaces it. `entry_count` is what the log held when it ran, so the
-- UI can tell the user how far behind the analysis has fallen.
CREATE TABLE english_analysis (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    analysis    TEXT    NOT NULL,
    entry_count INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);
