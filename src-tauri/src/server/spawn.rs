//! Installing and launching the server binary.
//!
//! The app copies the bundled `santree-server` to `<rev_dir>/santree-server`
//! (so an app update that replaces the bundle can't swap the executable out
//! from under a running server — a replaced running exe fails the peer check)
//! and launches *that* copy, detached, with nothing of the app's environment:
//! the server is a long-lived process every agent descends from, so what it
//! was started with is what a bug could leak into all of them.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Seek};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use tokio::sync::{oneshot, watch};

use santree_server::{endpoint, EXIT_UNTRUSTED_LAUNCHER, EXIT_UNVERIFIED_SELF};

use super::layout::{plain_u32, Layout};
use super::lock::{lock_beside, probe_lock, EndpointLock};
use crate::bundled_bin::{self, Installed};

/// How long a launched server has to say it is ready. Generous: the first run of
/// a freshly copied binary is scanned by the OS before it executes, and that has
/// taken seconds on a loaded machine; a server that is simply broken exits, and
/// is heard at once, so this only bounds one that hangs.
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// What the server's environment is, besides its `PATH`: the identity and
/// locale a process needs to find its way around, and nothing else. A session's
/// environment is built per open by the app (`sessions::env`); the server's own
/// is never one of its inputs.
const SERVER_ENV: [&str; 5] = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"];

/// The server's `PATH`: system tools only. Whatever shell the user's agents run
/// gets its own `PATH` from the app's `baseEnv`.
const SERVER_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// The installed binary's name in its revision's dir.
const BIN_NAME: &str = "santree-server";

/// The fd number the server finds its ready socket on.
const READY_FD: i32 = 3;

/// Longest ready line read: `ready <pid>\n` is a dozen bytes.
const READY_LINE_MAX: usize = 64;

/// What of the server's stderr is kept for an error message.
const STDERR_TAIL: u64 = 4096;

/// A server command with an environment of its own: cleared, then the few
/// names in [`SERVER_ENV`] looked up through `ambient` and a fixed `PATH`;
/// working directory `/`, stdin and stdout null, its own process group.
/// `ambient` is the process environment in production and a fixture in tests.
fn isolated_command(
    program: &Path,
    ambient: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear();
    for name in SERVER_ENV {
        if let Some(value) = ambient(name) {
            cmd.env(name, value);
        }
    }
    cmd.env("PATH", SERVER_PATH)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Out of the app's process group: a signal to the app (Ctrl-C in a
        // terminal `pnpm dev`, a group kill) must not reach it. The server
        // calls setsid() itself, which is the real detachment.
        .process_group(0);
    cmd
}

// ── installing ──────────────────────────────────────────────────────────────

/// Put the bundled binary at `layout.bin` ([`bundled_bin::install_copy`]:
/// atomic, 0755, only when the bytes differ, never written through a symlink).
/// `None`: a server is answering on the socket, so nothing is written (a
/// running executable is never replaced: the replacement would fail the peer
/// check the app makes on it) and nothing is to be launched — the caller
/// connects.
pub fn install_binary(layout: &Layout, bundled: &Path) -> Result<Option<Installed>> {
    // First: whether a server answers decides what the caller does next.
    if server_answers(&layout.socket_for(santree_server::REVISION)) {
        return Ok(None);
    }
    bundled_bin::sweep_stale_tmp(&layout.rev_dir, BIN_NAME, bundled_bin::STALE_TMP);
    bundled_bin::install_copy(bundled, &layout.rev_dir, BIN_NAME).map(Some)
}

/// Whether something accepts connections on `socket`. A connect that is closed
/// at once: the server sees a peer come and go and says nothing.
pub(super) fn server_answers(socket: &Path) -> bool {
    UnixStream::connect(socket).is_ok()
}

/// The revision in an install dir's name, `r<N>`.
fn parse_install_dir(name: &str) -> Option<u32> {
    plain_u32(name.strip_prefix('r')?)
}

