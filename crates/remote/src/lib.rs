//! Client side of santree's remote execution (docs/remote.md).
//!
//! Transport and protocol only — it knows nothing about repos, worktrees or
//! agents, and nothing about Tauri:
//!
//! - [`proto`]: protocol v1's frames, methods and shapes — the
//!   `santree-remote-proto` crate, re-exported because this crate's API speaks
//!   its types.
//! - [`transport`]: the `ssh … santree-remote connect` command, the
//!   [`Connector`] seam, and an in-memory link.
//! - [`client`]: [`RemoteClient`], the JSON-lines client over any byte stream.
//! - [`host`]: [`RemoteHost`], one server's connection lifecycle —
//!   handshake, status, reconnect, the hooks subscription.
//! - [`probe`]: [`ssh_probe`], the health check's "does ssh work, is
//!   `santree-remote` installed" round trip.
//! - `fake` (feature `fake`): an in-process daemon for tests.

pub use santree_remote_proto as proto;

pub mod client;
mod framing;
pub mod host;
pub mod probe;
pub mod transport;

#[cfg(any(test, feature = "fake"))]
pub mod fake;

#[cfg(test)]
mod tests;

pub use client::{ClientOptions, HookMessage, PtyEvent, RemoteClient, RemoteError};
pub use host::{HookDelivery, HostConfig, HostOptions, HostStatus, Reconnected, RemoteHost};
pub use probe::{ssh_probe, ProbeOutcome};
pub use transport::{ssh_command, Connector, Link, LinkTransport, SshConnector, SshTarget};
