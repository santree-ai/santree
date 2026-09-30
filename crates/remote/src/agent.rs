//! The real [`Connector`]: the Daedalus agent installed on this machine.
//!
//! santree never talks to the box itself. The agent serves a unix socket
//! for it; per connection it opens a TLS connection of its own to the box's
//! session host, proving this machine's node key, and pipes bytes both ways
//! (docs/remote.md, "The transport").
//!
//! ```text
//! santree ─unix─▶ <agent run dir>/santree.sock ─ agent ─ TLS 1.3 ─▶ session host
//! ```
//!
//! A connect is:
//!
//! 1. the socket at its one fixed path per OS ([`socket_path`]). None there
//!    means no agent — or, when the agent's own `agent.sock` sits beside it,
//!    an agent that predates santree's socket;
//! 2. the other end checked: the kernel names the peer's uid, and both it
//!    and the socket file's owner must be root, who runs the agent — so a
//!    process that got to the path first is not handed santree's traffic;
//! 3. the agent's one first line (≤ [`FIRST_LINE_MAX`] bytes, within
//!    [`FIRST_LINE_WAIT`]), read a byte at a time so nothing after it is
//!    taken: `{"id":null,"ok":{host,node,agent}}`, after which the stream is
//!    protocol v1 to the session host, or `{"id":null,"err":{code,msg}}`, a
//!    [`ConnectError::Refused`].

use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;

use crate::transport::{AgentOk, BoxFuture, ConnectError, Connector, Link, Refusal};

/// Where the agent keeps its sockets (its data directory's `run/`).
#[cfg(target_os = "macos")]
const RUN_DIR: &str = "/Library/Application Support/daedalus-agent/run";
#[cfg(not(target_os = "macos"))]
const RUN_DIR: &str = "/var/lib/daedalus-agent/run";

/// santree's socket, and the agent's own beside it.
const SANTREE_SOCKET: &str = "santree.sock";
const AGENT_SOCKET: &str = "agent.sock";

/// The longest first line the agent writes, with room to spare.
pub const FIRST_LINE_MAX: usize = 4 * 1024;
/// The agent answers within its own 15 s (its dial to the host takes at most
/// 10); past this santree stops waiting.
pub const FIRST_LINE_WAIT: Duration = Duration::from_secs(20);

/// The agent's santree socket on this OS.
pub fn socket_path() -> PathBuf {
    Path::new(RUN_DIR).join(SANTREE_SOCKET)
}

/// Opens links through the Daedalus agent's santree socket.
#[derive(Debug, Clone)]
pub struct AgentConnector {
    socket: PathBuf,
    /// Who must be at the other end, and own the socket file: root.
    server_uid: u32,
}

impl Default for AgentConnector {
    fn default() -> Self {
        Self {
            socket: socket_path(),
            server_uid: 0,
        }
    }
}

impl AgentConnector {
    /// The installed agent's socket.
    pub fn new() -> Self {
        Self::default()
    }

    /// A socket of the test's, served by `server_uid` (the test's own).
    #[cfg(any(test, feature = "fake"))]
    pub fn at(socket: impl Into<PathBuf>, server_uid: u32) -> Self {
        Self {
            socket: socket.into(),
            server_uid,
        }
    }
}

impl Connector for AgentConnector {
    fn connect(&self) -> BoxFuture<'static, Result<Link, ConnectError>> {
        let this = self.clone();
        Box::pin(async move { this.open().await })
    }
}

