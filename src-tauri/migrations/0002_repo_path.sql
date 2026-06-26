-- Local filesystem path for repos the user adds from a folder. NULL for the
-- built-in seed repos (which aren't backed by a checkout on this machine).
ALTER TABLE repos ADD COLUMN path TEXT;
