//! Tauri command adapter for the real terminal layer.
//!
//! These are thin wrappers over [`crate::sessions::Terminals`], the one facade
//! over where a pane's process lives: in this app (`santree_pty::PtyManager`), on
//! the local santree server, or on Daedalus. Output is streamed to the frontend
//! over a [`tauri::ipc::Channel`] (the correct high-throughput primitive for
//! per-chunk terminal output — `emit` would choke); input, resize and close map
//! straight onto the pane.

use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;

use serde::{Deserialize, Serialize};
use specta::{datatype::DataType, Type, Types};
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tauri::{AppHandle, Manager, State};

use crate::daedalus::host::DaedalusHost;
use crate::db::Db;
use crate::error::CmdResult;
use crate::sessions::{
    Exited, Local, Mode, OnExited, PaneId, Route, SeedPolicy, Sinks, Spec, Terminals,
};
pub use crate::sessions::{LiveTerminal, PaneLink};
pub use input::{Keystrokes, LaunchLine, LaunchRequest, PtyInput};
pub use santree_core::domain::TerminalSession;
use santree_core::domain::{AgentKind, QuitSummary, TerminalInventory};
use santree_pty::{Anchor, PtyManager, SessionId};
use santree_remote_client::proto::ReplayMode as BoxReplayMode;

/// A PTY output chunk, wrapped so it crosses the Tauri IPC [`Channel`] as raw
/// bytes (delivered to the frontend as an `ArrayBuffer`) instead of the
/// default `serde_json` encoding, which turns each chunk into a JSON array of
/// up to 8192 decimal integers — real CPU cost on both ends for
/// high-throughput output (verbose build logs, `cat` of a large file, fast
/// agent scroll).
///
/// [`IpcResponse::body`] bypasses `Serialize` entirely (there is no blanket
/// `Serialize` impl for this type, so it can't collide with `tauri`'s
/// `impl<T: Serialize> IpcResponse for T`), producing [`InvokeResponseBody::Raw`]
/// directly, which Tauri's JS runtime delivers to the channel's `onmessage` as
/// a real `ArrayBuffer` — never through `serde_json`.
///
/// `Type` is implemented by hand (not derived) to reflect exactly that: an
/// opaque reference to the built-in TS `ArrayBuffer`, not a structural
/// `number[]`. This is what keeps this on the sacred typed bridge — the
/// generated `bindings.ts` declares `Channel<ArrayBuffer>`, matching the real
/// runtime shape, instead of lying about it (tauri-specta rc.25's semantic-type
/// deserialize-transform machinery doesn't reach a bare `Channel<T>` generic —
/// verified empirically: it left the invoke call unwrapped — so we reflect the
/// honest runtime type directly instead of a `Uint8Array` alias with no actual
/// conversion behind it).
pub struct RawBytes(pub Vec<u8>);

impl Type for RawBytes {
    fn definition(_types: &mut Types) -> DataType {
        specta_typescript::define("ArrayBuffer").into()
    }
}

impl IpcResponse for RawBytes {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(InvokeResponseBody::Raw(self.0))
    }
}

/// How the frontend asks for a new terminal. An empty `command` means the user's
/// login shell.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenOpts {
    pub cwd: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    /// The webview page-load this session belongs to — see [`terminal_adopt`].
    /// Opaque: never a path, an id we look anything up by, or an argv value.
    pub owner: String,
    /// What the frontend calls this session (its `term_key`). Handed back by
    /// [`terminal_adopt`] so a reloaded page can match a live session to the
    /// surface that owns it. Opaque, exactly like `owner`.
    ///
    /// Exactly the `term_key` — never a decorated form of it. The pane's
    /// provider travels in `agent_kind` below, because this string is joined
    /// byte-for-byte against `terminal_sessions.term_key` to decide whether an
    /// agent is still running.
    pub label: String,
    /// Which agent the frontend is launching here, or `null` for a plain shell.
    ///
    /// The other half of the session's identity: `terminal_sessions` is keyed by
    /// `(repo, term_key, agent_kind)`, so one surface can hold one live session
    /// per provider and neither field names a session on its own.
    ///
    /// **It must name the CLI the seed actually `exec`s.** This value and the
    /// seed line arrive as two independent IPC arguments, and the provider's own
    /// hook writes the durable row from the CLI it is running — so a pane
    /// registered as `Codex` whose seed launches `claude` puts `(surface, Codex)`
    /// in the live set against a `(surface, Claude)` row, the liveness join
    /// matches nothing, and the working agent reads as exited. That is the same
    /// failure a provider-decorated `label` caused. Every launch site derives
    /// both halves from one resolved provider (`useAgentTab`, the triage hooks,
    /// `ReviewTerminal`); a new one must too.
    pub agent_kind: Option<AgentKind>,
}

/// Where a reattaching client is in a session's output stream.
///
/// Mirrors [`santree_pty::Anchor`] at the IPC boundary rather than deriving
/// `Type` on it, so the pty crate stays free of a specta dependency.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TerminalAnchor {
    /// "I have every byte of `epoch` through `seq`."
    ///
    /// `f64` rather than `u64` because specta forbids exporting BigInt-style
    /// types across the bridge. Harmless here: a double represents every integer
    /// up to 2^53, which is nine petabytes of terminal output on one session.
    At { epoch: String, seq: f64 },
    /// A brand-new terminal with nothing on it.
    Fresh,
    /// Bytes on screen, position unknown or untrustworthy. Answered by sending
    /// nothing — see [`terminal_attach`].
    Unknown,
}

impl From<TerminalAnchor> for Anchor {
    fn from(value: TerminalAnchor) -> Self {
        match value {
            // Negative or fractional values can only come from a corrupt
            // anchor; they land outside the ring and reanchor, which is the
            // right answer for a position we cannot trust.
            TerminalAnchor::At { epoch, seq } => Anchor::At {
                epoch,
                seq: seq.max(0.0) as u64,
            },
            TerminalAnchor::Fresh => Anchor::Fresh,
            TerminalAnchor::Unknown => Anchor::Unknown,
        }
    }
}

/// What the client should believe after an attach.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttached {
    /// The stream's identity. Pair it with `seq` to form the next anchor.
    pub epoch: String,
    /// The position the client is at once it has written everything the channel
    /// delivered before this call returned. See [`TerminalAnchor::At`] on why
    /// this is a double.
    pub seq: f64,
    /// How the gap was closed. `Reanchor` means no catch-up was possible and the
    /// pane keeps whatever it already had; the caller repaints from the program.
    pub mode: TerminalReplayMode,
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalReplayMode {
    Exact,
    Tail,
    Reanchor,
}

impl From<BoxReplayMode> for TerminalReplayMode {
    fn from(value: BoxReplayMode) -> Self {
        match value {
            BoxReplayMode::Exact => TerminalReplayMode::Exact,
            BoxReplayMode::Tail => TerminalReplayMode::Tail,
            BoxReplayMode::Reanchor => TerminalReplayMode::Reanchor,
        }
    }
}

/// A session handed over from a previous page load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AdoptedSession {
    pub id: SessionId,
    /// The `term_key` it was opened under — how the caller finds its surface.
    pub label: String,
    /// The provider it was opened for. With `label`, the pair that names the
    /// pane: a caller keying adopted sessions by label alone would hand one
    /// session to both panes of a surface a user has open under two providers.
    pub agent_kind: Option<AgentKind>,
    pub cwd: Option<String>,
    pub command: String,
}

/// Each live session's address paired with its root pid — the pane roots a
/// process-table scan walks down from (`agent_procs::detect`).
///
/// A live read of `Terminals::local_sessions`, asked a different question than
/// `Terminals::liveness`. A session the platform reported no pid for is omitted
/// rather than guessed at, which is the same rule the resource accounting uses.
pub fn pane_roots(sessions: &[santree_pty::SessionInfo]) -> Vec<(LiveTerminal, u32)> {
    sessions
        .iter()
        .filter(|s| s.alive)
        .filter_map(|s| {
            let pid = s.pid?;
            Some((
                LiveTerminal {
                    term_key: s.label.clone(),
                    agent_kind: s.agent_kind,
                },
                pid,
            ))
        })
        .collect()
}

