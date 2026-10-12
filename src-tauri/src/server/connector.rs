//! The link to the local santree server: [`ServerConnector`], a
//! `santree_remote_client::Connector` that **verifies the far end before a
//! single byte is written to it**.
//!
//! The socket carries everything a terminal is — the user's keystrokes, the
//! project's env secrets in `pty.open` — and it lives in a directory the user's
//! own agents can write to. So a connect is:
//!
//! 1. the socket at its path, dialled; nothing there is "not running", a state;
//! 2. the socket file's owner is this user (a symlink, or a file someone else
//!    made, is refused);
//! 3. `peer::verify` on the connected fd, off the async workers and bounded:
//!    the peer's uid and — in signed mode — its code signature (team, and
//!    `com.santree.server` as the identifier). A refusal, a panic or a
//!    timeout is [`ConnectError::Untrusted`] (a verdict) or
//!    [`ConnectError::Unverified`] (no verdict): **fail closed** either way;
//! 4. only then the link, tagged with how far it was verified
//!    ([`PeerTrust::Signed`] / [`PeerTrust::UidOnly`], never `Unverified`).
//!
//! `RemoteHost` repeats the whole thing on every reconnect, so a socket swapped
//! under a running app is judged afresh.

use std::io::ErrorKind;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::UnixStream;

use santree_remote_client::transport::BoxFuture;
use santree_remote_client::{ConnectError, Connector, Link, PeerTrust};
use santree_server::peer::{self, Verdict};
use santree_server::SERVER_IDENTIFIER;

/// How long the peer check may take before the server counts as untrusted.
/// A hung check must not hang the link. Just under `RemoteHost`'s own 3 s
/// attempt bound, which covers this check *and* `hello`: the verdict, not a
/// generic "didn't answer", is what a slow check should end as.
///
/// Measured (macOS, 2026-10-07): the first `SecCodeCheckValidity` of a given
/// executable in a process took 7 s for a 10 MB ad-hoc build and ~2 ms for every
/// later one; a notarized release is expected to be far quicker. A check that
/// outlives this bound keeps running and warms that cache, so the host's next
/// attempt is fast: [`ConnectError::Unverified`] with `slow`.
pub const VERIFY_TIMEOUT: Duration = Duration::from_millis(2500);

/// Who the server on the socket must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expect {
    /// Signed by this Apple team, with the server's identifier.
    Team(String),
    /// Only this uid and this user's socket file: the opt-in, unsigned build.
    UidOnly,
}

impl Expect {
    /// The trust a verified link carries.
    fn trust(&self) -> PeerTrust {
        match self {
            Expect::Team(team) => PeerTrust::Signed { team: team.clone() },
            Expect::UidOnly => PeerTrust::UidOnly,
        }
    }
}

/// The peer check, as a value: the real one is `peer::verify`; a test swaps in
/// one that refuses, hangs or panics.
pub type Verifier = Arc<dyn Fn(RawFd) -> Verdict + Send + Sync>;

#[derive(Clone)]
pub struct ServerConnector {
    socket: PathBuf,
    expect: Expect,
    verifier: Verifier,
    timeout: Duration,
    /// The uid the socket file must belong to.
    owner: u32,
}

impl ServerConnector {
    pub fn new(socket: PathBuf, expect: Expect) -> Self {
        let team = match &expect {
            Expect::Team(team) => Some(team.clone()),
            Expect::UidOnly => None,
        };
        Self {
            socket,
            expect,
            verifier: Arc::new(move |fd| peer::verify(fd, team.as_deref(), SERVER_IDENTIFIER)),
            timeout: VERIFY_TIMEOUT,
            // SAFETY: geteuid has no preconditions and cannot fail.
            owner: unsafe { libc::geteuid() },
        }
    }

    #[cfg(test)]
    pub fn with_verifier(mut self, verifier: Verifier) -> Self {
        self.verifier = verifier;
        self
    }

