//! Copying a binary the bundle ships (`santree-hook`, `santree-server`) to a
//! stable place of the app's own, so an update that moves the bundle never
//! moves what a running process executes.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Seek};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};

/// How old a half-written temp file must be before it is swept: younger ones
/// may be another instance's copy in flight.
pub const STALE_TMP: Duration = Duration::from_secs(10 * 60);

/// What [`install_copy`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Installed {
    /// The copy was already these bytes, in place, 0755.
    Unchanged,
    /// A copy was written (new, or replacing a different one).
    Replaced,
}

/// Copy `src` to `<dir>/<name>`: into a temp file beside it, made 0755, and
/// renamed over the target, so the path never holds a half-written file and an
/// executable in use is never modified in place. Only when the bytes differ.
/// Nothing at the target is followed: a symlink there is replaced, not written
/// through. `dir` must already be prepared (private, this user's) by the caller.
pub fn install_copy(src: &Path, dir: &Path, name: &str) -> Result<Installed> {
    let mut source = File::open(src)
        .with_context(|| format!("can't read the bundled {name} at {}", src.display()))?;
    let meta = source.metadata()?;
    if !meta.is_file() {
        bail!("the bundled {name} at {} is not a file", src.display());
    }
    let dest = dir.join(name);
    if is_installed(&dest, &mut source, meta.len())? {
        return Ok(Installed::Unchanged);
    }

    // `create_new` is O_EXCL: it never opens something that is already there,
    // a planted symlink included.
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| -> Result<()> {
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&tmp)
            .with_context(|| format!("can't create {}", tmp.display()))?;
        source.rewind()?;
        std::io::copy(&mut source, &mut out).with_context(|| format!("can't copy {name}"))?;
        // The umask may have narrowed the mode `open` asked for.
        out.set_permissions(fs::Permissions::from_mode(0o755))?;
        out.sync_all()?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("can't put {name} at {}", dest.display()));
    }
    Ok(Installed::Replaced)
}

/// Remove the temp files [`install_copy`] left in `dir` for `name` that are
/// older than `older_than`: a copy killed midway leaves one, and nothing else
/// would reclaim it.
pub fn sweep_stale_tmp(dir: &Path, name: &str, older_than: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let prefix = format!(".{name}.");
    for entry in entries.flatten() {
        let is_tmp = entry
            .file_name()
            .to_str()
            .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".tmp"));
        let old = entry
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= older_than);
        if is_tmp && old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Whether `dest` is already a plain file of ours, 0755, with exactly `src`'s
/// bytes. A symlink, another owner or another mode is "not installed": the copy
/// that replaces it is ours.
fn is_installed(dest: &Path, src: &mut File, src_len: u64) -> Result<bool> {
    let meta = match fs::symlink_metadata(dest) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e).with_context(|| format!("can't read {}", dest.display())),
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.is_file() || meta.len() != src_len || meta.uid() != me || meta.mode() & 0o7777 != 0o755
    {
        return Ok(false);
    }
    let Ok(mut dest) = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dest)
    else {
        return Ok(false);
    };
    src.rewind()?;
    let (mut a, mut b) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = read_full(src, &mut a)?;
        let m = read_full(&mut dest, &mut b[..n.max(1)])?;
        if n != m || a[..n] != b[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// `read` until `buf` is full or the file ends.
fn read_full(file: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}