/// Wrap a session's output sink so the PTY's exit sentinel also retires whatever
/// agent session that terminal was hosting.
///
/// The sentinel is an empty chunk — `crates/pty`'s `pump` emits exactly one, at
/// EOF, and output chunks are otherwise never empty — so this is the existing
/// exit signal, not a new one. santree gets it for free where other apps have to
/// inject shell integration to recover it: the seed is `exec <cli>`, so the PTY
/// *is* the agent process and its EOF is the agent exiting, however it died.
///
/// The forward happens first, so the pane still tears down at exactly the moment
/// it did before; the retirement is a detached task because this runs on the PTY
/// reader thread, which must never block on a database write.
fn retiring_sink(
    db: Db,
    label: String,
    agent_kind: Option<AgentKind>,
    cwd: Option<String>,
    forward: impl Fn(Vec<u8>) + Send + Sync + 'static,
) -> impl Fn(Vec<u8>) + Send + Sync + 'static {
    move |bytes| {
        let exited = bytes.is_empty();
        forward(bytes);
        if !exited {
            return;
        }
        let (db, label, cwd) = (db.clone(), label.clone(), cwd.clone());
        tauri::async_runtime::spawn(async move {
            retire(&db, &label, agent_kind, cwd.as_deref()).await;
        });
    }
}

/// Stamp the agent rows a terminal hosted as exited, logging what it did.
async fn retire(db: &Db, label: &str, agent_kind: Option<AgentKind>, cwd: Option<&str>) {
    match crate::hooks::retire_terminal(db, label, agent_kind, cwd).await {
        Ok(n) if n > 0 => log::info!("pty for {label} exited; retired {n} session row(s)"),
        Ok(_) => {}
        Err(e) => log::warn!("retiring session rows for {label}: {e}"),
    }
}

// ── The seed line ───────────────────────────────────────────────────────────

/// The most bytes santree will ever *type* into a terminal as one line.
///
/// A seed is written into a login shell that has not necessarily reached its
/// line editor yet, so the bytes land in the tty's **canonical-mode** input
/// buffer — which is capped and drops the overflow *silently*, with no error and
/// no signal that anything was lost: `MAX_CANON` is 1024 bytes on macOS
/// (`sys/syslimits.h`), `N_TTY_BUF_SIZE` 4096 on Linux. Splitting the write does
/// not help; the limit belongs to the line discipline, not to the call. What the
/// user sees is a half-typed command sitting unexecuted at a prompt.
///
/// Half of the smaller cap leaves room for the shell's own echo handling and for
/// a seed that grows. The guard lives here, below every provider, because this
/// repo has paid for the same trap three times: inlining Claude's settings JSON
/// (`hooks.rs` spills it to a `--settings` file for exactly this reason),
/// inlining a rendered work/review prompt (every launch site seeds "read this
/// file" instead), and then six Codex `-c 'hooks.<Event>=[…]'` flags, each
/// repeating an absolute hook-binary and db path. Shortening one command fixes
/// one command; a limit every seed passes through fixes the next one too.
const MAX_SEED_LINE: usize = 512;

/// How long a spilled seed script may sit before a later launch sweeps it.
///
/// The shell consumes its script within milliseconds of the write in the normal
/// case, but "the shell got there" is not observable from here (reading terminal
/// output to decide anything is exactly what COMPLIANCE.md forbids), and a login
/// shell resolving `direnv`/nix can legitimately take seconds. Ten minutes is far
/// past any of that while still bounding the directory to what the last few
/// minutes produced.
const SEED_SCRIPT_TTL: Duration = Duration::from_secs(10 * 60);

/// Where spilled seed scripts live: `<app_data_dir>/seeds`, app-owned and
/// `0700`. Never a world-writable directory — `/tmp` is the classic
/// symlink-swap target, and this file is about to be executed.
fn seed_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("seeds"))
}

/// The line santree actually types for a given seed.
///
/// Short seeds are typed verbatim — that is the common case, and it keeps what
/// runs visible in the user's own scrollback. A seed that would overflow the
/// tty's line buffer is written to a private script and replaced by a reference
/// to it, ~120 bytes however long the command was.
///
/// **How that reference is written follows the seed's own shape**, because the
/// two forms do not have the same lifecycle and picking the wrong one would
/// change what a launch means:
///
/// - A seed that starts with `exec ` — every agent launch
///   (`agentProvider.buildSeed`) — is referenced with `exec <path>`. The login
///   shell is replaced by the script, the script's own `exec` replaces *that*
///   with the agent, and the PTY ends up being the agent process, so its EOF is
///   still the agent exiting — which is what `retiring_sink` above depends on.
///   `exec` also needs nothing of the shell but the word itself, so it works
///   whatever `$SHELL` turned out to be.
/// - Any other seed is *sourced* (`. <path>`), which leaves the login shell
///   alive exactly as typing the command would. `exec`ing it instead would end
///   the session the moment the command finished — a difference no caller asked
///   for. Nothing produces a long non-`exec` seed today (the Settings login box
///   is the only non-`exec` caller and its command is a few bytes), so this is
///   the branch that keeps a future one from being quietly redefined. `.` is
///   POSIX and works in sh/bash/zsh/ksh; fish 4 dropped it, which is a trade
///   worth making against truncating the command outright.
///
/// Every failure degrades to typing the seed: that is no worse than the
/// behaviour this function replaced, and a launch that half-works is better
/// than one that cannot start at all.
fn seed_line(dir: Option<&Path>, seed: &str) -> String {
    // The caller's trailing Enter is added by `terminal_seed`; a CR inside a
    // script file would only be a stray byte on the line.
    let seed = seed.trim_end_matches(['\r', '\n']);
    if let Some(dir) = dir {
        sweep_seed_scripts(dir);
    }
    // Strictly less: the Enter that follows lands in the same buffer.
    if seed.len() < MAX_SEED_LINE {
        return seed.to_string();
    }
    let Some(dir) = dir else {
        log::warn!(
            "seed is {} bytes and no data directory resolved to spill it to; \
             the tty will truncate it",
            seed.len()
        );
        return seed.to_string();
    };
    match spill_seed_script(dir, seed) {
        Ok(path) => {
            // See the doc comment: `exec` for a launch line, sourcing for
            // anything else, so the script's lifecycle matches the seed's.
            let verb = if seed.starts_with("exec ") {
                "exec"
            } else {
                "."
            };
            let line = format!("{verb} {}", crate::hooks::sh_quote(&path));
            if line.len() >= MAX_SEED_LINE {
                log::warn!("spilled seed path is itself too long for a tty line: {path}");
            }
            line
        }
        Err(e) => {
            log::warn!(
                "spilling a {}-byte seed to {}: {e}",
                seed.len(),
                dir.display()
            );
            seed.to_string()
        }
    }
}

/// Write `seed` to a fresh owner-only script under `dir` and return its path.
///
/// The name is a v4 UUID and the content is the seed verbatim — nothing the
/// caller supplied reaches the *path*, so there is no traversal surface here,
/// and the seed itself is already shell-quoted by the builder that produced it
/// (`agentProvider.ts`). `create_new` refuses to follow or clobber anything that
/// is already at the name.
fn spill_seed_script(dir: &Path, seed: &str) -> std::io::Result<String> {
    make_private_dir(dir)?;
    let path = dir.join(format!("seed-{}.sh", uuid::Uuid::new_v4()));
    let mut file = {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            // Owner-only, and executable because the login shell `exec`s it.
            opts.mode(0o700);
        }
        opts.open(&path)?
    };
    // `#!/bin/sh`, not the user's `$SHELL`: the seed is machine-generated POSIX
    // (single-quoted values, `env`, `exec`), so the plainest interpreter is also
    // the most predictable one.
    file.write_all(
        format!(
            "#!/bin/sh\n# santree agent launch seed — one launch's command line, too long to \
             type into a tty.\n# Written per launch and swept automatically. Safe to delete.\n\
             {seed}\n"
        )
        .as_bytes(),
    )?;
    path.into_os_string()
        .into_string()
        .map_err(|p| std::io::Error::other(format!("non-UTF-8 seed path {p:?}")))
}

/// Refuse to treat `dir` as ours if something replaced it with a symlink.
///
/// Everything else here is careful about the *final* component — `create_new`
/// will not follow or clobber a planted `seed-<uuid>.sh` — but the directory
/// itself is followed by both of the operations below: `create_dir_all` decides
/// "already there" with `is_dir()`, which resolves links, and `set_permissions`
/// is `chmod`, not `lchmod`, so it would tighten a *link target*. The sweep
/// would then delete `*.sh` files inside that target.
///
/// Planting the link needs write access to santree's own data directory — the
/// UID santree runs as, which can do worse things directly — so this is
/// hardening, not a boundary. It matters in one real place: on macOS, a process
/// that can write to Application Support (not TCC-protected) would otherwise
/// borrow a signed app's reach into Documents or Desktop (which are).
fn reject_symlinked_dir(dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        // Not there yet is the normal first run — the caller creates it.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.file_type().is_symlink() => Err(std::io::Error::other(format!(
            "{} is a symlink; refusing to write seed scripts through it",
            dir.display()
        ))),
        Ok(_) => Ok(()),
    }
}

