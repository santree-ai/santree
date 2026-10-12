//! Test support: the real `santree-server` binary, short scratch dirs (a unix
//! socket path holds ~100 bytes) and a guard that kills every server a test
//! started, so none outlives the run.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use santree_remote_client::proto::{m, Empty, ServerInfo};
use santree_remote_client::RemoteClient;

use super::layout::Layout;
use crate::sessions::Mode;

/// A short dir under /tmp. The first call of a test process also sweeps the
/// scratch dirs earlier runs left behind ([`sweep_stale_scratch`]).
pub fn scratch() -> tempfile::TempDir {
    static SWEPT: OnceLock<()> = OnceLock::new();
    SWEPT.get_or_init(|| sweep_stale_scratch(Path::new("/tmp"), STALE_SCRATCH));
    let dir = tempfile::Builder::new()
        .prefix(SCRATCH_PREFIX)
        .tempdir_in("/tmp")
        .unwrap();
    std::fs::write(dir.path().join(SCRATCH_MARKER), b"").unwrap();
    dir
}

const SCRATCH_PREFIX: &str = "sts";

/// The file `scratch()` puts in every dir it makes. The sweep removes only dirs
/// that carry it: a prefix match alone would take an unrelated `/tmp/stsfoo` of
/// the user's.
const SCRATCH_MARKER: &str = ".santree-test-scratch";

/// How old a scratch dir must be before another run may remove it.
const STALE_SCRATCH: Duration = Duration::from_secs(30 * 60);

