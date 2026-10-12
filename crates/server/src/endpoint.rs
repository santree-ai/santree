//! Where the server listens, and the one rule for who may listen there.
//!
//! A server of revision N owns `<run>/server-rN.sock` exactly while it holds
//! the exclusive `flock` on `<run>/server-rN.lock`. The lock decides every
//! race the socket file alone cannot: two launches at once (the loser exits
//! 20 and its launcher adopts the winner), a crashed server's socket left
//! behind (whoever takes the lock next unlinks it), a server exiting while
//! another starts (it never unlinks its socket, so it cannot remove the
//! newcomer's). The kernel releases the lock when the holder dies, however
//! it dies, so there is no stale state to clean up but the socket file.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};

use crate::REVISION;

/// The socket's file name for server revision `revision`.
pub fn socket_name(revision: u32) -> String {
    format!("server-r{revision}.sock")
}

/// The endpoint lock's file name for server revision `revision`.
pub fn lock_name(revision: u32) -> String {
    format!("server-r{revision}.lock")
}

/// `<run>/server-r<REVISION>.sock`.
pub fn socket_path(run_dir: &Path) -> PathBuf {
    run_dir.join(socket_name(REVISION))
}

/// `<run>/server-r<REVISION>.lock`.
pub fn lock_path(run_dir: &Path) -> PathBuf {
    run_dir.join(lock_name(REVISION))
}

/// The longest socket path this platform can bind: `sun_path` less its NUL
/// (103 bytes on macOS, 107 on Linux).
pub fn max_socket_path() -> usize {
    // SAFETY: an all-zero sockaddr_un is a valid value of the type.
    let addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_path.len() - 1
}

/// Create the run dir (0700) if it is missing; refuse one that anyone but
/// this user could reach into. The socket inside is a shell as the user, and
/// its mode alone is not the whole story while its directory is open.
pub fn prepare_run_dir(dir: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(dir) {
        Err(e) if e.kind() == ErrorKind::NotFound => {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .with_context(|| format!("can't create the run dir {}", dir.display()))?;
        }
        Err(e) => bail!("can't read the run dir {}: {e}", dir.display()),
        Ok(_) => {}
    }
    let meta = fs::symlink_metadata(dir)
        .with_context(|| format!("can't read the run dir {}", dir.display()))?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.is_dir() {
        bail!(
            "the run dir {} is not a directory (a symlink is refused too)",
            dir.display()
        );
    }
    if meta.uid() != me {
        bail!(
            "the run dir {} belongs to uid {}, not {me}",
            dir.display(),
            meta.uid()
        );
    }
    if meta.mode() & 0o077 != 0 {
        bail!(
            "the run dir {} is open to other users (mode {:o}); it must be 0700",
            dir.display(),
            meta.mode() & 0o777
        );
    }
    Ok(())
}

/// The endpoint lock, held for the life of the process (dropping it releases
/// it, and so does the process ending).
pub struct EndpointLock {
    file: File,
}

impl EndpointLock {
    /// Which file this lock is on, by the descriptor held — not by any path.
    fn id(&self) -> std::io::Result<FileId> {
        self.file.metadata().map(|m| FileId::of(&m))
    }
}

/// A file's identity on its device. A path names a file only until somebody
/// removes or replaces it; this is what the server compares paths against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileId {
    dev: u64,
    ino: u64,
}

