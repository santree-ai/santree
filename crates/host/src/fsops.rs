//! `fs.*`, and the optional confinement to a projects root.
//!
//! Confinement is a guardrail, not a boundary: a client that can `exec.run`
//! anything as the operator could write anywhere the operator can. What it
//! catches is a client bug — a terminal opened in `$HOME` because its worktree
//! was deleted (santree-pty would fall back silently), or an `fs.write` about
//! to land on `~/.ssh`. So it covers exactly: the `cwd` of `pty.open` and
//! `exec.run` (must exist, and resolve under the root) and the parent of an
//! `fs.write`. Reads and stats are not confined (`fs.read` has its own
//! `within`). A host without a root ([`Confine::None`]) checks only that paths
//! are absolute: the local server, whose one client already validated them.

use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use santree_remote_proto::{
    ErrorCode, FsKind, FsReadParams, FsReadResult, FsStat, FsWriteParams, WireError, FS_READ_MAX,
};

use crate::util::{err, io_err};

pub fn absolute(path: &str, what: &str) -> Result<PathBuf, WireError> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(err(
            ErrorCode::BadRequest,
            format!("{what} must be absolute"),
        ))
    }
}

/// Where the host lets working directories and writes land.
#[derive(Debug, Clone)]
pub enum Confine {
    /// Anywhere: paths must only be absolute.
    None,
    /// Under this root.
    Root(Root),
}

impl Confine {
    /// `pty.open`'s `cwd`: under a root it is required and resolved there;
    /// without one it is optional, absolute when given, and passed through for
    /// santree-pty to use (or fall back to `$HOME` from), as the app always
    /// did.
    pub fn pty_cwd(&self, cwd: Option<&str>) -> Result<Option<String>, WireError> {
        match self {
            Confine::Root(root) => Ok(Some(root.cwd(cwd)?.to_string_lossy().into_owned())),
            Confine::None => match cwd.filter(|c| !c.is_empty()) {
                Some(cwd) => absolute(cwd, "cwd").map(|_| Some(cwd.to_string())),
                None => Ok(None),
            },
        }
    }

    /// `exec.run`'s `cwd`: required and absolute everywhere, and under the root
    /// when there is one.
    pub fn exec_cwd(&self, cwd: &str) -> Result<PathBuf, WireError> {
        match self {
            Confine::Root(root) => root.cwd(Some(cwd)),
            Confine::None => absolute(cwd, "cwd"),
        }
    }

    /// Where an `fs.write` to `path` lands, its parent made when missing.
    pub fn write_target(&self, path: &str) -> Result<PathBuf, WireError> {
        match self {
            Confine::Root(root) => root.write_target(path),
            Confine::None => {
                let full = absolute(path, "path")?;
                let (Some(parent), Some(_)) = (full.parent(), full.file_name()) else {
                    return Err(err(ErrorCode::BadRequest, "path has no file name"));
                };
                std::fs::create_dir_all(parent)
                    .map_err(|e| io_err(e, &parent.to_string_lossy()))?;
                Ok(full)
            }
        }
    }
}

/// The projects root. Its real path is resolved at each check, so a root made
/// (or remounted) after the host started is followed.
#[derive(Debug, Clone)]
pub struct Root {
    path: PathBuf,
}

impl Root {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn real(&self) -> Result<PathBuf, WireError> {
        self.path
            .canonicalize()
            .map_err(|e| io_err(e, &format!("the projects root {}", self.path.display())))
    }

    fn outside(&self, what: &str, shown: &str) -> WireError {
        err(
            ErrorCode::Outside,
            format!("{what} {shown} is outside {}", self.path.display()),
        )
    }

    /// A working directory: required, an existing directory, under the root.
    /// The real path is what the process gets.
    pub fn cwd(&self, cwd: Option<&str>) -> Result<PathBuf, WireError> {
        let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
            return Err(err(ErrorCode::BadRequest, "cwd is required"));
        };
        let real = absolute(cwd, "cwd")?
            .canonicalize()
            .map_err(|e| io_err(e, cwd))?;
        if !real.starts_with(self.real()?) {
            return Err(self.outside("cwd", cwd));
        }
        if !real.is_dir() {
            return Err(err(ErrorCode::Io, format!("{cwd} is not a directory")));
        }
        Ok(real)
    }

    /// Where an `fs.write` to `path` lands: its parent, made when missing,
    /// under the root; the real parent joined with the file name. The nearest
    /// existing ancestor is checked before anything is made, and the parent
    /// again after.
    pub fn write_target(&self, path: &str) -> Result<PathBuf, WireError> {
        let full = absolute(path, "path")?;
        let (Some(parent), Some(name)) = (full.parent(), full.file_name()) else {
            return Err(err(ErrorCode::BadRequest, "path has no file name"));
        };
        let existing = parent
            .ancestors()
            .find(|a| a.exists())
            .unwrap_or(Path::new("/"));
        let root = self.real()?;
        let real = existing
            .canonicalize()
            .map_err(|e| io_err(e, &existing.to_string_lossy()))?;
        if !real.starts_with(&root) {
            return Err(self.outside("path", path));
        }
        std::fs::create_dir_all(parent).map_err(|e| io_err(e, &parent.to_string_lossy()))?;
        let real = parent
            .canonicalize()
            .map_err(|e| io_err(e, &parent.to_string_lossy()))?;
        if !real.starts_with(&root) {
            return Err(self.outside("path", path));
        }
        Ok(real.join(name))
    }
}