/// Remove the install dirs (`<root>/r<N>`) and the stale endpoint files
/// (`server-r<N>.{sock,lock}`) of revisions that are over: older than `current`,
/// not in `keep` (the draining servers), nothing holding their endpoint lock
/// and nothing answering on their socket. Each copy of the server is a few MB
/// and every update leaves one behind.
///
/// Only a plain directory this user owns, named exactly `r<N>`, is removed
/// (never followed through a symlink); a revision whose lock is held, or whose
/// socket answers, is a server that is still running and is left alone whole.
/// Returns the revisions pruned.
pub fn prune_old_revisions(layout: &Layout, current: u32, keep: &[u32]) -> Vec<u32> {
    let Ok(entries) = fs::read_dir(&layout.root) else {
        return Vec::new();
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    let mut pruned = Vec::new();
    for entry in entries.flatten() {
        let Some(revision) = entry.file_name().to_str().and_then(parse_install_dir) else {
            continue;
        };
        if revision >= current || keep.contains(&revision) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.is_dir() || meta.uid() != me {
            continue;
        }
        let endpoints: Vec<(PathBuf, PathBuf)> = layout
            .run_dirs()
            .into_iter()
            .map(|run| {
                let socket = run.join(endpoint::socket_name(revision));
                (lock_beside(&socket, revision), socket)
            })
            .collect();
        let running = endpoints
            .iter()
            .any(|(lock, socket)| probe_lock(lock) == EndpointLock::Held || server_answers(socket));
        if running {
            continue;
        }
        if let Err(e) = fs::remove_dir_all(entry.path()) {
            log::warn!(
                "santree server: can't remove the old install {}: {e}",
                entry.path().display()
            );
            continue;
        }
        for (lock, socket) in &endpoints {
            for stale in [socket, lock] {
                // A plain socket or file of ours; whatever else is there is not
                // this app's to delete.
                if fs::symlink_metadata(stale).is_ok_and(|m| m.uid() == me && !m.is_dir()) {
                    let _ = fs::remove_file(stale);
                }
            }
        }
        log::info!("santree server: removed the old install r{revision}");
        pruned.push(revision);
    }
    pruned.sort_unstable();
    pruned
}

/// The binary is something the app may execute: a plain file this user owns
/// that nobody else can write.
pub fn validate_binary(bin: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(bin)
        .with_context(|| format!("the santree server isn't installed at {}", bin.display()))?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.is_file() {
        bail!("{} is not a plain file", bin.display());
    }
    if meta.uid() != me {
        bail!("{} belongs to uid {}, not {me}", bin.display(), meta.uid());
    }
    if meta.mode() & 0o022 != 0 || meta.mode() & 0o100 == 0 {
        bail!(
            "{} must be executable and writable by its owner alone (mode {:o})",
            bin.display(),
            meta.mode() & 0o777
        );
    }
    Ok(())
}

// ── launching ───────────────────────────────────────────────────────────────

/// How the server's launch ended, as far as the launcher can tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Start {
    /// `ready <pid>`: serving.
    Ready { pid: u32 },
    /// `occupied`: another server of this revision holds the endpoint.
    Occupied,
    /// It ended without (or right after) a ready line.
    Exited(ExitInfo),
    /// Nothing, in time: it was killed.
    TimedOut,
    /// A line that is not the protocol: it was killed.
    Garbled,
}

/// How a process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl ExitInfo {
    /// A sentence for the Down state; `stderr` is the tail the server wrote.
    pub fn describe(&self, stderr: &str) -> String {
        match (self.code, self.signal) {
            (Some(EXIT_UNTRUSTED_LAUNCHER), _) => {
                "santree server refused to start: it was not launched by santree".into()
            }
            (Some(EXIT_UNVERIFIED_SELF), _) => {
                "santree server is not signed by the expected team".into()
            }
            (code, signal) => {
                let how = match (code, signal) {
                    (Some(code), _) => format!("exited with code {code}"),
                    (None, Some(signal)) => format!("was killed by signal {signal}"),
                    (None, None) => "stopped".into(),
                };
                if stderr.is_empty() {
                    format!("the santree server {how} while starting")
                } else {
                    format!("the santree server {how} while starting: {stderr}")
                }
            }
        }
    }
}

enum ReadyRead {
    Line(String),
    Closed,
    Timeout,
}

/// A launched server: its ready handshake, and its fate once reaped.
pub struct Spawned {
    pub pid: u32,
    ready: Option<oneshot::Receiver<ReadyRead>>,
    exit: watch::Receiver<Option<ExitInfo>>,
    reaped: Arc<AtomicBool>,
    stderr: PathBuf,
    /// Where this launch's output begins in the (appended-to) stderr file.
    stderr_from: u64,
}

impl std::fmt::Debug for Spawned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Spawned").field("pid", &self.pid).finish()
    }
}

impl Spawned {
    /// Wait for the server to say how it started.
    pub async fn start(&mut self) -> Start {
        let Some(ready) = self.ready.take() else {
            return Start::Garbled;
        };
        // The reader has its own deadline; this one only covers a reader that
        // never answers at all.
        match tokio::time::timeout(READY_WAIT_SLACK + READY_TIMEOUT_MAX, ready).await {
            Ok(Ok(ReadyRead::Line(line))) => match parse_ready(&line) {
                Some(start) => start,
                None => {
                    self.kill();
                    Start::Garbled
                }
            },
            // No line, and the socket closed: the server is gone or going. Its
            // exit code says which.
            Ok(Ok(ReadyRead::Closed)) => match self.exited(Duration::from_secs(2)).await {
                Some(exit) => Start::Exited(exit),
                None => {
                    self.kill();
                    Start::TimedOut
                }
            },
            Ok(Ok(ReadyRead::Timeout)) | Ok(Err(_)) | Err(_) => {
                self.kill();
                Start::TimedOut
            }
        }
    }

    /// How the process ended, once it has; waits up to `within` for it to.
    pub async fn exited(&self, within: Duration) -> Option<ExitInfo> {
        let mut exit = self.exit.clone();
        let waited = tokio::time::timeout(within, exit.wait_for(|e| e.is_some())).await;
        match waited {
            Ok(Ok(seen)) => *seen,
            _ => None,
        }
    }

    /// How the process ended, if it has.
    pub fn exit(&self) -> Option<ExitInfo> {
        *self.exit.borrow()
    }

    /// SIGKILL it, unless it has already been reaped (its pid could be anyone's
    /// by then).
    pub fn kill(&self) {
        if !self.reaped.load(Ordering::SeqCst) {
            // SAFETY: kill on a pid this process spawned and has not reaped.
            unsafe {
                libc::kill(self.pid as i32, libc::SIGKILL);
            }
        }
    }

