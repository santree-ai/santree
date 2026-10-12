//! Whether a server process is alive, by the endpoint lock it holds.
//!
//! A server holds `server-r<N>.lock` exclusively for its whole life
//! (`endpoint::take_lock`). That makes the lock, not the socket, the evidence a
//! server is running: the socket is a file in a directory a process with the
//! user's uid can `rm`, and a socket that is gone says nothing about the process
//! that bound it.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// What the endpoint lock says about a server of some revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EndpointLock {
    /// Some process holds it: a server of that revision is alive.
    Held,
    /// Nobody does (or there is no lock file we own): nothing is running.
    Free,
}

/// Probe `lock` without creating it and without holding it: a read-only
/// `O_NOFOLLOW` open of a regular file this user owns, one non-blocking
/// *shared* `flock`, and let go. Shared, so that two probes overlapping (or a
/// probe and the launcher's own) never read each other as a server; it still
/// excludes the server's exclusive lock, which is all it asks. The server takes the same lock exclusively for its
/// whole life (`endpoint::take_lock`), so a held lock is a live server whatever
/// has become of its socket. A file that is missing, a symlink, not a regular
/// file or not ours cannot be a server's lock and reads as `Free`; any error
/// other than "held" reads as `Held`, the cautious answer.
pub(super) fn probe_lock(lock: &Path) -> EndpointLock {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::os::unix::io::AsRawFd;
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(lock)
    else {
        return EndpointLock::Free;
    };
    let Ok(meta) = file.metadata() else {
        return EndpointLock::Free;
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.is_file() || meta.uid() != me {
        return EndpointLock::Free;
    }
    // SAFETY: a valid open fd, released by the close when `file` drops.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0 {
        return EndpointLock::Free;
    }
    let e = std::io::Error::last_os_error();
    if e.kind() != std::io::ErrorKind::WouldBlock {
        log::warn!("santree server: can't probe {}: {e}", lock.display());
    }
    EndpointLock::Held
}

/// Wait up to `within` for nobody to hold `lock`. `false`: it is still held — a
/// server that was told to stop and whose socket is gone is still running (or
/// still closing its sessions), and neither "gone" nor "its sessions are over".
pub(super) async fn wait_until_free(lock: &Path, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        if probe_lock(lock) == EndpointLock::Free {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// `server-r<revision>.lock` beside `socket`.
pub(super) fn lock_beside(socket: &Path, revision: u32) -> PathBuf {
    socket.with_file_name(santree_server::endpoint::lock_name(revision))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::testkit::HeldLock;
    use std::os::unix::io::AsRawFd;

    fn lock_file() -> (tempfile::TempDir, PathBuf) {
        let dir = crate::server::testkit::scratch();
        let path = dir.path().join("server-r1.lock");
        std::fs::write(&path, b"").unwrap();
        (dir, path)
    }

    /// An exclusive hold — what a server keeps — reads as a live server; a free
    /// lock, a missing one and one that is not a plain file we own do not.
    #[test]
    fn only_an_exclusively_held_lock_is_a_live_server() {
        let (dir, path) = lock_file();
        assert_eq!(probe_lock(&path), EndpointLock::Free);
        let server = HeldLock::exclusive(&path);
        assert_eq!(probe_lock(&path), EndpointLock::Held);
        // Waits for the probe to read it free (a stray fork's copy aside).
        server.let_go();
        assert_eq!(
            probe_lock(&dir.path().join("missing.lock")),
            EndpointLock::Free
        );
        let link = dir.path().join("link.lock");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let _server = HeldLock::exclusive(&path);
        assert_eq!(
            probe_lock(&link),
            EndpointLock::Free,
            "a symlink was followed"
        );
    }

    /// A stopped server's lock frees when it exits, and the wait sees it.
    #[tokio::test]
    async fn the_wait_ends_when_the_lock_is_let_go_and_gives_up_if_it_is_not() {
        let (_dir, path) = lock_file();
        let server = HeldLock::exclusive(&path);
        assert!(!wait_until_free(&path, Duration::from_millis(200)).await);
        let letting_go = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            drop(server);
        });
        assert!(wait_until_free(&path, Duration::from_secs(5)).await);
        letting_go.await.unwrap();
    }

    /// Probes are shared holds: any number overlapping never look like a
    /// server to each other (an exclusive probe read the other as `Held`, and
    /// a launch that met one exited "occupied" with nobody there).
    #[test]
    fn overlapping_probes_do_not_read_each_other_as_a_server() {
        let (_dir, path) = lock_file();
        let other_probe = HeldLock::shared(&path);
        assert_eq!(probe_lock(&path), EndpointLock::Free);
        let another = HeldLock::shared(&path);
        assert_eq!(probe_lock(&path), EndpointLock::Free);
        drop((other_probe, another));
        // And a probe in flight does not stop a server taking its lock… only an
        // exclusive request while a shared one is held is refused, which is the
        // launcher's own case, which the server waits out.
        let probing = HeldLock::shared(&path);
        let file = std::fs::File::open(&path).unwrap();
        // SAFETY: a valid open fd.
        assert_ne!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        drop(probing);
    }
}