pub fn read(p: &FsReadParams) -> Result<FsReadResult, WireError> {
    let path = absolute(&p.path, "path")?;
    let path = match &p.within {
        Some(within) => {
            let root = absolute(within, "within")?
                .canonicalize()
                .map_err(|e| io_err(e, within))?;
            let real = path.canonicalize().map_err(|e| io_err(e, &p.path))?;
            if !real.starts_with(&root) {
                return Err(err(
                    ErrorCode::Outside,
                    format!("{} resolves outside {within}", p.path),
                ));
            }
            // Read the resolved path, so a swap after the check can't escape.
            real
        }
        None => path,
    };
    // O_NONBLOCK: opening a FIFO nobody writes to returns at once instead of
    // pinning this thread; O_NOCTTY: a terminal device never becomes ours.
    // Then only a regular file is read, checked on the descriptor itself.
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(&path)
        .map_err(|e| io_err(e, &p.path))?;
    let meta = file.metadata().map_err(|e| io_err(e, &p.path))?;
    if meta.is_dir() {
        return Err(err(ErrorCode::Io, format!("{} is a directory", p.path)));
    }
    if !meta.is_file() {
        return Err(err(
            ErrorCode::Io,
            format!("{} is not a regular file", p.path),
        ));
    }
    let size = meta.len();
    let start = match p.offset.unwrap_or(0) {
        offset if offset < 0 => size.saturating_sub(offset.unsigned_abs()),
        offset => (offset as u64).min(size),
    };
    let len = p.len.unwrap_or(FS_READ_MAX).min(FS_READ_MAX);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| io_err(e, &p.path))?;
    let mut data = Vec::new();
    file.take(len)
        .read_to_end(&mut data)
        .map_err(|e| io_err(e, &p.path))?;
    let eof = start + data.len() as u64 >= size;
    Ok(FsReadResult { data, size, eof })
}

/// Write `p.data` to `target` (from [`Root::write_target`]) atomically: a
/// temp file beside it, synced, then a rename, and the directory synced. The
/// temp file is made 0600, so the content is never readable by others on the
/// way, and given its final mode
/// (`p.mode`, else the replaced file's, else the umask's default) before the
/// rename — permission bits only: never setuid, setgid or sticky.
pub fn write(p: &FsWriteParams, target: &Path) -> Result<(), WireError> {
    use std::os::unix::fs::PermissionsExt;
    static TEMP: AtomicU64 = AtomicU64::new(0);
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(err(ErrorCode::BadRequest, "path has no file name"));
    };
    let temp = parent.join(format!(
        ".{}.santree-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&p.data)?;
        let mode = match p.mode {
            Some(mode) => mode,
            None => match std::fs::metadata(target) {
                Ok(meta) => meta.permissions().mode(),
                Err(_) => 0o666 & !umask(),
            },
        };
        file.set_permissions(std::fs::Permissions::from_mode(mode & 0o777))?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, target)?;
        // The rename itself is durable only once its directory is synced.
        std::fs::File::open(parent)?.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(io_err(e, &p.path));
    }
    Ok(())
}

/// This process's umask, from `/proc/self/status` (reading it with umask(2)
/// would set it, racing every thread that creates a file). Unreadable: 0o077,
/// the private answer.
fn umask() -> u32 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("Umask:"))
                .and_then(|v| u32::from_str_radix(v.trim(), 8).ok())
        })
        .unwrap_or(0o077)
}

