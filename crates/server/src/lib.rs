//! The local santree server: santree-host's PTY sessions on a unix socket, in
//! a process of their own, so a terminal and the agent in it outlive the app
//! that opened them — a quit, a crash, an update.
//!
//! The app launches it detached (`santree-server serve`) and talks protocol
//! v1 to it like to any other host. It runs nothing on its own: it opens a
//! session when asked, relays `pty.write`, replays a session to whoever
//! attaches, and retires once it holds neither sessions (live, or exited
//! and not yet reaped) nor clients.
//!
//! Who may connect is the app alone ([`peer`]): every agent in one of its
//! PTYs runs as the same user, and a socket that admitted them would let one
//! agent type into another's terminal.

pub mod endpoint;
mod ext;
pub mod logging;
pub mod peer;
mod sys;

use std::os::fd::{AsRawFd, RawFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use santree_host::{serve_conn, Caps, Host, HostOptions, Methods, Peer, BUILTIN_FEATURES};
use tokio::net::UnixStream;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{Notify, Semaphore};

use ext::ServerExt;
pub use ext::SERVER_FEATURES;
use peer::{Identity, Verdict};

/// The server's compatibility revision. Bumped whenever the server's code or
/// any crate it links changes; `revision.lock` and its drift test
/// (`tests/revision.rs`) hold that rule. An app runs the server revision it
/// bundles: one already running at that revision is the same server and is
/// adopted as is, sessions and all; one at another revision is left to drain.
pub const REVISION: u32 = 1;

/// The app's code-signing identifier: who the server admits.
pub const APP_IDENTIFIER: &str = "com.santree.desktop";
/// The server's own: who the app expects to find on the socket.
pub const SERVER_IDENTIFIER: &str = "com.santree.server";

/// `serve`'s exit code when another server of this revision already holds the
/// endpoint. The launcher connects to that one instead.
pub const EXIT_OCCUPIED: i32 = 20;
/// `serve`'s exit code when the server is code-signed and its launcher — the
/// peer on `--ready-fd` — is not santree.app, or there is no ready fd to ask;
/// and, signed or not, when the ready fd it was given is not an unnamed
/// socketpair end (a client socket connected to a named listener answers for
/// the listener's identity). A genuine server binary that an agent launches
/// serves nothing.
pub const EXIT_UNTRUSTED_LAUNCHER: i32 = 21;
/// `serve`'s exit code when a release build (its Team ID baked in,
/// `SANTREE_TEAM_ID`) can't confirm it is signed by that team. It would
/// otherwise admit peers by uid alone — any agent in any of its sessions.
pub const EXIT_UNVERIFIED_SELF: i32 = 22;

/// The Team ID a release build is signed with, baked in at build time.
/// Unset (every dev build), the server goes by whatever signature it has.
const BAKED_TEAM: Option<&str> = option_env!("SANTREE_TEAM_ID");

/// How often exited, unattached sessions are looked for, at most.
const REAP_EVERY: Duration = Duration::from_secs(60);
/// How long a shutdown waits for its connections to finish their last write
/// (each writer gets `santree_host`'s one second to drain).
const DRAIN: Duration = Duration::from_millis(1500);
/// Peer signature checks run at once. Each holds a blocking-pool thread for
/// about a quarter second; a same-user process connecting in a loop must not
/// take the pool the sessions' own handlers run on.
const MAX_CHECKS: usize = 4;
/// Connections accepted and still waiting for their peer check. Past this, a
/// new one is closed at once: each holds an fd and a task, and a same-user
/// process connecting in a loop must not run the server out of either.
const MAX_WAITING: usize = 32;
/// How often the server looks at its own endpoint ([`endpoint::Endpoint`]).
pub const ENDPOINT_CHECK: Duration = Duration::from_secs(3);

/// Connections accepted and not yet over — those still being verified among
/// them, which `Host::connection_count` does not count until they are served.
struct Admissions {
    open: AtomicUsize,
    /// Accepted and not yet past their peer check ([`MAX_WAITING`]).
    waiting: AtomicUsize,
    /// Connections are being turned away for [`MAX_WAITING`]: logged once,
    /// until the queue empties.
    overflowing: AtomicBool,
    /// Set once the server is going: a connection verified after it is
    /// closed instead of served.
    closing: AtomicBool,
    checks: Semaphore,
    /// Raised when a connection ends.
    changed: Notify,
}

impl Admissions {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            open: AtomicUsize::new(0),
            waiting: AtomicUsize::new(0),
            overflowing: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            checks: Semaphore::new(MAX_CHECKS),
            changed: Notify::new(),
        })
    }

    /// A place among the connections waiting for their peer check, or `Err`
    /// with whether this is the first turned away since the queue last
    /// emptied (the one worth logging).
    fn wait(self: &Arc<Self>) -> Result<Waiting, bool> {
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= MAX_WAITING {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return Err(!self.overflowing.swap(true, Ordering::SeqCst));
        }
        Ok(Waiting(self.clone()))
    }

    fn open(&self) -> usize {
        self.open.load(Ordering::SeqCst)
    }

    /// Counted from the accept, before the task that checks it exists, so
    /// there is no instant the idle check could miss it.
    fn enter(self: &Arc<Self>) -> Admitted {
        self.open.fetch_add(1, Ordering::SeqCst);
        Admitted(self.clone())
    }
}

