//! One ssh round trip that answers the health check's middle questions: can
//! santree ssh in, and is `santree-remote` installed there? It runs with the
//! link's own argv ([`crate::transport`]), so "ssh works" here means the link's
//! ssh works — same key, same pinned host key, same control socket.
//!
//! Whether the daemon is *running* is not this probe's question: that is
//! whether `santree-remote connect` completes `hello`, which only the link
//! itself (`RemoteHost`) can say.

use std::path::Path;
use std::process::ExitStatus;
use std::time::Duration;

use crate::transport::{classify_ssh_failure, ssh_argv, ssh_process, SshTarget};

/// What runs on the server. `command -v` is POSIX, so this reads the same
/// under any login shell; the marker is printed when the binary isn't on its
/// `PATH`.
pub const PROBE_COMMAND: &str = "command -v santree-remote >/dev/null 2>&1 && santree-remote --version || echo __santree_remote_missing__";

const MISSING_MARKER: &str = "__santree_remote_missing__";

/// The whole round trip, connect included (the argv's `ConnectTimeout=4`
/// bounds the connect alone).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// How a probe went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// ssh itself failed; `reason` is [`classify_ssh_failure`]'s short line.
    SshFailed { reason: String },
    /// ssh worked, and `santree-remote` isn't installed.
    DaemonMissing,
    /// ssh worked, and `santree-remote --version` said `version_line` — e.g.
    /// `santree-remote 0.1.0 protocol 1`, read leniently into `version` and
    /// `protocol` (each `None` when the line doesn't carry it).
    Installed {
        version_line: String,
        version: Option<String>,
        protocol: Option<u32>,
    },
}

/// Probe `target`. Never fails: every way it can go wrong is an outcome.
pub async fn ssh_probe(target: &SshTarget, app_dir: &Path) -> ProbeOutcome {
    let failed = |reason: String| ProbeOutcome::SshFailed { reason };
    let mut command = match ssh_argv(target, app_dir, &[PROBE_COMMAND])
        .and_then(|args| ssh_process(args, app_dir))
    {
        Ok(command) => command,
        Err(e) => return failed(e.to_string()),
    };
    let child = match command.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return failed("ssh is not installed".into())
        }
        Err(e) => return failed(format!("could not start ssh: {e}")),
    };
    // `kill_on_drop`: a timed-out probe takes its ssh with it.
    match tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await {
        Err(_) => failed("ssh: connection timed out".into()),
        Ok(Err(e)) => failed(format!("ssh: {e}")),
        Ok(Ok(output)) => interpret(&output.stdout, &output.stderr, Some(output.status)),
    }
}

/// Read a finished probe. Split out so every outcome is testable without ssh.
pub fn interpret(stdout: &[u8], stderr: &[u8], status: Option<ExitStatus>) -> ProbeOutcome {
    let stdout = String::from_utf8_lossy(stdout);
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    // The marker can only come from the remote shell, so ssh got that far.
    if stdout.lines().any(|l| l.trim() == MISSING_MARKER) {
        return ProbeOutcome::DaemonMissing;
    }
    if status.is_some_and(|s| s.success()) {
        let version_line: String = lines.next().unwrap_or_default().chars().take(200).collect();
        let (version, protocol) = parse_version_line(&version_line);
        return ProbeOutcome::Installed {
            version_line,
            version,
            protocol,
        };
    }
    ProbeOutcome::SshFailed {
        reason: classify_ssh_failure(&String::from_utf8_lossy(stderr), status),
    }
}

/// `santree-remote 0.1.0 protocol 1` → (`0.1.0`, `1`). Tolerant: the version
/// is the first word shaped like one (`v0.1.0`, `0.1.0-beta.2` too), the
/// protocol the number after the word `protocol` (or `protocol=1`).
fn parse_version_line(line: &str) -> (Option<String>, Option<u32>) {
    let words: Vec<&str> = line
        .split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')')
        .filter(|w| !w.is_empty())
        .collect();
    let version = words
        .iter()
        .map(|w| w.strip_prefix('v').unwrap_or(w))
        .find(|w| is_version(w))
        .map(str::to_string);
    let protocol = words.iter().enumerate().find_map(|(i, w)| {
        let lower = w.to_ascii_lowercase();
        match lower.strip_prefix("protocol") {
            Some("") => words.get(i + 1)?.parse().ok(),
            Some(rest) => rest.trim_start_matches(['=', ':']).parse().ok(),
            None => None,
        }
    });
    (version, protocol)
}