impl FileId {
    fn of(meta: &fs::Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
}

/// How long a held lock is retried before it counts as another server's. The
/// launching app probes the lock with a shared `flock` held for microseconds; a
/// server that met one would otherwise exit "occupied" with nobody there. A
/// real server holds it for its whole life.
const LOCK_PATIENCE: Duration = Duration::from_millis(200);

/// Take the endpoint lock, waiting out a brief hold ([`LOCK_PATIENCE`]).
/// `None`: another server of this revision holds it.
pub fn take_lock(run_dir: &Path) -> anyhow::Result<Option<EndpointLock>> {
    let path = lock_path(run_dir);
    // CLOEXEC (std's default) matters: a PTY child that inherited this fd
    // would keep the lock — and so the endpoint — after the server died.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .with_context(|| format!("can't open the lock {}", path.display()))?;
    let deadline = Instant::now() + LOCK_PATIENCE;
    // SAFETY: a valid open fd.
    while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let e = std::io::Error::last_os_error();
        if e.kind() != ErrorKind::WouldBlock {
            return Err(e).with_context(|| format!("can't lock {}", path.display()));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(Some(EndpointLock { file }))
}

/// Bind the socket (0600), replacing whatever a dead server left at its path.
/// Only for the holder of the [`EndpointLock`].
pub fn bind(run_dir: &Path, _held: &EndpointLock) -> anyhow::Result<UnixListener> {
    let path = socket_path(run_dir);
    let len = path.as_os_str().len();
    if len > max_socket_path() {
        bail!(
            "the socket path {} is {len} bytes; a unix socket path holds at most {}",
            path.display(),
            max_socket_path()
        );
    }
    match fs::remove_file(&path) {
        Ok(()) => log::info!("replaced a stale socket at {}", path.display()),
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("can't remove {}", path.display())),
    }
    let listener =
        UnixListener::bind(&path).with_context(|| format!("can't bind {}", path.display()))?;
    chmod_nofollow(&path, 0o600).with_context(|| format!("can't restrict {}", path.display()))?;
    Ok(listener)
}

/// How often the endpoint's files are touched: temp-dir cleaners go by access
/// time, holding a lock does not move it, and the run dir falls back to
/// `$TMPDIR` when the app data path is too long for a socket.
const TOUCH_EVERY: Duration = Duration::from_secs(60 * 60);

/// What the server holds of its own endpoint, and the means to restore it.
///
/// The endpoint is two files in a directory a process with this user's uid can
/// write to, and an agent in a terminal has that uid: it can `rm` the socket
/// (leaving a live server nobody can dial) or the lock (letting a second server
/// take the endpoint over this one's sessions). The server therefore records
/// what it made — the socket's and the lock's identity — and looks again every
/// few seconds ([`Endpoint::check`]): a lock that was removed is taken again,
/// unless someone else now holds it, and a socket that is gone, replaced, or no
/// longer a socket is bound again the way startup binds it, under the lock.
///
/// Nothing here admits anyone. A rebound socket is served by the same accept
/// loop and the same peer check as the first.
pub struct Endpoint {
    run_dir: PathBuf,
    /// The lock held: the file `lock_id` names, and — only until a replacement
    /// is held — older ones. Dropping an entry drops its `flock`, so one is
    /// let go only after the lock that replaces it is held.
    locks: Vec<EndpointLock>,
    lock_id: FileId,
    socket_id: FileId,
    touched: Instant,
    /// A lock problem that lasts is logged once, not on every look.
    lock_trouble: bool,
}

impl Endpoint {
    /// Bind the socket under the held lock and remember what was made.
    pub fn bind(run_dir: &Path, held: EndpointLock) -> anyhow::Result<(Self, UnixListener)> {
        let listener = bind(run_dir, &held)?;
        let socket = fs::symlink_metadata(socket_path(run_dir))
            .context("can't read the socket just bound")?;
        let lock_id = held.id().context("can't read the lock just taken")?;
        Ok((
            Self {
                run_dir: run_dir.to_path_buf(),
                locks: vec![held],
                lock_id,
                socket_id: FileId::of(&socket),
                touched: Instant::now(),
                lock_trouble: false,
            },
            listener,
        ))
    }

    /// Look at the endpoint. `Some`: the socket was gone or replaced and a new
    /// one is bound — the caller must accept on it. Also touches both files
    /// every [`TOUCH_EVERY`]. Blocking file work.
    pub fn check(&mut self, now: Instant) -> Option<UnixListener> {
        // The lock first, on every look: a lock file removed or replaced lets
        // a second server take the endpoint over this one's sessions, whether or
        // not the socket is still there.
        if !self.keep_lock() {
            return None;
        }
        let socket = socket_path(&self.run_dir);
        let intact = fs::symlink_metadata(&socket)
            .is_ok_and(|m| m.file_type().is_socket() && FileId::of(&m) == self.socket_id);
        if intact {
            if now.saturating_duration_since(self.touched) >= TOUCH_EVERY {
                self.touched = now;
                touch(&socket);
                touch(&lock_path(&self.run_dir));
            }
            return None;
        }
        self.rebind(now)
    }

