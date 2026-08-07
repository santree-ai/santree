-- Which slice of the practice log an analysis covered.
--
-- Advice drawn from the last 7 days reads very differently from advice drawn from
-- a year, so the UI has to be able to say which one it's showing. Existing rows
-- (if any) predate scopes and covered the whole log, so 'everything' is the
-- truthful backfill rather than merely a convenient default.
ALTER TABLE english_analysis ADD COLUMN scope TEXT NOT NULL DEFAULT 'everything';