/// `MAJOR.MINOR[.PATCH][-pre][+build]`, digits where digits go.
fn is_version(word: &str) -> bool {
    let core = word.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    (2..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    fn exited(code: i32) -> Option<ExitStatus> {
        Some(ExitStatus::from_raw(code << 8))
    }

    #[test]
    fn a_missing_binary_is_the_marker() {
        assert_eq!(
            interpret(b"__santree_remote_missing__\n", b"", exited(0)),
            ProbeOutcome::DaemonMissing
        );
        // Whatever a noisy login shell printed around it.
        assert_eq!(
            interpret(
                b"Welcome!\n__santree_remote_missing__\n",
                b"motd",
                exited(0)
            ),
            ProbeOutcome::DaemonMissing
        );
    }

    #[test]
    fn an_installed_binary_reports_its_version_line() {
        assert_eq!(
            interpret(b"santree-remote 0.1.0 protocol 1\n", b"", exited(0)),
            ProbeOutcome::Installed {
                version_line: "santree-remote 0.1.0 protocol 1".into(),
                version: Some("0.1.0".into()),
                protocol: Some(1),
            }
        );
        // Junk is kept as the line, and read for what it has.
        assert_eq!(
            interpret(b"santree-remote (dev build)\n", b"", exited(0)),
            ProbeOutcome::Installed {
                version_line: "santree-remote (dev build)".into(),
                version: None,
                protocol: None,
            }
        );
    }

    #[test]
    fn ssh_failures_read_as_its_short_reasons() {
        assert_eq!(
            interpret(
                b"",
                b"santiago@s2.example.org: Permission denied (publickey).\n",
                exited(255)
            ),
            ProbeOutcome::SshFailed {
                reason: "ssh: permission denied".into()
            }
        );
        assert_eq!(
            interpret(
                b"",
                b"ssh: connect to host s2.example.org port 22: Operation timed out\n",
                exited(255)
            ),
            ProbeOutcome::SshFailed {
                reason: "ssh: connection timed out".into()
            }
        );
    }

    #[test]
    fn version_lines_are_read_leniently() {
        for (line, version, protocol) in [
            ("santree-remote 0.1.0 protocol 1", Some("0.1.0"), Some(1)),
            (
                "santree-remote v0.2.3-beta.1 (protocol 2)",
                Some("0.2.3-beta.1"),
                Some(2),
            ),
            ("santree-remote 1.4 protocol=3", Some("1.4"), Some(3)),
            ("santree-remote 0.1.0", Some("0.1.0"), None),
            ("protocol 1", None, Some(1)),
            ("santree-remote 1.2.3.4 protocol x", None, None),
            ("", None, None),
        ] {
            assert_eq!(
                parse_version_line(line),
                (version.map(str::to_string), protocol),
                "{line:?}"
            );
        }
    }

    #[test]
    fn the_probe_runs_through_the_links_own_argv() {
        let target = SshTarget {
            user: "santiago".into(),
            host: "s2.example.org".into(),
            port: 22,
            identity_file: None,
        };
        let dir = Path::new("/data/santree");
        let probe: Vec<_> = ssh_argv(&target, dir, &[PROBE_COMMAND]).unwrap();
        let link = crate::transport::ssh_args(&target, dir).unwrap();
        // Same options and destination; only the remote command differs, and it
        // goes as one argument (ssh hands it to the login shell as written).
        assert_eq!(probe[..probe.len() - 1], link[..link.len() - 2]);
        assert_eq!(probe.last().unwrap(), PROBE_COMMAND);
        assert!(probe.iter().any(|a| a == "BatchMode=yes"));
        assert!(probe.iter().any(|a| a == "HostKeyAlias=santree-daedalus"));
    }
}
