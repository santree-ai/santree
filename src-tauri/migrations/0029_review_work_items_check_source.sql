-- Widen review_work_items.source_kind to allow 'check' — a failing CI check
-- queued as review work, alongside 'manual'/'github_thread'/'ai_draft'.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is recreated and
-- the rows copied across. 0026 is NOT edited: sqlx checksums every applied
-- migration and refuses to open a database whose stored checksum no longer
-- matches, so rewriting it — even a comment — would lock every installed user out
-- of their own data. It is not deleted either: sqlx also fails to start against a
-- database recording an applied version the resolved set no longer contains,
-- which is why 0017_dev_todos is still on disk.
--
-- Nothing references review_work_items by foreign key, so the drop/rename is
-- safe. The copy revalidates every row against the new CHECK, which is a strict
-- superset of the old one, so no existing row can be rejected.
CREATE TABLE review_work_items_new (
    id          TEXT NOT NULL PRIMARY KEY,
    pr_repo     TEXT NOT NULL,
    pr_number   INTEGER NOT NULL CHECK (pr_number > 0),
    body        TEXT NOT NULL CHECK (length(trim(body)) > 0),
    done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    source_kind TEXT NOT NULL
                CHECK (source_kind IN ('manual', 'github_thread', 'ai_draft', 'check')),
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

INSERT INTO review_work_items_new
    (id, pr_repo, pr_number, body, done, source_kind, source_id,
     path, line, start_line, on_right, created_at, updated_at)
    SELECT id, pr_repo, pr_number, body, done, source_kind, source_id,
           path, line, start_line, on_right, created_at, updated_at
      FROM review_work_items;

DROP TABLE review_work_items;
ALTER TABLE review_work_items_new RENAME TO review_work_items;

-- Both indexes must be recreated by hand: DROP TABLE takes a table's indexes with
-- it, and RENAME TO does not bring them back. The unique one is not housekeeping
-- — `review_work_items::add` upserts with
-- `ON CONFLICT(pr_repo, pr_number, source_kind, source_id) WHERE source_id IS NOT NULL`,
-- and a partial-index conflict target *requires* the matching partial index to
-- exist. Without it every source-backed add fails at runtime with "ON CONFLICT
-- clause does not match any PRIMARY KEY or UNIQUE constraint".
CREATE INDEX idx_review_work_items_pr
    ON review_work_items (pr_repo, pr_number, done, created_at);
CREATE UNIQUE INDEX idx_review_work_items_source
    ON review_work_items (pr_repo, pr_number, source_kind, source_id)
    WHERE source_id IS NOT NULL;
