//! The status-line **passthrough**: run the user's own `statusLine.command` on
//! the payload santree just recorded, and hand its output back unchanged.
//!
//! This is the `--then` half of the opt-in global capture
//! (`set_claude_global_capture` in the app): the user's `~/.claude/settings.json`
//! status line becomes `santree-hook --db <db> statusline --then '<their
//! command>'`, so every Claude session on the machine — not just the ones
//! santree launched — feeds the usage meters, while the status line they see
//! stays exactly theirs. Two rules here are load-bearing:
//!  - the command string is handed to `sh -c` as **one argument**, never
//!    re-tokenised, so it runs exactly as Claude would have run it;
//!  - the child is **bounded**: a hung script is killed at [`TIMEOUT`] and
//!    whatever it managed to print is forwarded, so it can wedge neither
//!    Claude's redraw nor this process.

use std::io::{Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// How long the user's command may run. Claude redraws the status line after
/// every message, so anything past a few seconds is already useless — and
/// unbounded, it would hold Claude's redraw hostage to a hung script.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(5);

/// How the user's command ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Exit {
    /// It exited on its own; a signal death is reported shell-style (`128 + n`).
    Code(i32),
    /// It was still running at the deadline and was killed.
    TimedOut,
}

/// Everything the user's command produced, ready to forward.
pub(crate) struct Outcome {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit: Exit,
}

/// A spawned command whose output is being collected in the background.
pub(crate) struct Running {
    child: Child,
    stdout: Receiver<Vec<u8>>,
    stderr: Receiver<Vec<u8>>,
    started: Instant,
}

/// Start `sh -c <command>` with `stdin` piped to it, inheriting our cwd and
/// environment (Claude set both for the status line). Returns as soon as the
/// process exists; [`Running::finish`] collects the result.
pub(crate) fn spawn(command: &str, stdin: &[u8]) -> std::io::Result<Running> {
    let mut child = Command::new("sh")
        .arg("-c")
        // ONE argument: the user's string reaches the shell verbatim.
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let started = Instant::now();

    // Feed stdin from its own thread: a command that never reads it must not
    // block us, and the write's own errors (EPIPE from a command that exited
    // early) are that command's business, not ours.
    if let Some(mut pipe) = child.stdin.take() {
        let bytes = stdin.to_vec();
        thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    let stdout = pump(child.stdout.take());
    let stderr = pump(child.stderr.take());
    Ok(Running {
        child,
        stdout,
        stderr,
        started,
    })
}

/// Copy a pipe into a channel chunk by chunk — chunks, not one buffer at EOF,
/// so a command killed at the deadline still yields what it printed first.
fn pump<R: Read + Send + 'static>(reader: Option<R>) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    if let Some(mut reader) = reader {
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    rx
}

impl Running {
    /// Wait for the command up to `timeout` past its start (killing it at the
    /// deadline) and gather its output.
    pub(crate) fn finish(mut self, timeout: Duration) -> Outcome {
        let deadline = self.started + timeout;
        let exit = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break Exit::Code(exit_code(status)),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Ok(None) => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break Exit::TimedOut;
                }
                // The child is gone in a way we can't reap; don't wait on it.
                Err(_) => {
                    let _ = self.child.kill();
                    break Exit::Code(1);
                }
            }
        };
        // An exited process has closed its pipes — unless it left a background
        // child holding them (`foo &`), which the kill above orphans too. So the
        // drain is bounded as well: the deadline's remainder, or a short grace so
        // a normal exit's last bytes have time to land.
        let grace = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(200));
        let stdout = drain(&self.stdout, grace);
        let stderr = drain(&self.stderr, grace);
        Outcome {
            stdout,
            stderr,
            exit,
        }
    }
}

/// Everything the pump has sent so far, waiting at most `grace` for EOF.
fn drain(rx: &Receiver<Vec<u8>>, grace: Duration) -> Vec<u8> {
    let until = Instant::now() + grace;
    let mut out = Vec::new();
    loop {
        let left = until.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(chunk) => out.extend_from_slice(&chunk),
            // Disconnected = the pipe hit EOF; Timeout = something still holds it.
            Err(_) => break,
        }
    }
    out
}

/// A shell's view of an exit status: the code, or `128 + signal`.
fn exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .or_else(|| status.signal().map(|s| 128 + s))
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(command: &str, stdin: &[u8], timeout: Duration) -> Outcome {
        spawn(command, stdin).unwrap().finish(timeout)
    }

    /// The whole contract in one: stdin reaches the command, its stdout and
    /// stderr come back separately, and its exit code is preserved.
    #[test]
    fn passthrough_forwards_stdin_stdout_stderr_and_exit_code() {
        let payload = br#"{"session_id":"s1","context_window":{"used_percentage":12}}"#;
        let out = run("cat; echo oops >&2; exit 3", payload, TIMEOUT);
        assert_eq!(out.stdout, payload);
        assert_eq!(out.stderr, b"oops\n");
        assert_eq!(out.exit, Exit::Code(3));

        // A command that never reads stdin is fine too (no EPIPE surfaces here).
        let out = run("echo hi", payload, TIMEOUT);
        assert_eq!(out.stdout, b"hi\n");
        assert_eq!(out.exit, Exit::Code(0));

        // A command sh can't find: its own 127 and its own message, forwarded.
        let out = run("definitely-not-a-command-xyz", b"", TIMEOUT);
        assert_eq!(out.exit, Exit::Code(127));
        assert!(!out.stderr.is_empty());
    }

    /// The command string is the shell's to interpret — quotes, pipes and
    /// expansions all work because we never split it ourselves.
    #[test]
    fn passthrough_hands_the_command_to_sh_as_one_argument() {
        let out = run(
            r#"printf '%s|%s' "a b" 'c d' | tr a-z A-Z; printf "$X""#,
            b"",
            TIMEOUT,
        );
        assert_eq!(String::from_utf8_lossy(&out.stdout), "A B|C D");
        assert_eq!(out.exit, Exit::Code(0));
    }

    /// A hung script is killed at the deadline, what it printed first is kept,
    /// and the wait is bounded by the timeout — not by the script.
    #[test]
    fn passthrough_kills_a_hung_command_at_the_deadline() {
        let started = Instant::now();
        let out = run(
            "echo partial; exec sleep 30",
            b"",
            Duration::from_millis(300),
        );
        assert_eq!(out.exit, Exit::TimedOut);
        assert_eq!(out.stdout, b"partial\n");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_signal_death_reads_like_a_shell_exit_code() {
        let out = run("kill -TERM $$", b"", TIMEOUT);
        assert_eq!(out.exit, Exit::Code(128 + 15));
    }
}
