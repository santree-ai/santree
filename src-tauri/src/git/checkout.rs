//! Where a checkout lives, and so where its git runs and its files are read —
//! the one dispatch seam between this machine and Daedalus (docs/remote.md,
//! "How santree dispatches").
//!
//! Everything in [`crate::git`] takes a [`Checkout`] rather than a path, so a
//! git operation is written once and runs wherever the checkout is: a child
//! process here, or `exec.run` / `fs.read` on the box through the link. A
//! Daedalus checkout's path names a directory on the server, so nothing here
//! hands it to this machine's filesystem; code that genuinely needs one asks
//! [`Checkout::local_path`], which a Daedalus checkout refuses.
//!
//! The remote half is blocking ([`RemoteClient::call_blocking`]), like the
//! local child processes it stands in for: git code runs on the blocking pool.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};

use santree_remote_client::proto::{m, ExecParams, FsKind, FsReadParams, FsStatParams};
use santree_remote_client::RemoteClient;

/// Where a checkout's commands run.
#[derive(Clone)]
enum Host {
    /// This machine: child processes and `std::fs`.
    Local,
    /// The Daedalus box, through the live link.
    Daedalus(Arc<RemoteClient>),
}

/// A checkout directory — a repo root or one of its worktrees — and where it
/// lives. Cheap to clone.
#[derive(Clone)]
pub struct Checkout {
    host: Host,
    path: PathBuf,
}

/// A finished git run: whether it exited 0, and what it printed.
pub(crate) struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Checkout {
    /// A checkout on this machine.
    pub fn local(path: impl Into<PathBuf>) -> Self {
        Self {
            host: Host::Local,
            path: path.into(),
        }
    }

    /// A checkout on Daedalus, reached through `client`. `path` is absolute on
    /// the server.
    pub fn daedalus(client: Arc<RemoteClient>, path: impl Into<PathBuf>) -> Self {
        Self {
            host: Host::Daedalus(client),
            path: path.into(),
        }
    }

    /// Another directory on the same machine — a worktree of this repo root.
    pub fn at(&self, path: impl Into<PathBuf>) -> Self {
        Self {
            host: self.host.clone(),
            path: path.into(),
        }
    }

    /// The directory, as its own machine spells it. On Daedalus that is a
    /// server path: never hand it to `std::fs` or a local process.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The directory on **this** machine, for the few operations that are
    /// still local-only (they create or remove directories, or run something
    /// other than git). A Daedalus checkout refuses, so such an operation fails
    /// closed rather than touching a local path that merely shares a spelling.
    pub fn local_path(&self) -> Result<&Path> {
        match self.host {
            Host::Local => Ok(&self.path),
            Host::Daedalus(_) => bail!("This isn't available for Daedalus projects yet."),
        }
    }

    /// Whether the directory exists (following symlinks here; the server's
    /// `fs.stat` is an lstat, and a checkout it lists is a real directory).
    pub fn is_dir(&self) -> bool {
        match &self.host {
            Host::Local => self.path.is_dir(),
            Host::Daedalus(client) => client
                .call_blocking::<m::FsStat>(&FsStatParams {
                    path: self.server_path(&self.path),
                })
                .is_ok_and(|stat| stat.exists && stat.kind == Some(FsKind::Dir)),
        }
    }

    /// Run `git <args>` in the checkout. Errors only when git can't be run at
    /// all (or, on Daedalus, the link fails); a non-zero exit is `ok: false`.
    pub(crate) fn git(&self, args: &[&str]) -> Result<Output> {
        match &self.host {
            Host::Local => {
                let out = Command::new("git")
                    .arg("-C")
                    .arg(&self.path)
                    // Read-only commands (`status`, `diff`) opportunistically take
                    // `.git/index.lock` to write back a refreshed index. That's a
                    // pure optimization, but it makes every status poll a contender
                    // for the lock that `add`/`restore`/`commit` *must* have.
                    // Opting out (what editors and IDEs do) keeps the reads out of
                    // the fight; commands whose index write is required are
                    // unaffected. The session host sets the same on Daedalus.
                    .env("GIT_OPTIONAL_LOCKS", "0")
                    .args(args)
                    .output()
                    .map_err(|e| anyhow!("failed to run git: {e}"))?;
                Ok(Output {
                    ok: out.status.success(),
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                })
            }
            Host::Daedalus(client) => {
                let argv = std::iter::once("git")
                    .chain(args.iter().copied())
                    .map(str::to_string)
                    .collect();
                let out = client.call_blocking::<m::ExecRun>(&ExecParams {
                    cwd: self.server_path(&self.path),
                    argv,
                    ..ExecParams::default()
                })?;
                // Parsed output cut at the host's cap would be a confident, wrong
                // answer (a status list missing its tail, half a diff).
                if out.truncated {
                    bail!("git {}: more output than Daedalus sends", args.join(" "));
                }
                Ok(Output {
                    ok: out.success(),
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                })
            }
        }
    }

    /// Up to `max` bytes from the start of the file at `rel` inside the
    /// checkout, and whether that was all of it. Refuses a path that escapes
    /// the checkout — lexically, or through a symlink — and anything that isn't
    /// a regular file.
    pub(crate) fn read(&self, rel: &str, max: u64) -> Result<(Vec<u8>, bool)> {
        match &self.host {
            Host::Local => {
                let mut data = Vec::new();
                let mut file = super::open_in_worktree(&self.path, rel)?.take(max);
                file.read_to_end(&mut data)?;
                let whole = file.into_inner().read(&mut [0u8; 1])? == 0;
                Ok((data, whole))
            }
            Host::Daedalus(client) => {
                let path = super::safe_path(&self.path, rel)?;
                let read = client.call_blocking::<m::FsRead>(&FsReadParams {
                    path: self.server_path(&path),
                    len: Some(max),
                    within: Some(self.server_path(&self.path)),
                    ..FsReadParams::default()
                })?;
                Ok((read.data, read.eof))
            }
        }
    }

    /// `rel` as a path git can be handed, once it is known to resolve inside
    /// the checkout (following symlinks). For the one git command that reads
    /// any path it is given: `diff --no-index`.
    pub(crate) fn contained(&self, rel: &str) -> Result<PathBuf> {
        match &self.host {
            Host::Local => super::safe_real_path(&self.path, rel),
            Host::Daedalus(client) => {
                let path = super::safe_path(&self.path, rel)?;
                // A zero-length read is the host's containment check: it resolves
                // the real path and answers `outside` when it leaves `within`.
                client.call_blocking::<m::FsRead>(&FsReadParams {
                    path: self.server_path(&path),
                    len: Some(0),
                    within: Some(self.server_path(&self.path)),
                    ..FsReadParams::default()
                })?;
                Ok(path)
            }
        }
    }

    /// A path as the wire's string. Server paths are the host's own UTF-8
    /// (every one came from it), so nothing is lost.
    fn server_path(&self, path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
}

impl std::fmt::Debug for Checkout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let host = match self.host {
            Host::Local => "local",
            Host::Daedalus(_) => "daedalus",
        };
        write!(f, "{host}:{}", self.path.display())
    }
}
