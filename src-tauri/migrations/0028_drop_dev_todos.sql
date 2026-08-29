-- The hidden Dev tab is gone (its feature folder, its Rust module and its
-- commands with it), so its bug list has nothing left to read or write it.
--
-- 0017 stays where it is on purpose: sqlx records every applied migration by
-- version, and an installed app whose DB already ran 0017 fails to start if that
-- version disappears from the resolved set. Retiring a table is a new migration,
-- never a deleted one.
DROP TABLE IF EXISTS dev_todos;