    /// The last of what the server wrote to stderr, for an error message.
    pub fn stderr_tail(&self) -> String {
        stderr_tail(&self.stderr, self.stderr_from)
    }
}

/// Slack on top of the reader's own deadline.
const READY_WAIT_SLACK: Duration = Duration::from_secs(2);
/// The longest ready timeout any caller passes; bounds the outer wait.
const READY_TIMEOUT_MAX: Duration = READY_TIMEOUT;

fn parse_ready(line: &str) -> Option<Start> {
    if line == "occupied" {
        return Some(Start::Occupied);
    }
    let pid = line.strip_prefix("ready ")?.parse::<u32>().ok()?;
    Some(Start::Ready { pid })
}

/// The server's stderr file.
fn stderr_path(layout: &Layout) -> PathBuf {
    layout.log.with_extension("stderr")
}

/// Launch the installed server: `serve --run-dir --log-file --ready-fd 3`.
///
/// The file is checked to be a plain executable of ours that only we can write
/// ([`validate_binary`]); what it is, is decided later and by the other end:
/// the app sends nothing to a server whose signature `peer::verify` doesn't
/// confirm on the connected fd, and a signed server serves only when santree.app
/// launched it.
pub fn spawn_server(layout: &Layout) -> Result<Spawned> {
    validate_binary(&layout.bin)?;
    let mut cmd = isolated_command(&layout.bin, |name| std::env::var_os(name));
    cmd.args(server_args(layout));
    spawn_child(cmd, stderr_path(layout), READY_TIMEOUT)
}

/// The arguments the server is started with, after its own path.
fn server_args(layout: &Layout) -> Vec<std::ffi::OsString> {
    vec![
        "serve".into(),
        "--run-dir".into(),
        layout.run.clone().into_os_string(),
        "--log-file".into(),
        layout.log.clone().into_os_string(),
        "--ready-fd".into(),
        READY_FD.to_string().into(),
    ]
}

/// The most of the server's stderr file kept between launches. It is appended
/// to (each launch's tail is read from where that launch began) and cut back to
/// nothing past this, so it can't grow without limit.
const STDERR_KEEP: u64 = 64 * 1024;

/// Open `path` as a server's stderr: a plain file of ours, never a FIFO or a
/// device someone planted there. Opened without blocking and without following
/// a symlink, then checked on the descriptor it returned (a FIFO with no reader
/// would otherwise hang the open, and one with a reader would be written to).
/// Returns the file and the offset this launch's output starts at.
fn open_stderr(path: &Path) -> Result<(File, u64)> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .with_context(|| format!("can't open {}", path.display()))?;
    let meta = file.metadata()?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.is_file() || meta.uid() != me {
        bail!("{} is not a plain file of ours", path.display());
    }
    // The flag is shared with the child's copy; a regular file ignores it, but
    // nothing downstream should inherit a non-blocking stderr.
    // SAFETY: fcntl on an fd we own.
    unsafe {
        let flags = libc::fcntl(file.as_raw_fd(), libc::F_GETFL);
        if flags >= 0 {
            libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK);
        }
    }
    let mut start = meta.len();
    if start > STDERR_KEEP {
        file.set_len(0)?;
        start = 0;
    }
    Ok((file, start))
}

/// `fd`, moved above the standard streams if the process was started with any
/// of them closed (a descriptor that is 0-2 would be overwritten by the child's
/// own stdio setup before `exec`).
fn above_stdio(fd: OwnedFd) -> Result<OwnedFd> {
    if fd.as_raw_fd() > 2 {
        return Ok(fd);
    }
    // SAFETY: F_DUPFD_CLOEXEC on an fd we own returns a new fd or -1.
    let moved = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if moved < 0 {
        return Err(std::io::Error::last_os_error()).context("can't move a descriptor");
    }
    // SAFETY: `moved` is a fresh fd nothing else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(moved) })
}

/// The highest descriptor number worth closing after fork: the process's soft
/// limit, bounded.
fn fd_ceiling() -> i32 {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid out-pointer.
    let rc = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) };
    if rc != 0 || limit.rlim_cur == libc::RLIM_INFINITY {
        return 1 << 16;
    }
    limit.rlim_cur.min(1 << 16) as i32
}