    /// The lock at its path is the one held, or a new one is taken. `false`:
    /// somebody else holds the lock now (they own the endpoint, and this server
    /// must not take the name back from them) or it can't be taken; either way
    /// nothing may be bound.
    fn keep_lock(&mut self) -> bool {
        let lock = lock_path(&self.run_dir);
        let ours = fs::symlink_metadata(&lock)
            .is_ok_and(|m| m.file_type().is_file() && FileId::of(&m) == self.lock_id);
        if ours {
            self.lock_trouble = false;
            return true;
        }
        // The same checks as at startup, again: the directory may have been
        // swapped for one that is not ours.
        if let Err(e) = prepare_run_dir(&self.run_dir) {
            self.lock_trouble(format!(
                "the lock file is gone or replaced and the run dir is not safe to use: {e:#}"
            ));
            return false;
        }
        match take_lock(&self.run_dir) {
            Ok(Some(new)) => match new.id() {
                Ok(id) => {
                    log::warn!("the lock file was removed or replaced; took a new one");
                    self.lock_id = id;
                    self.locks.push(new);
                    // The lock that replaces them is held: the older ones are on
                    // files the path no longer names, and are let go.
                    let current = self.lock_id;
                    self.locks.retain(|l| l.id().ok() == Some(current));
                    self.lock_trouble = false;
                    true
                }
                Err(e) => {
                    self.lock_trouble(format!("can't read the new lock: {e}"));
                    false
                }
            },
            Ok(None) => {
                self.lock_trouble(
                    "the lock file was replaced and another server holds the endpoint lock; not \
                     taking the endpoint back from it"
                        .into(),
                );
                false
            }
            Err(e) => {
                self.lock_trouble(format!("the lock can't be retaken: {e:#}"));
                false
            }
        }
    }

    fn lock_trouble(&mut self, why: String) {
        if !std::mem::replace(&mut self.lock_trouble, true) {
            log::error!("{why}");
        }
    }

