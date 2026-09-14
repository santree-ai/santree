//! Linear through its hosted MCP server — the last-resort connection for
//! workspaces that block santree's OAuth app.
//!
//! Same workspace, same `TicketProvider::Linear`, a narrower API: an org records
//! how it was connected (`linear_orgs.auth`), and a token from this server works
//! nowhere but this server. The design, what it can't do, and every fallback:
//! `docs/linear-mcp.md`.

pub(crate) mod auth;
pub(crate) mod client;
pub(crate) mod tracker;
pub(crate) mod wire;

pub use auth::connect;