/// Create `dir` owner-only, repairing the mode if it already exists.
fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    reject_symlinked_dir(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        // `recursive` leaves an existing directory's mode alone, so a dir that
        // predates this (or a permissive umask upstream) is tightened here.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// Delete seed scripts older than [`SEED_SCRIPT_TTL`].
///
/// Sweeping on the way *in* — rather than deleting a script after its shell has
/// run it — is deliberate: the script has to outlive an unbounded shell startup,
/// and nothing here may watch the session to learn when it is safe to remove.
/// Bounding it by age instead means a launch that crashed between the write and
/// the exec still cleans up, and the directory never grows.
fn sweep_seed_scripts(dir: &Path) {
    // A delete loop must never run through a link someone else chose — see
    // `reject_symlinked_dir`. Entries *inside* are already safe: `DirEntry`
    // metadata is `lstat`, so a `foo.sh` symlink is aged by its own mtime and
    // `remove_file` unlinks the link rather than its target.
    if reject_symlinked_dir(dir).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sh") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > SEED_SCRIPT_TTL);
        if stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// What a terminal accepts as input, as types (COMPLIANCE.md, "No output-parsing
/// influences input"). The only bytes santree types are the user's keystrokes
/// and the one launch line they asked for, and these types are how the compiler
/// holds that: [`Keystrokes`] and [`LaunchRequest`] have private fields and no
/// constructor function, so the only way to make one is to deserialize it — and
/// the only things deserialized into them are the IPC arguments of
/// [`terminal_write`] and [`terminal_seed`]. Everything that types into a pane,
/// here, in the facade or in a remote pane's queue, takes one of them or a
/// [`PtyInput`] made from one. None is `Clone`, so each launch request is typed
/// at most once; that a pane asks only once is the frontend's latch.
pub mod input {
    use serde::Deserialize;
    use specta::Type;

    /// The user's keystrokes, verbatim, as the webview sent them.
    #[derive(Deserialize, Type)]
    #[serde(transparent)]
    #[specta(transparent)]
    pub struct Keystrokes(String);

    /// The launch line a human asked for, before it is prepared for a tty.
    #[derive(Deserialize, Type)]
    #[serde(transparent)]
    #[specta(transparent)]
    pub struct LaunchRequest(String);

    /// The line typed for one [`LaunchRequest`], prepared for the pane's tty.
    pub struct LaunchLine(String);

    /// Bytes on their way into a PTY: keystrokes or a launch line, nothing else.
    pub struct PtyInput(Vec<u8>);

    impl LaunchRequest {
        pub fn as_str(&self) -> &str {
            &self.0
        }

        /// The line typed for this request. Consumes it: one request, one line.
        pub fn into_line(self, line: String) -> LaunchLine {
            LaunchLine(line)
        }
    }

    impl PtyInput {
        pub fn as_bytes(&self) -> &[u8] {
            &self.0
        }

        pub fn into_bytes(self) -> Vec<u8> {
            self.0
        }
    }

    impl From<Keystrokes> for PtyInput {
        fn from(keys: Keystrokes) -> Self {
            Self(keys.0.into_bytes())
        }
    }

    impl From<LaunchLine> for PtyInput {
        fn from(line: LaunchLine) -> Self {
            Self(line.0.into_bytes())
        }
    }

    #[cfg(test)]
    impl Keystrokes {
        pub fn typed(keys: impl Into<String>) -> Self {
            Self(keys.into())
        }
    }

    #[cfg(test)]
    impl LaunchRequest {
        pub fn typed(seed: impl Into<String>) -> Self {
            Self(seed.into())
        }
    }

    #[cfg(test)]
    impl LaunchLine {
        pub fn typed(line: impl Into<String>) -> Self {
            Self(line.into())
        }
    }
}

/// The single place bytes enter a PTY: [`terminal_write`]'s keystrokes and
/// [`terminal_seed`]'s launch line. The facade relays them to wherever the
/// pane's process is — in this app, on the local server, or on Daedalus.
fn write_pty(terminals: &Terminals, id: SessionId, input: Input) -> anyhow::Result<()> {
    refuse_run_pane(id)?;
    match input {
        Input::Keys(keys) => terminals.write(id, keys),
        Input::Seed(line) => terminals.seed(id, line),
    }
}

/// A setup run's pane belongs to the app: nothing a page sends may type into it,
/// attach to it, detach it or re-grid it — attaching replaces the sinks the run
/// is followed by. (Closing it stays allowed, as it is for every id: it ends
/// the process, and the run's own task then settles it as stopped.)
fn refuse_run_pane(id: SessionId) -> anyhow::Result<()> {
    anyhow::ensure!(
        !crate::stream::RUNS.owns(id),
        "terminal {id} is a setup run's, not a tab's"
    );
    Ok(())
}

/// What [`write_pty`] types: the user's keystrokes, or the one launch line
/// (with its Enter). A remote session tells them apart — a found-again session
/// is already running its launch, so only keystrokes reach it.
enum Input {
    Keys(Keystrokes),
    Seed(LaunchLine),
}

/// Output and link channels, as the sinks a pane forwards to. The exit
/// sentinel retires the pane's session rows ([`retiring_sink`]): `pane` is its
/// address, `cwd` its directory on its host.
fn channel_sinks(
    db: &Db,
    pane: LiveTerminal,
    cwd: Option<String>,
    on_output: Channel<RawBytes>,
    on_link: Channel<PaneLink>,
) -> Sinks {
    Sinks {
        output: Arc::new(retiring_sink(
            db.clone(),
            pane.term_key,
            pane.agent_kind,
            cwd,
            move |bytes| {
                // A failed send means the channel was dropped (view unmounted);
                // the session is closed separately, so just stop forwarding.
                let _ = on_output.send(RawBytes(bytes));
            },
        )),
        link: Arc::new(move |link| {
            let _ = on_link.send(link);
        }),
    }
}

/// A cwd on the box as IPC gave it, refused unless it is an absolute path
/// that never climbs: the host confines it under its projects root, and this
/// keeps a `..` from walking it to another checkout first.
pub(crate) fn box_cwd(cwd: &str) -> anyhow::Result<String> {
    let path = Path::new(cwd);
    let plain = path.is_absolute()
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)));
    anyhow::ensure!(
        plain,
        "not a directory santree can open a terminal in: {cwd}"
    );
    Ok(cwd.to_string())
}

/// What a server's `on_exited` does with a session found already exited when
/// the app (re)connected: the same row retirement a live pane's exit sentinel
/// does ([`retiring_sink`]), for an exit nobody was attached to hear.
pub fn retire_exited(db: Db) -> OnExited {
    Arc::new(move |exited: Exited| {
        let db = db.clone();
        Box::pin(async move {
            retire(&db, &exited.label, exited.agent_kind, exited.cwd.as_deref()).await;
        })
    })
}

/// Build the terminal facade for `mode` and put it in Tauri state, where every
/// command finds it. With no server the local arm is a `PtyManager` in this
/// process; otherwise it is the supervisor, so local panes run on the detached
/// santree server. The Daedalus arm is the link's own, sharing its id registry.
/// Must run after the Daedalus link is managed.
pub fn manage(app: &AppHandle, mode: Mode, servers: &Arc<crate::server::LocalServers>) {
    let local = match mode {
        Mode::Off => Local::InApp(PtyManager::new()),
        Mode::Signed { .. } | Mode::OptIn => Local::Server(servers.clone()),
    };
    let link = app.state::<DaedalusHost>();
    let terminals = Arc::new(Terminals::new(
        local,
        link.terminals().clone(),
        link.ids().clone(),
    ));
    app.manage(terminals.clone());
    app.manage(Arc::new(TerminalRuns::new(terminals)) as Arc<dyn crate::stream::RunHost>);
}

/// The owner a setup run's pane is opened under: no page's. A reloaded page's
/// adopt takes it over like any pane, and [`terminal_adopt`] then leaves it out
/// of what the page is handed, by label.
const RUN_OWNER: &str = "santree-runs";