/// Remove the `sts*` scratch dirs under `parent` that carry the marker
/// `scratch()` leaves, that this user owns, that are older than `older_than`,
/// and that nothing is running out of. A test run that
/// is killed (a timeout, a SIGKILL) skips its drops and leaves its dir behind;
/// nothing else would ever reclaim it.
pub fn sweep_stale_scratch(parent: &Path, older_than: Duration) {
    use std::os::unix::fs::MetadataExt;
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_scratch = entry
            .file_name()
            .to_str()
            .is_some_and(|n| n.starts_with(SCRATCH_PREFIX) && n.len() > SCRATCH_PREFIX.len());
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= older_than);
        // Only a dir `scratch()` made: it carries the marker. The prefix is a
        // guess about a name; the marker is a fact about the dir.
        let marked = std::fs::symlink_metadata(path.join(SCRATCH_MARKER))
            .is_ok_and(|m| m.is_file() && m.uid() == me);
        if is_scratch
            && marked
            && meta.is_dir()
            && meta.uid() == me
            && old
            && pids_running_under(&path).is_empty()
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Poll `check` until it holds, failing the test after `secs` seconds.
pub async fn until(what: &str, secs: u64, mut check: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    while !check() {
        assert!(std::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// An executable `#!/bin/sh` script at `<dir>/<name>` running `body`.
pub fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    {
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(format!("#!/bin/sh\n{body}\n").as_bytes())
            .unwrap();
        f.sync_all().unwrap();
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// A `flock` this test process holds on a file (created if missing): an
/// exclusive one is a live server's endpoint lock, a shared one a squatter's.
pub struct HeldLock {
    file: std::fs::File,
    path: PathBuf,
}

/// How long a lock may outlive the fd that held it. Every child another test
/// spawns is born with a copy of each fd this process has open and keeps it
/// until its exec closes them (close-on-exec acts at exec, not at fork, and
/// macOS's `posix_spawn` is no different), and a `flock` lasts until its last
/// copy closes. Unloaded that is under a millisecond; a loaded run stretches it.
const LINGER: Duration = Duration::from_secs(5);

impl HeldLock {
    pub fn exclusive(lock: &Path) -> Self {
        Self::take(lock, libc::LOCK_EX)
    }

    pub fn shared(lock: &Path) -> Self {
        Self::take(lock, libc::LOCK_SH)
    }

    fn take(lock: &Path, how: libc::c_int) -> Self {
        use std::os::unix::io::AsRawFd;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock)
            .unwrap();
        // An earlier hold of this test's, or a probe, may still linger (see
        // [`LINGER`]).
        let deadline = std::time::Instant::now() + LINGER;
        // SAFETY: a valid open fd.
        while unsafe { libc::flock(file.as_raw_fd(), how | libc::LOCK_NB) } != 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "{} stayed locked for {LINGER:?}",
                lock.display()
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        Self {
            file,
            path: lock.to_path_buf(),
        }
    }

    /// Let go, as the holder's exit would, and wait until the app's own probe
    /// reads the lock free, past the copies other tests' children may still
    /// hold (see [`LINGER`]): what a test asserts next is then about the code,
    /// not a stray fork. A real hold that never ends still fails the test.
    pub fn let_go(self) {
        let Self { file, path } = self;
        drop(file);
        let deadline = std::time::Instant::now() + LINGER;
        while super::lock::probe_lock(&path) == super::lock::EndpointLock::Held {
            assert!(
                std::time::Instant::now() < deadline,
                "{} still held {LINGER:?} after it was let go",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

/// An exclusive hold on `lock`, as a live server keeps its endpoint lock.
pub fn hold_exclusive(lock: &Path) -> HeldLock {
    HeldLock::exclusive(lock)
}

/// How long a cold build of `santree-server` may take before the test run gives
/// up on it. Generous: it compiles the server's whole dependency tree once, in
/// a target dir of its own.
const BUILD_LIMIT: Duration = Duration::from_secs(20 * 60);

/// `target/server-testbin/<profile>/santree-server`, built if it is missing or
/// stale (cargo decides which; a no-op when fresh), once per test process.
///
/// Built into a target dir of its own, never the one the tests were compiled
/// in: that dir is locked by whatever else is building (an editor's check, a
/// second `cargo`), and a build that waits on that lock from inside a running
/// test waits for as long as the other one does — a deadlock when it is the
/// `cargo test` that started this very test. Its own dir has its own lock.
pub fn real_binary() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        // …/target/debug/deps/<test exe> → debug | release
        let exe = std::env::current_exe().unwrap();
        let profile = exe
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .map(|n| n.to_os_string())
            .unwrap_or_else(|| "debug".into());
        let release = profile == "release";
        let target = test_target_dir(workspace);
        let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
        let mut build = Command::new(cargo);
        build
            .args(["build", "-p", "santree-server", "--target-dir"])
            .arg(&target)
            .current_dir(workspace);
        if release {
            build.arg("--release");
        }
        run_bounded(build, BUILD_LIMIT).unwrap_or_else(|e| {
            panic!(
                "building santree-server for the tests failed: {e}\n\
                 (it builds into {}, apart from the main target dir; run the same \
                 `cargo build -p santree-server --target-dir …` by hand to see why)",
                target.display()
            )
        });
        let bin = target.join(&profile).join("santree-server");
        assert!(bin.is_file(), "{} wasn't built", bin.display());
        bin
    })
    .clone()
}

/// Where the tests' server binary is built: under the workspace's `target/`,
/// beside (never inside) the main profile dirs.
pub fn test_target_dir(workspace: &Path) -> PathBuf {
    workspace.join("target").join("server-testbin")
}

/// Run `command` to completion, killing it if it takes longer than `limit`.
pub fn run_bounded(mut command: Command, limit: Duration) -> Result<(), String> {
    let mut child = command.spawn().map_err(|e| format!("can't run it: {e}"))?;
    let deadline = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("it exited with {status}")),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("it didn't finish within {limit:?}"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("can't wait for it: {e}")),
        }
    }
}

/// A scratch dir, an opt-in layout inside it, and a guard that kills every
/// server process it (or anything under its dir) started.
pub struct Fixture {
    pub dir: tempfile::TempDir,
    pub layout: Layout,
    pids: Mutex<Vec<u32>>,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = scratch();
        let layout = Layout::in_dir(dir.path(), Mode::OptIn);
        Self {
            dir,
            layout,
            pids: Mutex::new(Vec::new()),
        }
    }

    /// With the real binary installed in the layout.
    pub fn installed() -> Self {
        let fx = Self::new();
        fx.layout.prepare().unwrap();
        super::spawn::install_binary(&fx.layout, &real_binary()).unwrap();
        fx
    }

    pub fn track(&self, pid: u32) {
        self.pids.lock().unwrap().push(pid);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for pid in self.pids.lock().unwrap().drain(..) {
            kill(pid);
        }
        // Whatever else runs out of this dir (a respawned server, one a test
        // lost track of): found by its command line, which names the dir.
        for pid in pids_running_under(self.dir.path()) {
            kill(pid);
        }
        // A killed server can still be writing its log for a moment, and a dir
        // removed under it comes back: wait for it to be gone, then remove the
        // dir, so none is left in /tmp.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !pids_running_under(self.dir.path()).is_empty()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = std::fs::remove_dir_all(self.dir.path());
    }
}

fn kill(pid: u32) {
    // SAFETY: SIGKILL to a pid of a test's own server.
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

/// Processes whose command line names a path under `dir`.
pub fn pids_running_under(dir: &Path) -> Vec<u32> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
        .expect("ps");
    let needle = dir.to_string_lossy().into_owned();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(&needle))
        .filter_map(|l| l.split_whitespace().next()?.parse().ok())
        .filter(|pid| *pid != std::process::id())
        .collect()
}

