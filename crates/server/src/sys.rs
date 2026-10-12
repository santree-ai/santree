//! The process-level setup `serve` does first.

use std::fs::OpenOptions;
use std::os::fd::IntoRawFd;

/// Point each closed standard fd (0–2) at `/dev/null`, before the process
/// opens anything. Otherwise the next file opened takes the number, and
/// whatever writes to stdout or stderr — a panic message — writes into it:
/// the log, a client's socket, a PTY master. (Rust's runtime does this for
/// a binary's `main`; `serve` doesn't rely on being called from one.)
pub fn fill_standard_fds() -> std::io::Result<()> {
    for fd in 0..=2 {
        // SAFETY: F_GETFD on any fd number only reports EBADF if it is closed.
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } != -1 {
            continue;
        }
        let null = OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/null")?
            .into_raw_fd();
        // Every lower fd is open by now, so `open` returned `fd` itself; a
        // dup2 covers the case it somehow didn't.
        if null != fd {
            // SAFETY: both are fds this process owns; the copy outlives the
            // original, which is closed.
            unsafe {
                libc::dup2(null, fd);
                libc::close(null);
            }
        }
        // `/dev/null` is meant to stay at a standard fd through exec: a PTY
        // child gets its own from the PTY anyway.
        // SAFETY: as above.
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, 0);
        }
    }
    Ok(())
}

/// Linux: no core dumps, and no same-user `ptrace` or `/proc/<pid>/mem` —
/// the server holds every session's input and the env secrets passed to it.
/// (macOS: the hardened runtime does the same for a signed build.) A PTY
/// child is dumpable again after its exec.
pub fn not_dumpable() {
    #[cfg(target_os = "linux")]
    // SAFETY: PR_SET_DUMPABLE takes an int argument and touches nothing else.
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
    }
}

/// Leave the launcher's session: a terminal closing, or the app's process
/// group being signalled, must not reach the server. EPERM (already a
/// session leader) changes nothing worth failing over.
pub fn detach() {
    // SAFETY: setsid has no preconditions; its only failure is EPERM.
    unsafe {
        libc::setsid();
    }
}

/// The most file descriptors asked for: macOS's `OPEN_MAX`, which is also
/// what its `setrlimit` accepts for `RLIMIT_NOFILE` whatever the hard limit.
const WANT_FDS: libc::rlim_t = 10_240;

/// Raise the soft fd limit to `min(hard, 10240)`. Each session holds a PTY
/// master and each client a socket; the default soft limit (256 on macOS)
/// runs out long before `max_ptys` does.
pub fn raise_fd_limit() {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `lim` is a valid out-pointer.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        return;
    }
    let want = WANT_FDS.min(lim.rlim_max);
    if lim.rlim_cur >= want {
        return;
    }
    lim.rlim_cur = want;
    // SAFETY: `lim` is a valid, initialised rlimit.
    unsafe {
        libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
    }
}
