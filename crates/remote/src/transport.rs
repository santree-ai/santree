//! Getting a byte stream to a daemon: system `ssh` running
//! `santree-remote connect`, or an in-memory pipe for tests.
//!
//! The ssh argv is docs/remote.md "SSH transport". Every value that lands in it
//! is validated first. The user and host come from Daedalus's API, so they are
//! allow-listed: one starting with `-` would be read by ssh as a flag, and one
//! carrying anything but the characters a name or address has could be read as
//! something other than a single destination.

use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, DuplexStream};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Where the server's sshd is, and as whom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    pub user: String,
    /// A hostname or address.
    pub host: String,
    pub port: u16,
    /// A user-chosen key; `None` = whatever ssh's own config and agent offer.
    pub identity_file: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("invalid ssh {field}: {why}")]
    Invalid { field: &'static str, why: String },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// An open byte stream to a daemon, plus whatever can explain its death.
pub struct Link {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// Owns the transport's resources (the ssh child — killed on drop) for as
    /// long as the link is in use.
    pub transport: Box<dyn LinkTransport>,
}

impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Link").finish_non_exhaustive()
    }
}

pub trait LinkTransport: Send {
    /// Once the stream has ended: a short human reason, if the transport has a
    /// better one than "connection closed" (ssh's stderr usually does).
    fn failure_reason(&mut self) -> BoxFuture<'_, Option<String>>;
}

/// A transport with nothing to say (the in-memory pipe).
impl LinkTransport for () {
    fn failure_reason(&mut self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { None })
    }
}

/// Opens links. `RemoteHost` takes one so tests can swap ssh for the fake.
pub trait Connector: Send + Sync + 'static {
    fn connect(&self, target: &SshTarget) -> BoxFuture<'static, Result<Link, String>>;
}

impl<F> Connector for F
where
    F: Fn(&SshTarget) -> BoxFuture<'static, Result<Link, String>> + Send + Sync + 'static,
{
    fn connect(&self, target: &SshTarget) -> BoxFuture<'static, Result<Link, String>> {
        self(target)
    }
}

/// An in-memory link: the client half, and the stream a (fake) daemon serves.
pub fn memory_link() -> (Link, DuplexStream) {
    let (client, server) = tokio::io::duplex(256 * 1024);
    let (reader, writer) = tokio::io::split(client);
    (
        Link {
            reader: Box::new(reader),
            writer: Box::new(writer),
            transport: Box::new(()),
        },
        server,
    )
}

// ── ssh ───────────────────────────────────────────────────────────────────

/// The name the server's host key is pinned under, whatever address reaches it.
pub const HOST_KEY_ALIAS: &str = "santree-daedalus";

/// `sun_path` holds 104 bytes on macOS, 108 on Linux, NUL included.
#[cfg(target_os = "macos")]
const SUN_PATH_MAX: usize = 103;
#[cfg(not(target_os = "macos"))]
const SUN_PATH_MAX: usize = 107;
/// While it becomes a master, ssh binds `<ControlPath>.<16 random chars>`.
const CONTROL_TEMP_SUFFIX: usize = 17;

/// A user or host from Daedalus's API — untrusted, so allow-listed rather than
/// screened: `allowed` is every character it may have, and it may not start
/// with `-` (ssh would read it as a flag).
fn validate_word(
    field: &'static str,
    value: &str,
    allowed: fn(char) -> bool,
    shape: &str,
) -> Result<(), TransportError> {
    let invalid = |why: &str| TransportError::Invalid {
        field,
        why: why.to_string(),
    };
    if value.is_empty() {
        return Err(invalid("empty"));
    }
    if value.starts_with('-') {
        return Err(invalid("must not start with '-'"));
    }
    if !value.chars().all(allowed) {
        return Err(invalid(shape));
    }
    Ok(())
}

/// A login name: letters, digits, `.`, `_` and `-`.
fn user_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// A host name or IP address: letters, digits, `.` and `-`, plus `:` for an
/// IPv6 literal.
fn host_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':')
}

