//! Where a checkout lives, and so where its git runs and its files are read —
//! the one dispatch seam between this machine and Daedalus (docs/remote.md,
//! "How santree dispatches").
//!
//! Everything in [`crate::git`] takes a [`Checkout`] rather than a path, so a
//! git operation is written once and runs wherever the checkout is: a child
//! process here, or `exec.run` / `fs.*` on the box through the link — reads,
//! writes, and the few file operations a worktree or a split needs (stat,
//! write, remove), each spelled once for both. A
//! Daedalus checkout's path names a directory on the server, so nothing here
//! hands it to this machine's filesystem; code that genuinely needs one asks
//! [`Checkout::local_path`], which a Daedalus checkout refuses.
//!
//! The remote half is blocking ([`RemoteClient::call_blocking`]), like the
//! local child processes it stands in for: git code runs on the blocking pool.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use anyhow::{anyhow, bail, ensure, Result};

pub(crate) use santree_remote_client::proto::FsKind;
use santree_remote_client::proto::{
    m, ExecParams, FsReadParams, FsStatParams, FsWriteParams, EXEC_MAX_TIMEOUT_MS,
};
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

/// A finished git run: whether it exited 0, and what it printed. `stdout` is
/// the raw bytes (a split refuses non-UTF-8 rather than guess); `stderr` is
/// only ever shown.
pub(crate) struct Output {
    pub ok: bool,
    pub stdout: Vec<u8>,
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