/// The terminals a setup run is a pane of ([`crate::stream::RunHost`]): this
/// adapter is the only place a run touches the facade, so a run is opened,
/// closed and re-gridded like any pane — on the local server when there is
/// one, in this process when there isn't — and, like any pane it opens,
/// nothing in it ever writes into the PTY.
pub struct TerminalRuns {
    terminals: Arc<Terminals>,
}

impl TerminalRuns {
    pub fn new(terminals: Arc<Terminals>) -> Self {
        Self { terminals }
    }
}

impl crate::stream::RunHost for TerminalRuns {
    fn open(
        &self,
        launch: crate::stream::Launch,
        size: (u16, u16),
        sinks: Sinks,
    ) -> BoxFuture<'_, anyhow::Result<PaneId>> {
        Box::pin(async move {
            // The project's env; what the process inherits beneath it is its
            // host's, as for any local terminal.
            let spec = Spec {
                cwd: Some(launch.cwd),
                command: launch.command,
                args: launch.args,
                env: launch.env,
                label: launch.label,
                agent_kind: None,
            };
            #[allow(clippy::disallowed_methods)]
            let opened = self
                .terminals
                .open(Route::Local, spec, RUN_OWNER.into(), size, sinks)
                .await;
            opened
        })
    }

    fn any_live(&self, prefix: &str) -> BoxFuture<'_, Option<bool>> {
        let prefix = prefix.to_string();
        Box::pin(async move {
            self.terminals
                .liveness()
                .await
                .knows(|pane| pane.term_key.starts_with(&prefix))
        })
    }

    fn close(&self, pane: PaneId) {
        #[allow(clippy::disallowed_methods)]
        let closed = self.terminals.close(pane);
        if let Err(e) = closed {
            // Already gone: the run is over either way.
            log::debug!("closing run pane {pane}: {e:#}");
        }
    }

    fn resize(&self, pane: PaneId, cols: u16, rows: u16) -> bool {
        self.terminals.resize(pane, cols, rows).is_ok()
    }
}

/// The run host over a fresh in-app terminal set, for tests.
#[cfg(test)]
pub(crate) fn test_run_host() -> Arc<dyn crate::stream::RunHost> {
    let link = DaedalusHost::default();
    let terminals = Terminals::new(
        Local::InApp(PtyManager::new()),
        link.terminals().clone(),
        link.ids().clone(),
    );
    Arc::new(TerminalRuns::new(Arc::new(terminals)))
}

/// The app is exiting or updating: let go of every terminal. A terminal in this
/// app ends with it; one on the local server keeps running — quitting never
/// stops it ([`Terminals::release`]).
pub fn release(app: &AppHandle) {
    if let Some(terminals) = app.try_state::<Arc<Terminals>>() {
        terminals.release();
    }
}

/// Open a terminal: on this Mac (in the app or on the local server) or — for a
/// cwd inside a Daedalus project — on the box. A Daedalus project's checkout is
/// a path on the server: a shell there runs on the box or not at all, never in
/// whatever this machine has at that path. With the link down the pane waits,
/// `Reconnecting`, and opens on the next connect.
///
/// The route is the one decision made here, because only the caller knows
/// whether a directory is a Daedalus project's; everything after it
/// ([`Terminals::open`]) is the facade's.
pub(crate) async fn open(
    terminals: &Terminals,
    db: &Db,
    opts: TerminalOpenOpts,
    on_output: Channel<RawBytes>,
    on_link: Channel<PaneLink>,
) -> anyhow::Result<PaneId> {
    // The `run:` namespace is the app's own (setup runs): a page can't open, or
    // claim, a pane under it.
    anyhow::ensure!(
        !crate::stream::is_run_label(&opts.label),
        "that terminal label is reserved"
    );
    let daedalus = match opts.cwd.as_deref() {
        Some(cwd) => crate::repo::daedalus_repo_at(db, Path::new(cwd))
            .await?
            .is_some(),
        None => false,
    };
    let route = if daedalus {
        Route::Daedalus
    } else {
        Route::Local
    };
    // A path on the box is checked before anything is built for it.
    let cwd = match route {
        Route::Daedalus => opts.cwd.as_deref().map(box_cwd).transpose()?,
        Route::Local => opts.cwd.clone(),
    };
    // The env a pane starts with, by where its process runs: the user's project
    // env for a local one (app + per-repo, the one chokepoint every
    // santree-spawned terminal passes), never the Mac's for Daedalus. What it
    // inherits beneath that is its host's.
    let env = crate::sessions::env::session_env(route, db, &opts).await?;
    let pane = LiveTerminal {
        term_key: opts.label.clone(),
        agent_kind: opts.agent_kind,
    };
    let sinks = channel_sinks(db, pane, cwd.clone(), on_output, on_link);
    let spec = Spec {
        cwd,
        command: opts.command,
        args: opts.args,
        env,
        label: opts.label,
        agent_kind: opts.agent_kind,
    };
    #[allow(clippy::disallowed_methods)]
    let opened = terminals
        .open(route, spec, opts.owner, (opts.cols, opts.rows), sinks)
        .await;
    opened
}

// These are `async` so Tauri runs them on the async runtime rather than the main
// (UI) thread: opening a PTY does a fork+exec with a full env copy, and a write
// can block if a stuck child's PTY buffer is full — neither should ever stall the
// UI. The PtyManager's per-session locking keeps sessions isolated from each other.

/// Spawn a process behind a PTY and stream its raw output over `on_output`.
///
/// The spawn itself is `openpty` + a fork/exec with a full env copy + a reader
/// thread — all blocking, and slow enough (an interactive `claude` on a cold
/// cache) to stall a tokio worker, so the facade sends it to the blocking pool
/// like [`terminal_write`]. Nothing about *what* is spawned or how its bytes
/// stream changes: it runs exactly once, with the same opts and the same
/// verbatim byte-forwarding sink (COMPLIANCE.md).
///
/// In a Daedalus project the process is spawned on the box instead ([`open`]);
/// `on_link` then says whether the pane is reaching it, and so it does for a
/// pane on the local server. An in-app session never sends on it.
#[tauri::command]
#[specta::specta]
pub async fn terminal_open(
    opts: TerminalOpenOpts,
    on_output: Channel<RawBytes>,
    on_link: Channel<PaneLink>,
    terminals: State<'_, Arc<Terminals>>,
    db: State<'_, Db>,
) -> CmdResult<SessionId> {
    Ok(open(&terminals, &db, opts, on_output, on_link).await?)
}

/// Write raw bytes to a session — the user's keystrokes, verbatim.
///
/// Verbatim is the contract: a paste is keystrokes too, and it is longer than a
/// line more often than not, so nothing here may rewrite what it was given. The
/// one launch line santree types on the user's behalf goes through
/// [`terminal_seed`] instead, which is what makes the two distinguishable.
///
/// Unlike resize/close, this can genuinely block (see the comment above): the
/// write is offloaded to a blocking-pool thread so a stuck child's full PTY
/// buffer can never pin a tokio worker and starve every other async command.
#[tauri::command]
#[specta::specta]
pub async fn terminal_write(
    id: SessionId,
    data: Keystrokes,
    terminals: State<'_, Arc<Terminals>>,
) -> CmdResult<()> {
    let terminals = terminals.inner().clone();
    Ok(tokio::task::spawn_blocking(move || write_pty(&terminals, id, Input::Keys(data))).await??)
}

/// Type the one human-initiated seed into a session, followed by Enter.
///
/// This is the launch line — `exec <agent> …` — and it is a separate command
/// from [`terminal_write`] for one reason: a seed is the only input santree
/// composes itself, so it is the only input santree may reshape. Anything over
/// [`MAX_SEED_LINE`] is spilled to a private script and typed as an `exec` of
/// it, because a tty silently truncates a long line and leaves the launch
/// half-typed at the prompt. A keystroke can never take that path.
///
/// Both parameters are untrusted, and neither gains authority here: `id` is an
/// integer looked up in the facade, exactly as [`terminal_write`] looks it up,
/// and `seed` becomes bytes in a PTY that the caller could already have written
/// one keystroke at a time. It never reaches a path — the spill file's name is a
/// UUID this process mints — and it is shell-quoted by the builder that composed
/// it (`agentProvider.ts`), which this must preserve rather than redo.
///
/// A session whose tty isn't this Mac's (Daedalus) has no spill: its line holds
/// what [`SeedPolicy::Cap`] says, and a seed that doesn't fit is refused rather
/// than truncated.
#[tauri::command]
#[specta::specta]
pub async fn terminal_seed(
    app: AppHandle,
    id: SessionId,
    seed: LaunchRequest,
    terminals: State<'_, Arc<Terminals>>,
) -> CmdResult<()> {
    let dir = seed_dir(&app);
    let terminals = terminals.inner().clone();
    Ok(
        tokio::task::spawn_blocking(move || type_seed(&terminals, dir.as_deref(), id, seed))
            .await??,
    )
}

