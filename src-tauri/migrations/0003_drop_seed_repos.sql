-- The early builds seeded three placeholder repos that don't exist on disk.
-- Repos are now added by the user from a real local checkout, so drop the seeds.
DELETE FROM repos WHERE name IN ('akamai/agent', 'akamai/web-dashboard', 'akamai/infra');