pub fn validate_target(target: &SshTarget) -> Result<(), TransportError> {
    validate_word(
        "user",
        &target.user,
        user_char,
        "may only have letters, digits, '.', '_' and '-'",
    )?;
    validate_word(
        "host",
        &target.host,
        host_char,
        "may only have letters, digits, '.', '-' and ':'",
    )?;
    if target.port == 0 {
        return Err(TransportError::Invalid {
            field: "port",
            why: "must be 1-65535".into(),
        });
    }
    if let Some(identity) = &target.identity_file {
        let text = identity.to_string_lossy();
        if !identity.is_absolute() || text.chars().any(char::is_control) {
            return Err(TransportError::Invalid {
                field: "identity file",
                why: "must be an absolute path".into(),
            });
        }
    }
    Ok(())
}

/// A path as one double-quoted ssh config token.
///
/// ssh splits `-o` values on whitespace (honouring quotes) and expands `%` and
/// `${…}` in several of them, so an app data dir under "Application Support"
/// must be quoted, and one carrying characters we would have to escape is
/// refused rather than guessed at.
fn ssh_quoted(path: &Path) -> Result<String, TransportError> {
    let text = path.to_string_lossy();
    if text
        .chars()
        .any(|c| matches!(c, '"' | '\\' | '%' | '$') || c.is_control())
    {
        return Err(TransportError::Invalid {
            field: "app data dir",
            why: format!("{text:?} has characters ssh would reinterpret"),
        });
    }
    Ok(format!("\"{text}\""))
}

