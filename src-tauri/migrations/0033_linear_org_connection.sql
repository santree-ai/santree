-- How each connected Linear org is connected.
--
-- 'oauth' is santree's OAuth app and Linear's GraphQL API — every org connected
-- before this migration. 'mcp' is Linear's hosted MCP server, the last resort
-- for workspaces that block OAuth apps (docs/linear-mcp.md). The two use
-- different token endpoints and APIs, so the row has to say which one its
-- keychain credential belongs to.
ALTER TABLE linear_orgs ADD COLUMN auth TEXT NOT NULL DEFAULT 'oauth';

-- The MCP client an 'mcp' org's grant was issued to. santree registers a client
-- on every MCP connect, and a refresh or a revocation has to present the client
-- the grant belongs to. NULL for 'oauth' orgs, whose client id is compiled in.
ALTER TABLE linear_orgs ADD COLUMN mcp_client_id TEXT;