/// One accepted connection, until it ends.
struct Admitted(Arc<Admissions>);

impl Drop for Admitted {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::SeqCst);
        self.0.changed.notify_one();
    }
}

/// One connection waiting for its peer check, until it has a verdict.
struct Waiting(Arc<Admissions>);

impl Drop for Waiting {
    fn drop(&mut self) {
        if self.0.waiting.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.overflowing.store(false, Ordering::SeqCst);
        }
    }
}

/// When an idle server retires.
#[derive(Debug, Clone, Copy)]
pub struct Idle {
    /// With no clients and no sessions for this long, after a client has
    /// connected at least once. A session that exited still counts until it
    /// is reaped: it holds how it ended, for the app to read when it is back.
    pub grace: Duration,
    /// …and for this long when none ever has: the launcher that started it
    /// died before connecting.
    pub initial: Duration,
    /// How long an exited session nobody is attached to is kept before the
    /// reaper closes it. Then, with nothing else held, the grace runs out.
    pub reap_after: Duration,
}

impl Default for Idle {
    fn default() -> Self {
        Self {
            grace: Duration::from_secs(10),
            initial: Duration::from_secs(120),
            reap_after: Duration::from_secs(60 * 60),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServeOptions {
    pub run_dir: PathBuf,
    /// The log, rotated; stderr when absent.
    pub log_file: Option<PathBuf>,
    /// The server's end of a unix socketpair the launcher holds the other
    /// end of: `ready <pid>` (or `occupied`) goes out on it, then it is
    /// closed. Required of a code-signed server, which asks it who launched
    /// it; an unsigned one may go without (a dev's manual run).
    pub ready_fd: Option<RawFd>,
    pub idle: Idle,
    /// Between looks at the socket and the lock, to restore what was removed
    /// ([`ENDPOINT_CHECK`] outside tests).
    pub endpoint_check: Duration,
}

/// How `serve` ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Served {
    /// Another server of this revision holds the endpoint.
    Occupied,
    /// Code-signed, and not launched by santree.app.
    UntrustedLauncher,
    /// Built to be signed by one team, and can't confirm it is.
    UnverifiedSelf,
    /// Idle: no clients, no sessions.
    Retired,
    /// `server.stop`.
    Stopped,
    /// SIGTERM or SIGINT.
    Signalled,
}

impl Served {
    pub fn exit_code(self) -> i32 {
        match self {
            Served::Occupied => EXIT_OCCUPIED,
            Served::UntrustedLauncher => EXIT_UNTRUSTED_LAUNCHER,
            Served::UnverifiedSelf => EXIT_UNVERIFIED_SELF,
            Served::Retired | Served::Stopped | Served::Signalled => 0,
        }
    }
}

/// `hello.features`: the host's own and the `server.*` methods.
pub fn features() -> Vec<String> {
    BUILTIN_FEATURES
        .iter()
        .chain(SERVER_FEATURES)
        .map(|f| f.to_string())
        .collect()
}

/// The host the server serves: PTYs only, sized for one trusted client.
pub fn host_options() -> HostOptions {
    let mut opts = HostOptions::local(env!("CARGO_PKG_VERSION"));
    opts.methods = Methods::PTY_ONLY;
    opts.features = features();
    // A session inherits what the app forwards and nothing of this process's
    // own environment, which is whatever launched the server.
    opts.require_base_env = true;
    opts.caps = Caps {
        max_ptys: 128,
        // One client, but it reconnects — a link it is replacing may not have
        // been torn down yet.
        max_conns_per_node: 16,
        ..Caps::default()
    };
    opts
}

/// Whose signature the server requires of its peers: its own team's, or
/// nobody's (uid only) when it has none. A build with `baked` in requires
/// exactly that team, and is refused rather than falling back to uid only.
fn expected_team(own: &Identity, baked: Option<&str>) -> Result<Option<String>, String> {
    match (own, baked) {
        (Identity::Signed { team }, Some(baked)) if team == baked => Ok(Some(team.clone())),
        (Identity::Signed { team }, Some(baked)) => Err(format!(
            "this server is signed by team {team}, but was built for team {baked}"
        )),
        (Identity::Unsigned, Some(baked)) => Err(format!(
            "this server was built for team {baked}, but its own signature can't be confirmed"
        )),
        (Identity::Signed { team }, None) => Ok(Some(team.clone())),
        (Identity::Unsigned, None) => Ok(None),
    }
}

/// A code-signed server serves only when santree.app launched it: the peer
/// on its ready socket, asked through `verify`. Unsigned (`team` None),
/// anyone may — the uid-only warning is the caller's.
///
/// A ready socket that is given is always an unnamed one (`unnamed`: a
/// socketpair end), signed or not: a client connected to a named listener
/// answers for the listener's identity, so a socket santree.app listens on
/// would otherwise vouch for whoever passes it.
fn check_launcher(
    ready: Option<RawFd>,
    team: Option<&str>,
    unnamed: impl FnOnce(RawFd) -> bool,
    verify: impl FnOnce(RawFd, &str) -> Verdict,
) -> Result<(), String> {
    if let Some(fd) = ready {
        if !unnamed(fd) {
            return Err(
                "its ready socket is not a socketpair end: its peer is a named socket, \
                        which answers for another process's identity"
                    .into(),
            );
        }
    }
    let Some(team) = team else {
        return Ok(());
    };
    let Some(fd) = ready else {
        return Err("a code-signed server needs --ready-fd: it asks its launcher who it is".into());
    };
    match verify(fd, team) {
        Verdict::Trusted => Ok(()),
        Verdict::Refused(why) => Err(format!("its launcher is not santree.app: {why}")),
    }
}

/// Run the server until it retires, is stopped, or is signalled. Takes the
/// process over: its standard fds, its session, its fd limit, its logger,
/// its signals.
pub fn serve(opts: ServeOptions) -> anyhow::Result<Served> {
    // Before any file is opened, in this order: a closed standard fd, or a
    // ready fd left closed, would otherwise be the number the next file
    // takes — the log, once, which then passed for the ready fd.
    sys::fill_standard_fds()?;
    let ready = opts
        .ready_fd
        .map(endpoint::ReadySocket::adopt)
        .transpose()?;
    sys::not_dumpable();
    sys::detach();
    sys::raise_fd_limit();
    logging::init(opts.log_file.as_deref())?;
    install_panic_log();

    let team = match expected_team(&peer::own_identity(), BAKED_TEAM) {
        Ok(team) => team,
        Err(why) => {
            log::error!("{why}; refusing to serve");
            return Ok(Served::UnverifiedSelf);
        }
    };
    if team.is_none() {
        log::warn!("this server is not code-signed: a connecting peer is checked by uid only");
    }
    // Before the endpoint is touched: a server an agent launched must not
    // even hold the lock against santree's own.
    let launcher = check_launcher(
        ready.as_ref().map(|r| r.fd()),
        team.as_deref(),
        endpoint::peer_is_unnamed,
        |fd, team| peer::verify(fd, Some(team), APP_IDENTIFIER),
    );
    if let Err(why) = launcher {
        log::error!("{why}; refusing to serve");
        return Ok(Served::UntrustedLauncher);
    }
    endpoint::prepare_run_dir(&opts.run_dir)?;
    let Some(held) = endpoint::take_lock(&opts.run_dir)? else {
        log::info!(
            "revision {REVISION}: another server holds {}; exiting",
            endpoint::lock_path(&opts.run_dir).display()
        );
        if let Some(ready) = ready {
            ready.send("occupied\n");
        }
        return Ok(Served::Occupied);
    };
    let (endpoint, listener) = endpoint::Endpoint::bind(&opts.run_dir, held)?;
    let endpoint = Arc::new(Mutex::new(endpoint));
    listener.set_nonblocking(true)?;

    let pid = std::process::id();
    log::info!(
        "santree-server {} revision {REVISION} (pid {pid}) serving {}",
        env!("CARGO_PKG_VERSION"),
        endpoint::socket_path(&opts.run_dir).display()
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("santree-server")
        .enable_all()
        .build()?;
    let watched = endpoint.clone();
    let served = runtime.block_on(async move {
        let listener = tokio::net::UnixListener::from_std(listener)?;
        let started_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        let ext = ServerExt::new(started_at_ms);
        let host = Host::new(host_options(), Some(ext.clone()));
        // Signals are caught before anyone can connect, and caught rather
        // than ignored: a disposition of SIG_IGN would pass to every PTY child.
        let signals = Signals::new()?;
        if let Some(ready) = ready {
            ready.send(&format!("ready {pid}\n"));
        }
        let admissions = Admissions::new();
        // The accept loop of the socket now bound; each time the endpoint is
        // restored it is replaced by the loop of the new one.
        let accepting = Arc::new(Mutex::new(vec![tokio::spawn(accept_loop(
            host.clone(),
            listener,
            team.clone(),
            admissions.clone(),
        ))]));
        let watching = tokio::spawn(watch_endpoint(
            watched,
            host.clone(),
            team,
            admissions.clone(),
            accepting.clone(),
            opts.endpoint_check,
        ));
        tokio::spawn(reaper(host.clone(), opts.idle.reap_after));
        let served = run(&host, &ext, &admissions, signals, opts.idle).await;
        // Nobody new is let in on the way out: a client that connected now
        // would be served by a server about to exit.
        admissions.closing.store(true, Ordering::SeqCst);
        watching.abort();
        for accept in accepting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            accept.abort();
        }
        shut_down(&host, &ext, &admissions, served).await;
        anyhow::Ok(served)
    })?;
    // The endpoint lock goes with the process; the socket file stays for the
    // next holder to replace (never unlinked here: it may already be theirs).
    drop(endpoint);
    // Blocking work still parked (a PTY input thread in a write) must not
    // hold the exit up.
    runtime.shutdown_timeout(Duration::from_millis(200));
    Ok(served)
}

/// A panic is caught per request by santree-host; this puts it in the log,
/// where someone will look, instead of a stderr nobody reads.
fn install_panic_log() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        log::logger().flush();
        default(info);
    }));
}