impl AgentConnector {
    async fn open(&self) -> Result<Link, ConnectError> {
        let mut stream = match UnixStream::connect(&self.socket).await {
            Ok(stream) => stream,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                let agent = self.socket.with_file_name(AGENT_SOCKET);
                return Err(if std::fs::symlink_metadata(agent).is_ok() {
                    ConnectError::AgentOutdated
                } else {
                    ConnectError::NoAgent
                });
            }
            Err(e) if e.kind() == ErrorKind::ConnectionRefused => {
                return Err(ConnectError::Failed(
                    "the Daedalus agent isn't running".into(),
                ))
            }
            Err(e) => {
                return Err(ConnectError::Failed(format!(
                    "can't open the Daedalus agent's socket: {e}"
                )))
            }
        };
        self.check_server(&stream)?;
        let line = tokio::time::timeout(FIRST_LINE_WAIT, first_line(&mut stream))
            .await
            .map_err(|_| {
                ConnectError::Failed("the Daedalus agent didn't answer in time".into())
            })??;
        let agent = verdict(&line)?;
        let (reader, writer) = stream.into_split();
        Ok(Link {
            reader: Box::new(reader),
            writer: Box::new(writer),
            agent: Some(agent),
        })
    }

    /// The peer the kernel names, and the socket file's owner, are both
    /// `server_uid`.
    fn check_server(&self, stream: &UnixStream) -> Result<(), ConnectError> {
        let peer = stream
            .peer_cred()
            .map_err(|e| ConnectError::Failed(format!("can't tell who serves the socket: {e}")))?
            .uid();
        let owner = std::fs::symlink_metadata(&self.socket)
            .map_err(|e| ConnectError::Failed(format!("can't read the socket: {e}")))?
            .uid();
        if peer != self.server_uid || owner != self.server_uid {
            return Err(ConnectError::Untrusted(format!(
                "{} is served by uid {peer} and owned by uid {owner}, not the Daedalus agent's",
                self.socket.display()
            )));
        }
        Ok(())
    }
}

/// The agent's first line, without its newline.
async fn first_line(stream: &mut UnixStream) -> Result<Vec<u8>, ConnectError> {
    let mut line = Vec::new();
    loop {
        match stream.read_u8().await {
            Ok(b'\n') => return Ok(line),
            Ok(_) if line.len() == FIRST_LINE_MAX => {
                return Err(ConnectError::Failed(
                    "the Daedalus agent's answer is too long".into(),
                ))
            }
            Ok(b) => line.push(b),
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => {
                return Err(ConnectError::Failed(
                    "the Daedalus agent closed the connection without answering".into(),
                ))
            }
            Err(e) => {
                return Err(ConnectError::Failed(format!(
                    "reading the Daedalus agent's answer: {e}"
                )))
            }
        }
    }
}

/// The first line's envelope: one of `ok` and `err`.
#[derive(Deserialize)]
struct Verdict {
    #[serde(default)]
    ok: Option<AgentOk>,
    #[serde(default)]
    err: Option<Refused>,
}

#[derive(Deserialize)]
struct Refused {
    code: String,
    msg: String,
}

/// Where the agent piped the connection, or why it didn't.
fn verdict(line: &[u8]) -> Result<AgentOk, ConnectError> {
    match serde_json::from_slice::<Verdict>(line) {
        Ok(Verdict {
            ok: Some(ok),
            err: None,
        }) => Ok(ok),
        Ok(Verdict {
            ok: None,
            err: Some(err),
        }) => Err(ConnectError::Refused {
            refusal: Refusal::of(&err.code),
            msg: err.msg,
        }),
        _ => Err(ConnectError::Failed(
            "the Daedalus agent answered in a way this santree doesn't understand".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_is_the_agents() {
        let path = socket_path();
        assert!(
            path.ends_with("daedalus-agent/run/santree.sock"),
            "{path:?}"
        );
        assert!(path.is_absolute());
    }

    #[test]
    fn verdicts_read_as_ok_or_refusals() {
        assert_eq!(
            verdict(br#"{"id":null,"ok":{"host":"box:7789","node":"00ff","agent":"0.22.0"}}"#),
            Ok(AgentOk {
                host: "box:7789".into(),
                node: "00ff".into(),
                agent: "0.22.0".into(),
            })
        );
        assert_eq!(
            verdict(br#"{"id":null,"err":{"code":"santree_off","msg":"off"}}"#),
            Err(ConnectError::Refused {
                refusal: Refusal::SantreeOff,
                msg: "off".into(),
            })
        );
        for garbage in [
            &b"not json"[..],
            br#"{"id":null}"#,
            br#"{"id":null,"ok":{"host":"h"}}"#,
            br#"{"id":null,"ok":{"host":"h","node":"n","agent":"a"},"err":{"code":"busy","msg":"m"}}"#,
        ] {
            assert!(
                matches!(verdict(garbage), Err(ConnectError::Failed(_))),
                "{}",
                String::from_utf8_lossy(garbage)
            );
        }
    }
}
