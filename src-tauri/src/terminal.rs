//! Tauri command adapter for the real terminal layer.
//!
//! These are thin wrappers over [`santree_pty::PtyManager`]. Output is streamed
//! to the frontend over a [`tauri::ipc::Channel`] (the correct high-throughput
//! primitive for per-chunk terminal output — `emit` would choke); input, resize
//! and close map straight onto the PTY.

use std::collections::HashSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use specta::{datatype::DataType, Type, Types};
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::error::CmdResult;
use santree_core::domain::AgentKind;
use santree_pty::{Anchor, OpenOpts, PtyManager, ReplayMode, SessionId};

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

impl From<ReplayMode> for TerminalReplayMode {
    fn from(value: ReplayMode) -> Self {
        match value {
            ReplayMode::Exact => TerminalReplayMode::Exact,
            ReplayMode::Tail => TerminalReplayMode::Tail,
            ReplayMode::Reanchor => TerminalReplayMode::Reanchor,
        }
    }
}

/// One live PTY session, for the Terminal settings panel.
///
/// Deliberately a different shape from `TerminalUsage` (`resources.rs`), which
/// answers "what is this costing" by joining the process table. This answers
/// "what is running, and can I still reach it" — the lifecycle question, which
/// is the one a reload made possible to get wrong.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: SessionId,
    /// The `term_key` it was opened under — how the UI names it.
    pub label: String,
    pub cwd: Option<String>,
    pub command: String,
    /// The root process's pid, or `None` when the platform didn't report one.
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    /// Whether a pane is currently receiving this session's output. `false` is
    /// ordinary — a closed pane, or work inherited from a reload and not yet
    /// reopened — but it is otherwise invisible, which is why it is here.
    pub attached: bool,
    /// Whether the root process still exists.
    pub alive: bool,
}

/// A session handed over from a previous page load.
#[derive(Debug, Clone, Serialize, Type)]
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

/// One live PTY, named the way `terminal_sessions` names a session: the surface
/// it hosts and the provider running in it.
///
/// The pair is the identity, and it is a pair on purpose. `term_key` alone is
/// what the durable row is keyed by *together with* `agent_kind` — one surface
/// holds one conversation per provider — so a single string could only carry
/// both by decorating one with the other, which is exactly the bug this replaced:
/// a triage PTY opened under `AK-1::codex` matched no `term_key` on the way back,
/// and a live agent was reported as exited.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LiveTerminal {
    /// The `term_key` the pane's PTY was opened under.
    pub term_key: String,
    /// The provider santree launched in it, or `None` for a plain shell.
    pub agent_kind: Option<AgentKind>,
}

/// The `(term_key, agent_kind)` pairs that have a live PTY right now.
///
/// This is santree's whole answer to "which agents are actually running", and it
/// is a *live read*, not a record: the manager holds the real processes, and
/// `alive` is a non-blocking `try_wait` on each one. There is no daemon, so a PTY
/// cannot outlive the app — which is what makes an empty set after a restart the
/// correct answer rather than a missing one.
///
/// A session's `label` **is** its `term_key` and its `agent_kind` **is** the
/// provider column (see [`TerminalOpenOpts`] and `TauriBackend.ts`, which keys
/// adopted sessions by the same pair), so this needs no translation. Consumed by
/// `hooks::session_states`.
pub fn live_terminals(manager: &PtyManager) -> HashSet<LiveTerminal> {
    manager
        .sessions()
        .into_iter()
        .filter(|s| s.alive)
        .map(|s| LiveTerminal {
            term_key: s.label,
            agent_kind: s.agent_kind,
        })
        .collect()
}