/// FNV-1a: a stable, dependency-free name for one destination's control socket.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, b| {
        (hash ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// Where this target's multiplexing socket lives, or `None` when no path under
/// the app dir fits in a unix socket address.
///
/// The doc's `cm-%C` expands to 40 hex characters, which under macOS's
/// `~/Library/Application Support/com.santree.desktop/ssh/` is ~113 bytes —
/// past `sun_path`, and ssh treats that as fatal, not as "no multiplexing".
/// So the name is our own short hash of what `%C` hashes (user, host, port;
/// plus the key), and when even that doesn't fit the mux options are left out:
/// multiplexing only speeds up reconnects, a failed connect is not worth it.
fn control_path(target: &SshTarget, ssh_dir: &Path) -> Option<PathBuf> {
    let key = format!(
        "{}@{}:{}#{}",
        target.user,
        target.host,
        target.port,
        target
            .identity_file
            .as_deref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    let path = ssh_dir.join(format!("cm-{:08x}", fnv1a(&key) as u32));
    (path.as_os_str().len() + CONTROL_TEMP_SUFFIX <= SUN_PATH_MAX).then_some(path)
}

/// The full `ssh` argv (without the program) for `target`, per docs/remote.md.
pub fn ssh_args(target: &SshTarget, app_dir: &Path) -> Result<Vec<OsString>, TransportError> {
    ssh_argv(target, app_dir, &["santree-remote", "connect"])
}

/// The argv that runs `remote` on the server with every option the link
/// uses — so anything that checks "can santree ssh in" checks exactly what
/// the link would do (same key, same pinned host key, same mux socket).
pub(crate) fn ssh_argv(
    target: &SshTarget,
    app_dir: &Path,
    remote: &[&str],
) -> Result<Vec<OsString>, TransportError> {
    validate_target(target)?;
    let ssh_dir = app_dir.join("ssh");
    let mut args: Vec<OsString> = Vec::new();
    let mut opt = |value: String| {
        args.push("-o".into());
        args.push(value.into());
    };
    // `-T` goes first below; options in the doc's order.
    opt("BatchMode=yes".into());
    opt("ConnectTimeout=4".into());
    if let Some(path) = control_path(target, &ssh_dir) {
        opt("ControlMaster=auto".into());
        opt(format!("ControlPath={}", ssh_quoted(&path)?));
        opt("ControlPersist=300".into());
    }
    opt("ServerAliveInterval=15".into());
    opt("ServerAliveCountMax=3".into());
    opt(format!("HostKeyAlias={HOST_KEY_ALIAS}"));
    opt("StrictHostKeyChecking=accept-new".into());
    opt(format!(
        "UserKnownHostsFile={} ~/.ssh/known_hosts",
        ssh_quoted(&ssh_dir.join("known_hosts"))?
    ));
    // The link only needs its stdio. Whatever the user's ssh config forwards
    // elsewhere — their agent, X11, ports — or runs locally on connect must not
    // ride along to a server santree reaches on an API's say-so. (Command-line
    // `-o` wins over every config file: ssh keeps the first value it reads.)
    opt("ForwardAgent=no".into());
    opt("ForwardX11=no".into());
    opt("ClearAllForwardings=yes".into());
    opt("PermitLocalCommand=no".into());
    let mut argv: Vec<OsString> = vec!["-T".into()];
    argv.append(&mut args);
    if let Some(identity) = &target.identity_file {
        argv.push("-i".into());
        argv.push(identity.clone().into_os_string());
        argv.push("-o".into());
        argv.push("IdentitiesOnly=yes".into());
    }
    argv.push("-p".into());
    argv.push(target.port.to_string().into());
    argv.push(format!("{}@{}", target.user, target.host).into());
    argv.extend(remote.iter().map(OsString::from));
    Ok(argv)
}

/// `ssh … santree-remote connect`, with stdio piped and the child killed when
/// the command's `Child` is dropped. Creates `<app_dir>/ssh` (0700) for the
/// pinned host key and the control socket.
pub fn ssh_command(
    target: &SshTarget,
    app_dir: &Path,
) -> Result<tokio::process::Command, TransportError> {
    let mut cmd = ssh_process(ssh_args(target, app_dir)?, app_dir)?;
    cmd.stdin(Stdio::piped());
    Ok(cmd)
}

/// `ssh <args>` with stdout/stderr piped, killed on drop, and the private
/// `<app_dir>/ssh` it keeps its host key and control socket in.
pub(crate) fn ssh_process(
    args: Vec<OsString>,
    app_dir: &Path,
) -> Result<tokio::process::Command, TransportError> {
    let ssh_dir = app_dir.join("ssh");
    std::fs::create_dir_all(&ssh_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&ssh_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Ok(cmd)
}

/// Turn what ssh printed into the short reason the UI shows.
pub fn classify_ssh_failure(stderr: &str, status: Option<ExitStatus>) -> String {
    let lower = stderr.to_ascii_lowercase();
    let has = |needle: &str| lower.contains(needle);
    if has("remote host identification has changed") || has("host key verification failed") {
        return "ssh: host key changed".into();
    }
    if has("permission denied") || has("too many authentication failures") {
        return "ssh: permission denied".into();
    }
    if has("timed out") {
        return "ssh: connection timed out".into();
    }
    if has("connection refused") {
        return "ssh: connection refused".into();
    }
    if has("could not resolve hostname") {
        return "ssh: host not found".into();
    }
    if has("no route to host") {
        return "ssh: no route to host".into();
    }
    if has("network is unreachable") {
        return "ssh: network unreachable".into();
    }
    // Only the shell's own "no such command" — `santree-remote connect`'s
    // errors (a missing socket, say) mention it and "no such file" too, and
    // are a daemon that isn't running, not one that isn't installed.
    let not_found = has("santree-remote")
        && (has("command not found")
            || has("santree-remote: not found")
            || has("no such file or directory: santree-remote"));
    if not_found || status.and_then(|s| s.code()) == Some(127) {
        return "santree-remote not found on the server".into();
    }
    if let Some(line) = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()) {
        let line: String = line.chars().take(200).collect();
        return format!("ssh: {line}");
    }
    match status.and_then(|s| s.code()) {
        Some(code) => format!("ssh exited with status {code}"),
        None => "ssh: connection closed".into(),
    }
}

/// Keeps the last `cap` bytes ssh wrote to stderr.
#[derive(Default)]
struct StderrTail {
    bytes: Vec<u8>,
}

const STDERR_TAIL: usize = 8 * 1024;

impl StderrTail {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > STDERR_TAIL {
            let cut = self.bytes.len() - STDERR_TAIL;
            self.bytes.drain(..cut);
        }
    }
}

struct SshLink {
    child: tokio::process::Child,
    stderr: Arc<Mutex<StderrTail>>,
    drain: Option<tokio::task::JoinHandle<()>>,
}

impl LinkTransport for SshLink {
    fn failure_reason(&mut self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            // The stream ended, so ssh is exiting; give it a moment to say why.
            let status = tokio::time::timeout(Duration::from_secs(2), self.child.wait())
                .await
                .ok()
                .and_then(Result::ok);
            if let Some(drain) = self.drain.take() {
                let _ = tokio::time::timeout(Duration::from_millis(500), drain).await;
            }
            let tail = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
            Some(classify_ssh_failure(
                &String::from_utf8_lossy(&tail.bytes),
                status,
            ))
        })
    }
}