pub fn stat(path: &str) -> Result<FsStat, WireError> {
    let full = absolute(path, "path")?;
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(FsStat::default()),
        Err(e) => return Err(io_err(e, path)),
    };
    let kind = if meta.file_type().is_symlink() {
        FsKind::Symlink
    } else if meta.is_dir() {
        FsKind::Dir
    } else if meta.is_file() {
        FsKind::File
    } else {
        FsKind::Other
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(FsStat {
        exists: true,
        kind: Some(kind),
        size: meta.len(),
        mtime_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Without a root, a `pty.open` cwd is still a path on this machine, not
    /// one relative to wherever the host happened to start.
    #[test]
    fn an_unconfined_pty_cwd_must_be_absolute() {
        let none = Confine::None;
        assert_eq!(
            none.pty_cwd(Some("projects/web")).unwrap_err().code,
            ErrorCode::BadRequest
        );
        assert_eq!(none.pty_cwd(Some("/tmp")).unwrap(), Some("/tmp".into()));
        assert_eq!(none.pty_cwd(None).unwrap(), None);
        assert_eq!(none.pty_cwd(Some("")).unwrap(), None);
    }

    #[test]
    fn cwd_and_write_parent_stay_under_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("projects");
        std::fs::create_dir_all(root_path.join("web/src")).unwrap();
        std::fs::create_dir_all(dir.path().join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), root_path.join("escape")).unwrap();
        let root = Root::new(root_path.clone());
        let s = |p: &Path| p.to_string_lossy().into_owned();

        assert_eq!(
            root.cwd(Some(&s(&root_path.join("web")))).unwrap(),
            root_path.canonicalize().unwrap().join("web")
        );
        let code = |r: Result<PathBuf, WireError>| r.unwrap_err().code;
        assert_eq!(code(root.cwd(None)), ErrorCode::BadRequest);
        assert_eq!(code(root.cwd(Some("web"))), ErrorCode::BadRequest);
        assert_eq!(
            code(root.cwd(Some(&s(&root_path.join("web/../..")))),),
            ErrorCode::Outside
        );
        assert_eq!(
            code(root.cwd(Some(&s(&root_path.join("escape"))))),
            ErrorCode::Outside
        );
        assert_eq!(
            code(root.cwd(Some(&s(&root_path.join("missing"))))),
            ErrorCode::NotFound
        );
        std::fs::write(root_path.join("web/file"), b"x").unwrap();
        assert_eq!(
            code(root.cwd(Some(&s(&root_path.join("web/file"))))),
            ErrorCode::Io
        );

        // A new directory under the root is made; one through the symlink is
        // refused before anything is created.
        let target = root
            .write_target(&s(&root_path.join("web/new/deep/f.txt")))
            .unwrap();
        assert!(target.parent().unwrap().is_dir());
        assert_eq!(
            code(root.write_target(&s(&root_path.join("escape/sub/f.txt")))),
            ErrorCode::Outside
        );
        assert!(!dir.path().join("elsewhere/sub").exists());
        assert_eq!(
            code(root.write_target(&s(&dir.path().join("elsewhere/f.txt")))),
            ErrorCode::Outside
        );
        // The file itself may be a symlink out: the rename replaces the link.
        std::os::unix::fs::symlink(
            dir.path().join("elsewhere/target"),
            root_path.join("web/link"),
        )
        .unwrap();
        let t = root.write_target(&s(&root_path.join("web/link"))).unwrap();
        let p = FsWriteParams {
            path: s(&root_path.join("web/link")),
            data: b"hi".to_vec(),
            mode: None,
        };
        write(&p, &t).unwrap();
        assert!(!dir.path().join("elsewhere/target").exists());
        assert_eq!(std::fs::read(root_path.join("web/link")).unwrap(), b"hi");
    }

    /// `fs.read` of a FIFO nobody writes to is refused at once
    /// instead of blocking its thread in `open` forever; so is a device.
    #[test]
    fn reads_refuse_what_is_not_a_regular_file_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: plain mkfifo(3) on a NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let read_of = |path: &Path| {
            let p = FsReadParams {
                path: path.to_string_lossy().into_owned(),
                ..Default::default()
            };
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(read(&p));
            });
            rx.recv_timeout(std::time::Duration::from_secs(5))
                .expect("fs.read blocked")
        };
        let e = read_of(&fifo).unwrap_err();
        assert!(e.msg.contains("not a regular file"), "{}", e.msg);
        let e = read_of(Path::new("/dev/null")).unwrap_err();
        assert!(e.msg.contains("not a regular file"), "{}", e.msg);
        std::fs::write(dir.path().join("f"), b"data").unwrap();
        assert_eq!(read_of(&dir.path().join("f")).unwrap().data, b"data");
    }

    /// The final mode is permission bits only (no setuid, setgid
    /// or sticky), a replaced file's mode is kept the same way, and a new
    /// file without a mode gets the umask's default.
    #[test]
    fn writes_get_permission_bits_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mode_of = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o7777;
        let put = |name: &str, mode: Option<u32>| {
            let target = dir.path().join(name);
            let p = FsWriteParams {
                path: target.to_string_lossy().into_owned(),
                data: b"secret".to_vec(),
                mode,
            };
            write(&p, &target).unwrap();
            mode_of(&target)
        };
        assert_eq!(put(".env", Some(0o600)), 0o600);
        assert_eq!(put("tool", Some(0o6755)), 0o755, "setuid/setgid dropped");
        assert_eq!(put("dir-ish", Some(0o1777)), 0o777, "sticky dropped");
        std::fs::set_permissions(
            dir.path().join(".env"),
            std::fs::Permissions::from_mode(0o640),
        )
        .unwrap();
        assert_eq!(put(".env", None), 0o640, "the replaced file's mode is kept");
        assert_eq!(put("new", None), 0o666 & !umask());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(names.is_empty(), "{names:?}");
    }
}