/// `server.info` over a fresh connection, past the connector: the test is
/// asking what is listening, not exercising the link.
pub async fn info_over(socket: &Path) -> ServerInfo {
    let stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    let (reader, writer) = stream.into_split();
    let client = RemoteClient::new(reader, writer);
    client.hello("santree/test", "testkit").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), client.call::<m::ServerInfo>(&Empty))
        .await
        .unwrap()
        .unwrap()
}

pub fn process_group_of(pid: u32) -> Option<u32> {
    let out = Command::new("ps")
        .args(["-o", "pgid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// The NAMES in a process's environment — never a value, which a failing
/// assertion would otherwise print.
pub fn environment_names_of(pid: u32) -> Vec<String> {
    // `ps eww` prints the environment after the command line, which here
    // has no `NAME=` tokens of its own (flags are `--x value`).
    let out = Command::new("ps")
        .args(["eww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .filter_map(|tok| {
            let (name, _) = tok.split_once('=')?;
            (!name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
                .then(|| name.to_string())
        })
        .collect()
}

/// A socket file nobody listens on, the way a server that died leaves one: a
/// socket bound to `path` and closed, **never listening**. Not a listener that
/// is dropped: for as long as any process holds a copy of a listening socket's
/// fd — a child another test is forking at that moment has one until its
/// `exec` — a connect to it succeeds, and "nobody listens" is false. A socket
/// that never listened refuses whoever holds it.
pub fn stale_socket(path: &Path) {
    use std::os::unix::ffi::OsStrExt;

    // SAFETY: plain socket/bind/close calls on an fd made here, with a
    // zeroed sockaddr_un filled from `path` (length-checked).
    unsafe {
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
        assert!(fd >= 0, "socket(): {}", std::io::Error::last_os_error());
        let mut addr: libc::sockaddr_un = std::mem::zeroed();
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        let bytes = path.as_os_str().as_bytes();
        assert!(bytes.len() < addr.sun_path.len(), "socket path too long");
        for (slot, b) in addr.sun_path.iter_mut().zip(bytes) {
            *slot = *b as libc::c_char;
        }
        let rc = libc::bind(
            fd,
            (&addr as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        );
        let err = std::io::Error::last_os_error();
        libc::close(fd);
        assert_eq!(rc, 0, "bind(): {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn age(path: &Path, by: Duration) {
        let when = std::time::SystemTime::now() - by;
        let file = fs::File::open(path).unwrap();
        file.set_modified(when).unwrap();
    }

    /// The sweep reclaims what a killed run left, and nothing else: not a fresh
    /// dir (another run may be using it), not one something runs out of, not a
    /// dir without the prefix.
    #[test]
    fn the_sweep_removes_only_old_idle_scratch_dirs() {
        let parent = tempfile::tempdir().unwrap();
        // `marked`: made by `scratch()`, which leaves its marker; the marker is
        // written before the dir is aged, since writing it touches the dir.
        let make = |name: &str, old: bool, marked: bool| {
            let dir = parent.path().join(name);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("leftover"), b"x").unwrap();
            if marked {
                fs::write(dir.join(SCRATCH_MARKER), b"").unwrap();
            }
            if old {
                age(&dir, Duration::from_secs(3600));
            }
            dir
        };
        let stale = make("stsOLD123", true, true);
        let fresh = make("stsNEW123", false, true);
        let other = make("keepme", true, true);
        // The prefix alone is no scratch dir.
        let bare = make("sts", true, true);
        // Named like a scratch dir, old and idle, but not made by `scratch()`:
        // somebody's own directory. Never removed.
        let decoy = make("stsfoo", true, false);
        let busy = make("stsBUSY12", true, true);
        // Something running out of `busy`: its command line names the dir.
        let mut runner = Command::new("sh")
            // The trailing `:` keeps the shell from exec'ing `sleep`, which
            // would drop the dir from the command line.
            .args(["-c", "sleep 30; :", "--"])
            .arg(&busy)
            .spawn()
            .unwrap();

        std::thread::sleep(Duration::from_millis(200)); // let it exec
        sweep_stale_scratch(parent.path(), Duration::from_secs(1800));
        let _ = runner.kill();
        let _ = runner.wait();

        assert!(!stale.exists(), "an old idle dir was left");
        assert!(fresh.exists(), "a fresh dir was removed");
        assert!(other.exists(), "a dir without the prefix was removed");
        assert!(bare.exists());
        assert!(busy.exists(), "a dir something runs out of was removed");
        assert!(decoy.exists(), "a dir `scratch()` did not make was removed");
    }
}