/// The real connector: system `ssh`, one process per link.
#[derive(Debug, Clone)]
pub struct SshConnector {
    app_dir: PathBuf,
}

impl SshConnector {
    pub fn new(app_dir: impl Into<PathBuf>) -> Self {
        Self {
            app_dir: app_dir.into(),
        }
    }
}

impl Connector for SshConnector {
    fn connect(&self, target: &SshTarget) -> BoxFuture<'static, Result<Link, String>> {
        let command = ssh_command(target, &self.app_dir);
        Box::pin(async move {
            let mut command = command.map_err(|e| e.to_string())?;
            let mut child = command.spawn().map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => "ssh is not installed".to_string(),
                _ => format!("could not start ssh: {e}"),
            })?;
            let (Some(stdin), Some(stdout), Some(mut stderr)) =
                (child.stdin.take(), child.stdout.take(), child.stderr.take())
            else {
                return Err("ssh started without its pipes".into());
            };
            let tail = Arc::new(Mutex::new(StderrTail::default()));
            let sink = tail.clone();
            let drain = tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    log::debug!("ssh: {}", String::from_utf8_lossy(&buf[..n]).trim_end());
                    sink.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(&buf[..n]);
                }
            });
            Ok(Link {
                reader: Box::new(stdout),
                writer: Box::new(stdin),
                transport: Box::new(SshLink {
                    child,
                    stderr: tail,
                    drain: Some(drain),
                }),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> SshTarget {
        SshTarget {
            user: "santiago".into(),
            host: "s2.example.org".into(),
            port: 2222,
            identity_file: None,
        }
    }

    fn argv(target: &SshTarget, app_dir: &str) -> Vec<String> {
        ssh_args(target, Path::new(app_dir))
            .unwrap()
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect()
    }

    #[test]
    fn argv_matches_the_doc() {
        let args = argv(&target(), "/data/santree");
        let hash = format!("{:08x}", fnv1a("santiago@s2.example.org:2222#") as u32);
        let expected: Vec<String> = [
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=4",
            "-o",
            "ControlMaster=auto",
            "-o",
            &format!("ControlPath=\"/data/santree/ssh/cm-{hash}\""),
            "-o",
            "ControlPersist=300",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "HostKeyAlias=santree-daedalus",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "UserKnownHostsFile=\"/data/santree/ssh/known_hosts\" ~/.ssh/known_hosts",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ForwardX11=no",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "PermitLocalCommand=no",
            "-p",
            "2222",
            "santiago@s2.example.org",
            "santree-remote",
            "connect",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn an_identity_file_pins_that_key_only() {
        let t = SshTarget {
            identity_file: Some("/Users/me/.ssh/daedalus".into()),
            ..target()
        };
        let args = argv(&t, "/data/santree");
        let at = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(
            &args[at..at + 6],
            [
                "-i",
                "/Users/me/.ssh/daedalus",
                "-o",
                "IdentitiesOnly=yes",
                "-p",
                "2222"
            ]
        );
    }

    /// The real macOS app dir has a space in it: it must reach ssh quoted,
    /// and a control socket path too long for `sun_path` must be left out
    /// rather than handed to ssh to fail on.
    #[test]
    fn a_long_app_dir_with_spaces_is_quoted_and_drops_the_mux() {
        let long = format!(
            "/Users/{}/Library/Application Support/com.santree.desktop",
            "u".repeat(40)
        );
        let args = argv(&target(), &long);
        assert!(!args.iter().any(|a| a.starts_with("Control")));
        assert!(args.contains(&format!(
            "UserKnownHostsFile=\"{long}/ssh/known_hosts\" ~/.ssh/known_hosts"
        )));

        let usual = "/Users/stoscanini/Library/Application Support/com.santree.desktop";
        let args = argv(&target(), usual);
        let control = args.iter().find(|a| a.starts_with("ControlPath=")).unwrap();
        assert!(control.starts_with(&format!("ControlPath=\"{usual}/ssh/cm-")));
    }

    #[test]
    fn flag_shaped_or_compound_values_are_refused() {
        for (user, host) in [
            ("-oProxyCommand=x", "h"),
            ("u", "-oProxyCommand=x"),
            ("u", ""),
            ("u", "a b"),
            ("u", "h\nx"),
            ("a@b", "h"),
            ("u", "h@x"),
            // Shell and ssh metacharacters, whatever the API sends.
            ("$(id)", "h"),
            ("u", "$(id)"),
            ("`id`", "h"),
            ("u", "h`id`"),
            ("u;id", "h"),
            ("u", "h;id"),
            ("u|id", "h"),
            ("u", "h|id"),
            ("'u'", "h"),
            ("u", "\"h\""),
            ("u", "h%d"),
            ("u", "h/x"),
            ("u", "[fd00::1]"),
            ("ü", "h"),
            ("u", "hé.example"),
        ] {
            let t = SshTarget {
                user: user.into(),
                host: host.into(),
                ..target()
            };
            assert!(ssh_args(&t, Path::new("/d")).is_err(), "{user:?}@{host:?}");
        }
        let relative = SshTarget {
            identity_file: Some("id_rsa".into()),
            ..target()
        };
        assert!(ssh_args(&relative, Path::new("/d")).is_err());
        assert!(ssh_args(&target(), Path::new("/d/%h")).is_err());
        // IPv6 literals are plain words.
        let v6 = SshTarget {
            host: "fd00::1".into(),
            ..target()
        };
        assert!(ssh_args(&v6, Path::new("/d")).is_ok());
        for (user, host) in [
            ("santiago", "s2.example.org"),
            ("first.last_2-x", "10.0.0.2"),
            ("u", "daedalus"),
            ("u", "fe80::1:2"),
        ] {
            let t = SshTarget {
                user: user.into(),
                host: host.into(),
                ..target()
            };
            assert!(ssh_args(&t, Path::new("/d")).is_ok(), "{user:?}@{host:?}");
        }
    }

    #[test]
    fn ssh_command_creates_a_private_ssh_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = ssh_command(&target(), dir.path()).unwrap();
        assert_eq!(cmd.as_std().get_program(), "ssh");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("ssh"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    #[test]
    fn failures_read_as_short_reasons() {
        let cases = [
            ("santiago@1.2.3.4: Permission denied (publickey).", "ssh: permission denied"),
            ("ssh: connect to host 1.2.3.4 port 22: Operation timed out", "ssh: connection timed out"),
            ("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", "ssh: host key changed"),
            ("bash: line 1: santree-remote: command not found", "santree-remote not found on the server"),
            ("zsh:1: command not found: santree-remote", "santree-remote not found on the server"),
            ("sh: 1: santree-remote: not found", "santree-remote not found on the server"),
            // Installed but not running: `connect` can't find the daemon's socket.
            ("santree-remote: connect /run/santree-remote.sock: No such file or directory", "ssh: santree-remote: connect /run/santree-remote.sock: No such file or directory"),
            ("ssh: connect to host h port 22: Connection refused", "ssh: connection refused"),
            ("ssh: Could not resolve hostname nope: nodename nor servname provided", "ssh: host not found"),
            ("kex_exchange_identification: read: Connection reset by peer", "ssh: kex_exchange_identification: read: Connection reset by peer"),
        ];
        for (stderr, reason) in cases {
            assert_eq!(classify_ssh_failure(stderr, None), reason, "{stderr}");
        }
        assert_eq!(classify_ssh_failure("", None), "ssh: connection closed");
    }

    #[test]
    fn the_stderr_tail_is_bounded() {
        let mut tail = StderrTail::default();
        for _ in 0..100 {
            tail.push(&[b'x'; 1000]);
        }
        tail.push(b"last");
        assert_eq!(tail.bytes.len(), STDERR_TAIL);
        assert!(tail.bytes.ends_with(b"last"));
    }
}