    /// Bind the socket again, as startup did. Every time it is needed: a server
    /// that stopped restoring its name would leave a Restart, which ends every
    /// session, as the only way back.
    fn rebind(&mut self, now: Instant) -> Option<UnixListener> {
        if let Err(e) = prepare_run_dir(&self.run_dir) {
            log::error!("the socket is gone and the run dir is not safe to bind in: {e:#}");
            return None;
        }
        let held = self.locks.last()?;
        let made = bind(&self.run_dir, held).and_then(|listener| {
            let made = fs::symlink_metadata(socket_path(&self.run_dir))
                .context("can't read the new socket")?;
            Ok((listener, made))
        });
        match made {
            Ok((listener, made)) => {
                log::warn!("the socket was removed or replaced; bound it again");
                self.socket_id = FileId::of(&made);
                self.touched = now;
                Some(listener)
            }
            Err(e) => {
                log::error!("can't restore the socket: {e:#}");
                None
            }
        }
    }
}

/// `chmod` `path` without following a symlink at it.
fn chmod_nofollow(path: &Path, mode: u32) -> std::io::Result<()> {
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(ErrorKind::InvalidInput))?;
    // SAFETY: a valid NUL-terminated path.
    let rc = unsafe {
        libc::fchmodat(
            libc::AT_FDCWD,
            c.as_ptr(),
            mode as libc::mode_t,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Set `path`'s access and modification times to now, without following a
/// symlink. Best effort.
fn touch(path: &Path) {
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return;
    };
    // SAFETY: a valid NUL-terminated path; a null `times` means "now".
    let rc = unsafe {
        libc::utimensat(
            libc::AT_FDCWD,
            c.as_ptr(),
            std::ptr::null(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc != 0 {
        log::debug!(
            "can't touch {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        );
    }
}

/// The server's end of the startup handshake: one end of a unix socketpair
/// whose other end the launcher keeps. One line goes out on it, then it is
/// closed. A socket rather than a pipe so the launcher can be asked who it is
/// (`peer::verify`): a code-signed server serves only for santree.app.
pub struct ReadySocket(UnixStream);

impl ReadySocket {
    /// Take ownership of the inherited `fd`. Called before the process
    /// opens any file of its own, so an `fd` the launcher left closed can't
    /// have become one of them (the log, once — whose lines then went to
    /// whatever reused the fd: a client's socket, a PTY master). It is marked
    /// close-on-exec at once, so no PTY child can hold it open.
    pub fn adopt(fd: RawFd) -> anyhow::Result<Self> {
        if fd <= 2 {
            bail!("--ready-fd {fd} is a standard stream; pass one end of a socketpair");
        }
        // SAFETY: fcntl on an arbitrary fd number only reports EBADF if it is
        // not open; nothing is dereferenced.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            bail!(
                "--ready-fd {fd} is not open: {}",
                std::io::Error::last_os_error()
            );
        }
        if !is_unix_socket(fd) {
            bail!("--ready-fd {fd} is not a socket: pass one end of a unix socketpair");
        }
        // SAFETY: the fd is an open unix socket (checked above), was handed to
        // this process for exactly this, and nothing else in it owns it.
        Ok(Self(unsafe { UnixStream::from_raw_fd(fd) }))
    }

    /// The launcher's socket, to ask who is on the other end.
    pub fn fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }

    /// Write `line` and close the socket. A launcher that went away is not
    /// this process's problem: the line is lost and the server goes on.
    pub fn send(mut self, line: &str) {
        if let Err(e) = self.0.write_all(line.as_bytes()) {
            log::warn!("can't write to the ready fd: {e}");
        }
    }
}

/// Whether the other end of the connected unix socket `fd` has no name: a
/// socketpair's. A socket connected to a *named* listener reports that
/// listener's audit token as its peer's on macOS, so the identity check on a
/// ready socket proves nothing unless the peer is anonymous: an agent could
/// otherwise connect to any socket santree.app listens on (its hook socket)
/// and pass that as `--ready-fd`. Unreadable counts as named.
pub fn peer_is_unnamed(fd: RawFd) -> bool {
    // SAFETY: all-zero is a valid sockaddr_un; getpeername writes at most
    // `len` bytes into it, its exact size, and reports a bad fd through its
    // return value.
    unsafe {
        let mut addr: libc::sockaddr_un = std::mem::zeroed();
        let mut len = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        let rc = libc::getpeername(fd, (&mut addr as *mut libc::sockaddr_un).cast(), &mut len);
        if rc != 0 || i32::from(addr.sun_family) != libc::AF_UNIX {
            return false;
        }
        // A path starts with a byte; an unnamed socket's is zero. On Linux a
        // zero first byte is also an abstract name, which the length gives
        // away (`len` counts the name; macOS has no abstract sockets and
        // reports a padded length).
        let named_len =
            (len as usize).saturating_sub(std::mem::offset_of!(libc::sockaddr_un, sun_path));
        addr.sun_path[0] == 0 && (cfg!(not(target_os = "linux")) || named_len == 0)
    }
}

/// Whether `fd` is an open unix-domain socket.
fn is_unix_socket(fd: RawFd) -> bool {
    // SAFETY: all-zero is a valid stat and sockaddr_storage; fstat and
    // getsockname only write into them (getsockname at most `len` bytes, the
    // storage's exact size) and report a bad fd through their return value.
    unsafe {
        let mut st: libc::stat = std::mem::zeroed();
        if libc::fstat(fd, &mut st) != 0 || st.st_mode & libc::S_IFMT != libc::S_IFSOCK {
            return false;
        }
        let mut addr: libc::sockaddr_storage = std::mem::zeroed();
        let mut len = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
        let rc = libc::getsockname(
            fd,
            (&mut addr as *mut libc::sockaddr_storage).cast(),
            &mut len,
        );
        rc == 0 && i32::from(addr.ss_family) == libc::AF_UNIX
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn only_a_socketpair_end_has_an_unnamed_peer() {
        let (a, b) = UnixStream::pair().unwrap();
        assert!(peer_is_unnamed(a.as_raw_fd()));
        assert!(peer_is_unnamed(b.as_raw_fd()));
        let dir = tempfile::Builder::new()
            .prefix("sts")
            .tempdir_in("/tmp")
            .unwrap();
        let path = dir.path().join("l.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let client = UnixStream::connect(&path).unwrap();
        let (accepted, _) = listener.accept().unwrap();
        assert!(!peer_is_unnamed(client.as_raw_fd()), "client of a listener");
        // The listener's side of the connection has no name to report.
        assert!(peer_is_unnamed(accepted.as_raw_fd()));
        let file = File::open("/dev/null").unwrap();
        assert!(!peer_is_unnamed(file.as_raw_fd()), "not a socket");
    }

    fn scratch() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("sts")
            .tempdir_in("/tmp")
            .unwrap()
    }

    /// An endpoint bound the way `serve` does it, in a fresh run dir.
    fn bound() -> (tempfile::TempDir, PathBuf, Endpoint, UnixListener) {
        let dir = scratch();
        let run = dir.path().join("run");
        prepare_run_dir(&run).unwrap();
        let held = take_lock(&run).unwrap().expect("a free lock");
        let (endpoint, listener) = Endpoint::bind(&run, held).unwrap();
        (dir, run, endpoint, listener)
    }

    /// Dial `path` and say whether `listener` (not another) is what answered.
    fn reaches(path: &Path, listener: &UnixListener) -> bool {
        listener.set_nonblocking(true).unwrap();
        let Ok(_client) = UnixStream::connect(path) else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if listener.accept().is_ok() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn an_intact_endpoint_is_left_alone() {
        let (_dir, run, mut endpoint, _listener) = bound();
        assert!(endpoint.check(Instant::now()).is_none());
        assert!(socket_path(&run).exists());
    }

    #[test]
    fn a_removed_socket_is_bound_again_and_reached() {
        let (_dir, run, mut endpoint, old) = bound();
        fs::remove_file(socket_path(&run)).unwrap();
        assert!(UnixStream::connect(socket_path(&run)).is_err());

        let new = endpoint.check(Instant::now()).expect("restored");
        assert!(reaches(&socket_path(&run), &new));
        assert_eq!(
            fs::metadata(socket_path(&run))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        // And it holds: the next look finds it as it was left.
        assert!(endpoint.check(Instant::now()).is_none());
        drop(old);
    }

    /// A symlink or somebody else's socket planted at the name is replaced —
    /// never followed, never bound through.
    #[test]
    fn a_planted_symlink_or_foreign_socket_is_replaced_not_followed() {
        let (dir, run, mut endpoint, _old) = bound();
        let victim = dir.path().join("victim");
        fs::write(&victim, b"mine").unwrap();
        fs::remove_file(socket_path(&run)).unwrap();
        std::os::unix::fs::symlink(&victim, socket_path(&run)).unwrap();
        let new = endpoint.check(Instant::now()).expect("restored");
        assert!(reaches(&socket_path(&run), &new));
        assert_eq!(fs::read(&victim).unwrap(), b"mine");

        fs::remove_file(socket_path(&run)).unwrap();
        let foreign = UnixListener::bind(socket_path(&run)).unwrap();
        let new = endpoint.check(Instant::now()).expect("restored");
        assert!(reaches(&socket_path(&run), &new));
        drop(foreign);
    }

    /// A launcher's probe holds the lock shared for a moment; a server started
    /// in that moment still takes it rather than exiting "occupied".
    #[test]
    fn a_lock_held_for_a_moment_by_a_probe_is_still_taken() {
        let dir = scratch();
        let run = dir.path().join("run");
        prepare_run_dir(&run).unwrap();
        let probe = File::create(lock_path(&run)).unwrap();
        // SAFETY: a valid open fd.
        assert_eq!(
            unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) },
            0
        );
        let letting_go = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            drop(probe);
        });
        assert!(take_lock(&run).unwrap().is_some(), "gave up on a probe");
        letting_go.join().unwrap();
    }

    #[test]
    fn a_removed_lock_is_taken_again_and_a_second_server_still_finds_it_occupied() {
        let (_dir, run, mut endpoint, _old) = bound();
        fs::remove_file(socket_path(&run)).unwrap();
        fs::remove_file(lock_path(&run)).unwrap();
        // With the lock gone a newcomer could take the endpoint; before the
        // server looks again, it can: this is the window the look closes.
        let new = endpoint.check(Instant::now()).expect("restored");
        assert!(lock_path(&run).exists(), "the lock was not restored");
        assert!(reaches(&socket_path(&run), &new));
        assert!(
            take_lock(&run).unwrap().is_none(),
            "a second server got the lock"
        );
    }

    #[test]
    fn a_lock_someone_else_holds_means_no_rebind() {
        let (_dir, run, mut endpoint, _old) = bound();
        fs::remove_file(socket_path(&run)).unwrap();
        fs::remove_file(lock_path(&run)).unwrap();
        // Another server took the endpoint in the meantime.
        let theirs = take_lock(&run).unwrap().expect("free after removal");
        assert!(endpoint.check(Instant::now()).is_none());
        assert!(
            !socket_path(&run).exists(),
            "bound over another server's endpoint"
        );
        // They go away; the next look restores.
        drop(theirs);
        // A child forked by a test running beside this one holds a copy of the
        // descriptor until its exec, and so the lock: look again until it is let go.
        let mut new = None;
        for _ in 0..100 {
            new = endpoint.check(Instant::now());
            if new.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let new = new.expect("restored");
        assert!(reaches(&socket_path(&run), &new));
    }

    /// A lock removed while the socket is still there is retaken on the very next
    /// look — not only when the socket is also gone — and the file it replaces is
    /// let go once the new one is held.
    #[test]
    fn a_removed_lock_is_retaken_on_the_next_look_even_with_the_socket_intact() {
        let (_dir, run, mut endpoint, _old) = bound();
        fs::remove_file(lock_path(&run)).unwrap();
        assert!(endpoint.check(Instant::now()).is_none());
        assert!(lock_path(&run).exists(), "the lock was not retaken");
        assert!(
            take_lock(&run).unwrap().is_none(),
            "a second server could take the endpoint"
        );
        assert_eq!(
            endpoint.locks.len(),
            1,
            "the old lock's descriptor was kept"
        );

        // Replaced rather than removed: the same.
        fs::remove_file(lock_path(&run)).unwrap();
        fs::write(lock_path(&run), b"").unwrap();
        endpoint.check(Instant::now());
        assert!(take_lock(&run).unwrap().is_none());
        assert_eq!(endpoint.locks.len(), 1);

        // Somebody else took it in between: the socket is left alone too.
        fs::remove_file(lock_path(&run)).unwrap();
        let theirs = take_lock(&run).unwrap().expect("free after removal");
        assert!(endpoint.check(Instant::now()).is_none());
        assert_eq!(endpoint.locks.len(), 1);
        drop(theirs);
    }

    #[test]
    fn a_run_dir_others_can_reach_is_not_bound_in() {
        let (_dir, run, mut endpoint, _old) = bound();
        fs::remove_file(socket_path(&run)).unwrap();
        fs::set_permissions(&run, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(endpoint.check(Instant::now()).is_none());
        assert!(!socket_path(&run).exists());
    }

    #[test]
    fn the_files_are_touched_when_the_interval_has_passed() {
        let (_dir, run, mut endpoint, _old) = bound();
        let old = std::time::SystemTime::now() - Duration::from_secs(3 * 24 * 3600);
        let times = fs::FileTimes::new().set_accessed(old).set_modified(old);
        File::open(lock_path(&run))
            .unwrap()
            .set_times(times)
            .unwrap();
        let before = fs::metadata(lock_path(&run)).unwrap().modified().unwrap();
        // Not yet due.
        endpoint.check(Instant::now());
        assert_eq!(
            fs::metadata(lock_path(&run)).unwrap().modified().unwrap(),
            before
        );
        // Due.
        endpoint.check(Instant::now() + TOUCH_EVERY + Duration::from_secs(1));
        let after = fs::metadata(lock_path(&run)).unwrap().modified().unwrap();
        assert!(
            after > before + Duration::from_secs(24 * 3600),
            "{before:?} {after:?}"
        );
        let sock = fs::symlink_metadata(socket_path(&run)).unwrap();
        assert!(sock.modified().unwrap() > old + Duration::from_secs(24 * 3600));
    }

    #[test]
    fn only_a_unix_socket_is_a_ready_socket() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert!(is_unix_socket(a.as_raw_fd()));
        let file = File::open("/dev/null").unwrap();
        assert!(!is_unix_socket(file.as_raw_fd()));
        let (r, _w) = std::io::pipe().unwrap();
        assert!(!is_unix_socket(r.as_raw_fd()));
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(!is_unix_socket(tcp.as_raw_fd()));
    }
}