/// Launch `cmd` with one end of a fresh unix socketpair on [`READY_FD`], its
/// stderr in `stderr_file`, and reader/reaper threads for the handshake and the
/// exit.
fn spawn_child(mut cmd: Command, stderr_file: PathBuf, ready_timeout: Duration) -> Result<Spawned> {
    let (stderr, stderr_from) = open_stderr(&stderr_file)?;
    cmd.stderr(Stdio::from(above_stdio(OwnedFd::from(stderr))?));

    // A socketpair, not a pipe: the server asks its launcher who it is, and
    // only a socket can be asked. Both ends are close-on-exec; the child's is
    // placed on a fixed fd between fork and exec, so a process this app spawns
    // concurrently doesn't get it from us. That is NOT a promise about every
    // descriptor: one some library opened without close-on-exec, or that is in
    // the window between an `open` and its `fcntl` on another thread, would be
    // inherited by the server — and held for as long as it lives. So everything
    // above the ready fd is closed in the child, below.
    let (mine, theirs) = UnixStream::pair().context("can't make the ready socketpair")?;
    let mine = above_stdio(OwnedFd::from(mine))?;
    let theirs = above_stdio(OwnedFd::from(theirs))?;
    let their_fd = theirs.as_raw_fd();
    let ceiling = fd_ceiling();
    // SAFETY: the closure runs between fork and exec and calls only
    // async-signal-safe functions (dup2, fcntl, close); it allocates nothing.
    unsafe {
        cmd.pre_exec(move || {
            // dup2 onto itself would leave close-on-exec set.
            let rc = if their_fd == READY_FD {
                libc::fcntl(READY_FD, libc::F_SETFD, 0)
            } else {
                libc::dup2(their_fd, READY_FD)
            };
            if rc < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Bounded, and an already-closed number is just EBADF.
            let mut fd = READY_FD + 1;
            while fd < ceiling {
                libc::close(fd);
                fd += 1;
            }
            Ok(())
        });
    }
    let child = cmd
        .spawn()
        .with_context(|| format!("can't launch {}", cmd.get_program().to_string_lossy()))?;
    drop(theirs);
    let pid = child.id();
    // Shared with the reaper so a failure to start it can still end the child.
    let child = Arc::new(Mutex::new(Some(child)));
    let end_child = |child: &Mutex<Option<std::process::Child>>| {
        if let Some(mut child) = child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    };

    let (ready_tx, ready_rx) = oneshot::channel();
    let deadline = Instant::now() + ready_timeout;
    let mine = UnixStream::from(mine);
    if let Err(e) = std::thread::Builder::new()
        .name("server-ready".into())
        .spawn(move || {
            let _ = ready_tx.send(read_ready(mine, deadline));
        })
    {
        end_child(&child);
        return Err(e).context("can't start the ready reader");
    }

    let (exit_tx, exit_rx) = watch::channel(None);
    let reaped = Arc::new(AtomicBool::new(false));
    let reaper = std::thread::Builder::new()
        .name("server-reaper".into())
        .spawn({
            let (reaped, child) = (reaped.clone(), child.clone());
            move || {
                let taken = child.lock().unwrap_or_else(|e| e.into_inner()).take();
                let info = match taken.map(|mut c| c.wait()) {
                    Some(Ok(status)) => ExitInfo {
                        code: status.code(),
                        signal: status.signal(),
                    },
                    _ => ExitInfo {
                        code: None,
                        signal: None,
                    },
                };
                reaped.store(true, Ordering::SeqCst);
                let _ = exit_tx.send(Some(info));
            }
        });
    if let Err(e) = reaper {
        end_child(&child);
        return Err(anyhow!("can't start the reaper: {e}"));
    }

    Ok(Spawned {
        pid,
        ready: Some(ready_rx),
        exit: exit_rx,
        reaped,
        stderr: stderr_file,
        stderr_from,
    })
}

/// One line off the ready socket, byte by byte so nothing past it is taken,
/// against a deadline. Waits with `poll` rather than a socket read timeout:
/// macOS refuses `SO_RCVTIMEO` on a unix socket whose peer has already hung up,
/// which is exactly how a server that wrote its line and closed looks.
fn read_ready(mut sock: UnixStream, deadline: Instant) -> ReadyRead {
    let mut line = Vec::with_capacity(32);
    let mut byte = [0u8; 1];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return ReadyRead::Timeout;
        }
        let mut pfd = libc::pollfd {
            fd: sock.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let millis = left.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: one valid pollfd, and a count of one.
        match unsafe { libc::poll(&mut pfd, 1, millis.max(1)) } {
            0 => return ReadyRead::Timeout,
            n if n < 0 => {
                if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                    continue;
                }
                return ReadyRead::Closed;
            }
            _ => {}
        }
        // Readable (a byte, or the end of the stream): this read can't block.
        match sock.read(&mut byte) {
            Ok(0) if line.is_empty() => return ReadyRead::Closed,
            Ok(0) => return ReadyRead::Line(String::from_utf8_lossy(&line).into_owned()),
            Ok(_) if byte[0] == b'\n' => {
                return ReadyRead::Line(String::from_utf8_lossy(&line).into_owned())
            }
            Ok(_) if line.len() >= READY_LINE_MAX => {
                return ReadyRead::Line(String::from_utf8_lossy(&line).into_owned())
            }
            Ok(_) => line.push(byte[0]),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return ReadyRead::Closed,
        }
    }
}

/// The last few lines of `path`, on one line, bounded.
fn stderr_tail(path: &Path, from: u64) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file
        .seek(std::io::SeekFrom::Start(
            len.saturating_sub(STDERR_TAIL).max(from),
        ))
        .is_err()
    {
        return String::new();
    }
    let mut text = String::new();
    // Lossy: a stderr cut mid-character is still worth showing.
    let mut bytes = Vec::new();
    if file.take(STDERR_TAIL).read_to_end(&mut bytes).is_ok() {
        text = String::from_utf8_lossy(&bytes).into_owned();
    }
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" | ");
    let mut out: String = tail.chars().take(400).collect();
    if tail.chars().count() > 400 {
        out.push('…');
    }
    out
}

/// `<bundled> version --json` and its revision must be the one this app was
/// built against: what CI's smoke launch asserts about the signed bundle, with
/// no server started and no socket touched.
pub fn smoke_assert(bundled: &Path) -> Result<()> {
    smoke_assert_within(bundled, SMOKE_VERIFY)
}

