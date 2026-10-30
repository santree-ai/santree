//! Opening an agent CLI's record of a session — a Claude transcript, a Codex
//! rollout, a subagent's transcript or sidecar — when santree did not choose
//! the whole path.
//!
//! Such a path comes from a hook payload, a stored row, or a listing of a
//! directory another process writes to, and any process running as the user
//! can plant a link, a FIFO or a device where a record should be. So a record
//! is opened one way, which makes what is read the file the caller meant:
//!
//! - never through a symbolic link in the file's own place (`O_NOFOLLOW`), and
//!   never blocking on a FIFO swapped in where a file was (`O_NONBLOCK`, which
//!   changes nothing for a regular file);
//! - a regular file by the opened handle's own `fstat`, not by a `stat` of the
//!   path, which can have changed since;
//! - inside one of the directories the caller expects, by the path the kernel
//!   has for the opened handle (`F_GETPATH`). `O_NOFOLLOW` guards only the last
//!   component: a directory above it can be a link to anywhere.

use std::ffi::OsStr;
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// A record opened for reading.
pub(crate) struct Record {
    pub file: File,
    /// The opened handle's own metadata: its length and identity.
    pub meta: Metadata,
    /// Where the kernel says the opened file is, links resolved.
    pub path: PathBuf,
}

/// Open `path` as a record inside one of `roots`, which must be canonical
/// ([`canonical`]). Fails for a link in the file's place, anything but a
/// regular file, and a file that is not under a root once opened.
pub(crate) fn open(path: &Path, roots: &[PathBuf]) -> io::Result<Record> {
    let file = open_no_follow(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let real = real_path(&file)?;
    if !roots.iter().any(|root| real.starts_with(root)) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is outside the records santree reads", real.display()),
        ));
    }
    Ok(Record {
        file,
        meta,
        path: real,
    })
}

/// Open `path` for reading, refusing a symbolic link in its place, without
/// blocking on a FIFO. The caller still has to check what it opened.
pub(crate) fn open_no_follow(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

/// The path the kernel has for an open file (`fcntl(F_GETPATH)`): absolute,
/// with every link on the way resolved.
pub(crate) fn real_path(file: &File) -> io::Result<PathBuf> {
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes a NUL-terminated path of at most MAXPATHLEN
    // (== PATH_MAX) bytes into the buffer, which holds that many.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return Err(io::Error::last_os_error());
    }
    let len = buf
        .iter()
        .position(|b| *b == 0)
        .ok_or_else(|| io::Error::other("F_GETPATH returned an unterminated path"))?;
    Ok(PathBuf::from(OsStr::from_bytes(&buf[..len])))
}

/// `roots` in canonical form, the ones that resolve: what [`open`] and
/// [`within`] compare against. A root is resolved once, by the caller, rather
/// than once per file.
pub(crate) fn canonical(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect()
}

/// Whether a real path sits under one of the canonical `roots`.
pub(crate) fn within(roots: &[PathBuf], path: &Path) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}
