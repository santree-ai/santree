CREATE TABLE review_work_items (
    id          TEXT NOT NULL PRIMARY KEY,
    pr_repo     TEXT NOT NULL,
    pr_number   INTEGER NOT NULL CHECK (pr_number > 0),
    body        TEXT NOT NULL CHECK (length(trim(body)) > 0),
    done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('manual', 'github_thread', 'ai_draft')),
    source_id   TEXT,
    path        TEXT,
    line        INTEGER CHECK (line IS NULL OR line > 0),
    start_line  INTEGER CHECK (start_line IS NULL OR start_line > 0),
    on_right    INTEGER CHECK (on_right IS NULL OR on_right IN (0, 1)),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CHECK ((source_kind = 'manual' AND source_id IS NULL) OR
           (source_kind != 'manual' AND source_id IS NOT NULL))
);

CREATE INDEX idx_review_work_items_pr
    ON review_work_items (pr_repo, pr_number, done, created_at);
CREATE UNIQUE INDEX idx_review_work_items_source
    ON review_work_items (pr_repo, pr_number, source_kind, source_id)
    WHERE source_id IS NOT NULL;
