//! `exec.run`: one process, argv only (no shell), in a process group of its
//! own, so the whole tree it starts (`git` → `ssh`, `sh -c` …) is killed with
//! it — on a timeout, on output that never closes, and when the request is
//! dropped (its connection ended) before the process did.

use std::path::PathBuf;
use std::time::Duration;

use santree_remote_proto::{
    ErrorCode, ExecParams, ExecResult, WireError, EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::util::{check_env, err, io_err};

/// Per-stream cap on `exec.run` output. 8 MiB, as santree's reference
/// daemon: base64 grows a stream by 4/3, and two capped streams must still fit
/// one response line under the client's 32 MiB cap.
pub const EXEC_OUTPUT_CAP: usize = 8 * 1024 * 1024;

/// SIGKILL to a process group, unless disarmed. Held from the spawn until the
/// process has exited AND its output has closed: a drop anywhere before that
/// (a timeout's early return, or the request's task aborted) kills the group.
struct Group {
    pgid: Option<libc::pid_t>,
}

impl Group {
    fn kill(&mut self) {
        if let Some(pgid) = self.pgid.take() {
            // SAFETY: plain killpg(2); a group that is already gone is ESRCH.
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
    }

    fn disarm(&mut self) {
        self.pgid = None;
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.kill();
    }
}

/// A task aborted when this is dropped.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn read_capped<R: AsyncRead + Unpin>(mut reader: R) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 16 * 1024];
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let room = EXEC_OUTPUT_CAP.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
        // Keep draining past the cap so the child never blocks on a full pipe.
        truncated |= n > room;
    }
    (kept, truncated)
}

/// Run `p` in `cwd` (already resolved, and confined if the host confines),
/// with `host_env` under the request's own `env`.
pub async fn run(
    p: ExecParams,
    cwd: PathBuf,
    host_env: &[(String, String)],
) -> Result<ExecResult, WireError> {
    let Some(program) = p.argv.first() else {
        return Err(err(ErrorCode::BadRequest, "argv is empty"));
    };
    check_env(p.env.as_deref().unwrap_or_default(), "env")?;
    let limit = Duration::from_millis(
        p.timeout_ms
            .unwrap_or(EXEC_DEFAULT_TIMEOUT_MS)
            .clamp(1, EXEC_MAX_TIMEOUT_MS),
    );
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&p.argv[1..])
        .current_dir(&cwd)
        .envs(host_env.iter().cloned())
        .envs(p.env.unwrap_or_default())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if p.stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| io_err(e, program))?;
    let mut group = Group {
        pgid: child.id().map(|pid| pid as libc::pid_t),
    };
    // Aborted on every way out (`_feed`'s drop): a grandchild that keeps
    // stdin open without reading must not keep the task and its buffer.
    let _feed = match (child.stdin.take(), p.stdin) {
        (Some(mut pipe), Some(data)) => Some(AbortOnDrop(tokio::spawn(async move {
            let _ = pipe.write_all(&data).await;
        }))),
        _ => None,
    };
    let stdout = tokio::spawn(read_capped(child.stdout.take().expect("piped")));
    let stderr = tokio::spawn(read_capped(child.stderr.take().expect("piped")));
    let started = tokio::time::Instant::now();
    let status = match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => status.map_err(|e| io_err(e, program))?,
        Err(_) => {
            group.kill();
            return Err(err(
                ErrorCode::Timeout,
                format!("{program} ran past {}ms", limit.as_millis()),
            ));
        }
    };
    // A grandchild can hold the pipes open past the child's exit; don't wait
    // for it beyond the request's own deadline (and then kill it with the
    // group).
    let remaining = limit
        .saturating_sub(started.elapsed())
        .max(Duration::from_millis(100));
    let collect = async { (stdout.await, stderr.await) };
    let (stdout, stderr) = match tokio::time::timeout(remaining, collect).await {
        Ok((Ok(out), Ok(errs))) => (out, errs),
        _ => {
            group.kill();
            return Err(err(
                ErrorCode::Timeout,
                format!("{program}'s output never closed"),
            ));
        }
    };
    group.disarm();
    let signal = std::os::unix::process::ExitStatusExt::signal(&status);
    Ok(ExecResult {
        code: status.code(),
        signal,
        stdout: stdout.0,
        stderr: stderr.0,
        truncated: stdout.1 || stderr.1,
    })
}