/// [`terminal_seed`]'s body: prepare the launch line for the pane's tty, then
/// type it through the chokepoint.
fn type_seed(
    terminals: &Terminals,
    dir: Option<&Path>,
    id: SessionId,
    seed: LaunchRequest,
) -> anyhow::Result<()> {
    refuse_run_pane(id)?;
    let line = match terminals.seed_policy(id) {
        SeedPolicy::Cap(cap) => {
            let line = seed.as_str().trim_end_matches(['\r', '\n']);
            anyhow::ensure!(
                line.len() < cap,
                "this launch line is too long to type into a terminal on Daedalus"
            );
            line.to_string()
        }
        SeedPolicy::Spill => {
            // Resolve the session BEFORE spilling, so a file is only ever the
            // consequence of a real launch. A write would reject an unknown id
            // anyway, but only after the script had been written — and a caller
            // looping on an id that does not exist would leave one file per call
            // for the whole TTL. Ordinary TOCTOU applies (the session can close
            // in between) and is harmless: the write then fails exactly as before.
            if !terminals.seed_wanted(id) {
                // A session found already running (on the local server) has its
                // launch and is never typed a second one; one that isn't there at
                // all is an error, as it always was.
                anyhow::ensure!(terminals.address(id).is_some(), "no terminal session {id}");
                return Ok(());
            }
            seed_line(dir, seed.as_str())
        }
    };
    write_pty(
        terminals,
        id,
        Input::Seed(seed.into_line(format!("{line}\r"))),
    )
}

/// Resize a session's PTY to the visible grid.
#[tauri::command]
#[specta::specta]
pub async fn terminal_resize(
    id: SessionId,
    cols: u16,
    rows: u16,
    terminals: State<'_, Arc<Terminals>>,
) -> CmdResult<()> {
    refuse_run_pane(id)?;
    Ok(terminals.resize(id, cols, rows)?)
}

/// Kill a session's child and free it. On a remote host, as soon as it can be
/// told.
#[tauri::command]
#[specta::specta]
pub async fn terminal_close(id: SessionId, terminals: State<'_, Arc<Terminals>>) -> CmdResult<()> {
    #[allow(clippy::disallowed_methods)]
    let closed = terminals.close(id);
    Ok(closed?)
}

/// Point a live session's output at this page's channel, and catch it up.
///
/// This is what makes a session survive losing its view. The previous sink — an
/// unmounted pane's channel, or a whole page that reloaded — is replaced, and
/// the bytes the client is missing are written to `on_output` **before** this
/// returns, so they arrive ahead of any live output on the same channel (the
/// facade holds back what the new sink is handed meanwhile).
///
/// `anchor` is what the client claims to already have. When that claim can't be
/// verified against the session's ring (a different stream, or a gap older than
/// the ring keeps) nothing is sent and the mode comes back `Reanchor`: the
/// client's own screen is better than anything this could synthesize, and the
/// caller repaints from the running program instead.
///
/// A session on a remote host is caught up from that host's ring the same way;
/// while the link is down the answer is `Reanchor` with nothing sent, `on_link`
/// says `Reconnecting`, and the catch-up follows on the next connect.
///
/// Untrusted like any IPC value, and inert: `epoch` is compared for string
/// equality against a value this process minted, `seq` indexes a byte count.
/// Neither reaches the filesystem, a git argv, or a lookup key, and neither
/// grants authority the caller doesn't already have.
#[tauri::command]
#[specta::specta]
pub async fn terminal_attach(
    id: SessionId,
    anchor: TerminalAnchor,
    on_output: Channel<RawBytes>,
    on_link: Channel<PaneLink>,
    terminals: State<'_, Arc<Terminals>>,
    db: State<'_, Db>,
) -> CmdResult<TerminalAttached> {
    Ok(attach(&terminals, &db, id, anchor, on_output, on_link).await?)
}

/// [`terminal_attach`]'s body, over the facade it was handed.
pub(crate) async fn attach(
    terminals: &Terminals,
    db: &Db,
    id: SessionId,
    anchor: TerminalAnchor,
    on_output: Channel<RawBytes>,
    on_link: Channel<PaneLink>,
) -> anyhow::Result<TerminalAttached> {
    refuse_run_pane(id)?;
    // Attaching *replaces* the sink, so the exit retirement has to be re-wrapped
    // here or a session loses it the first time its pane remounts — which is the
    // common case, not the rare one. The address and cwd come from the pane as it
    // was opened, never from IPC, which could name another surface's terminal.
    let (pane, cwd) = terminals
        .address(id)
        .ok_or_else(|| anyhow::anyhow!("no terminal session {id}"))?;
    #[allow(clippy::disallowed_methods)]
    let attached = terminals
        .attach(
            id,
            anchor.into(),
            channel_sinks(db, pane, cwd, on_output, on_link),
        )
        .await?;
    Ok(TerminalAttached {
        epoch: attached.epoch,
        seq: attached.seq as f64,
        mode: attached.mode.into(),
    })
}

/// Stop delivering a session's output without ending it — what a pane does when
/// it unmounts. The process keeps running and keeps recording; only delivery
/// stops, and [`terminal_attach`] resumes it.
#[tauri::command]
#[specta::specta]
pub async fn terminal_detach(id: SessionId, terminals: State<'_, Arc<Terminals>>) -> CmdResult<()> {
    refuse_run_pane(id)?;
    terminals.detach(id);
    Ok(())
}

/// What quitting the app would end, so the quit guard warns only about work that
/// really goes: the in-app terminals — setup runs included, they are panes like
/// the rest. With a local server the answer is none (its sessions outlive the
/// app), so on a build that has one quitting never asks.
#[tauri::command]
#[specta::specta]
pub fn quit_summary(terminals: State<'_, Arc<Terminals>>) -> QuitSummary {
    summarize_quit(&terminals)
}

fn summarize_quit(terminals: &Terminals) -> QuitSummary {
    QuitSummary {
        terminals_end: terminals.ends_on_quit(),
    }
}

/// This Mac's terminal sessions with what the Terminal settings panel's server
/// card needs beside them: whether the list is the whole of it (`complete` is
/// false while a server that may hold more can't be asked) and which sessions
/// are orphans — see [`orphans_of`].
///
/// Read-only and cheap: in-app, a snapshot under the manager lock plus one
/// non-blocking `try_wait` per session; on the local server, one listing per
/// server. It grants no authority the frontend doesn't have — it can already
/// close any id — and reveals nothing about a session's *contents*, only that
/// it exists. This Mac's sessions only: the box's are its own to list. The db
/// read is the set of tab ids the app itself stored, compared by string
/// equality.
#[tauri::command]
#[specta::specta]
pub async fn terminal_inventory(
    terminals: State<'_, Arc<Terminals>>,
    db: State<'_, Db>,
) -> CmdResult<TerminalInventory> {
    let snapshot = terminals.snapshot().await;
    let tabs = tab_term_keys(&db).await?;
    let orphans = orphans_of(&snapshot.sessions, &tabs);
    Ok(TerminalInventory {
        sessions: snapshot.sessions,
        complete: snapshot.complete,
        orphans,
    })
}

/// The terminal key of every tab row there is, in any repo: the keys a session
/// labelled as a tab can still belong to.
async fn tab_term_keys(db: &Db) -> anyhow::Result<std::collections::HashSet<String>> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT worktree_id, id FROM worktree_tabs")
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(owner, id)| crate::tabs::term_key(&owner, &id))
        .collect())
}

/// The live sessions no tab will ever show: labelled as a tab
/// (`tree:<worktree>:tab:<id>`, `triage:<ticket>:tab:<id>`), with no pane
/// showing them, and no tab row of that key. That is what is left when a tab was
/// closed while its server couldn't be told, or a worktree went away under a
/// session. Only tab-shaped labels can be judged: an investigation, an AI review
/// and a settings login terminal live on surfaces that have no row, so the
/// backend cannot know whether one is still wanted, and they are never listed.
pub fn orphans_of(
    sessions: &[TerminalSession],
    tabs: &std::collections::HashSet<String>,
) -> Vec<SessionId> {
    sessions
        .iter()
        .filter(|s| s.alive && !s.attached)
        .filter(|s| s.label.contains(":tab:") && !tabs.contains(&s.label))
        .map(|s| s.id)
        .collect()
}