    #[cfg(test)]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    #[cfg(test)]
    pub fn with_owner(mut self, uid: u32) -> Self {
        self.owner = uid;
        self
    }

    async fn open(&self) -> Result<Link, ConnectError> {
        let stream = match UnixStream::connect(&self.socket).await {
            Ok(stream) => stream,
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
                return Err(ConnectError::NotRunning)
            }
            Err(e) => {
                return Err(ConnectError::Failed(format!(
                    "can't open the santree server's socket: {e}"
                )))
            }
        };
        check_socket_file(&self.socket, self.owner)?;

        // The verifier blocks (a signature check), so it runs on the blocking
        // pool, owning the stream: a verifier that outlives its timeout then
        // closes the connection when it finishes rather than leaving it open
        // with nobody judging it.
        let std_stream = stream
            .into_std()
            .map_err(|e| ConnectError::Failed(format!("can't hand off the socket: {e}")))?;
        let verifier = self.verifier.clone();
        let check = tokio::task::spawn_blocking(move || {
            let verdict = verifier(std_stream.as_raw_fd());
            (verdict, std_stream)
        });
        let (verdict, std_stream) = match tokio::time::timeout(self.timeout, check).await {
            Ok(Ok(checked)) => checked,
            Ok(Err(_)) => return Err(unverified(false, "the peer check failed to complete")),
            Err(_) => {
                return Err(unverified(
                    true,
                    &format!(
                        "the peer check took longer than {} s",
                        self.timeout.as_secs_f32()
                    ),
                ))
            }
        };
        if let Verdict::Refused(why) = verdict {
            return Err(if is_definitive_verdict(&why) {
                refused(&why)
            } else {
                unverified(false, &why)
            });
        }

        // `into_std` left the socket non-blocking, which is what tokio wants.
        let stream = UnixStream::from_std(std_stream)
            .map_err(|e| ConnectError::Failed(format!("can't take the socket back: {e}")))?;
        let (reader, writer) = stream.into_split();
        Ok(Link {
            reader: Box::new(reader),
            writer: Box::new(writer),
            agent: None,
            // Set after the verdict and before the first write: what
            // `RemoteHost` and the terminals' profile check.
            peer: self.expect.trust(),
        })
    }
}

impl Connector for ServerConnector {
    fn connect(&self) -> BoxFuture<'static, Result<Link, ConnectError>> {
        let this = self.clone();
        Box::pin(async move { this.open().await })
    }
}

/// A verdict: the peer was located and judged, and it is not the santree
/// server.
fn refused(why: &str) -> ConnectError {
    ConnectError::Untrusted(format!(
        "the process on the santree server's socket isn't the santree server (refused): {why}"
    ))
}

/// No verdict: the peer could not be judged, and the server behind it may well
/// be the real one holding agents. Callers that would forget a server on the
/// strength of a refusal must not do so on this.
fn unverified(slow: bool, why: &str) -> ConnectError {
    ConnectError::Unverified {
        slow,
        why: format!(
            "the process on the santree server's socket could not be verified as the santree \
             server: {why}"
        ),
    }
}

/// Whether a `peer::verify` refusal is a verdict. The Security framework's
/// "requirement failed" family and a uid that isn't ours are; everything else
/// (`peer audit token unreadable`, `uid of peer unreadable`, a failure to build
/// the requirement) is the check not working.
fn is_definitive_verdict(why: &str) -> bool {
    (why.starts_with("uid ") && why.contains("is not this user's"))
        || [
            "OSStatus -67050", // errSecCSReqFailed: the requirement is not met
            "OSStatus -67062", // errSecCSUnsigned
            "OSStatus -67061", // errSecCSSignatureFailed
            "OSStatus -67034", // errSecCSStaticCodeChanged: not the code on disk
        ]
        .iter()
        .any(|code| why.contains(code))
}