struct Signals {
    term: tokio::signal::unix::Signal,
    int: tokio::signal::unix::Signal,
    hup: tokio::signal::unix::Signal,
}

impl Signals {
    fn new() -> std::io::Result<Self> {
        Ok(Self {
            term: signal(SignalKind::terminate())?,
            int: signal(SignalKind::interrupt())?,
            hup: signal(SignalKind::hangup())?,
        })
    }
}

/// Accept until the process ends. A failed accept (out of fds) is logged and
/// retried after a pause instead of spinning.
async fn accept_loop(
    host: Arc<Host>,
    listener: tokio::net::UnixListener,
    team: Option<String>,
    admissions: Arc<Admissions>,
) {
    let team: Option<Arc<str>> = team.map(Into::into);
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let team = team.clone();
                accept_one(&host, stream, &admissions, move |fd| {
                    peer::verify(fd, team.as_deref(), APP_IDENTIFIER)
                });
            }
            Err(e) => {
                log::warn!("accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Look at the endpoint every `timing.check`, and accept on a new socket
/// whenever the old one was removed or replaced. Stops looking once the server
/// is closing: nothing new is let in then.
async fn watch_endpoint(
    endpoint: Arc<Mutex<endpoint::Endpoint>>,
    host: Arc<Host>,
    team: Option<String>,
    admissions: Arc<Admissions>,
    accepting: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    every: Duration,
) {
    loop {
        tokio::time::sleep(every).await;
        if admissions.closing.load(Ordering::SeqCst) {
            return;
        }
        let looking = endpoint.clone();
        let Ok(restored) = tokio::task::spawn_blocking(move || {
            looking
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .check(Instant::now())
        })
        .await
        else {
            continue;
        };
        let Some(listener) = restored else {
            continue;
        };
        let listener = listener
            .set_nonblocking(true)
            .and_then(|()| tokio::net::UnixListener::from_std(listener));
        match listener {
            Ok(listener) => {
                let next = tokio::spawn(accept_loop(
                    host.clone(),
                    listener,
                    team.clone(),
                    admissions.clone(),
                ));
                // The loop on the old socket is done: its listener (and fd) go
                // with it. Connections it accepted run in tasks of their own
                // (`admit`), so ending the loop touches none of them.
                let mut loops = accepting.lock().unwrap_or_else(|e| e.into_inner());
                for old in loops.drain(..) {
                    old.abort();
                }
                loops.push(next);
            }
            Err(e) => log::error!("can't accept on the restored socket: {e}"),
        }
    }
}

/// One accepted connection: closed at once when too many wait already, else
/// counted and handed to [`admit`].
fn accept_one<V>(host: &Arc<Host>, stream: UnixStream, admissions: &Arc<Admissions>, verify: V)
where
    V: FnOnce(RawFd) -> Verdict + Send + 'static,
{
    let waiting = match admissions.wait() {
        Ok(waiting) => waiting,
        Err(first) => {
            if first {
                log::warn!(
                    "{MAX_WAITING} connections are already waiting for their peer \
                     check; closing new ones until they clear"
                );
            }
            return;
        }
    };
    let admitted = admissions.enter();
    tokio::spawn(admit(host.clone(), stream, admitted, waiting, verify));
}

/// Serve `stream` if `verify` trusts its peer; close it unanswered if not.
/// Verified on the blocking pool, [`MAX_CHECKS`] at a time: the signature
/// check asks the OS.
async fn admit<V>(
    host: Arc<Host>,
    stream: UnixStream,
    admitted: Admitted,
    waiting: Waiting,
    verify: V,
) where
    V: FnOnce(RawFd) -> Verdict + Send + 'static,
{
    let admissions = admitted.0.clone();
    let fd = stream.as_raw_fd();
    let verdict = {
        // Never closed, so never an error; held across the check.
        let _permit = admissions.checks.acquire().await;
        // `stream` outlives the check, so `fd` stays this connection's.
        tokio::task::spawn_blocking(move || verify(fd))
            .await
            .unwrap_or_else(|e| Verdict::Refused(format!("the peer check panicked: {e}")))
    };
    let verdict = match verdict {
        Verdict::Trusted if admissions.closing.load(Ordering::SeqCst) => {
            Verdict::Refused("the server is closing".into())
        }
        verdict => verdict,
    };
    drop(waiting);
    match verdict {
        Verdict::Trusted => {
            let (reader, writer) = stream.into_split();
            let peer = Peer {
                node: "app".into(),
                addr: "local".into(),
            };
            serve_conn(host, reader, writer, peer).await;
        }
        Verdict::Refused(why) => log::warn!("refused a connection: {why}"),
    }
    drop(admitted);
}

/// Close the sessions that have been exited and unattached for `after`.
async fn reaper(host: Arc<Host>, after: Duration) {
    let mut every = tokio::time::interval((after / 4).clamp(Duration::from_millis(20), REAP_EVERY));
    loop {
        every.tick().await;
        let host = host.clone();
        let _ = tokio::task::spawn_blocking(move || host.reap(after)).await;
    }
}

/// Wait for the reason to stop: idle for its window, `server.stop`, or a
/// signal.
async fn run(
    host: &Arc<Host>,
    ext: &ServerExt,
    admissions: &Admissions,
    mut signals: Signals,
    idle: Idle,
) -> Served {
    // A session that exits on its own may not raise `changed`, so the state
    // is also looked at on a tick well inside the window.
    let tick =
        (idle.grace.min(idle.initial) / 4).clamp(Duration::from_millis(20), Duration::from_secs(1));
    let mut ever_connected = false;
    let mut idle_since = Some(Instant::now());
    loop {
        let clients = host.connection_count();
        ever_connected |= clients > 0;
        // `admissions` also counts a connection still being verified: the
        // app reconnecting at the end of the grace must not be cut off. An
        // exited session counts until the reaper closes it: retiring would
        // lose how it ended, and the app would read "server stopped".
        if clients > 0 || admissions.open() > 0 || host.held_sessions() > 0 {
            idle_since = None;
        } else {
            let since = *idle_since.get_or_insert_with(Instant::now);
            let window = if ever_connected {
                idle.grace
            } else {
                idle.initial
            };
            if since.elapsed() >= window {
                log::info!(
                    "no clients and no sessions for {}s; retiring",
                    window.as_secs_f32()
                );
                return Served::Retired;
            }
        }
        tokio::select! {
            _ = host.changed() => {}
            _ = admissions.changed.notified() => {}
            _ = tokio::time::sleep(tick) => {}
            _ = ext.stop.notified() => return Served::Stopped,
            _ = signals.term.recv() => {
                log::info!("SIGTERM: closing every session and exiting");
                return Served::Signalled;
            }
            _ = signals.int.recv() => {
                log::info!("SIGINT: closing every session and exiting");
                return Served::Signalled;
            }
            // Nothing to hang up on: the server has no terminal of its own.
            _ = signals.hup.recv() => log::info!("SIGHUP ignored"),
        }
    }
}

/// Close what is left, then let the connections finish their last write.
/// Retiring, nothing is held to close — unless a session was opened in the
/// instant after the idle check, and that one must not outlive the server
/// as an orphan.
async fn shut_down(host: &Arc<Host>, ext: &ServerExt, admissions: &Admissions, served: Served) {
    ext.release();
    let closing = host.clone();
    let _ = tokio::task::spawn_blocking(move || closing.close_all()).await;
    let deadline = Instant::now() + DRAIN;
    loop {
        // Again each round: a connection verified just before `closing` was
        // set may have registered after the last sweep. Waited out until
        // `admissions` lets go of it, not just `Host::connection_count`: a
        // connection leaves that table before its writer has drained what
        // was queued — `server.stop`'s own answer among it.
        host.disconnect_all();
        if (host.connection_count() == 0 && admissions.open() == 0) || Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    log::info!("exiting ({served:?})");
    log::logger().flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const HELLO: &str = r#"{"id":1,"m":"hello","p":{"protocol":1,"client":"test","owner":"o"}}"#;

    /// Send `hello` through `admit` with the given verdict; what comes back.
    async fn hello_through(verdict: Verdict) -> (Option<String>, Arc<Host>) {
        let host = Host::new(host_options(), None);
        let (ours, theirs) = UnixStream::pair().unwrap();
        let admissions = Admissions::new();
        let (admitted, waiting) = (admissions.enter(), admissions.wait().unwrap());
        let task = tokio::spawn(admit(host.clone(), theirs, admitted, waiting, move |_| {
            verdict
        }));
        let (read, mut write) = ours.into_split();
        // A refused peer may already be gone; only the answer counts.
        let _ = write.write_all(format!("{HELLO}\n").as_bytes()).await;
        let mut line = String::new();
        let mut read = BufReader::new(read);
        let got = tokio::time::timeout(Duration::from_secs(5), read.read_line(&mut line))
            .await
            .expect("the server neither answered nor closed");
        drop(write);
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        (
            (got.unwrap_or(0) > 0).then_some(line.trim_end().to_string()),
            host,
        )
    }

    #[tokio::test]
    async fn a_refused_peer_is_closed_unanswered() {
        let (answer, host) = hello_through(Verdict::Refused("not the app".into())).await;
        assert_eq!(answer, None, "a refused peer got an answer");
        assert!(host.connection_count() == 0);
    }

    #[tokio::test]
    async fn a_trusted_peer_is_served() {
        let (answer, _host) = hello_through(Verdict::Trusted).await;
        let answer = answer.expect("a trusted peer is answered");
        assert!(answer.starts_with(r#"{"id":1,"ok":"#), "{answer}");
        assert!(answer.contains(r#""server.stop""#), "{answer}");
    }

    #[tokio::test]
    async fn a_peer_verified_after_closing_is_not_served() {
        let host = Host::new(host_options(), None);
        let admissions = Admissions::new();
        admissions.closing.store(true, Ordering::SeqCst);
        let (ours, theirs) = UnixStream::pair().unwrap();
        let (admitted, waiting) = (admissions.enter(), admissions.wait().unwrap());
        admit(host.clone(), theirs, admitted, waiting, |_| {
            Verdict::Trusted
        })
        .await;
        assert!(host.connection_count() == 0);
        assert_eq!(admissions.open(), 0);
        let mut line = String::new();
        let (read, _write) = ours.into_split();
        let n = BufReader::new(read).read_line(&mut line).await.unwrap();
        assert_eq!(n, 0, "a closing server answered: {line}");
    }

    /// The app reconnecting at the end of the grace is still in its peer
    /// check (a quarter second, on macOS), so `Host::connection_count` does not
    /// see it yet: retiring then would cut it off.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_connection_being_verified_holds_off_retirement() {
        let host = Host::new(host_options(), None);
        let ext = ServerExt::new(0);
        let admissions = Admissions::new();
        let idle = Idle {
            grace: Duration::from_millis(50),
            initial: Duration::from_millis(50),
            reap_after: Duration::from_secs(60),
        };
        let checking = admissions.enter();
        let running = tokio::spawn({
            let (host, admissions) = (host.clone(), admissions.clone());
            async move { run(&host, &ext, &admissions, Signals::new().unwrap(), idle).await }
        });
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            !running.is_finished(),
            "retired under a connection being verified"
        );
        drop(checking);
        let served = tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .expect("it never retired")
            .unwrap();
        assert_eq!(served, Served::Retired);
    }

    #[test]
    fn connections_waiting_for_a_check_are_capped_and_logged_once_per_burst() {
        let admissions = Admissions::new();
        let mut waiting: Vec<Waiting> = (0..MAX_WAITING)
            .map(|_| admissions.wait().expect("under the cap"))
            .collect();
        assert_eq!(admissions.wait().err(), Some(true), "the first is logged");
        assert_eq!(admissions.wait().err(), Some(false), "the rest are not");
        // A place frees: one more gets in, and the burst goes on.
        waiting.pop();
        waiting.push(admissions.wait().expect("a freed place"));
        assert_eq!(admissions.wait().err(), Some(false));
        // The queue empties: the next burst is logged again.
        waiting.clear();
        assert_eq!(admissions.waiting.load(Ordering::SeqCst), 0);
        let again: Vec<Waiting> = (0..MAX_WAITING)
            .map(|_| admissions.wait().unwrap())
            .collect();
        assert_eq!(admissions.wait().err(), Some(true));
        drop(again);
    }

    #[test]
    fn a_release_build_serves_only_as_its_own_team() {
        let signed = |team: &str| Identity::Signed { team: team.into() };
        // Dev builds: whatever signature there is.
        assert_eq!(expected_team(&Identity::Unsigned, None), Ok(None));
        assert_eq!(
            expected_team(&signed("ABCDE12345"), None),
            Ok(Some("ABCDE12345".into()))
        );
        // A baked team: exactly that one, or nothing at all — never uid only.
        assert_eq!(
            expected_team(&signed("ABCDE12345"), Some("ABCDE12345")),
            Ok(Some("ABCDE12345".into()))
        );
        assert!(expected_team(&Identity::Unsigned, Some("ABCDE12345")).is_err());
        assert!(expected_team(&signed("ZZZZZ99999"), Some("ABCDE12345")).is_err());
        assert!(expected_team(&signed("ABCDE12345"), Some("")).is_err());
    }

    #[test]
    fn a_signed_server_serves_only_for_santree_app() {
        let trusted = |_: RawFd, _: &str| Verdict::Trusted;
        let refused = |_: RawFd, _: &str| Verdict::Refused("not the app".into());
        let unnamed = |_: RawFd| true;
        // Unsigned: nobody to ask, and no need for a ready fd.
        assert_eq!(check_launcher(None, None, unnamed, refused), Ok(()));
        assert_eq!(check_launcher(Some(3), None, unnamed, refused), Ok(()));
        // Signed: the launcher on the ready socket must be the app.
        assert_eq!(check_launcher(Some(3), Some("T"), unnamed, trusted), Ok(()));
        let why = check_launcher(Some(3), Some("T"), unnamed, refused).unwrap_err();
        assert!(why.contains("not the app"), "{why}");
        let mut asked = None;
        let _ = check_launcher(Some(7), Some("TEAM"), unnamed, |fd, team| {
            asked = Some((fd, team.to_string()));
            Verdict::Trusted
        });
        assert_eq!(asked, Some((7, "TEAM".into())), "the ready fd, as the team");
        // …and there must be one to ask.
        let why = check_launcher(None, Some("T"), unnamed, trusted).unwrap_err();
        assert!(why.contains("--ready-fd"), "{why}");
    }

    /// A named ready socket is refused before anyone is asked who is on it,
    /// signed or not — whatever the identity check would have said.
    #[test]
    fn a_named_ready_socket_is_refused_signed_or_not() {
        let named = |_: RawFd| false;
        let must_not_ask = |_: RawFd, _: &str| -> Verdict { panic!("asked a named socket") };
        for team in [None, Some("T")] {
            let why = check_launcher(Some(3), team, named, must_not_ask).unwrap_err();
            assert!(why.contains("not a socketpair end"), "{why}");
        }
    }

    #[test]
    fn the_hello_names_the_server_methods_and_base_env() {
        let features = features();
        for name in [
            "pty.baseEnv",
            "server.info",
            "server.keepAwake",
            "server.stop",
        ] {
            assert!(features.iter().any(|f| f == name), "{name} missing");
        }
    }
}
