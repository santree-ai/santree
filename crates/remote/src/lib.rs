//! Client side of santree's remote execution (docs/remote.md).
//!
//! Transport and protocol only — it knows nothing about repos, worktrees or
//! agents, and nothing about Tauri:
//!
//! - [`proto`]: protocol v1's frames, methods and shapes — the
//!   `santree-remote-proto` crate, re-exported because this crate's API speaks
//!   its types.
//! - [`agent`]: [`AgentConnector`], the link through the Daedalus agent's
//!   santree socket on this machine.
//! - [`transport`]: the [`Connector`] seam, [`ConnectError`] (what a failed
//!   connect is, as a state), and an in-memory link.
//! - [`client`]: [`RemoteClient`], the JSON-lines client over any byte stream.
//! - [`host`]: [`RemoteHost`], one session host's connection lifecycle —
//!   handshake, status, reconnect, the hooks subscription.
//! - `fake` (feature `fake`): an in-process daemon, and a stand-in for the
//!   agent's socket in front of it, for tests.

pub use santree_remote_proto as proto;

pub mod agent;
pub mod client;
mod framing;
pub mod host;
pub mod transport;

#[cfg(any(test, feature = "fake"))]
pub mod fake;

#[cfg(test)]
mod tests;

pub use agent::AgentConnector;
pub use client::{ClientOptions, HookMessage, PtyEvent, RemoteClient, RemoteError};
pub use host::{HookDelivery, HostConfig, HostOptions, HostStatus, Reconnected, RemoteHost};
pub use transport::{AgentOk, ConnectError, Connector, Link, Refusal};