/// How long `version --json` may take in the release smoke. The run executes a
/// binary that was just signed and notarized for the first time on a loaded
/// runner, and macOS scans a binary's first execution (it has taken seconds under
/// load); the smoke's own watchdog is 90 s, so this is generous on purpose and
/// only guards a binary that hangs.
pub const SMOKE_VERIFY: Duration = Duration::from_secs(10);

/// [`smoke_assert`] with the bound the caller chose (tests: generous for a script
/// that has to be started under load, short for the one that hangs).
fn smoke_assert_within(bundled: &Path, within: Duration) -> Result<()> {
    let mut cmd = isolated_command(bundled, |name| std::env::var_os(name));
    cmd.args(["version", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .with_context(|| format!("can't run {} version", bundled.display()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("no stdout from santree-server version"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = std::io::Read::by_ref(&mut stdout)
            .take(64 * 1024)
            .read_to_end(&mut out);
        let _ = tx.send(out);
    });
    let out = match rx.recv_timeout(within) {
        Ok(out) => out,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            bail!("santree-server version didn't answer in {within:?}");
        }
    };
    let status = child.wait()?;
    if !status.success() {
        bail!("santree-server version failed ({status})");
    }
    let json: serde_json::Value =
        serde_json::from_slice(&out).context("santree-server version is not JSON")?;
    let revision = json.get("revision").and_then(serde_json::Value::as_u64);
    if revision != Some(u64::from(santree_server::REVISION)) {
        bail!(
            "the bundled santree-server is revision {revision:?}, this app needs {}",
            santree_server::REVISION
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::OsString;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    use santree_server::EXIT_OCCUPIED;

    use crate::server::testkit::{self, hold_exclusive, script, Fixture};
    use crate::sessions::Mode;

    #[test]
    fn the_server_gets_a_cleared_environment_and_nothing_of_the_apps() {
        let dir = testkit::scratch();
        let env_bin = Path::new("/usr/bin/env");
        let ambient = |name: &str| -> Option<OsString> {
            Some(
                match name {
                    "HOME" => "/Users/test",
                    "USER" => "test",
                    "LOGNAME" => "test",
                    "TMPDIR" => "/var/tmp/x/",
                    "LANG" => "en_US.UTF-8",
                    // Not in the allow-list: must never be looked up at all.
                    "SANTREE_TOKEN" | "GITHUB_TOKEN" | "PATH" | "CLAUDECODE" => {
                        panic!("{name} was read from the app's environment")
                    }
                    _ => return None,
                }
                .into(),
            )
        };
        let mut cmd = isolated_command(env_bin, ambient);
        cmd.stdout(Stdio::piped());
        // The test process's own environment (CARGO_*, PATH, …) is what must
        // not come through.
        let out = cmd.output().unwrap();
        let printed = String::from_utf8(out.stdout).unwrap();
        let mut names: Vec<&str> = printed
            .lines()
            .filter_map(|l| l.split('=').next())
            .collect();
        names.sort_unstable();
        assert_eq!(
            names,
            ["HOME", "LANG", "LOGNAME", "PATH", "TMPDIR", "USER"],
            "{printed}"
        );
        assert!(printed.contains("PATH=/usr/bin:/bin:/usr/sbin:/sbin"));
        drop(dir);
    }

    #[test]
    fn the_server_runs_in_root_with_null_stdio_and_its_own_process_group() {
        let dir = testkit::scratch();
        let probe = script(
            dir.path(),
            "probe.sh",
            "pwd; ps -o pgid= -p $$; ps -o pid= -p $$; cat /dev/stdin | wc -c",
        );
        let mut cmd = isolated_command(&probe, |_| None);
        cmd.stdout(Stdio::piped());
        let out = cmd.output().unwrap();
        let printed = String::from_utf8(out.stdout).unwrap();
        let mut lines = printed.lines().map(str::trim);
        assert_eq!(lines.next(), Some("/"));
        let pgid = lines.next().unwrap();
        let pid = lines.next().unwrap();
        assert_eq!(pgid, pid, "its own process group leader");
        assert_eq!(lines.next(), Some("0"), "stdin is /dev/null");
    }

    #[tokio::test]
    async fn the_launcher_reads_ready_exit_codes_and_gives_up_on_silence() {
        let dir = testkit::scratch();
        let stderr = dir.path().join("e");
        let launch = |body: &str, timeout: Duration| {
            let sh = script(dir.path(), "s.sh", body);
            let mut cmd = isolated_command(&sh, |_| None);
            cmd.arg("serve");
            spawn_child(cmd, stderr.clone(), timeout).unwrap()
        };

        // The ready socket is fd 3 in the child.
        let mut ready = launch("echo 'ready 4242' >&3; sleep 5", Duration::from_secs(60));
        assert_eq!(ready.start().await, Start::Ready { pid: 4242 });
        ready.kill();
        assert!(ready.exited(Duration::from_secs(60)).await.is_some());

        // Written and gone at once, as the real server does: macOS refuses a
        // socket option on a unix socket whose peer has hung up, which once made
        // a server that was ready read as "didn't start".
        let mut quick = launch("echo 'ready 7' >&3", Duration::from_secs(60));
        assert_eq!(quick.start().await, Start::Ready { pid: 7 });

        let mut occupied = launch("echo occupied >&3; exit 20", Duration::from_secs(60));
        assert_eq!(occupied.start().await, Start::Occupied);

        let mut refused = launch("echo 'bad launcher' >&2; exit 21", Duration::from_secs(60));
        let Start::Exited(exit) = refused.start().await else {
            panic!("expected an exit")
        };
        assert_eq!(exit.code, Some(21));
        assert!(exit.describe("").contains("not launched by santree"));

        let mut garbled = launch("echo 'hello there' >&3; sleep 5", Duration::from_secs(60));
        assert_eq!(garbled.start().await, Start::Garbled);
        assert!(
            garbled.exited(Duration::from_secs(60)).await.is_some(),
            "killed"
        );

        // Silence is bounded and the silent child does not outlive it.
        let mut silent = launch("sleep 30", Duration::from_millis(200));
        assert_eq!(silent.start().await, Start::TimedOut);
        let exit = silent
            .exited(Duration::from_secs(60))
            .await
            .expect("killed");
        assert_eq!(exit.signal, Some(libc::SIGKILL));
    }

    #[test]
    fn exit_codes_read_as_the_documented_reasons() {
        let code = |code| ExitInfo {
            code: Some(code),
            signal: None,
        };
        assert_eq!(
            code(21).describe("ignored"),
            "santree server refused to start: it was not launched by santree"
        );
        assert_eq!(
            code(22).describe("ignored"),
            "santree server is not signed by the expected team"
        );
        assert!(code(1).describe("can't bind").ends_with("can't bind"));
        assert!(ExitInfo {
            code: None,
            signal: Some(9)
        }
        .describe("")
        .contains("signal 9"));
    }

    #[test]
    fn stderr_is_kept_as_a_short_tail() {
        let dir = testkit::scratch();
        let path = dir.path().join("e");
        let mut f = File::create(&path).unwrap();
        for i in 0..2000 {
            writeln!(f, "line {i}").unwrap();
        }
        let tail = stderr_tail(&path, 0);
        assert!(tail.ends_with("line 1999"), "{tail}");
        assert_eq!(tail.matches(" | ").count(), 2, "three lines: {tail}");
        assert_eq!(stderr_tail(&dir.path().join("missing"), 0), "");
    }

    #[test]
    fn a_running_servers_binary_is_never_replaced() {
        let fx = Fixture::new();
        fx.layout.prepare().unwrap();
        let bundled = fx.dir.path().join("bundled");
        fs::write(&bundled, b"old").unwrap();
        install_binary(&fx.layout, &bundled).unwrap();

        // Something answers on the socket: a server, as far as the installer
        // can tell.
        let _listener =
            std::os::unix::net::UnixListener::bind(fx.layout.socket_for(santree_server::REVISION))
                .unwrap();
        fs::write(&bundled, b"new!").unwrap();
        assert_eq!(install_binary(&fx.layout, &bundled).unwrap(), None);
        assert_eq!(fs::read(&fx.layout.bin).unwrap(), b"old");
    }

    #[test]
    fn an_identical_bundle_with_a_server_answering_is_still_a_server_running() {
        let fx = Fixture::new();
        fx.layout.prepare().unwrap();
        let bundled = fx.dir.path().join("bundled");
        fs::write(&bundled, b"the build").unwrap();
        assert_eq!(
            install_binary(&fx.layout, &bundled).unwrap(),
            Some(Installed::Replaced)
        );
        assert_eq!(
            install_binary(&fx.layout, &bundled).unwrap(),
            Some(Installed::Unchanged)
        );

        // Same bytes, but something answers on the socket: the caller must see
        // that, or it launches a second server over the first.
        let _listener =
            std::os::unix::net::UnixListener::bind(fx.layout.socket_for(santree_server::REVISION))
                .unwrap();
        assert_eq!(install_binary(&fx.layout, &bundled).unwrap(), None);
    }

    #[test]
    fn only_a_private_plain_executable_is_run() {
        let dir = testkit::scratch();
        let bin = script(dir.path(), "bin", "true");
        validate_binary(&bin).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o757)).unwrap();
        assert!(validate_binary(&bin).is_err(), "world-writable");
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(validate_binary(&bin).is_err(), "not executable");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&bin, &link).unwrap();
        assert!(validate_binary(&link).is_err(), "a symlink");
        assert!(validate_binary(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn smoke_checks_the_bundled_revision_without_starting_a_server() {
        let dir = testkit::scratch();
        let good = script(
            dir.path(),
            "good",
            &format!(
                r#"echo '{{"version":"0","revision":{},"protocol":1,"features":[]}}'"#,
                santree_server::REVISION
            ),
        );
        // Generous where the script has to be started (a fresh file is scanned by
        // the OS on its first run, which load stretches); short only for the one
        // that hangs on purpose.
        let patient = Duration::from_secs(120);
        smoke_assert_within(&good, patient).unwrap();
        let stale = script(dir.path(), "stale", r#"echo '{"revision":999}'"#);
        assert!(smoke_assert_within(&stale, patient)
            .unwrap_err()
            .to_string()
            .contains("999"));
        let broken = script(dir.path(), "broken", "echo nope; exit 3");
        assert!(smoke_assert_within(&broken, patient).is_err());
        let hung = script(dir.path(), "hung", "sleep 30");
        let started = Instant::now();
        assert!(smoke_assert_within(&hung, Duration::from_millis(500))
            .unwrap_err()
            .to_string()
            .contains("didn't answer"));
        assert!(started.elapsed() < Duration::from_secs(30));
        // The real binary passes.
        smoke_assert_within(&testkit::real_binary(), patient).unwrap();
    }

    #[test]
    fn a_launchs_stderr_tail_starts_where_that_launch_began() {
        let dir = testkit::scratch();
        let path = dir.path().join("e");
        fs::write(&path, "old launch: boom\n").unwrap();
        let (mut file, from) = open_stderr(&path).unwrap();
        assert_eq!(from, "old launch: boom\n".len() as u64);
        file.write_all(b"new launch: fine\n").unwrap();
        assert_eq!(stderr_tail(&path, from), "new launch: fine");
        // Appended to, so an earlier launch's output survives for the log…
        assert!(fs::read_to_string(&path).unwrap().starts_with("old launch"));
        // …and a file that grew past the bound starts over.
        fs::write(&path, vec![b'x'; (STDERR_KEEP + 1) as usize]).unwrap();
        let (_, from) = open_stderr(&path).unwrap();
        assert_eq!((from, fs::metadata(&path).unwrap().len()), (0, 0));
    }

    #[test]
    fn a_planted_fifo_or_symlink_is_not_opened_as_stderr() {
        let dir = testkit::scratch();
        // A FIFO with no reader: a blocking open would hang forever.
        let fifo = dir.path().join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let started = Instant::now();
        assert!(open_stderr(&fifo).is_err(), "no reader");
        // …and one WITH a reader would be opened for writing; the type check
        // on the descriptor refuses it.
        let _reader = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        let err = open_stderr(&fifo).unwrap_err();
        assert!(err.to_string().contains("not a plain file"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5), "must not hang");

        let target = dir.path().join("target");
        fs::write(&target, b"precious").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(open_stderr(&link).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"precious");
    }

    #[tokio::test]
    async fn descriptors_the_app_leaked_do_not_reach_the_server() {
        let dir = testkit::scratch();
        // Not close-on-exec, as a careless library's would be.
        // SAFETY: duplicating /dev/null's fd to a high number.
        let leaked = unsafe {
            let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY);
            let high = libc::fcntl(null, libc::F_DUPFD, 120);
            libc::close(null);
            high
        };
        assert!(leaked >= 120);
        let listing = dir.path().join("fds");
        let sh = script(
            dir.path(),
            "fds.sh",
            &format!(
                "ls /dev/fd > {} 2>&1; echo 'ready 1' >&3",
                listing.display()
            ),
        );
        let mut cmd = isolated_command(&sh, |_| None);
        cmd.arg("serve");
        let mut spawned = spawn_child(cmd, dir.path().join("e"), Duration::from_secs(10)).unwrap();
        assert_eq!(spawned.start().await, Start::Ready { pid: 1 });
        spawned.exited(Duration::from_secs(5)).await;
        // SAFETY: closing the fd this test made.
        unsafe { libc::close(leaked) };
        let open: Vec<String> = fs::read_to_string(&listing)
            .unwrap()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        assert!(
            !open.contains(&leaked.to_string()),
            "fd {leaked} leaked into the server: {open:?}"
        );
        // The ready socket is there on its fixed number (the ls itself may add
        // one more).
        assert!(open.contains(&"3".to_string()), "{open:?}");
    }

    // ── against the real binary ─────────────────────────────────────────────

    #[tokio::test]
    async fn the_real_server_starts_says_ready_and_answers_on_its_socket() {
        let fx = Fixture::installed();
        let mut spawned = spawn_server(&fx.layout).unwrap();
        fx.track(spawned.pid);
        let started = spawned.start().await;
        let Start::Ready { pid } = started else {
            panic!(
                "not ready: {started:?} {} / log: {} / exit {:?}",
                spawned.stderr_tail(),
                std::fs::read_to_string(&fx.layout.log).unwrap_or_default(),
                spawned.exit()
            )
        };
        assert_eq!(pid, spawned.pid);

        let info = testkit::info_over(&fx.layout.socket_for(santree_server::REVISION)).await;
        assert_eq!(info.revision, santree_server::REVISION);
        assert_eq!(info.pid, pid);
        assert_eq!(
            Path::new(&info.exe).file_name().unwrap(),
            "santree-server",
            "{}",
            info.exe
        );
        // Out of the app's session and group: the server is its own leader.
        assert_eq!(testkit::process_group_of(pid), Some(pid));
    }

    #[tokio::test]
    async fn a_second_server_on_the_same_endpoint_says_occupied_and_exits_20() {
        let fx = Fixture::installed();
        let mut first = spawn_server(&fx.layout).unwrap();
        fx.track(first.pid);
        assert!(matches!(first.start().await, Start::Ready { .. }));

        let mut second = spawn_server(&fx.layout).unwrap();
        fx.track(second.pid);
        assert_eq!(second.start().await, Start::Occupied);
        let exit = second.exited(Duration::from_secs(10)).await.expect("exits");
        assert_eq!(exit.code, Some(EXIT_OCCUPIED));
        // The winner is untouched.
        assert!(first.exit().is_none());
    }

    #[tokio::test]
    async fn a_stale_socket_and_an_unlocked_lock_are_replaced_by_the_next_server() {
        let fx = Fixture::installed();
        let socket = fx.layout.socket_for(santree_server::REVISION);
        // What a crashed server leaves: its socket file, its lock file (free).
        testkit::stale_socket(&socket);
        File::create(
            fx.layout
                .run
                .join(endpoint::lock_name(santree_server::REVISION)),
        )
        .unwrap();

        let mut spawned = spawn_server(&fx.layout).unwrap();
        fx.track(spawned.pid);
        assert!(
            matches!(spawned.start().await, Start::Ready { .. }),
            "{}",
            spawned.stderr_tail()
        );
        let info = testkit::info_over(&socket).await;
        assert_eq!(info.pid, spawned.pid);
    }

    #[tokio::test]
    async fn the_real_server_gets_none_of_the_apps_environment() {
        // The server's pid environment is readable through `ps eww` on macOS and
        // /proc on Linux; either way it must hold only the allow-list.
        let fx = Fixture::installed();
        let mut spawned = spawn_server(&fx.layout).unwrap();
        fx.track(spawned.pid);
        assert!(matches!(spawned.start().await, Start::Ready { .. }));
        let names = testkit::environment_names_of(spawned.pid);
        let allowed = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PATH"];
        for name in &names {
            assert!(
                allowed.contains(&name.as_str()),
                "{name} reached the server from the app's environment"
            );
        }
        assert!(names.iter().any(|n| n == "PATH"), "{names:?}");
    }

    // ── pruning old installs ────────────────────────────────────────────────

    fn install_dir(layout: &Layout, revision: u32) -> PathBuf {
        let dir = layout.root.join(format!("r{revision}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("santree-server"), b"bin").unwrap();
        dir
    }

    fn endpoint_files(layout: &Layout, revision: u32) -> (PathBuf, PathBuf) {
        let socket = layout.socket_for(revision);
        let lock = lock_beside(&socket, revision);
        fs::write(&lock, b"").unwrap();
        (socket, lock)
    }

    #[test]
    fn a_finished_revisions_install_and_stale_endpoint_are_removed() {
        let dir = testkit::scratch();
        let layout = Layout::in_dir(dir.path(), Mode::OptIn);
        layout.prepare().unwrap();
        let older = santree_server::REVISION - 1;
        let old = install_dir(&layout, older);
        let newer = install_dir(&layout, santree_server::REVISION + 1);
        // `prepare` made the current revision's dir.
        let current = layout.rev_dir.clone();
        let (socket, lock) = endpoint_files(&layout, older);
        testkit::stale_socket(&socket);

        assert_eq!(
            prune_old_revisions(&layout, santree_server::REVISION, &[]),
            vec![older]
        );
        assert!(!old.exists(), "the old install is gone");
        assert!(!socket.exists() && !lock.exists(), "and its stale endpoint");
        assert!(current.exists(), "the current revision is never pruned");
        assert!(newer.exists(), "nor a newer one");
    }

    #[test]
    fn a_revision_that_is_running_draining_or_newer_is_kept() {
        let dir = testkit::scratch();
        let layout = Layout::in_dir(dir.path(), Mode::OptIn);
        layout.prepare().unwrap();
        // Not the current revision's own dir, which `prepare` made.
        fs::remove_dir_all(&layout.rev_dir).unwrap();
        let held = install_dir(&layout, 1);
        let answering = install_dir(&layout, 2);
        let draining = install_dir(&layout, 3);
        let newer = install_dir(&layout, 9);
        let (_, lock1) = endpoint_files(&layout, 1);
        let _server = hold_exclusive(&lock1);
        endpoint_files(&layout, 2);
        let _listener = std::os::unix::net::UnixListener::bind(layout.socket_for(2)).unwrap();

        assert_eq!(prune_old_revisions(&layout, 5, &[3]), Vec::<u32>::new());
        for kept in [&held, &answering, &draining, &newer] {
            assert!(kept.exists(), "{} must stay", kept.display());
        }
    }

    #[test]
    fn only_a_plain_install_dir_of_ours_is_pruned() {
        let dir = testkit::scratch();
        let layout = Layout::in_dir(dir.path(), Mode::OptIn);
        layout.prepare().unwrap();
        // A symlink named like an install dir points somewhere that must not be
        // touched; so do names that merely look like one.
        let precious = dir.path().join("precious");
        fs::create_dir_all(&precious).unwrap();
        fs::write(precious.join("keep"), b"x").unwrap();
        // Older than the current revision, so only its kind can spare it.
        let older = santree_server::REVISION - 1;
        std::os::unix::fs::symlink(&precious, layout.root.join(format!("r{older}"))).unwrap();
        for name in ["r00", "r01", "r", "rx", "r-1", "run", "r0.bak"] {
            fs::create_dir_all(layout.root.join(name)).unwrap();
        }

        assert_eq!(
            prune_old_revisions(&layout, santree_server::REVISION, &[]),
            Vec::<u32>::new()
        );
        assert!(precious.join("keep").exists());
        for name in ["r00", "r01", "r", "rx", "r-1", "run", "r0.bak"] {
            assert!(layout.root.join(name).exists(), "{name}");
        }
    }
}