    /// The directory on **this** machine, for the operations that are still
    /// local-only (agents, the AI review). A Daedalus checkout
    /// refuses, so such an operation fails closed rather than touching a local
    /// path that merely shares a spelling.
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
        self.git_with(args, &[], None)
    }

    /// [`Self::git`] with extra environment and bytes on stdin — what a split
    /// needs for its private index (`GIT_INDEX_FILE`) and pathspec lists. The
    /// one place a git process is started, here or on the box.
    pub(crate) fn git_with(
        &self,
        args: &[&str],
        env: &[(&str, &str)],
        stdin: Option<&[u8]>,
    ) -> Result<Output> {
        #[cfg(test)]
        super::count_git_call(&self.path);
        match &self.host {
            Host::Local => {
                let mut cmd = Command::new("git");
                cmd.arg("-C")
                    .arg(&self.path)
                    // Read-only commands (`status`, `diff`) opportunistically take
                    // `.git/index.lock` to write back a refreshed index. That's a
                    // pure optimization, but it makes every status poll a contender
                    // for the lock that `add`/`restore`/`commit` *must* have.
                    // Opting out (what editors and IDEs do) keeps the reads out of
                    // the fight; commands whose index write is required are
                    // unaffected. The session host sets the same on Daedalus.
                    .env("GIT_OPTIONAL_LOCKS", "0")
                    .envs(env.iter().copied())
                    .args(args)
                    .stdin(if stdin.is_some() {
                        Stdio::piped()
                    } else {
                        Stdio::null()
                    })
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                let mut child = cmd.spawn().map_err(|e| anyhow!("failed to run git: {e}"))?;
                // Fed from its own thread, so a large input git rejects early can't
                // deadlock against a full stderr pipe.
                let writer = match (child.stdin.take(), stdin) {
                    (Some(mut pipe), Some(bytes)) => {
                        let bytes = bytes.to_vec();
                        Some(std::thread::spawn(move || pipe.write_all(&bytes)))
                    }
                    _ => None,
                };
                let out = child
                    .wait_with_output()
                    .map_err(|e| anyhow!("failed to run git: {e}"))?;
                if let Some(writer) = writer {
                    let _ = writer.join();
                }
                Ok(Output {
                    ok: out.status.success(),
                    stdout: out.stdout,
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
                    env: (!env.is_empty()).then(|| {
                        env.iter()
                            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                            .collect()
                    }),
                    stdin: stdin.map(<[u8]>::to_vec),
                    // A local git has no deadline; a push or fetch over a slow
                    // uplink must not be cut at the host's one-minute default.
                    timeout_ms: Some(EXEC_MAX_TIMEOUT_MS),
                })?;
                // Parsed output cut at the host's cap would be a confident, wrong
                // answer (a status list missing its tail, half a diff).
                if out.truncated {
                    bail!("git {}: more output than Daedalus sends", args.join(" "));
                }
                Ok(Output {
                    ok: out.success(),
                    stdout: out.stdout,
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                })
            }
        }
    }

    /// What is at `path` (an absolute path on the checkout's machine), without
    /// following a final symlink; `None` when nothing is.
    pub(crate) fn stat(&self, path: &Path) -> Result<Option<FsKind>> {
        match &self.host {
            Host::Local => match std::fs::symlink_metadata(path) {
                Ok(meta) => {
                    let kind = meta.file_type();
                    Ok(Some(if kind.is_symlink() {
                        FsKind::Symlink
                    } else if kind.is_dir() {
                        FsKind::Dir
                    } else if kind.is_file() {
                        FsKind::File
                    } else {
                        FsKind::Other
                    }))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(anyhow!("can't read {}: {e}", path.display())),
            },
            Host::Daedalus(client) => {
                let stat = client.call_blocking::<m::FsStat>(&FsStatParams {
                    path: self.server_path(path),
                })?;
                Ok(stat.exists.then(|| stat.kind.unwrap_or(FsKind::Other)))
            }
        }
    }

    /// Whether `path` (absolute, on the checkout's machine) is a regular file
    /// that machine would run — following symlinks, as running it does.
    pub(crate) fn is_executable(&self, path: &Path) -> Result<bool> {
        match &self.host {
            Host::Local => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    Ok(std::fs::metadata(path)
                        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
                }
                #[cfg(not(unix))]
                Ok(path.is_file())
            }
            Host::Daedalus(client) => {
                let path = self.server_path(path);
                let out = client.call_blocking::<m::ExecRun>(&ExecParams {
                    cwd: self.server_path(&self.path),
                    argv: ["test", "-f", &path, "-a", "-x", &path]
                        .map(str::to_string)
                        .to_vec(),
                    ..ExecParams::default()
                })?;
                Ok(out.success())
            }
        }
    }

    /// Write `data` to the file at `path`, creating its parent directories.
    pub(crate) fn write(&self, path: &Path, data: &[u8]) -> Result<()> {
        match &self.host {
            Host::Local => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, data)?;
            }
            Host::Daedalus(client) => {
                client.call_blocking::<m::FsWrite>(&FsWriteParams {
                    path: self.server_path(path),
                    data: data.to_vec(),
                    mode: None,
                })?;
            }
        }
        Ok(())
    }

    /// Delete whatever is at `path`, a directory with everything in it; a
    /// symlink is unlinked, never followed. Nothing there is success.
    pub(crate) fn remove(&self, path: &Path) -> Result<()> {
        plain_absolute(path)?;
        match &self.host {
            Host::Local => match self.stat(path)? {
                None => Ok(()),
                Some(FsKind::Dir) => Ok(std::fs::remove_dir_all(path)?),
                Some(_) => Ok(std::fs::remove_file(path)?),
            },
            Host::Daedalus(_) => self.exec(&["rm", "-rf", "--", &self.server_path(path)]),
        }
    }

    /// Remove the directory at `path` only if it is empty — reclaiming a
    /// leftover without deleting anything in it.
    pub(crate) fn remove_empty_dir(&self, path: &Path) -> Result<()> {
        plain_absolute(path)?;
        match &self.host {
            Host::Local => Ok(std::fs::remove_dir(path)?),
            Host::Daedalus(_) => self.exec(&["rmdir", "--", &self.server_path(path)]),
        }
    }

    /// Run a program other than git on the box, in the checkout, for the file
    /// operations the protocol has no method for. Its stderr is the error.
    fn exec(&self, argv: &[&str]) -> Result<()> {
        ensure!(
            matches!(self.host, Host::Daedalus(_)),
            "exec runs on Daedalus only"
        );
        let out = self.run(argv)?;
        ensure!(out.ok, "{}", out.stderr.trim());
        Ok(())
    }

    /// Run `argv` (a program and its arguments, no shell) in the checkout, on
    /// its machine — a child process here, `exec.run` on the box. Errors only
    /// when it can't be run (or its output was cut at the host's cap); a
    /// non-zero exit is `ok: false`.
    pub(crate) fn run(&self, argv: &[&str]) -> Result<Output> {
        let Some((program, args)) = argv.split_first() else {
            bail!("nothing to run");
        };
        match &self.host {
            Host::Local => {
                let out = Command::new(program)
                    .args(args)
                    .current_dir(&self.path)
                    .stdin(Stdio::null())
                    .output()
                    .map_err(|e| anyhow!("failed to run {program}: {e}"))?;
                Ok(Output {
                    ok: out.status.success(),
                    stdout: out.stdout,
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                })
            }
            Host::Daedalus(client) => {
                let out = client.call_blocking::<m::ExecRun>(&ExecParams {
                    cwd: self.server_path(&self.path),
                    argv: argv.iter().map(|s| (*s).to_string()).collect(),
                    ..ExecParams::default()
                })?;
                if out.truncated {
                    bail!("{program}: more output than Daedalus sends");
                }
                Ok(Output {
                    ok: out.success(),
                    stdout: out.stdout,
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                })
            }
        }
    }

    /// The names of the regular files directly in the directory `rel` inside
    /// the checkout — no symlinks, and never through a symlinked directory.
    /// A directory that isn't there has none.
    pub(crate) fn list_files(&self, rel: &str) -> Result<Vec<String>> {
        let dir = super::safe_path(&self.path, rel)?;
        match self.stat(&dir)? {
            None => return Ok(Vec::new()),
            Some(FsKind::Dir) => {}
            Some(_) => bail!("{} is not a directory", dir.display()),
        }
        match &self.host {
            Host::Local => Ok(std::fs::read_dir(&dir)?
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()),
            Host::Daedalus(_) => {
                // Plain POSIX `find` (no `-printf`): each line is `<dir>/<name>`.
                let dir = self.server_path(&dir);
                let out = self.run(&[
                    "find",
                    &dir,
                    "-mindepth",
                    "1",
                    "-maxdepth",
                    "1",
                    "-type",
                    "f",
                ])?;
                ensure!(out.ok, "listing {dir}: {}", out.stderr.trim());
                let prefix = format!("{}/", dir.trim_end_matches('/'));
                Ok(String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .filter_map(|line| line.strip_prefix(&prefix))
                    .filter(|name| !name.contains('/'))
                    .map(str::to_string)
                    .collect())
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

/// Refuse a path a delete could be steered with: relative (it would resolve
/// against someone's cwd), climbing (`..`), or the filesystem root. The paths
/// deleted are ones santree derived itself — a worktree row it wrote, a file
/// git named — so this is a backstop, not a sandbox.
fn plain_absolute(path: &Path) -> Result<()> {
    let mut components = path.components();
    ensure!(
        components.next() == Some(Component::RootDir)
            && components.all(|c| matches!(c, Component::Normal(_)))
            && path.parent().is_some(),
        "refusing to remove {}",
        path.display()
    );
    Ok(())
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
