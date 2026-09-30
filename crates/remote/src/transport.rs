//! Getting a byte stream to a session host: the [`Connector`] seam, what a
//! connect can come back with, and an in-memory pipe for tests. The real
//! connector is [`crate::agent::AgentConnector`].
//!
//! A failed connect is a [`ConnectError`], a *state* the app renders rather
//! than an error it toasts (docs/remote.md, "unreachable is normal"). Some
//! of them do not change by trying again soon — [`ConnectError::permanent`]
//! — and the reconnect loop waits them out at its slowest pace.

use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// An open byte stream to a session host, speaking protocol v1.
pub struct Link {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// The agent's `ok` line, when the link came through the Daedalus agent.
    pub agent: Option<AgentOk>,
}

impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Link")
            .field("agent", &self.agent)
            .finish_non_exhaustive()
    }
}

/// The Daedalus agent's `ok` line: where it piped this connection.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentOk {
    /// The session host, as `host:port`.
    pub host: String,
    /// This machine's node id at the box.
    pub node: String,
    /// The agent's own version.
    pub agent: String,
}

/// Why the agent turned a connection away, from its refusal's `code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// This machine's policy keeps santree off (Daedalus › Settings › Machines).
    SantreeOff,
    /// The session host proved another key than the one the box named.
    HostKeyChanged,
    /// This user may not use the agent's santree socket.
    Forbidden,
    /// The agent is carrying as many santree connections as it takes.
    Busy,
    /// Anything else the agent can't do now; its message says why (not
    /// paired, not approved, no session host, the host not reachable…).
    Unavailable,
}

impl Refusal {
    /// The refusal a wire `code` names; a code this santree doesn't know
    /// reads as `Unavailable`, whose message still says why.
    pub fn of(code: &str) -> Self {
        match code {
            "santree_off" => Refusal::SantreeOff,
            "host_key_changed" => Refusal::HostKeyChanged,
            "forbidden" => Refusal::Forbidden,
            "busy" => Refusal::Busy,
            _ => Refusal::Unavailable,
        }
    }
}

/// Why no link opened.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    /// No agent socket on this machine: the Daedalus agent isn't installed.
    #[error("the Daedalus agent isn't installed on this machine")]
    NoAgent,
    /// The agent is installed but serves no santree socket: it predates it.
    #[error("the Daedalus agent on this machine is too old to serve santree")]
    AgentOutdated,
    /// Something other than the agent holds its socket.
    #[error("{0}")]
    Untrusted(String),
    /// The agent answered with a refusal; `msg` is its own reason.
    #[error("{msg}")]
    Refused { refusal: Refusal, msg: String },
    /// Anything else, as a short human line.
    #[error("{0}")]
    Failed(String),
}

impl ConnectError {
    /// Whether trying again soon is pointless: nothing changes until someone
    /// installs or updates the agent, flips a setting in Daedalus, or looks
    /// into a changed key.
    pub fn permanent(&self) -> bool {
        match self {
            ConnectError::NoAgent | ConnectError::AgentOutdated | ConnectError::Untrusted(_) => {
                true
            }
            ConnectError::Refused { refusal, .. } => matches!(
                refusal,
                Refusal::SantreeOff | Refusal::HostKeyChanged | Refusal::Forbidden
            ),
            ConnectError::Failed(_) => false,
        }
    }
}

/// Opens links. `RemoteHost` takes one so tests can swap the agent for the
/// fake.
pub trait Connector: Send + Sync + 'static {
    fn connect(&self) -> BoxFuture<'static, Result<Link, ConnectError>>;
}

impl<F> Connector for F
where
    F: Fn() -> BoxFuture<'static, Result<Link, ConnectError>> + Send + Sync + 'static,
{
    fn connect(&self) -> BoxFuture<'static, Result<Link, ConnectError>> {
        self()
    }
}

/// An in-memory link: the client half, and the stream a (fake) daemon serves.
pub fn memory_link() -> (Link, DuplexStream) {
    let (client, server) = tokio::io::duplex(256 * 1024);
    let (reader, writer) = tokio::io::split(client);
    (
        Link {
            reader: Box::new(reader),
            writer: Box::new(writer),
            agent: None,
        },
        server,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_codes_read_as_refusals() {
        assert_eq!(Refusal::of("santree_off"), Refusal::SantreeOff);
        assert_eq!(Refusal::of("host_key_changed"), Refusal::HostKeyChanged);
        assert_eq!(Refusal::of("forbidden"), Refusal::Forbidden);
        assert_eq!(Refusal::of("busy"), Refusal::Busy);
        assert_eq!(Refusal::of("unavailable"), Refusal::Unavailable);
        assert_eq!(Refusal::of("internal"), Refusal::Unavailable);
    }

    #[test]
    fn only_what_waits_on_a_person_is_permanent() {
        let refused = |refusal| ConnectError::Refused {
            refusal,
            msg: "why".into(),
        };
        for permanent in [
            ConnectError::NoAgent,
            ConnectError::AgentOutdated,
            ConnectError::Untrusted("x".into()),
            refused(Refusal::SantreeOff),
            refused(Refusal::HostKeyChanged),
            refused(Refusal::Forbidden),
        ] {
            assert!(permanent.permanent(), "{permanent:?}");
        }
        for transient in [
            refused(Refusal::Busy),
            refused(Refusal::Unavailable),
            ConnectError::Failed("x".into()),
        ] {
            assert!(!transient.permanent(), "{transient:?}");
        }
    }
}