/// Each live PTY session's address paired with its root pid — the pane roots a
/// process-table scan walks down from (`agent_procs::detect`).
///
/// Sibling of [`live_terminals`]: the same live read of the manager, asked a
/// different question. A session the platform reported no pid for is omitted
/// rather than guessed at, which is the same rule the resource accounting uses.
pub fn pane_roots(manager: &PtyManager) -> Vec<(LiveTerminal, u32)> {
    manager
        .sessions()
        .into_iter()
        .filter(|s| s.alive)
        .filter_map(|s| {
            let pid = s.pid?;
            Some((
                LiveTerminal {
                    term_key: s.label,
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
    forward: impl Fn(Vec<u8>) + Send + 'static,
) -> impl Fn(Vec<u8>) + Send + 'static {
    move |bytes| {
        let exited = bytes.is_empty();
        forward(bytes);
        if !exited {
            return;
        }
        let (db, label, cwd) = (db.clone(), label.clone(), cwd.clone());
        tauri::async_runtime::spawn(async move {
            match crate::hooks::retire_terminal(&db, &label, agent_kind, cwd.as_deref()).await {
                Ok(n) if n > 0 => log::info!("pty for {label} exited; retired {n} session row(s)"),
                Ok(_) => {}
                Err(e) => log::warn!("retiring session rows for {label}: {e}"),
            }
        });
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

/// The single place bytes enter a PTY.
///
/// Both [`terminal_write`] (keystrokes) and [`terminal_seed`] (the one
/// human-initiated launch line) go through here, so COMPLIANCE.md's "only
/// `terminal.rs` writes into a PTY" stays checkable as one call site rather than
/// a growing list of them.
fn write_pty(manager: &PtyManager, id: SessionId, bytes: &[u8]) -> anyhow::Result<()> {
    manager.write(id, bytes)
}

// These are `async` so Tauri runs them on the async runtime rather than the main
// (UI) thread: opening a PTY does a fork+exec with a full env copy, and a write
// can block if a stuck child's PTY buffer is full — neither should ever stall the
// UI. The PtyManager's per-session locking keeps sessions isolated from each other.

/// Spawn a process behind a PTY and stream its raw output over `on_output`.
///
/// The spawn itself is `openpty` + a fork/exec with a full env copy + a reader
/// thread — all blocking, and slow enough (an interactive `claude` on a cold
/// cache) to stall a tokio worker, so it goes to the blocking pool like
/// [`terminal_write`]. Nothing about *what* is spawned or how its bytes stream
/// changes: `PtyManager::open` runs exactly once, with the same opts and the
/// same verbatim byte-forwarding sink (COMPLIANCE.md).
#[tauri::command]
#[specta::specta]
pub async fn terminal_open(
    opts: TerminalOpenOpts,
    on_output: Channel<RawBytes>,
    manager: State<'_, PtyManager>,
    db: State<'_, Db>,
) -> CmdResult<SessionId> {
    // The user's configured project env for the repo this cwd belongs to (app +
    // per-repo). Applies to every santree-spawned terminal — the one chokepoint.
    let env = crate::env::resolve_env(&db, opts.cwd.as_deref()).await;
    let opts = OpenOpts {
        cwd: opts.cwd,
        command: opts.command,
        args: opts.args,
        cols: opts.cols,
        rows: opts.rows,
        env,
        owner: opts.owner,
        label: opts.label,
        agent_kind: opts.agent_kind,
    };
    let manager = manager.inner().clone();
    let sink = retiring_sink(
        db.inner().clone(),
        opts.label.clone(),
        opts.agent_kind,
        opts.cwd.clone(),
        move |bytes| {
            // A failed send means the channel was dropped (view unmounted); the
            // session will be closed separately, so just stop forwarding.
            let _ = on_output.send(RawBytes(bytes));
        },
    );
    Ok(tokio::task::spawn_blocking(move || manager.open(opts, sink)).await??)
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
    data: String,
    manager: State<'_, PtyManager>,
) -> CmdResult<()> {
    let manager = manager.inner().clone();
    Ok(tokio::task::spawn_blocking(move || write_pty(&manager, id, data.as_bytes())).await??)
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
/// integer looked up in the manager, exactly as [`terminal_write`] looks it up,
/// and `seed` becomes bytes in a PTY that the caller could already have written
/// one keystroke at a time. It never reaches a path — the spill file's name is a
/// UUID this process mints — and it is shell-quoted by the builder that composed
/// it (`agentProvider.ts`), which this must preserve rather than redo.
#[tauri::command]
#[specta::specta]
pub async fn terminal_seed(
    app: AppHandle,
    id: SessionId,
    seed: String,
    manager: State<'_, PtyManager>,
) -> CmdResult<()> {
    let dir = seed_dir(&app);
    let manager = manager.inner().clone();
    Ok(tokio::task::spawn_blocking(move || {
        // Resolve the session BEFORE spilling, so a file is only ever the
        // consequence of a real launch. `write_pty` would reject an unknown id
        // anyway, but only after the script had been written — and a caller
        // looping on an id that does not exist would leave one file per call
        // for the whole TTL. Ordinary TOCTOU applies (the session can close in
        // between) and is harmless: the write then fails exactly as before.
        if !manager.sessions().iter().any(|s| s.id == id) {
            anyhow::bail!("no terminal session {id}");
        }
        let line = seed_line(dir.as_deref(), &seed);
        write_pty(&manager, id, format!("{line}\r").as_bytes())
    })
    .await??)
}

/// Resize a session's PTY to the visible grid.
#[tauri::command]
#[specta::specta]
pub async fn terminal_resize(
    id: SessionId,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> CmdResult<()> {
    Ok(manager.resize(id, cols, rows)?)
}

/// Kill a session's child and free it.
#[tauri::command]
#[specta::specta]
pub async fn terminal_close(id: SessionId, manager: State<'_, PtyManager>) -> CmdResult<()> {
    Ok(manager.close(id)?)
}

/// Point a live session's output at this page's channel, and catch it up.
///
/// This is what makes a session survive losing its view. The previous sink — an
/// unmounted pane's channel, or a whole page that reloaded — is replaced, and
/// the bytes the client is missing are written to `on_output` **before** this
/// returns, so they arrive ahead of any live output on the same channel.
///
/// `anchor` is what the client claims to already have. When that claim can't be
/// verified against the session's ring (a different stream, or a gap older than
/// the ring keeps) nothing is sent and the mode comes back `Reanchor`: the
/// client's own screen is better than anything this could synthesize, and the
/// caller repaints from the running program instead.
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
    manager: State<'_, PtyManager>,
    db: State<'_, Db>,
) -> CmdResult<TerminalAttached> {
    // Attaching *replaces* the sink, so the exit retirement has to be re-wrapped
    // here or a session loses it the first time its pane remounts — which is the
    // common case, not the rare one. The label comes from the manager rather than
    // the caller: it is the value this process stored at open, and an IPC-supplied
    // one could name another surface's terminal.
    let owner = manager
        .sessions()
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| (s.label, s.agent_kind, s.cwd));
    let forward = {
        let on_output = on_output.clone();
        move |bytes: Vec<u8>| {
            let _ = on_output.send(RawBytes(bytes));
        }
    };
    let replay = match owner {
        Some((label, agent_kind, cwd)) => manager.attach(
            id,
            &anchor.into(),
            retiring_sink(db.inner().clone(), label, agent_kind, cwd, forward),
        ),
        None => manager.attach(id, &anchor.into(), forward),
    }?;
    // Never send an empty chunk: empty is the exit sentinel, and an `Exact`
    // attach with no gap (or any `Reanchor`) legitimately has nothing to write.
    if !replay.bytes.is_empty() {
        let _ = on_output.send(RawBytes(replay.bytes));
    }
    Ok(TerminalAttached {
        epoch: replay.epoch,
        seq: replay.seq as f64,
        mode: replay.mode.into(),
    })
}

/// Stop delivering a session's output without ending it — what a pane does when
/// it unmounts. The process keeps running and keeps recording; only delivery
/// stops, and [`terminal_attach`] resumes it.
#[tauri::command]
#[specta::specta]
pub async fn terminal_detach(id: SessionId, manager: State<'_, PtyManager>) -> CmdResult<()> {
    manager.detach(id);
    Ok(())
}

/// Every live PTY session, for the Terminal settings panel.
///
/// Read-only and cheap: a snapshot under the manager lock plus one non-blocking
/// `try_wait` per session. It grants no authority the frontend doesn't have —
/// it can already close any id — and it reveals nothing about a session's
/// *contents*, only that it exists.
#[tauri::command]
#[specta::specta]
pub async fn terminal_sessions(manager: State<'_, PtyManager>) -> CmdResult<Vec<TerminalSession>> {
    Ok(manager
        .sessions()
        .into_iter()
        .map(|info| TerminalSession {
            id: info.id,
            label: info.label,
            cwd: info.cwd,
            command: info.command,
            pid: info.pid,
            cols: info.cols,
            rows: info.rows,
            attached: info.attached,
            alive: info.alive,
        })
        .collect())
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
    manager: State<'_, PtyManager>,
) -> CmdResult<Vec<AdoptedSession>> {
    let adopted: Vec<AdoptedSession> = manager
        .adopt_others(&owner)
        .into_iter()
        .map(|info| AdoptedSession {
            id: info.id,
            label: info.label,
            agent_kind: info.agent_kind,
            cwd: info.cwd,
            command: info.command,
        })
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
mod tests {
    use super::*;

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

        let roots = pane_roots(&manager);
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
}