/// Claim the sessions an earlier page-load left running, and report them so the
/// caller can put each one back on the surface that owns it.
///
/// A session deliberately outlives the view that opened it — that is what lets a
/// terminal keep running while you look at another tab. It used to also have to
/// die with the *page*: every handle to one lived in the webview, and a reload
/// threw all of them away, so the sessions were unreachable and had to be
/// reaped. They no longer are. Each session records its own recent output, so a
/// reloaded page can rebuild the tab from `(label, agent_kind)` and catch the
/// pane up from the stream — a reload now costs the view, not the work.
///
/// Panes on Daedalus are handed over the same way: they live in this process
/// too, beside the link. With a local santree server there is more to hand over:
/// every session it holds, including ones no tab asked for since the app was
/// relaunched, so this first waits (bounded) for the server to list them. (After
/// santree itself restarts a Daedalus pane has nothing here to adopt; a pane
/// opening under the same address finds its session on the box instead —
/// `sessions::remote`.)
///
/// The caller must close whatever it cannot host (a worktree deleted while the
/// page was down); this reports everything rather than filtering, because only
/// the caller knows which surfaces still exist.
///
/// `owner` is untrusted like any IPC value and only ever compared for string
/// equality against tags this process stored. It grants no authority the
/// frontend doesn't already have: anything that can call this can call
/// [`terminal_close`] on every id in turn.
#[tauri::command]
#[specta::specta]
pub async fn terminal_adopt(
    owner: String,
    terminals: State<'_, Arc<Terminals>>,
) -> CmdResult<Vec<AdoptedSession>> {
    #[allow(clippy::disallowed_methods)]
    let adopted: Vec<AdoptedSession> = terminals
        .adopt(&owner)
        .await
        .into_iter()
        // A setup run is a pane no page hosts: the app follows it itself
        // while it can (`stream::start`), and a page handed it would have
        // nothing to put it on.
        .filter(|pane| !crate::stream::is_run_label(&pane.label))
        .collect();
    if !adopted.is_empty() {
        log::info!(
            "adopted {} pty session(s) from a previous page load",
            adopted.len()
        );
    }
    Ok(adopted)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // tests drive PTYs directly
mod tests {

    fn session(id: SessionId, label: &str, alive: bool, attached: bool) -> TerminalSession {
        TerminalSession {
            id,
            label: label.into(),
            cwd: None,
            command: "/bin/zsh".into(),
            pid: Some(id + 1000),
            cols: 80,
            rows: 24,
            attached,
            alive,
            server_revision: None,
        }
    }

    /// An orphan is a live, unshown session labelled as a tab whose row is gone.
    /// Anything the backend cannot judge is never one.
    #[test]
    fn a_session_is_an_orphan_only_when_its_tab_is_gone_and_nothing_shows_it() {
        let tabs: std::collections::HashSet<String> = [
            crate::tabs::term_key("AK-1", "t1"),
            crate::tabs::term_key("triage:AK-9", "t2"),
        ]
        .into();
        let sessions = vec![
            session(1, "tree:AK-1:tab:t1", true, false), // its tab exists
            session(2, "tree:AK-1:tab:gone", true, false), // tab closed: orphan
            session(3, "tree:AK-2:tab:t1", true, true),  // a pane shows it
            session(4, "tree:AK-2:tab:t9", false, false), // exited: not running
            session(5, "triage:AK-9:tab:t2", true, false), // a triage tab, present
            session(6, "triage:AK-9:tab:zz", true, false), // a triage tab, gone: orphan
            session(7, "triage:AK-9", true, false),      // an investigation: unjudgeable
            session(8, "ai-review:o/r#4", true, false),  // a review session: unjudgeable
            session(9, "login:claude", true, false),     // settings login: unjudgeable
        ];
        assert_eq!(orphans_of(&sessions, &tabs), vec![2, 6]);
        assert!(orphans_of(&[], &tabs).is_empty());
    }

    /// A setup run's pane is the app's: a page's attach, write, seed, resize
    /// and detach on it are refused, so it cannot take the run's sinks.
    #[test]
    fn a_page_cannot_reach_a_setup_runs_pane() {
        let host = crate::stream::fake::FakeHost::new();
        let host: Arc<dyn crate::stream::RunHost> = host;
        let slot = crate::stream::RUNS.reserve("terminal-test-run").unwrap();
        assert!(refuse_run_pane(987_654).is_ok());
        assert!(slot.attach_for_test(&host, 987_654));
        assert!(refuse_run_pane(987_654).is_err());
        drop(slot);
        assert!(refuse_run_pane(987_654).is_ok());
    }

    /// The keys are read from the real table with the same function the tabs are
    /// keyed by, so a worktree's and a triage ticket's tabs both count.
    #[tokio::test]
    async fn tab_keys_come_from_the_tab_rows_of_every_repo() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::init(dir.path().join("test.db")).await.unwrap();
        for (repo, owner, id) in [("a", "AK-1", "t1"), ("b", "triage:AK-9", "t2")] {
            sqlx::query(
                "INSERT INTO worktree_tabs (repo, id, worktree_id, kind, title, position) \
                 VALUES (?, ?, ?, 'terminal', 'x', 1)",
            )
            .bind(repo)
            .bind(id)
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        }
        let keys = tab_term_keys(&db).await.unwrap();
        assert_eq!(
            keys,
            [
                "tree:AK-1:tab:t1".to_string(),
                "triage:AK-9:tab:t2".to_string()
            ]
            .into()
        );
    }
    use super::*;
    use santree_pty::OpenOpts;
    use std::sync::Mutex;

    /// A throwaway seed directory, uniquely named per test (no tempfile dep in
    /// this crate — see `openers.rs`, which does the same).
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "santree-seed-{}-{tag}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// A seed of `len` bytes that is still a runnable command line.
    fn seed_of(len: usize) -> String {
        let head = "exec '/opt/homebrew/bin/codex' ";
        format!("{head}'{}'", "x".repeat(len - head.len() - 2))
    }

    #[test]
    fn a_seed_that_fits_on_a_line_is_typed_verbatim() {
        let dir = scratch("short");
        let seed = "exec env SANTREE_REPO='/r' '/usr/local/bin/claude' --resume 'abc'";
        assert_eq!(seed_line(Some(&dir), seed), seed);
        // Nothing was written: the common case costs no file at all.
        assert!(!dir.exists());
    }

    #[test]
    fn a_trailing_return_is_not_part_of_the_line() {
        let dir = scratch("cr");
        assert_eq!(seed_line(Some(&dir), "exec 'claude'\r"), "exec 'claude'");
    }

    /// The regression this whole path exists for. Deliberately asserted on the
    /// *mechanism* — a seed past the limit does not reach the tty verbatim, and
    /// what does reach it fits — never on the byte count of today's Codex line,
    /// which will drift while the tty's limit does not.
    #[test]
    fn a_seed_too_long_for_a_tty_is_replaced_by_a_short_line_that_runs_it() {
        let dir = scratch("long");
        let seed = seed_of(MAX_SEED_LINE * 3);

        let line = seed_line(Some(&dir), &seed);

        assert_ne!(line, seed, "the over-long seed was typed verbatim");
        assert!(
            !line.contains("xxxx"),
            "the seed's own text is still on the line: {line}"
        );
        assert!(
            line.len() < MAX_SEED_LINE,
            "the replacement line is itself {} bytes",
            line.len()
        );

        // …and what it runs is exactly the seed, so the launch is unchanged.
        let path = line
            .strip_prefix("exec '")
            .and_then(|rest| rest.strip_suffix('\''))
            .expect("an exec of a single-quoted path");
        let script = std::fs::read_to_string(path).expect("the script exists");
        assert!(script.starts_with("#!/bin/sh\n"));
        assert_eq!(script.lines().next_back(), Some(seed.as_str()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// It runs with the user's privileges, so nobody else may read it, write it,
    /// or swap it for something else on the way to `exec`.
    #[cfg(unix)]
    #[test]
    fn the_spilled_script_and_its_directory_are_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = scratch("perms");
        // A pre-existing, permissive directory is tightened rather than trusted.
        std::fs::create_dir_all(&dir).expect("create");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).expect("chmod");

        let path = spill_seed_script(&dir, &seed_of(MAX_SEED_LINE * 2)).expect("spilled");

        let mode = |p: &Path| std::fs::metadata(p).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700, "seed directory is group/world readable");
        assert_eq!(
            mode(Path::new(&path)),
            0o700,
            "seed script is not owner-only"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A per-launch file that is never removed accumulates forever; one removed
    /// too eagerly races the shell that has not read it yet.
    #[test]
    fn stale_scripts_are_swept_and_fresh_ones_are_kept() {
        let dir = scratch("sweep");
        make_private_dir(&dir).expect("create");
        let stale = dir.join("seed-stale.sh");
        let fresh = dir.join("seed-fresh.sh");
        let other = dir.join("keep.txt");
        for path in [&stale, &fresh, &other] {
            std::fs::write(path, "exec 'claude'\n").expect("write");
        }
        let long_ago = SystemTime::now() - (SEED_SCRIPT_TTL + Duration::from_secs(60));
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .expect("open")
            .set_times(std::fs::FileTimes::new().set_modified(long_ago))
            .expect("backdate");

        sweep_seed_scripts(&dir);

        assert!(!stale.exists(), "a script past the TTL was kept");
        assert!(
            fresh.exists(),
            "a script a launch may still be about to run was deleted"
        );
        assert!(
            other.exists(),
            "the sweep deleted something that is not a seed script"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `exec` and sourcing do not mean the same thing to a session, so the form
    /// has to follow the seed rather than be assumed. Every agent launch is an
    /// `exec`; anything else must leave the shell alive exactly as typing would.
    #[test]
    fn the_reference_form_follows_the_seed_rather_than_being_assumed() {
        let dir = scratch("form");
        let launch = seed_of(MAX_SEED_LINE * 2);
        assert!(launch.starts_with("exec "));
        assert!(
            seed_line(Some(&dir), &launch).starts_with("exec '"),
            "a launch line must replace the shell, or the PTY stops being the agent"
        );

        // A long non-`exec` seed is sourced: `exec`ing it would end the session
        // the moment the command finished, which is not what typing it does.
        let plain = format!("printf '{}'", "x".repeat(MAX_SEED_LINE * 2));
        let line = seed_line(Some(&dir), &plain);
        assert!(
            line.starts_with(". '"),
            "expected a sourced reference, got {line}"
        );
        assert!(line.len() < MAX_SEED_LINE);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The final component is protected by `create_new`, but the directory is
    /// followed by `create_dir_all`'s `is_dir()` and by `chmod` — so a symlink
    /// standing in for it would hand a delete loop and a mode change to whatever
    /// it points at.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_seed_directory_is_refused_rather_than_followed() {
        use std::os::unix::fs::PermissionsExt as _;

        let base = scratch("symlink");
        let target = base.join("target");
        let link = base.join("seeds");
        std::fs::create_dir_all(&target).expect("create");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let bystander = target.join("someone-elses.sh");
        std::fs::write(&bystander, "echo hi\n").expect("write");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");

        assert!(
            spill_seed_script(&link, &seed_of(MAX_SEED_LINE * 2)).is_err(),
            "a spill followed a symlinked seed directory"
        );
        // The sweep is the half that deletes, so it must bail too — and it must
        // not have re-moded the target on the way past.
        sweep_seed_scripts(&link);
        assert!(
            bystander.exists(),
            "the sweep deleted a file through a symlink"
        );
        assert_eq!(
            std::fs::metadata(&target)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o755,
            "the mode of a symlink's target was changed"
        );

        // …and the seed still launches: a refused spill degrades to typing it.
        let seed = seed_of(MAX_SEED_LINE * 2);
        assert_eq!(seed_line(Some(&link), &seed), seed);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Every failure degrades to the old behaviour rather than to no launch.
    #[test]
    fn an_unresolvable_data_directory_falls_back_to_typing_the_seed() {
        let seed = seed_of(MAX_SEED_LINE * 2);
        assert_eq!(seed_line(None, &seed), seed);
    }

    /// The one OS assumption agent detection rests on, checked against a real
    /// PTY: a process santree spawns behind one *is* the foreground process
    /// group of its controlling terminal, so `ps` marks it `+` and
    /// `agent_procs` can see it. Together with `pane_roots`, that is the whole
    /// path from a live session to "a Codex is running in this pane".
    ///
    /// Deliberately the only pty this crate's tests open — `crates/pty`
    /// serialises its own because the pty table has been exhausted before — but
    /// nothing cheaper can check this. If portable-pty ever stopped handing the
    /// child a controlling terminal, every pane would detect as unknown forever
    /// and no test over a `ps` fixture would notice.
    ///
    /// The "agent" is a symlink named `codex` pointing at `cat`, which sits
    /// reading the pty and holds the foreground. No vendor binary is involved:
    /// recognition is on `argv[0]`'s basename, which is exactly what the
    /// symlink's name controls.
    #[tokio::test]
    async fn a_pane_running_an_agent_is_detected_from_its_root_pid() {
        let dir = scratch("detect");
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let fake_agent = dir.join("codex");
        std::os::unix::fs::symlink("/bin/cat", &fake_agent).expect("symlink");

        let manager = PtyManager::new();
        let id = manager
            .open(
                OpenOpts {
                    command: fake_agent.to_string_lossy().into_owned(),
                    cwd: Some(dir.to_string_lossy().into_owned()),
                    cols: 80,
                    rows: 24,
                    label: "tree:AK-1".into(),
                    agent_kind: Some(AgentKind::Codex),
                    ..Default::default()
                },
                |_| {},
            )
            .expect("open session");

        let roots = pane_roots(&manager.sessions());
        assert_eq!(
            roots
                .iter()
                .map(|(pane, _)| pane.clone())
                .collect::<Vec<_>>(),
            vec![LiveTerminal {
                term_key: "tree:AK-1".into(),
                agent_kind: Some(AgentKind::Codex),
            }],
            "the pane is addressed by its term_key AND the provider in it"
        );

        // The process table snapshot is cached for 500ms, so the first scan can
        // legitimately predate the spawn. Retry rather than sleep blindly.
        let mut found = Vec::new();
        for _ in 0..20 {
            found = crate::agent_procs::detect(&roots).await;
            if !found.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        manager.close(id).expect("close session");
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(
            found,
            vec![santree_core::domain::AgentProcess {
                term_key: "tree:AK-1".into(),
                pane_agent_kind: Some(AgentKind::Codex),
                agent_kind: AgentKind::Codex,
            }],
            "a pty-hosted `codex` must be seen in its pane's foreground"
        );
    }

    // ── The adapter over the facade ─────────────────────────────────────────
    //
    // `open`, `attach` and `type_seed` are the commands' bodies, so these run
    // what a pane's life runs, through the channels the frontend holds — once
    // with no server (`Mode::Off`, the default for unsigned, dev and Linux
    // builds) and once on a real `santree-server`.

    use crate::sessions::testkit::{until, Screen};

    fn shell_opts(cwd: &Path, label: &str, agent_kind: Option<AgentKind>) -> TerminalOpenOpts {
        TerminalOpenOpts {
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: "/bin/sh".into(),
            args: Vec::new(),
            cols: 100,
            rows: 30,
            owner: "page-1".into(),
            label: label.into(),
            agent_kind,
        }
    }

    fn type_line(terminals: &Terminals, id: SessionId, line: &str) {
        write_pty(
            terminals,
            id,
            Input::Keys(Keystrokes::typed(format!("{line}\n"))),
        )
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_no_server_a_terminal_is_an_in_app_pty_exactly_as_before() {
        let _serial = crate::stream::pty_guard().await;
        let dir = scratch("off");
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::init(dir.join("t.db")).await.unwrap();
        let link = DaedalusHost::default();
        let manager = PtyManager::new();
        let terminals = Terminals::new(
            Local::InApp(manager.clone()),
            link.terminals().clone(),
            link.ids().clone(),
        );

        // A retirable agent row: the pane's exit must still stamp it.
        for sql in [
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind) \
             VALUES ('r', 'tree:A:tab:1', ?, 's1', 'Claude')",
            "INSERT INTO session_state (session_id, state, event, cwd, updated_at_ms) \
             VALUES ('s1', 'active', 'UserPromptSubmit', ?, 1)",
        ] {
            sqlx::query(sql)
                .bind(dir.to_string_lossy().into_owned())
                .execute(&db)
                .await
                .unwrap();
        }

        let screen = Screen::new();
        let (output, links) = screen.channels();
        let id = open(
            &terminals,
            &db,
            shell_opts(&dir, "tree:A:tab:1", Some(AgentKind::Claude)),
            output,
            links,
        )
        .await
        .unwrap();

        // The manager's own id, never minted; the session is the manager's.
        assert!(!link.ids().minted(id));
        let held = manager.sessions();
        assert_eq!((held.len(), held[0].id), (1, id));
        assert_eq!(held[0].label, "tree:A:tab:1");
        assert_eq!(held[0].agent_kind, Some(AgentKind::Claude));
        assert_eq!(terminals.seed_policy(id), SeedPolicy::Spill);
        assert!(screen.links().is_empty(), "in-app never sends a link");

        type_line(&terminals, id, "echo off-$((20+1))");
        screen
            .until("the echo", |s| s.text().contains("off-21"))
            .await;

        // Detach, let it print unwatched, attach from where the screen stopped:
        // exactly the missed bytes, ahead of anything live.
        let anchor = TerminalAnchor::At {
            epoch: held[0].epoch.clone(),
            seq: screen.len() as f64,
        };
        terminals.detach(id);
        type_line(&terminals, id, "echo away-$((3+3))");
        let again = Screen::new();
        let (output, links) = again.channels();
        let attached = attach(&terminals, &db, id, anchor, output, links)
            .await
            .unwrap();
        assert!(matches!(attached.mode, TerminalReplayMode::Exact));
        again
            .until("the missed output", |s| s.text().contains("away-6"))
            .await;
        assert!(!again.text().contains("off-21"), "{:?}", again.text());

        // A launch line too long for a tty is spilled and run, as before; an
        // unknown id spills nothing.
        let seeds = dir.join("seeds");
        let long = format!("echo spilled-$((2+2)) # {}", "x".repeat(MAX_SEED_LINE * 2));
        type_seed(
            &terminals,
            Some(&seeds),
            id,
            LaunchRequest::typed(long.clone()),
        )
        .unwrap();
        again
            .until("the spilled seed", |s| s.text().contains("spilled-4"))
            .await;
        assert_eq!(std::fs::read_dir(&seeds).unwrap().count(), 1);
        let nowhere = dir.join("nowhere");
        assert!(type_seed(&terminals, Some(&nowhere), 999, LaunchRequest::typed(long)).is_err());
        assert!(!nowhere.exists(), "a refused seed left a file");

        // Quitting would end this in-app terminal.
        assert_eq!(summarize_quit(&terminals), QuitSummary { terminals_end: 1 });

        // The exit sentinel closes the pane and retires the agent's rows.
        type_line(&terminals, id, "exit");
        again.until("the exit", |s| s.exited()).await;
        for _ in 0..100 {
            let (state,): (String,) =
                sqlx::query_as("SELECT state FROM session_state WHERE session_id = 's1'")
                    .fetch_one(&db)
                    .await
                    .unwrap();
            if state == "exited" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let (state,): (String,) =
            sqlx::query_as("SELECT state FROM session_state WHERE session_id = 's1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(state, "exited");

        // Leaving closes every in-app session, as it always did.
        terminals.release();
        assert!(manager.sessions().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The same pane on a real `santree-server`: it opens there with the app's
    /// environment, takes keystrokes, survives a detach and re-attaches with
    /// exact replay, is adopted by a later page, and outlives the app's
    /// `release`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_a_server_the_pane_runs_there_replays_exactly_and_outlives_release() {
        use crate::server::testkit::{real_binary, Fixture};
        use crate::server::{LocalServers, ServerConfig};
        use santree_core::domain::ServerState;

        assert!(
            std::env::var_os("CARGO_MANIFEST_DIR").is_some(),
            "this test reads cargo's own variable to prove the app's env reaches the \
             server: run it through `cargo test`"
        );
        let _serial = crate::stream::pty_guard().await;
        let fx = Fixture::new();
        let db = crate::db::init(fx.dir.path().join("t.db")).await.unwrap();
        let link = DaedalusHost::default();
        let states = Arc::new(Mutex::new(Vec::new()));
        let servers = LocalServers::new(ServerConfig {
            app_data_dir: fx.dir.path().to_path_buf(),
            log_dir: Some(fx.dir.path().join("logs")),
            bundled_binary: Some(real_binary()),
            mode: Mode::OptIn,
            ids: link.ids().clone(),
            retire: retire_exited(db.clone()),
            emit: {
                let states = states.clone();
                Arc::new(move |status| states.lock().unwrap().push(status.state))
            },
            keep_awake: Arc::new(|| false),
            keep_awake_held: Arc::new(|_| {}),
        });
        servers.ensure().await;
        let ServerState::Running { pid, .. } = servers.status().state else {
            panic!("the server isn't running: {:?}", servers.status());
        };
        fx.track(pid);
        // `ensure` announced the move into Running, which is what the frontend
        // re-runs its adopt on.
        assert!(matches!(
            states.lock().unwrap().last(),
            Some(ServerState::Running { .. })
        ));

        let terminals = Terminals::new(
            Local::Server(servers.clone()),
            link.terminals().clone(),
            link.ids().clone(),
        );
        let screen = Screen::new();
        let (output, links) = screen.channels();
        let id = open(
            &terminals,
            &db,
            shell_opts(fx.dir.path(), "tree:S:tab:1", None),
            output,
            links,
        )
        .await
        .unwrap();
        assert!(
            id >= 1 << 31,
            "a server pane's id is minted by the registry"
        );
        assert!(
            crate::sessions::LocalHosts::current(&*servers).is_some_and(|server| server.holds(id)),
            "the pane is the server's"
        );
        assert_eq!(terminals.seed_policy(id), SeedPolicy::Spill);
        screen
            .until("the pane to go live", |s| {
                s.links().contains(&PaneLink::Live)
            })
            .await;

        // The app's environment reached a server that started with none of it
        // (`CARGO_MANIFEST_DIR` is in a test's env and in no server's).
        type_line(&terminals, id, "echo base-${CARGO_MANIFEST_DIR:+forwarded}");
        screen
            .until("the base env", |s| s.text().contains("base-forwarded"))
            .await;

        type_line(&terminals, id, "echo first-$((1+1))");
        screen
            .until("the echo", |s| s.text().contains("first-2"))
            .await;
        let held = terminals.local_sessions().await;
        assert_eq!((held.len(), held[0].id), (1, id));
        // Input typed to a detached pane is dropped, never replayed later, so
        // the shell is told in advance to print while nobody is watching, and
        // to leave a mark once it has. It waits for `go`, created only after
        // the detach: a timer raced a slow runner, and not every `sh` prints
        // a job number to wait on.
        let go = fx.dir.path().join("go");
        let printed = fx.dir.path().join("printed");
        type_line(
            &terminals,
            id,
            &format!(
                "(until [ -e '{}' ]; do sleep 0.1; done; echo away-$((3+3)); touch '{}') &",
                go.display(),
                printed.display()
            ),
        );
        screen
            .until("the job's line to echo", |s| s.text().contains("touch '"))
            .await;
        let anchor = TerminalAnchor::At {
            epoch: held[0].epoch.clone(),
            seq: screen.len() as f64,
        };
        terminals.detach(id);
        std::fs::write(&go, b"").unwrap();
        until("the job to print unwatched", || printed.exists()).await;
        let again = Screen::new();
        let (output, links) = again.channels();
        let attached = attach(&terminals, &db, id, anchor, output, links)
            .await
            .unwrap();
        assert!(matches!(attached.mode, TerminalReplayMode::Exact));
        again
            .until("the missed output", |s| s.text().contains("away-6"))
            .await;
        assert!(!again.text().contains("first-2"), "{:?}", again.text());
        type_line(&terminals, id, "echo typed-$((2+2))");
        again
            .until("typing", |s| s.text().contains("typed-4"))
            .await;

        // A later page adopts the pane; the snapshot lists it.
        let adopted = terminals.adopt("page-2").await;
        assert_eq!(
            adopted
                .iter()
                .map(|a| (a.id, a.label.as_str()))
                .collect::<Vec<_>>(),
            [(id, "tree:S:tab:1")]
        );
        assert_eq!(terminals.snapshot().await.sessions.len(), 1);

        // A live session on the server is not something quitting ends.
        assert_eq!(summarize_quit(&terminals), QuitSummary { terminals_end: 0 });

        // Quitting the app lets go; the server keeps running and answering.
        terminals.release();
        let info =
            crate::server::testkit::info_over(&fx.layout.socket_for(santree_server::REVISION))
                .await;
        assert_eq!(info.pid, pid, "the server ended with the app");
    }
}