/// The socket file is a socket, this user's own, and not a symlink to someone
/// else's.
fn check_socket_file(socket: &Path, owner: u32) -> Result<(), ConnectError> {
    let meta = std::fs::symlink_metadata(socket)
        .map_err(|e| ConnectError::Failed(format!("can't read the socket: {e}")))?;
    let kind = meta.file_type();
    if kind.is_symlink() || !std::os::unix::fs::FileTypeExt::is_socket(&kind) {
        return Err(refused("the path is not a plain socket file"));
    }
    if meta.uid() != owner {
        return Err(refused(&format!(
            "the socket is owned by uid {}, not {owner}",
            meta.uid()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::testkit::{scratch, until};

    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use santree_remote_client::fake::FakeDaemon;
    use santree_remote_client::{HostConfig, HostOptions, HostStatus, RemoteHost, Required};
    use tokio::io::AsyncReadExt;
    use tokio::net::UnixListener;

    /// A listener that records every byte any client sends it, and how many
    /// clients came and went.
    struct Recorder {
        bytes: Arc<Mutex<Vec<u8>>>,
        connections: Arc<AtomicUsize>,
        closed: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Recorder {
        fn at(path: &Path) -> Self {
            let listener = UnixListener::bind(path).unwrap();
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let connections = Arc::new(AtomicUsize::new(0));
            let closed = Arc::new(AtomicUsize::new(0));
            let task = tokio::spawn({
                let (bytes, connections, closed) =
                    (bytes.clone(), connections.clone(), closed.clone());
                async move {
                    while let Ok((mut stream, _)) = listener.accept().await {
                        connections.fetch_add(1, Ordering::SeqCst);
                        let (bytes, closed) = (bytes.clone(), closed.clone());
                        tokio::spawn(async move {
                            let mut buf = [0u8; 1024];
                            // Reads until the connector closes: a refused link
                            // is dropped, so EOF is the end of the evidence.
                            while let Ok(n) = stream.read(&mut buf).await {
                                if n == 0 {
                                    break;
                                }
                                bytes.lock().unwrap().extend_from_slice(&buf[..n]);
                            }
                            closed.fetch_add(1, Ordering::SeqCst);
                        });
                    }
                }
            });
            Self {
                bytes,
                connections,
                closed,
                task,
            }
        }

        fn received(&self) -> Vec<u8> {
            self.bytes.lock().unwrap().clone()
        }

        async fn until_closed(&self, clients: usize) {
            until("the recorder's clients to disconnect", 10, || {
                self.closed.load(Ordering::SeqCst) >= clients
            })
            .await;
        }
    }

    impl Drop for Recorder {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// A listener serving a fake session host on every connection.
    fn serve_daemon(path: &Path, daemon: &FakeDaemon) -> tokio::task::JoinHandle<()> {
        let listener = UnixListener::bind(path).unwrap();
        let daemon = daemon.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (reader, writer) = stream.into_split();
                daemon.serve(reader, writer);
            }
        })
    }

    /// Nothing is sent either way; only a verdict says who is there.
    fn fails_closed(e: &ConnectError) -> bool {
        matches!(
            e,
            ConnectError::Untrusted(_) | ConnectError::Unverified { .. }
        )
    }

    fn refusing(why: &'static str) -> Verifier {
        Arc::new(move |_| Verdict::Refused(why.into()))
    }

    fn trusting() -> Verifier {
        Arc::new(|_| Verdict::Trusted)
    }

    fn fast_host(connector: ServerConnector, required: Required) -> RemoteHost {
        RemoteHost::new(
            Arc::new(connector),
            HostOptions {
                backoff_min: Duration::from_millis(20),
                backoff_max: Duration::from_millis(40),
                hello_timeout: Duration::from_secs(2),
                hooks: false,
                require: required,
                ..HostOptions::default()
            },
        )
    }

    fn config() -> HostConfig {
        HostConfig {
            client: "santree/test".into(),
            owner: "owner".into(),
            hook_cursor: None,
            boot_id: None,
        }
    }

    async fn status_is(host: &RemoteHost, what: &str, f: impl Fn(&HostStatus) -> bool) {
        let mut status = host.status();
        tokio::time::timeout(Duration::from_secs(10), status.wait_for(|s| f(s)))
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}: {:?}", host.current_status()))
            .unwrap();
    }

    #[tokio::test]
    async fn a_server_that_is_not_there_is_a_state_not_a_failure_to_explain() {
        let dir = scratch();
        let socket = dir.path().join("s.sock");
        let connector = ServerConnector::new(socket.clone(), Expect::UidOnly);
        // No file at all.
        assert_eq!(
            connector.connect().await.unwrap_err(),
            ConnectError::NotRunning
        );
        // A stale socket file nobody listens on (a server that died).
        crate::server::testkit::stale_socket(&socket);
        assert!(socket.exists());
        assert_eq!(
            connector.connect().await.unwrap_err(),
            ConnectError::NotRunning
        );
    }

    #[tokio::test]
    async fn a_peer_that_fails_verification_is_sent_nothing() {
        let dir = scratch();
        let socket = dir.path().join("s.sock");
        let recorder = Recorder::at(&socket);
        let connector = ServerConnector::new(socket, Expect::Team("TEAM123456".into()))
            .with_verifier(refusing("not signed by the team"));

        let err = connector.connect().await.unwrap_err();
        assert!(
            fails_closed(&err) && err.to_string().contains("not signed by the team"),
            "{err:?}"
        );
        assert!(err.permanent(), "an untrusted server is not retried fast");
        recorder.until_closed(1).await;
        assert_eq!(
            recorder.received(),
            Vec::<u8>::new(),
            "bytes before the verdict"
        );
    }

    #[tokio::test]
    async fn a_host_never_speaks_to_an_unverified_peer_not_even_hello() {
        let dir = scratch();
        let socket = dir.path().join("s.sock");
        let recorder = Recorder::at(&socket);
        let host = fast_host(
            ServerConnector::new(socket, Expect::Team("TEAM123456".into()))
                .with_verifier(refusing("signature does not match")),
            Required::Signed,
        );
        host.configure(Some(config()));
        status_is(
            &host,
            "refused",
            |s| matches!(s, HostStatus::Down(e) if fails_closed(e)),
        )
        .await;
        // Several attempts: each is judged, none is written to.
        until("a second attempt", 10, || {
            recorder.connections.load(Ordering::SeqCst) >= 2
        })
        .await;
        recorder.until_closed(2).await;
        assert_eq!(recorder.received(), Vec::<u8>::new());
        assert!(host.client().is_none());
        assert!(host.peer().is_none());
    }

    #[tokio::test]
    async fn a_trusted_peer_is_served_and_the_link_says_how_far_it_was_verified() {
        let dir = scratch();
        let socket = dir.path().join("s.sock");
        let daemon = FakeDaemon::new();
        let _server = serve_daemon(&socket, &daemon);

        let signed = fast_host(
            ServerConnector::new(socket.clone(), Expect::Team("TEAM123456".into()))
                .with_verifier(trusting()),
            Required::Signed,
        );
        signed.configure(Some(config()));
        status_is(&signed, "Connected", |s| {
            matches!(s, HostStatus::Connected { .. })
        })
        .await;
        assert_eq!(
            signed.peer(),
            Some(PeerTrust::Signed {
                team: "TEAM123456".into()
            })
        );
        assert!(signed.hello().is_some(), "hello was answered");

        // The real verifier, uid only: this test process is the peer.
        let uid_only = fast_host(
            ServerConnector::new(socket, Expect::UidOnly),
            Required::UidOnly,
        );
        uid_only.configure(Some(config()));
        status_is(&uid_only, "Connected", |s| {
            matches!(s, HostStatus::Connected { .. })
        })
        .await;
        assert_eq!(uid_only.peer(), Some(PeerTrust::UidOnly));
    }

    #[tokio::test]
    async fn a_socket_swapped_for_a_stranger_after_a_good_connect_gets_nothing_on_reconnect() {
        let dir = scratch();
        let socket = dir.path().join("s.sock");
        let daemon = FakeDaemon::new();
        let real = serve_daemon(&socket, &daemon);

        // The verdict follows who is on the socket now, as the real check does.
        let genuine = Arc::new(AtomicBool::new(true));
        let verifier: Verifier = {
            let genuine = genuine.clone();
            Arc::new(move |_| {
                if genuine.load(Ordering::SeqCst) {
                    Verdict::Trusted
                } else {
                    Verdict::Refused("a different program holds the socket".into())
                }
            })
        };
        let host = fast_host(
            ServerConnector::new(socket.clone(), Expect::Team("TEAM123456".into()))
                .with_verifier(verifier),
            Required::Signed,
        );
        host.configure(Some(config()));
        status_is(&host, "Connected", |s| {
            matches!(s, HostStatus::Connected { .. })
        })
        .await;

        // The server goes away and a stranger binds its path.
        genuine.store(false, Ordering::SeqCst);
        real.abort();
        std::fs::remove_file(&socket).unwrap();
        let stranger = Recorder::at(&socket);
        daemon.disconnect_all();

        status_is(
            &host,
            "refused after the swap",
            |s| matches!(s, HostStatus::Down(e) if fails_closed(e)),
        )
        .await;
        until("the host to re-verify more than once", 10, || {
            stranger.connections.load(Ordering::SeqCst) >= 2
        })
        .await;
        stranger.until_closed(2).await;
        assert_eq!(
            stranger.received(),
            Vec::<u8>::new(),
            "bytes to the stranger"
        );
        assert!(host.client().is_none());
    }

    #[tokio::test]
    async fn a_socket_file_that_is_not_the_users_own_plain_socket_is_refused() {
        let dir = scratch();
        let socket = dir.path().join("s.sock");
        let recorder = Recorder::at(&socket);

        // Owned by someone else (the check compares to the uid it was told).
        let other = ServerConnector::new(socket.clone(), Expect::UidOnly)
            .with_verifier(trusting())
            .with_owner(unsafe { libc::geteuid() } + 1);
        let err = other.connect().await.unwrap_err();
        assert!(
            matches!(&err, ConnectError::Untrusted(why) if why.contains("owned by uid")),
            "{err:?}"
        );

        // A symlink to a socket is not a socket file of ours.
        let link = dir.path().join("link.sock");
        std::os::unix::fs::symlink(&socket, &link).unwrap();
        let err = ServerConnector::new(link, Expect::UidOnly)
            .with_verifier(trusting())
            .connect()
            .await
            .unwrap_err();
        assert!(matches!(err, ConnectError::Untrusted(_)), "{err:?}");

        recorder.until_closed(2).await;
        assert_eq!(recorder.received(), Vec::<u8>::new());
    }

    #[test]
    fn only_a_verdict_is_a_definitive_refusal() {
        for verdict in [
            "uid 502 is not this user's (501)",
            "peer is not com.santree.server signed by team T: OSStatus -67050 (code failed to satisfy specified code requirement(s))",
            "peer is not com.santree.server signed by team T: OSStatus -67062 (code object is not signed at all)",
            "peer is not com.santree.server signed by team T: OSStatus -67034 (a sealed resource is missing or invalid)",
        ] {
            assert!(is_definitive_verdict(verdict), "{verdict}");
        }
        for not_a_verdict in [
            "uid of peer unreadable: Invalid argument (os error 22)",
            "peer is not com.santree.server signed by team T: peer audit token unreadable: Socket is not connected (os error 57)",
            "peer is not com.santree.server signed by team T: SecRequirementCreateWithString: OSStatus -67000",
            "team id \"A B\" is not [A-Za-z0-9.-]+",
        ] {
            assert!(!is_definitive_verdict(not_a_verdict), "{not_a_verdict}");
        }
    }

    #[tokio::test]
    async fn a_check_that_could_not_judge_is_untrusted_but_not_a_refusal() {
        let dir = scratch();
        let socket = dir.path().join("s.sock");
        let recorder = Recorder::at(&socket);
        let connect = |verifier: Verifier| {
            ServerConnector::new(socket.clone(), Expect::UidOnly)
                .with_verifier(verifier)
                .with_timeout(Duration::from_millis(100))
                .connect()
        };

        // Fail closed in every case; only a verdict is definitive.
        let panics = connect(Arc::new(|_| panic!("the signature library fell over")))
            .await
            .unwrap_err();
        assert!(
            matches!(panics, ConnectError::Unverified { slow: false, .. }),
            "{panics:?}"
        );

        let no_uid = connect(Arc::new(|_| {
            Verdict::Refused("uid of peer unreadable: EINVAL".into())
        }))
        .await
        .unwrap_err();
        assert!(
            matches!(no_uid, ConnectError::Unverified { slow: false, .. }),
            "{no_uid:?}"
        );

        let slow = connect(Arc::new(|_| {
            std::thread::sleep(Duration::from_millis(500));
            Verdict::Trusted
        }))
        .await
        .unwrap_err();
        assert!(
            matches!(slow, ConnectError::Unverified { slow: true, .. }),
            "{slow:?}"
        );

        let failed = connect(Arc::new(|_| {
            Verdict::Refused(
                "peer is not com.santree.server signed by team T: OSStatus -67050 (code failed to satisfy specified code requirement(s))"
                    .into(),
            )
        }))
        .await
        .unwrap_err();
        assert!(matches!(failed, ConnectError::Untrusted(_)), "{failed:?}");

        // The slow check finishes after its timeout and drops the connection
        // it owned; nothing was ever written to any of them.
        recorder.until_closed(4).await;
        assert_eq!(recorder.received(), Vec::<u8>::new());
    }

    /// The real check, against a real same-user process that is not the
    /// server: `nc` is signed by Apple, under another team and identifier — an
    /// agent squatting the socket. (Not this test binary: hashing a debug test
    /// binary for its signature takes longer than any real peer's.)
    #[tokio::test]
    async fn the_real_signature_check_refuses_a_same_user_process_that_is_not_the_server() {
        use std::process::{Command, Stdio};

        struct Kill(std::process::Child);
        impl Drop for Kill {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let dir = scratch();
        let socket = dir.path().join("s.sock");
        let received = dir.path().join("received");
        let squatter = Kill(
            Command::new("/usr/bin/nc")
                .arg("-lU")
                .arg(&socket)
                .stdin(Stdio::null())
                .stdout(std::fs::File::create(&received).unwrap())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        // The socket file appears before nc listens on it, so "it exists" is
        // not "it accepts": ask the connector itself until it gets past "not
        // running". Only a verdict on a live peer counts.
        let connector = ServerConnector::new(socket, Expect::Team("ABCDE12345".into()));
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let err = loop {
            match connector.connect().await {
                Err(ConnectError::NotRunning) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "the squatter never listened"
                    );
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(e) => break e,
                Ok(_) => panic!("a squatter was trusted as the server"),
            }
        };
        assert!(fails_closed(&err), "{err:?}");

        // nc ends when its client does, but whether it has by now is its own
        // business: give it a moment, then end it and read what it was sent.
        let mut squatter = squatter;
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while squatter.0.try_wait().unwrap().is_none() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        drop(squatter);
        assert_eq!(std::fs::read(&received).unwrap(), Vec::<u8>::new());
    }
}
