//! Claude Code hooks integration.
//!
//! santree captures live Claude session state by injecting hook config into its
//! own `claude` launches (`claude --settings '<JSON>'`), one hook per
//! session-state event, each running the shipped `santree-hook` binary. This
//! module builds that `--settings` JSON (with the resolved binary + db paths
//! baked in) and reads back the states the binary records into `session_state`.
//!
//! The same file is where the optional English tutor rides in — see
//! [`crate::english_tutor`] — because it's the one place every santree `claude`
//! launch already passes through.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use santree_core::domain::{
    AgentKind, AgentState, ClaudeAccountRateLimits, ClaudeRateLimitWindow, DialogKind, DialogMarks,
    LiveText, PendingPrompt, SessionState, SessionUsageLive,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use santree_core::conversation::claude::is_subagent_id;

use crate::db::Db;
use crate::record_file;
use crate::sessions::Liveness;

/// The session-state events we inject. The CLI (`santree-hook`) owns the
/// event→state mapping; this list only decides which events fire our binary.
///
/// The events that *set* a state — turn start (`UserPromptSubmit`), a prompt
/// appearing (`Notification`/`PermissionRequest`), and turn/session end
/// (`Stop`/`SessionEnd`) — plus the two **heartbeat** events that keep a long
/// turn from decaying to idle.
///
/// `PostToolUse`/`PostToolUseFailure` are the only thing that fires *during* a
/// turn. Without them the sole evidence a turn is still running is transcript
/// movement, so one slow tool call — a long build, a big file read, an extended
/// think — goes quiet past `IDLE_QUIET_MS` and the agent reads as "Idle" while
/// it is plainly working. That was a real, reported bug.
///
/// They were previously excluded for a good reason, which still stands and is
/// now handled rather than avoided: these hooks are fire-and-forget (`async`)
/// with no ordering guarantee, so a straggling tool event can land *after* a
/// permission write and clobber it, showing "running" while a prompt is up.
/// `crates/hook`'s `record` therefore treats them as heartbeats — they may
/// refresh "still working" and advance the clock, but they can never move a
/// session out of a blocked-on-user state. `PreToolUse` stays out: it fires
/// *before* the tool, so it is the one that genuinely races its own
/// `PermissionRequest`, and it tells us nothing `PostToolUse` doesn't.
///
/// `PermissionRequest` is a blocking decision channel, but we register it
/// `async: true` (below) so our hook can NEVER approve/deny — Claude still shows
/// its own prompt; we only observe it.
///
/// Three more, each a transition and each captured on CLI 2.1.312 before it was
/// added: `StopFailure` (a turn that ended on an API error fires no `Stop`, and
/// read as working for the whole quiet window), `Elicitation` (an MCP server's
/// form or URL is on screen — needs you at once, not at its Notification ~6 s
/// later) and `ElicitationResult` (the user answered it).
///
/// And `PostToolBatch`, which sets no state: it lists every call of a batch
/// once they have all finished, and is the one hook a rejection with feedback
/// fires, so it is how a permission dialog's own call reads finished
/// (`crates/hook` `finished_calls`).
///
/// Every name here is verified against the CLI's own embedded hook-event table
/// (`claude.exe`, the "### Hook Events" doc block), not guessed.
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Notification",
    "PermissionRequest",
    "Elicitation",
    "ElicitationResult",
    "Stop",
    "StopFailure",
    "SessionEnd",
];

/// The events a launch registers only while Settings → Experimental →
/// Conversation view is on, and never on Daedalus: `MessageDisplay`, the reply
/// line by line as Claude draws it. It fires once per line batch, so it costs a
/// hook run per batch for a view that may not be open; `async`, so it never
/// holds a batch back (a synchronous one could rewrite what Claude displays).
const LIVE_TEXT_EVENTS: &[&str] = &["MessageDisplay"];

/// The sqlite db path — recomputed from `app_data_dir` (the setup path isn't
/// retained), matching `lib.rs`'s `db::init(data_dir.join("santree.db"))`.
pub fn db_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("santree.db"))
}

/// Build the `--settings` JSON santree layers over the user's own settings for
/// its `claude` launches, write it to `<app_data_dir>/claude-hooks.json`, and
/// return that file's **path**. Three things go in it; the first two invoke the
/// bundled `santree-hook` binary (so both need it + the db path to resolve):
///  - the session-state **hooks** (one per event);
///  - a **`statusLine`** pointing at the binary's `statusline` mode — santree's
///    own context-fill bar, which *always* captures Claude's authoritative usage
///    into the db (so the app can render the inline bar for any session) and
///    overrides the user's/project's status line for these launches;
///  - the **English tutor** hook, only when that setting is on (`tutor`).
///
/// The status line is injected **unconditionally**: capture is decoupled from
/// display. Whether the app *shows* the inline usage bar is a pure runtime,
/// frontend decision (the `claude_status_line` setting) — so toggling it lights
/// up already-running tabs without relaunching.
///
/// The English tutor is the one part that isn't setting-independent: it changes
/// what the agent *says* every turn, so it can only be a launch-time decision.
/// Flipping it must therefore invalidate the caller's cached path, and only
/// affects sessions started afterwards.
///
/// `--settings` is a *key-level* override (the keys we set win over the user's
/// `settings.json`; keys we omit keep their file values), so setting `statusLine`
/// replaces the user's whole status-line config for these launches only.
///
/// Returns `None` when nothing resolves to inject (no hook binary/db) or when no
/// writable data dir resolves — the caller then launches without `--settings`.
///
/// We pass Claude a settings *file* (`--settings <path>`), not inline JSON: the
/// JSON is large, and inlining it into the interactive-shell seed command
/// overflowed the line and left the shell stuck at a `quote>` continuation.
/// The hooks + statusLine map that every santree `claude` launch layers over the
/// user's settings — shared by [`claude_settings`] and [`claude_settings_no_git`].
/// `None` when the hook binary/db don't resolve (a dev build before the hook is
/// compiled), in which case there's nothing to inject.
///
/// `extras` are the launch-time switches ([`LaunchExtras`]). They're passed in
/// rather than read here because they live in the db (the tutor's instruction is
/// an editable prompt with a db-backed override), and this builder is sync.
fn base_settings_map(app: &AppHandle, extras: &LaunchExtras) -> Option<Map<String, Value>> {
    let mut root = hook_settings(&local_prefix(app)?, extras.live_text);
    let tutor = extras.tutor.as_deref();

    // The English tutor rides along as a *second* `UserPromptSubmit` entry, next to
    // the state hook (Claude runs every entry for an event). Two things about it
    // are load-bearing and easy to get wrong:
    //  - it is **synchronous** — no `async: true`. An async hook is fire-and-forget
    //    and its stdout is discarded, so the instruction would never reach the model
    //    and the tutor would silently do nothing.
    //  - it grants `Edit` on the log, because the instruction ends by telling the
    //    agent to append the corrections there; without the grant every turn stops
    //    on a permission prompt.
    if let Some(instruction) = tutor {
        if let Some((prompt_file, log)) = tutor_files(app, instruction) {
            if let Some(entries) = root
                .get_mut("hooks")
                .and_then(|hooks| hooks.get_mut("UserPromptSubmit"))
                .and_then(Value::as_array_mut)
            {
                entries.push(json!({ "hooks": [{
                    "type": "command",
                    "command": format!("cat {}", sh_quote(&prompt_file)),
                    "timeout": 5,
                }]}));
            }
            root.insert(
                "permissions".into(),
                json!({ "allow": [format!("Edit({log})")] }),
            );
        }
    }
    Some(root)
}

/// How santree's hook commands start on this Mac: the bundled binary against the
/// app's db (`'<bin>' --db '<db>'`). `None` when either doesn't resolve.
///
/// Claude runs `command` through a shell, so both paths are shell-quoted:
/// app_data_dir always has a space ("Application Support") and a home directory
/// may contain `$`/backtick/quote characters too.
fn local_prefix(app: &AppHandle) -> Option<String> {
    let (bin, db) = (crate::hook_bin::resolve(app)?, db_path(app)?);
    Some(format!(
        "{} --db {}",
        sh_quote(bin.to_str()?),
        sh_quote(db.to_str()?)
    ))
}

/// How santree's hook commands start on Daedalus: the session host's own hook
/// subcommand (`'<hookBin>' hook`, `hookBin` from `hello`), which queues the
/// event for the app to relay. What follows the prefix is the same either way —
/// the relayed event is exactly the words after `--db <db>` locally
/// (docs/remote.md, the hooks relay).
pub(crate) fn box_prefix(hook_bin: &str) -> String {
    format!("{} hook", sh_quote(hook_bin))
}

/// What a launch's `--settings` file depends on besides the hook binary: the
/// switches read when it is built. Each changes what the session runs, so it is
/// a launch-time decision: flipping one takes a fresh file (the frontend caches
/// the path until a switch moves) and applies to sessions started afterwards.
#[derive(Debug, Clone, Default)]
pub struct LaunchExtras {
    /// The English tutor's rendered instruction; `None` when the tutor is off.
    pub tutor: Option<String>,
    /// Settings → Experimental → Conversation view is on: register
    /// [`LIVE_TEXT_EVENTS`].
    pub live_text: bool,
}

/// The hooks + statusLine map every santree `claude` launch layers over the
/// user's settings, with each command starting `prefix` ([`local_prefix`] here,
/// [`box_prefix`] on Daedalus). `live_text` adds [`LIVE_TEXT_EVENTS`]; a box's
/// launch never asks for them.
pub(crate) fn hook_settings(prefix: &str, live_text: bool) -> Map<String, Value> {
    let live: &[&str] = if live_text { LIVE_TEXT_EVENTS } else { &[] };
    let mut hooks = Map::new();
    for &event in EVENTS.iter().chain(live) {
        // SessionEnd runs synchronously (short timeout) so "exited" reliably lands
        // before session teardown; the rest are async so they never add latency to
        // a turn — and, crucially, so this hook can never gate a Claude decision.
        let is_end = event == "SessionEnd";
        let mut hook = Map::new();
        hook.insert("type".into(), json!("command"));
        hook.insert("command".into(), json!(format!("{prefix} {event}")));
        hook.insert("timeout".into(), json!(if is_end { 5 } else { 10 }));
        if !is_end {
            hook.insert("async".into(), json!(true));
        }
        hooks.insert(
            event.to_string(),
            json!([{ "hooks": [Value::Object(hook)] }]),
        );
    }

    let mut root = Map::new();
    root.insert("hooks".into(), Value::Object(hooks));
    // santree's own status line: the `statusline` mode of the same binary. Prints
    // a context-fill bar AND captures Claude's authoritative usage into the db.
    // Always injected — the app gates *display* of the inline bar at runtime, so
    // capture must run regardless of the setting (see [`claude_settings`]).
    root.insert(
        "statusLine".into(),
        json!({
            "type": "command",
            "command": statusline_command_for(prefix, None),
            "refreshInterval": STATUSLINE_REFRESH_SECS,
        }),
    );
    root
}

/// A hooks map plus the Fix-CI deny list — [`claude_settings_no_git`]'s rules,
/// for a launch that builds its settings elsewhere (Daedalus).
pub(crate) fn hook_settings_no_git(prefix: &str) -> Map<String, Value> {
    let mut root = hook_settings(prefix, false);
    merge_permissions(&mut root, &NO_GIT_RULES, &[]);
    root
}

/// How often Claude re-runs our status line on its own, in **seconds**.
///
/// Verified against the CLI's own zod schema rather than assumed: `statusLine`
/// accepts `refreshInterval`, a number with `.min(1)`, described as "Re-run the
/// status line command every N seconds in addition to event-driven updates".
///
/// This buys a **proof-of-life** for free. Every status-line render writes
/// `session_usage_live`, so a session that is up — even one sitting silently at
/// the prompt — stamps a row every 15s. [`session_states`] uses that as the
/// liveness evidence for rows it cannot join to a live terminal, which is the
/// only way those rows could otherwise be told apart from a session that died.
///
/// It is deliberately **not** evidence of *work*: the status line renders just as
/// happily while idle. Liveness and activity are two orthogonal facts, and
/// conflating them would pin every idle session at "active" forever.
///
/// The cost is one extra `santree-hook` execution per live session per interval —
/// a small Rust binary doing a single SQLite upsert. 15s matches the cadence Orca
/// uses for the same signal, and keeps the worst case (a dozen live sessions) at
/// well under one process per second.
const STATUSLINE_REFRESH_SECS: u32 = 15;

/// The `statusLine.command` that runs the hook's `statusline` mode: `<bin> --db
/// <db> statusline`, plus ` --then <command>` when the payload should be handed
/// on to the user's own status line afterwards (the global passthrough, see
/// [`crate::global_capture`]). `bin` and `db` arrive already shell-quoted; the
/// user's command is quoted here so it stays ONE argv element to the hook.
pub(crate) fn statusline_command(bin: &str, db: &str, then: Option<&str>) -> String {
    statusline_command_for(&format!("{bin} --db {db}"), then)
}

/// [`statusline_command`] after any command prefix (see [`hook_settings`]).
fn statusline_command_for(prefix: &str, then: Option<&str>) -> String {
    let mut command = format!("{prefix} statusline");
    if let Some(then) = then {
        command.push_str(" --then ");
        command.push_str(&sh_quote(then));
    }
    command
}

/// Quote a path for the shell Claude runs a hook/statusLine `command` through.
/// Single quotes, because double quotes still expand `$`, backticks and `\` — and
/// a home directory may legally contain any of them. `'` itself can't be escaped
/// inside single quotes, so it's closed, escaped, and reopened (`'\''`).
/// The Codex hook events santree registers, and nothing else.
///
/// Codex fires eleven; these six are the ones that carry something the registry
/// can render. Five are state transitions; `PostToolUse` is the mid-turn
/// **heartbeat**, exactly as it is for Claude — Codex has the same long-turn
/// decay problem, and had it worse, since nothing reconciled a rollout at all
/// (see `evidence`). Codex has no `PostToolUseFailure`.
///
/// The other five (`PreToolUse`, `SubagentStart`, `SubagentStop`, `PreCompact`,
/// `PostCompact`) would fire the hook binary for no state change, so they are
/// left unregistered rather than registered-and-ignored.
///
/// **`SessionStart` is not a launch event for Codex.** Claude fires it while the
/// TUI is coming up; Codex fires it when the *first turn is submitted*, because
/// that is when it creates the thread the id belongs to. Measured on codex-cli
/// 0.151.0 in a real pty with these exact flags: idle for 95s after boot → only
/// `SessionEnd` ever fires (at quit); the same launch with one prompt typed →
/// `SessionStart` lands the instant it is submitted, then `UserPromptSubmit`,
/// `Stop`, `SessionEnd`. Since `SessionStart` is what binds the session to its
/// terminal (`reconcile_terminal_session`), a Codex tab that has been opened but
/// not yet prompted is invisible to every hook-fed surface — which is why the
/// registry does not wait for one; see `registry.ts`'s launched-but-unannounced
/// entries.
const CODEX_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
];

/// Escape a string for a TOML basic (double-quoted) string.
///
/// The hook command is TOML nested inside a shell word, so both layers have to
/// hold. A home directory containing a quote or a backslash is unusual but not
/// invalid, and getting this wrong would not fail loudly — Codex would parse a
/// truncated command and silently run the wrong thing, or nothing.
fn toml_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `-c 'hooks.<Event>=[…]'` flags every santree `codex` launch carries, or
/// `None` when the hook binary/db don't resolve (a dev build before the hook is
/// compiled), in which case the caller launches without them.
///
/// **Per launch, never the user's global `~/.codex/hooks.json`.** Codex accepts
/// hooks as config overrides on the command line, which registers them for that
/// invocation only — the exact analogue of Claude's `--settings` file. Orca and
/// superset both write the shared global file instead and pay for it: it is a
/// file other tools rewrite, and reindexing it invalidates the per-hook trust
/// hashes. We touch nothing the user owns.
///
/// The caller must pair these with `--dangerously-bypass-hook-trust`. Codex
/// gates each hook behind a trust hash and **silently skips an untrusted one** —
/// no error, no warning — and a `-c`-injected hook is untrusted by construction.
/// The bypass and the injection are meaningless apart: injecting without it
/// registers hooks that never fire, and passing it with nothing to inject widens
/// trust for no reason. See `agentProvider.ts`, which emits them together.
///
/// Measured against codex-cli 0.150.1 in an isolated `CODEX_HOME`, and the
/// reason the blunt flag is still here: an injected hook is listed as
/// `source: "sessionFlags"` under the synthetic key
/// `/<session-flags>/config.toml:<event_snake>:<group>:<hook>`, and trusting
/// exactly that one — `-c 'hooks.state={"<key>"={trusted_hash="sha256:…"}}'`,
/// an inline table; the dotted form is not parsed — makes it fire with no
/// bypass and *merges* with the user's own trust table rather than replacing
/// it. What's missing is the hash: it covers the hook definition (command,
/// async, matcher, event all change it) in a serialization we can't reproduce
/// from outside, and a wrong one reads as "modified", which is the same silent
/// no-fire. Reading it back needs `codex app-server`'s `hooks/list`. Until
/// there's a documented way to compute it, the bypass is what makes the
/// injection work at all.
pub fn codex_hook_flags(app: &AppHandle) -> Option<String> {
    Some(codex_flags_for(&local_prefix(app)?))
}

/// Every Codex hook flag, each command starting `prefix` (see [`hook_settings`]).
pub(crate) fn codex_flags_for(prefix: &str) -> String {
    CODEX_EVENTS
        .iter()
        .map(|event| codex_hook_flag(prefix, event))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The single `-c 'hooks.<Event>=[…]'` flag for one event, after a command
/// prefix whose paths are already shell-quoted ([`local_prefix`] /
/// [`box_prefix`]). Split out from [`codex_hook_flags`] so the three quoting
/// layers can be exercised end to end without an `AppHandle`.
///
/// Three layers, all of which have to hold at once, innermost first:
///  1. the hook `command` is a shell command line, so `bin` and `db` are
///     shell-quoted **individually** — the app data dir always contains a space
///     ("Application Support"), and an unquoted `--db` would bind to its first
///     word, leaving the hook writing to a db that doesn't exist (it exits 0, so
///     Codex reports the hook as completed and santree records nothing);
///  2. that command sits in a TOML basic string ([`toml_quote`], which also
///     escapes the `'` … `'\''` … `'` that step 1 introduces — a `\` there);
///  3. the whole `hooks.<Event>=…` assignment is one shell word of the seed
///     command line ([`sh_quote`]).
fn codex_hook_flag(prefix: &str, event: &str) -> String {
    // The event is the positional arg, exactly as Claude's is: the injected
    // command is what santree decided this hook means, so it must not depend on
    // the payload agreeing.
    let command = format!("{prefix} --agent-kind Codex {event}");
    let entry = format!(
        "hooks.{event}=[{{hooks=[{{type=\"command\",command={}}}]}}]",
        toml_quote(&command)
    );
    format!("-c {}", sh_quote(&entry))
}

pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Spill the English-tutor instruction to `<app_data_dir>/english-tutor.md` and
/// return `(that path, the practice-log path)`, both already shell-quoted for the
/// hook `command` / ready for the permission rule respectively. `None` when either
/// path can't be resolved or the write fails — the caller then simply omits the
/// tutor, leaving the rest of the settings intact.
///
/// A file, not inline text, for the same reason the settings themselves are one:
/// the instruction is ~1.5 KB of prose with quotes and newlines in it, and that
/// does not survive a trip through a shell `command` string.
fn tutor_files(app: &AppHandle, instruction: &str) -> Option<(String, String)> {
    let out = app.path().app_data_dir().ok()?.join("english-tutor.md");
    std::fs::write(&out, instruction)
        .inspect_err(|e| log::warn!("english tutor: writing {}: {e}", out.display()))
        .ok()?;
    let log = crate::english_tutor::log_path()?;
    Some((out.to_str()?.to_string(), log.to_str()?.to_string()))
}

/// Write a settings map to `<app_data_dir>/<file>` and return its path.
fn write_settings(app: &AppHandle, file: &str, root: Map<String, Value>) -> Option<String> {
    let json = serde_json::to_string_pretty(&Value::Object(root)).ok()?;
    let out = app.path().app_data_dir().ok()?.join(file);
    std::fs::write(&out, json).ok()?;
    Some(out.to_str()?.to_string())
}

pub fn claude_settings(app: &AppHandle, extras: &LaunchExtras) -> Option<String> {
    write_settings(app, "claude-hooks.json", base_settings_map(app, extras)?)
}

/// Like [`claude_settings`] but with a `permissions.deny` block that forbids git
/// commit/push — the `--settings` file for the "Fix CI" session, whose whole point
/// is to fix and validate but leave committing/pushing to the user (via Trees).
/// Written to a distinct file so it never affects normal work sessions.
///
/// This is **best-effort defence-in-depth, not a security boundary.** Claude Code
/// matches these rules against the command *text*, so they stop the shapes a model
/// plausibly reaches for, not a determined bypass: `git` invoked under another name
/// (a shell alias, a wrapper script), or a commit driven through some other tool
/// (`gh`, a Python `subprocess`), sails straight past them. Anthropic's own docs say
/// as much — "Bash permission patterns that try to constrain command arguments are
/// fragile". The CI-fix prompt reinforces the intent in prose; neither is a hard gate.
///
/// The rules are deliberately wider than the obvious `git commit` prefix. Verified
/// against the real CLI (2.1.207) in `--permission-mode default`: the engine already
/// canonicalizes the `command` wrapper and splits compound commands, so `command git
/// commit` and `x && git commit` are caught by the prefix forms alone — but an
/// absolute path (`/usr/bin/git commit`) and an option between verb and subcommand
/// (`git -C <path> commit`, `git -c k=v commit`) both slipped through. The leading
/// `*` closes the first; the `*git * commit*` form closes the second. `*` matches the
/// empty string, so these subsume the plain prefix rules; those are kept anyway,
/// since their semantics are the ones the CLI's own `/permissions` UI writes.
pub fn claude_settings_no_git(app: &AppHandle, extras: &LaunchExtras) -> Option<String> {
    restricted_settings(app, NO_GIT_SETTINGS_FILE, &NO_GIT_RULES, &[], extras)
}

/// The two restricted profiles' file names. Named because which one a session gets
/// is the whole of H2: a review tab resumed from its persisted row used to land on
/// [`NO_GIT_SETTINGS_FILE`], whose deny list is a strict *subset* of the review
/// one's and which grants no MCP tools at all.
pub const NO_GIT_SETTINGS_FILE: &str = "claude-hooks-fixci.json";
pub const AI_REVIEW_SETTINGS_FILE: &str = "claude-hooks-ai-review.json";

/// The git-writing shapes both restricted variants block. Each verb appears in
/// three forms for the reasons documented on [`claude_settings_no_git`].
const NO_GIT_RULES: [&str; 8] = [
    "Bash(git commit)",
    "Bash(git commit:*)",
    "Bash(git push)",
    "Bash(git push:*)",
    // Any path/wrapper before `git` (`/usr/bin/git commit`, `sudo git push`).
    "Bash(*git commit*)",
    "Bash(*git push*)",
    // Options between `git` and the subcommand (`git -C <path> commit`).
    "Bash(*git * commit*)",
    "Bash(*git * push*)",
];

/// Everything [`claude_settings_no_git`] denies, plus every `gh` route that would
/// speak on the user's behalf. `gh api` is denied wholesale because it can reach
/// every mutation endpoint and the PR content is already in the prompt.
fn review_deny_rules() -> Vec<&'static str> {
    let gh: [&str; 16] = [
        "Bash(gh pr review:*)",
        "Bash(*gh pr review*)",
        "Bash(gh pr comment:*)",
        "Bash(*gh pr comment*)",
        "Bash(gh pr merge:*)",
        "Bash(*gh pr merge*)",
        "Bash(gh pr close:*)",
        "Bash(*gh pr close*)",
        "Bash(gh pr edit:*)",
        "Bash(*gh pr edit*)",
        "Bash(gh pr ready:*)",
        "Bash(*gh pr ready*)",
        "Bash(gh issue comment:*)",
        "Bash(*gh issue comment*)",
        "Bash(gh api:*)",
        "Bash(*gh api*)",
    ];
    NO_GIT_RULES.iter().copied().chain(gh).collect()
}

/// The name the `santree-review` MCP server registers under, and the stem of its
/// permission rule. Mirrored by `crates/hook`'s `mcp::SERVER_NAME` — Claude matches
/// the two by string, so they have to agree.
pub const MCP_SERVER_NAME: &str = "santree-review";

/// The `--settings` file for an **AI review** session: the no-git/no-GitHub-write
/// deny list plus a grant for santree's own review tools.
///
/// The deny list is what keeps the session from reviewing on the user's behalf; the
/// grant is what lets it record findings *somewhere the user controls* instead. The
/// two are the same idea from both ends: everything the agent produces lands in
/// santree's database as a draft, and only a person can send it to GitHub.
///
/// The grant covers the whole server (`mcp__santree-review`), so adding a tool
/// later doesn't strand a review mid-flow on a permission prompt. It reaches only
/// the server santree launched, and that server can write nothing but this PR's
/// drafts and brief.
pub fn claude_settings_ai_review(app: &AppHandle, extras: &LaunchExtras) -> Option<String> {
    let allow = format!("mcp__{MCP_SERVER_NAME}");
    restricted_settings(
        app,
        AI_REVIEW_SETTINGS_FILE,
        &review_deny_rules(),
        &[&allow],
        extras,
    )
}

/// The base settings plus `permissions` rules, written to its own file so one
/// restricted variant can never affect another launch.
///
/// Both lists are *merged* into whatever `permissions` the base already set (the
/// English tutor's `Edit` allow), never written over it — replacing the object
/// would silently drop the tutor's grant and stop every turn on a permission
/// prompt. `allow` in particular is appended, since the base may already hold one.
fn restricted_settings(
    app: &AppHandle,
    file: &str,
    deny: &[&str],
    allow: &[&str],
    extras: &LaunchExtras,
) -> Option<String> {
    let mut root = base_settings_map(app, extras)?;
    merge_permissions(&mut root, deny, allow)?;
    write_settings(app, file, root)
}

/// Fold `deny`/`allow` into a settings map's `permissions` object. Split out from
/// [`restricted_settings`] so the merge — the part with a real failure mode — is
/// testable without an `AppHandle`.
/// `deny` replaces (the base never sets one, and a restricted variant owns its
/// whole deny list); `allow` appends, because the base may already hold the
/// English tutor's grant.
fn merge_permissions(root: &mut Map<String, Value>, deny: &[&str], allow: &[&str]) -> Option<()> {
    let perms = root
        .entry("permissions")
        .or_insert_with(|| json!({}))
        .as_object_mut()?;
    if !deny.is_empty() {
        perms.insert("deny".into(), json!(deny));
    }
    if !allow.is_empty() {
        let mut merged: Vec<Value> = perms
            .get("allow")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        merged.extend(allow.iter().map(|r| json!(r)));
        perms.insert("allow".into(), Value::Array(merged));
    }
    Some(())
}

// ── The AI review's MCP server ───────────────────────────────────────────────

/// Write the `--mcp-config` file that registers santree's review tools for one
/// pull request, and return its path.
///
/// The whole scope lives in argv, written here: the server can only touch the PR
/// named on its own command line, so nothing the model says can retarget it.
///
/// `Err`, not `None`, when the hook binary can't be found. The other settings
/// builders degrade quietly because their contents are a nicety (a status bar, a
/// state badge); here the tools *are* the feature, and a session that launches
/// without them looks like it's working right up until it has nowhere to put what
/// it found.
pub fn mcp_config_ai_review(
    app: &AppHandle,
    owner: &str,
    name: &str,
    number: u32,
    head_sha: &str,
    diff_index: &Path,
) -> Result<String> {
    let bin = crate::hook_bin::resolve(app).ok_or_else(|| {
        anyhow::anyhow!(
            "santree's helper binary is missing, so the review tools can't start. \
             In a dev build, run `pnpm bundle:hook`."
        )
    })?;
    let db =
        db_path(app).ok_or_else(|| anyhow::anyhow!("santree's database path won't resolve"))?;
    let out = mcp_config_path(app, owner, name, number)?;

    let config = mcp_config_json(&bin, &db, owner, name, number, head_sha, diff_index)?;
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&config)?)?;
    out.to_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("the mcp config path isn't valid UTF-8"))
}

/// Where one PR's review config lives — the same answer every time, which is what
/// lets a review tab find the config it launched with instead of carrying the path
/// around. [`mcp_config_ai_review`] writes it; the resume path only reads it.
pub fn mcp_config_path(app: &AppHandle, owner: &str, name: &str, number: u32) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("no writable data directory: {e}"))?
        .join("mcp")
        .join(mcp_stem(owner, name, number)?))
}

/// Collision-free filename for one canonical `<owner>/<name>#<number>` identity.
/// A delimiter-joined name is unsafe here: valid repos `a-b/c` and `a/b-c` would
/// otherwise share a file and therefore share review-tool authority.
pub fn mcp_stem(owner: &str, name: &str, number: u32) -> Result<String> {
    if owner.is_empty()
        || name.is_empty()
        || owner.contains(['/', '\\'])
        || name.contains(['/', '\\'])
        || owner.starts_with('.')
        || name.starts_with('.')
    {
        return Err(anyhow::anyhow!(
            "refusing to derive a review file for '{owner}/{name}#{number}'"
        ));
    }
    let digest = Sha256::digest(format!("{owner}/{name}#{number}").as_bytes());
    Ok(format!("review-{digest:x}.mcp.json"))
}

/// The config Claude reads. Pure, so the shape can be tested without a running app.
///
/// No shell quoting: Claude spawns an stdio server with `spawn(command, args)` and
/// no shell, so a path with spaces in it (every macOS app data dir has one) is
/// passed through intact. It *does* expand `${VAR}` in these strings, though, and
/// this is the file that fixes the server's scope — a `${` anywhere in it could
/// silently repoint the server at another PR or another binary. So every value is
/// checked, not only the paths.
fn mcp_config_json(
    bin: &Path,
    db: &Path,
    owner: &str,
    name: &str,
    number: u32,
    head_sha: &str,
    diff_index: &Path,
) -> Result<Value> {
    let literal = |s: &str| -> Result<String> {
        if s.contains("${") {
            return Err(anyhow::anyhow!(
                "'{s}' contains '${{', which Claude would expand as a variable"
            ));
        }
        Ok(s.to_string())
    };
    let path_of = |p: &Path| -> Result<String> {
        literal(
            p.to_str()
                .ok_or_else(|| anyhow::anyhow!("a path isn't valid UTF-8: {}", p.display()))?,
        )
    };
    Ok(json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "type": "stdio",
                "command": path_of(bin)?,
                "args": [
                    "--db", path_of(db)?,
                    "mcp",
                    "--pr", literal(&format!("{owner}/{name}"))?,
                    "--number", number.to_string(),
                    "--head", literal(head_sha)?,
                    "--diff", path_of(diff_index)?,
                ],
            }
        }
    }))
}

/// Cap on the session rows a single read hands back. Ordered newest-first, so
/// this keeps the freshest N — orders of magnitude more than the handful of
/// sessions a user has open, while keeping the query (and the reconcile pass in
/// [`session_states`]) bounded no matter how the table grows.
const MAX_SESSION_ROWS: i64 = 200;

/// A session whose hooks *and* status line have both been silent this long is
/// dead: a live one rewrites its row on every turn and every status-line render.
const STALE_SESSION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

/// How often [`prune_stale_sessions`] actually touches the db. It rides the
/// frontend's ~10s session poll (no separate scheduler), so it's rate-limited —
/// a delete-nothing write every 10s would churn the WAL for no reason.
const PRUNE_INTERVAL_MS: i64 = 60 * 60 * 1_000;

/// When the prune last ran (epoch-ms). Starts at 0, so the first poll after
/// launch prunes.
static LAST_PRUNE_MS: AtomicI64 = AtomicI64::new(0);

/// Drop `session_state` / `session_usage_live` rows for sessions gone quiet for
/// [`STALE_SESSION_MS`] — ad-hoc terminal and base-worktree sessions are never
/// otherwise cleaned up, so the tables only ever grow. A running session can't be
/// caught: any hook event or status-line render bumps its `updated_at_ms`.
async fn prune_stale_sessions(db: &Db, now_ms: i64) -> Result<()> {
    let last = LAST_PRUNE_MS.load(Ordering::Relaxed);
    if now_ms - last < PRUNE_INTERVAL_MS
        || LAST_PRUNE_MS
            .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return Ok(()); // too soon, or a concurrent poll claimed this round
    }
    let cutoff = now_ms - STALE_SESSION_MS;
    for table in ["session_state", "session_usage_live"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE updated_at_ms < ?"))
            .bind(cutoff)
            .execute(db)
            .await?;
    }
    // A turn's live text goes when the turn ends; this only catches a session
    // whose end no hook reported.
    sqlx::query("DELETE FROM session_live_text WHERE fired_ms < ?")
        .bind(cutoff)
        .execute(db)
        .await?;
    Ok(())
}

/// Every session's live usage row (from the status-line capture), newest first.
pub async fn session_usage_live(db: &Db) -> Result<Vec<SessionUsageLive>> {
    let rows = sqlx::query_as::<_, UsageRow>(
        "SELECT session_id, used_pct, input_tokens, context_size, model, cost_usd, updated_at_ms, \
                output_style, vim_mode \
         FROM session_usage_live ORDER BY updated_at_ms DESC LIMIT ?",
    )
    .bind(MAX_SESSION_ROWS)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| SessionUsageLive {
            agent_kind: santree_core::domain::AgentKind::Claude,
            session_id: row.session_id,
            used_pct: row.used_pct,
            input_tokens: row.input_tokens as f64,
            context_size: row.context_size as f64,
            model: row.model,
            cost_usd: row.cost_usd,
            updated_at_ms: row.updated_at_ms as f64,
            output_style: row.output_style,
            vim_mode: row.vim_mode,
        })
        .collect())
}

/// A `session_usage_live` row as stored.
#[derive(sqlx::FromRow)]
struct UsageRow {
    session_id: String,
    used_pct: f64,
    input_tokens: i64,
    context_size: i64,
    model: String,
    cost_usd: f64,
    updated_at_ms: i64,
    output_style: Option<String>,
    vim_mode: Option<String>,
}

/// The reply `session_id` is drawing right now, from its `MessageDisplay`
/// batches ([`LiveText`]): the newest message's — by when its batch fired, and
/// for two that fired in the same millisecond, the one stored last. `None` when
/// nothing is streaming, the session's
/// launch didn't register the event (Settings → Experimental → Conversation
/// view was off), or the message's first batch hasn't landed yet. The id is
/// the caller's to have validated.
pub async fn session_live_text(db: &Db, session_id: &str) -> Result<Option<LiveText>> {
    let rows = sqlx::query_as::<_, LiveRow>(
        "SELECT message_id, idx, turn_id, prompt_id, delta, final, cut, fired_ms \
         FROM session_live_text \
         WHERE session_id = ?1 AND message_id = ( \
           SELECT message_id FROM session_live_text WHERE session_id = ?1 \
           ORDER BY fired_ms DESC, rowid DESC LIMIT 1) \
         ORDER BY idx",
    )
    .bind(session_id)
    .fetch_all(db)
    .await?;
    Ok(live_text_of(session_id, &rows))
}

/// One stored `MessageDisplay` batch.
#[derive(Debug, Clone, sqlx::FromRow)]
struct LiveRow {
    message_id: String,
    idx: i64,
    turn_id: Option<String>,
    prompt_id: Option<String>,
    delta: String,
    #[sqlx(rename = "final")]
    is_final: bool,
    cut: bool,
    fired_ms: i64,
}

/// One message's batches, in `idx` order, joined into its text so far: from
/// its first batch up to the first one still in flight (the hooks are async,
/// so a later batch can land first). A first batch that isn't the message's
/// start is one only when the cap dropped what came before it (`cut`);
/// otherwise the start is in flight, and there is nothing to show yet.
fn live_text_of(session_id: &str, rows: &[LiveRow]) -> Option<LiveText> {
    let first = rows.first()?;
    if first.idx > 0 && !first.cut {
        return None;
    }
    let mut text = String::new();
    let mut last = first;
    let mut updated_at_ms = first.fired_ms;
    for (row, expected) in rows.iter().zip(first.idx..) {
        if row.idx != expected {
            break;
        }
        text.push_str(&row.delta);
        updated_at_ms = updated_at_ms.max(row.fired_ms);
        last = row;
    }
    Some(LiveText {
        session_id: session_id.to_string(),
        prompt_id: last.prompt_id.clone(),
        turn_id: last.turn_id.clone(),
        message_id: first.message_id.clone(),
        text,
        index: last.idx as f64,
        complete: last.is_final,
        truncated: first.cut,
        started_at_ms: first.fired_ms as f64,
        updated_at_ms: updated_at_ms as f64,
    })
}

/// Every Claude account's rate-limit windows: the Default account first, then
/// each account on disk in id order — an account with nothing recorded yet is
/// still listed, with no windows, so a meter row doesn't appear and vanish.
/// Rows left by a removed account are not shown.
pub async fn claude_rate_limits(db: &Db) -> Result<Vec<ClaudeAccountRateLimits>> {
    let mut out = vec![ClaudeAccountRateLimits {
        account: None,
        windows: claude_rate_limits_of(db, None).await?,
    }];
    for (id, _, _) in crate::accounts::on_disk(AgentKind::Claude) {
        let windows = claude_rate_limits_of(db, Some(&id)).await?;
        out.push(ClaudeAccountRateLimits {
            account: Some(id),
            windows,
        });
    }
    Ok(out)
}

/// One account's rate-limit windows as the status line last reported them — or
/// as the usage endpoint did (`claude_usage.rs` writes the same rows). The
/// Default account's are `claude_rate_limits`, a named account's
/// `claude_account_rate_limits`, one row per window, written by the hook's
/// statusline mode. Empty until a santree-launched subscriber session has
/// rendered a status line after its first API response — API-key sessions
/// never report any.
pub async fn claude_rate_limits_of(
    db: &Db,
    account: Option<&str>,
) -> Result<Vec<ClaudeRateLimitWindow>> {
    let rows = match account {
        None => {
            sqlx::query_as::<_, (String, f64, Option<i64>, i64)>(
                "SELECT window, used_pct, resets_at_ms, updated_at_ms \
                 FROM claude_rate_limits ORDER BY window",
            )
            .fetch_all(db)
            .await?
        }
        Some(account) => {
            sqlx::query_as::<_, (String, f64, Option<i64>, i64)>(
                "SELECT window, used_pct, resets_at_ms, updated_at_ms \
                 FROM claude_account_rate_limits WHERE account = ? ORDER BY window",
            )
            .bind(account)
            .fetch_all(db)
            .await?
        }
    };
    Ok(rows
        .into_iter()
        .map(
            |(window, used_pct, resets_at_ms, updated_at_ms)| ClaudeRateLimitWindow {
                window,
                used_pct,
                resets_at_ms: resets_at_ms.map(|ms| ms as f64),
                updated_at_ms: updated_at_ms as f64,
            },
        )
        .collect())
}

/// All current session states, most-recently-updated first.
///
/// Two corrections are applied on read, and they answer two orthogonal questions
/// — *is this session still alive* and *what is it doing*. Conflating them is how
/// both of this module's historical bugs happened.
///
/// **Alive** is a join, never a stored record. `terminals.live` is the set of
/// `(term_key, agent_kind)` pairs that have a live PTY *right now* — the same
/// pair `terminal_sessions` is keyed by — as the terminal facade reports them
/// (`sessions::Terminals::liveness`). A row whose terminal is not in that set
/// cannot be running, whatever it last stored — so a dead agent is
/// unrepresentable as a live-looking state, no matter how its terminal died (a
/// kill -9, a crash, the app quitting). The seed is `exec <cli>`, so the PTY *is*
/// the agent process. That is why this needs no sweeper, no decay timer and no
/// background poll, and why a straggling hook write cannot defeat it: the join
/// is re-evaluated from live state on every read, so there is nothing for a late
/// write to win against.
///
/// "Absent" only means "dead" when the answer is `complete`. A PTY can outlive
/// the app now (the local santree server holds them, docs/server.md), so a
/// server santree can't reach right now may be holding agents that run fine: an
/// incomplete answer is "unknown", and every row keeps the state it had rather
/// than being declared exited. In-app terminals and Daedalus's are always
/// complete, so with no server this is the join it always was.
///
/// **Doing** is reconciled against the transcript (see [`reconcile_live_state`]):
/// the "needs-you" states are set by a hook, but the user *resolving* the prompt
/// in the terminal (accept / reject a permission, or type a reply) fires no hook,
/// so a stored row can be stale.
pub async fn session_states(db: &Db, terminals: Liveness) -> Result<Vec<SessionState>> {
    let now_ms = now_ms();
    if let Err(e) = prune_stale_sessions(db, now_ms).await {
        log::warn!("pruning stale session rows failed: {e}");
    }

    // LEFT JOIN, not INNER: only terminals that auto-launch an agent get a
    // `terminal_sessions` row, so an unregistered session must still show up (as
    // an un-attributed agent) rather than vanish from the panel.
    //
    // `session_usage_live` rides along for its timestamp only: the status line
    // re-renders every `STATUSLINE_REFRESH_SECS`, so that column is a per-session
    // proof-of-life for the rows the terminal join can't reach.
    let rows = sqlx::query_as::<_, StateRow>(
        "SELECT s.session_id, s.state, s.event, s.cwd, s.message, s.transcript_path, \
                s.updated_at_ms, s.asker, s.permission_mode, s.effort_level, \
                s.pending_kind, s.pending_tool, s.pending_input, s.pending_suggestions, \
                s.pending_mcp_server, s.pending_agent_id, s.pending_agent_type, s.pending_mode, \
                s.pending_prompt_id, s.pending_truncated, s.pending_at_ms, s.pending_stacked, \
                s.pending_rendered_at_ms, s.pending_resolved_at_ms, t.repo, t.term_key, \
                t.agent_kind, \
                t.cwd AS launch_cwd, u.updated_at_ms AS heartbeat_ms \
         FROM session_state s \
         LEFT JOIN terminal_sessions t ON t.session_id = s.session_id \
         LEFT JOIN session_usage_live u ON u.session_id = s.session_id \
         ORDER BY s.updated_at_ms DESC LIMIT ?",
    )
    .bind(MAX_SESSION_ROWS)
    .fetch_all(db)
    .await?;

    // Reconciling is real blocking fs work *per row* — a 128 KB transcript-tail
    // read plus a JSON parse of every line, plus a subagent-dir scan with a
    // `metadata` call per entry — and this runs on a ~10s poll. One batch hop off
    // the async runtime, not one task per row.
    Ok(tokio::task::spawn_blocking(move || {
        let roots = RecordRoots::here();
        let mut settled = SETTLED_IDLE.lock().unwrap_or_else(|e| e.into_inner());
        one_per_session(reconcile_rows(
            rows,
            now_ms,
            &terminals,
            &roots,
            &mut settled,
        ))
    })
    .await?)
}

/// One state per session, preferring a binding whose terminal is alive.
///
/// `terminal_sessions` is keyed by surface, not by session, so one session can
/// be bound to two surfaces: a resume opened in a new tab while the original was
/// still running is exactly that. The join then answers twice for one session —
/// once through the live tab and once, as `Exited`, through the dead one — and a
/// reader keyed by session id keeps whichever came last. That is how a running
/// agent read as exited in the sidebar, and why clicking it resumed it into a
/// second tab that the CLI refused ("already running"). A session is running if
/// any terminal holding it is.
fn one_per_session(states: Vec<SessionState>) -> Vec<SessionState> {
    let mut out: Vec<SessionState> = Vec::with_capacity(states.len());
    let mut at: HashMap<String, usize> = HashMap::new();
    for state in states {
        match at.get(&state.session_id) {
            Some(&i) => {
                if out[i].state == AgentState::Exited && state.state != AgentState::Exited {
                    out[i] = state;
                }
            }
            None => {
                at.insert(state.session_id.clone(), out.len());
                out.push(state);
            }
        }
    }
    out
}

/// A `session_state` row as stored (`state` is the TEXT column, still
/// unparsed), with the owning logical terminal joined on and the status line's
/// last render.
#[derive(Debug, Clone, sqlx::FromRow)]
struct StateRow {
    session_id: String,
    state: String,
    event: String,
    /// The hook payload's `cwd`: where the session was when it last fired.
    cwd: String,
    message: Option<String>,
    /// Where the hook payload said the transcript is. Its presence says the
    /// session keeps a record on this Mac (a relayed Daedalus hook's is
    /// dropped); the record read is the one derived from the row
    /// ([`claude_evidence`], [`codex_evidence`]).
    transcript_path: Option<String>,
    updated_at_ms: i64,
    /// Who asked, for a pending row (migration 0042; [`Asker`]).
    asker: Option<String>,
    /// The latest mode and effort a payload carried (migration 0043).
    permission_mode: Option<String>,
    effort_level: Option<String>,
    /// The dialog on record with the row (migration 0043; [`pending_prompt`]).
    pending_kind: Option<String>,
    pending_tool: Option<String>,
    pending_input: Option<String>,
    pending_suggestions: Option<String>,
    pending_mcp_server: Option<String>,
    pending_agent_id: Option<String>,
    pending_agent_type: Option<String>,
    pending_mode: Option<String>,
    pending_prompt_id: Option<String>,
    pending_truncated: Option<bool>,
    pending_at_ms: Option<i64>,
    pending_stacked: Option<bool>,
    /// What has been seen of the dialog since ([`dialog_marks`]).
    pending_rendered_at_ms: Option<i64>,
    pending_resolved_at_ms: Option<i64>,
    repo: Option<String>,
    term_key: Option<String>,
    agent_kind: Option<String>,
    /// The directory santree launched the session in (`terminal_sessions`),
    /// which names its transcript's project directory.
    launch_cwd: Option<String>,
    heartbeat_ms: Option<i64>,
}

/// Parse + reconcile a batch of stored rows. Blocking (transcript fs reads) —
/// always call from `spawn_blocking`. `settled` is [`SETTLED_IDLE`]'s map,
/// kept to the sessions of this batch.
fn reconcile_rows(
    rows: Vec<StateRow>,
    now_ms: i64,
    terminals: &Liveness,
    roots: &RecordRoots,
    settled: &mut HashMap<String, RecordStamp>,
) -> Vec<SessionState> {
    let batch: std::collections::HashSet<String> =
        rows.iter().map(|row| row.session_id.clone()).collect();
    settled.retain(|session, _| batch.contains(session));
    rows.into_iter()
        .filter_map(|row| {
            let Some(recorded_state) = AgentState::parse(&row.state) else {
                // The hook binary is built separately, so a stale copy on disk
                // can write a state this build doesn't know. Drop the row rather
                // than guess — a wrong badge is worse than a missing one.
                log::warn!(
                    "session {}: unknown state {:?}, skipping",
                    row.session_id,
                    row.state
                );
                return None;
            };
            let mut state = recorded_state;
            let mut message = row.message.clone();
            let kind = row.agent_kind.as_deref().and_then(|k| k.parse().ok());
            let alive = terminal_liveness(
                row.term_key.as_deref(),
                kind,
                row.heartbeat_ms,
                now_ms,
                terminals,
            );
            let prompt = pending_prompt(&row, recorded_state);
            let closed_ms = prompt
                .as_ref()
                .and_then(|p| dialog_marks(&row, p.kind).closed_at());
            // The hook events set a state but can't reliably clear it (a manual
            // accept/reject and a turn that ends without a `Stop` both fire
            // nothing). So we reconcile the live state against the transcript —
            // the ground truth — and the dialog's own signs of closing, and drop
            // the now-irrelevant prompt text when the state is no longer a
            // "needs-you" one.
            let reconciled = if is_unsettled(recorded_state) && row.transcript_path.is_some() {
                reconcile_live_state(
                    recorded_state,
                    &Asker::parse(row.asker.as_deref()),
                    &evidence(&row, kind, roots),
                    row.updated_at_ms,
                    now_ms,
                    closed_ms,
                )
            } else if closed_ms.is_some() {
                // No record here to read (a Daedalus session's is on the box):
                // the dialog closed, and the turn it was part of reads as an
                // active row without a record does — running, until its next
                // hook.
                Reconciled {
                    state: Some(AgentState::Active),
                    interrupted_ms: None,
                }
            } else if recorded_state == AgentState::Idle && alive == Some(true) {
                // A message Claude queued while it worked starts its own turn
                // right after the `Stop` stored here, and no hook says so (CLI
                // 2.1.312): the transcript is the one witness. Read like a
                // running turn from its delivery on.
                queued_delivery(&row, kind, roots, settled)
                    .map(|(queued_ms, evidence)| Reconciled {
                        state: reconcile_activity(
                            false,
                            &Asker::Unknown,
                            &evidence,
                            queued_ms,
                            now_ms,
                            None,
                        ),
                        interrupted_ms: None,
                    })
                    .unwrap_or_default()
            } else {
                Reconciled::default()
            };
            if let Some(live) = reconciled.state {
                if !live.is_blocked_on_user() {
                    message = None;
                }
                state = live;
            }
            // …and whatever the events and the transcript agree on, a session
            // whose terminal is gone is not running. This is the last word
            // because it is the only one derived from live state rather than a
            // record: see [`session_states`].
            if state != AgentState::Exited && alive == Some(false) {
                state = AgentState::Exited;
                message = None;
            }
            // A dialog can't be on the screen of a pane that is gone.
            let prompt = prompt.filter(|_| state != AgentState::Exited);
            Some(SessionState {
                // The provider the owning terminal was registered under, not
                // an assumption — and `None` rather than a default when the
                // join isn't there. `terminal_sessions` holds one row per
                // logical surface, so a terminal that mints a *second*
                // session (a Codex `/new`, a Claude `/clear`) takes the join
                // with it and leaves the first row unattributed. Defaulting
                // that to Claude is how a Codex session came to render with
                // the Claude mark; the frontend shows no mark instead.
                agent_kind: kind,
                session_id: row.session_id,
                state,
                recorded_state,
                interrupted_at_ms: reconciled.interrupted_ms.map(|ms| ms as f64),
                event: row.event,
                cwd: row.cwd,
                message,
                transcript_path: row.transcript_path,
                updated_at_ms: row.updated_at_ms as f64,
                repo: row.repo,
                term_key: row.term_key,
                prompt,
                permission_mode: row.permission_mode,
                effort_level: row.effort_level,
            })
        })
        .collect()
}

/// The dialog stored with the row, while it is still the row's: written by the
/// write that holds the row now (`pending_at_ms` is that write's
/// `updated_at_ms` — an older hook binary's later write leaves the columns
/// behind but moves the clock) and for the state that write stored.
fn pending_prompt(row: &StateRow, recorded: AgentState) -> Option<PendingPrompt> {
    let kind = DialogKind::parse(row.pending_kind.as_deref()?)?;
    if kind.state() != recorded || row.pending_at_ms != Some(row.updated_at_ms) {
        return None;
    }
    let marks = dialog_marks(row, kind);
    Some(PendingPrompt {
        kind,
        tool_name: row.pending_tool.clone(),
        tool_input: row
            .pending_input
            .clone()
            .unwrap_or_else(|| "null".to_string()),
        suggestions: row.pending_suggestions.clone(),
        mcp_server: row.pending_mcp_server.clone(),
        agent_id: row.pending_agent_id.clone(),
        agent_type: row.pending_agent_type.clone(),
        permission_mode: row.pending_mode.clone(),
        prompt_id: row.pending_prompt_id.clone(),
        recorded_at_ms: row.updated_at_ms as f64,
        truncated: row.pending_truncated.unwrap_or(false),
        stacked: marks.stacked,
        closed_at_ms: marks.closed_at().map(|ms| ms as f64),
        call_ended_at_ms: marks.call_ended_at().map(|ms| ms as f64),
    })
}

/// What has been seen of the row's dialog since it was recorded, as the hook
/// stored it: the one reading of whether it closed ([`DialogMarks::closed_at`]),
/// for the card's `closed` and the reconciler alike. Without it an approved
/// tool read "needs you" until it ended — an approval leaves nothing in the
/// transcript before then.
fn dialog_marks(row: &StateRow, kind: DialogKind) -> DialogMarks {
    DialogMarks {
        kind,
        stacked: row.pending_stacked.unwrap_or(false),
        rendered_at_ms: row.pending_rendered_at_ms,
        resolved_at_ms: row.pending_resolved_at_ms,
    }
}

/// A record file's length and modification time (epoch ms): while both are
/// unchanged, so is what it says.
type RecordStamp = (u64, i64);

/// Idle sessions whose transcript, at the stamp noted, showed no message
/// delivered from Claude's queue, so the next read of an unchanged transcript
/// is a stat rather than a tail read: an idle session sits on every poll, and
/// its transcript's trailer is written in the same milliseconds as the `Stop`
/// it idles on, so its time alone can't tell a delivery from the trailer.
static SETTLED_IDLE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, RecordStamp>>> =
    std::sync::LazyLock::new(Default::default);

/// How far apart a queued message's delivery and the stored idle can be and
/// still be the `Stop` it followed: Claude writes the delivery within
/// milliseconds of that `Stop`, before or after the hook's own write lands.
const QUEUED_SLACK_MS: i64 = 2_000;

/// When an idle Claude row's session is running a turn Claude started from
/// its queue, when that turn began (the delivered prompt's record) and the
/// session's records; `None` otherwise, or when nothing was written since the
/// stored idle. Reads the transcript's tail only when its stamp moved since
/// the last read found nothing ([`SETTLED_IDLE`]).
fn queued_delivery(
    row: &StateRow,
    kind: Option<AgentKind>,
    roots: &RecordRoots,
    settled: &mut HashMap<String, RecordStamp>,
) -> Option<(i64, Evidence)> {
    let reported = row.transcript_path.as_deref()?;
    if is_codex_record(kind, reported) {
        return None;
    }
    let cwds = [row.launch_cwd.as_deref(), Some(row.cwd.as_str())];
    let mut record = open_claude_record(&row.session_id, &cwds, reported, &roots.claude)?;
    let len = record.meta.len();
    let modified = record
        .meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    if modified < row.updated_at_ms - QUEUED_SLACK_MS
        || settled.get(&row.session_id) == Some(&(len, modified))
    {
        return None;
    }
    let main = main_activity(&read_tail(&mut record.file, len, CLAUDE_TAIL)?);
    // A stored idle well after the delivery is that turn's own `Stop`, even
    // from a CLI that writes no turn-end record.
    let Some(queued_ms) = main
        .queued_ms
        .filter(|ms| ms + QUEUED_SLACK_MS > row.updated_at_ms)
    else {
        settled.insert(row.session_id.clone(), (len, modified));
        return None;
    };
    Some((
        queued_ms,
        Evidence {
            main,
            subagents: subagent_writes(&record.path),
        },
    ))
}

/// Whether a stored state is one the transcript can overrule: running, or a
/// prompt. Idle and exited are settled (see [`reconcile_live_state`]); an idle
/// row is read only for a turn Claude started from its queue
/// ([`queued_delivery`]).
fn is_unsettled(state: AgentState) -> bool {
    state == AgentState::Active || state.is_blocked_on_user()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// How long a session's status line must have been silent before its absence is
/// read as death. Only used for rows with no terminal to join (see
/// [`terminal_liveness`]); four missed renders at
/// [`STATUSLINE_REFRESH_SECS`], which is slack enough for a machine that slept or
/// a status line that lost a render to a busy turn.
pub(crate) const HEARTBEAT_DEAD_MS: i64 = STATUSLINE_REFRESH_SECS as i64 * 1_000 * 4;

/// Is the terminal hosting this session still alive? `None` = no evidence either
/// way, and the caller must leave the row alone.
///
/// The asymmetry is deliberate. A false "dead" **hides an agent that is working**
/// — the exact complaint this whole path exists to fix — while a false "alive"
/// only delays a retirement until the transcript-quiet check catches it. So this
/// answers `Some(false)` only on positive evidence of death, and shrugs
/// otherwise.
///
/// - **`term_key` present** — decisive, both ways, *when the answer is
///   complete*. `terminals` comes from the terminal facade
///   (`sessions::Terminals::liveness`), which asks wherever a pane's process
///   lives: this app's PTY manager, the local santree server, or Daedalus. With
///   in-app terminals it is the whole truth about what runs on this Mac, which
///   is what makes an app restart correct for free — nothing is live, so every
///   stored row retires instead of sitting at "active" until a timer notices.
///   With a local server, processes outlive the app, so an absence means
///   "exited" only if the server could be asked about everything it holds
///   (`complete`); otherwise the answer is `None` and the row is left alone.
///
///   Matched on the row's own identity — `(term_key, agent_kind)`, the pair its
///   primary key is — and never on `cwd`. Both halves, because a surface hosts
///   one live session *per provider*: matching the key alone would report a
///   Claude row as running because a Codex pane happens to be open on the same
///   PR. The key is santree's own opaque string, compared byte-for-byte against
///   the `label` the same frontend value opened the PTY under; a `cwd` would have
///   to survive path normalization (`/var` vs `/private/var` on macOS alone), and
///   a normalization mismatch here would retire *every* session at once. The cost
///   is that two repos sharing a `term_key` (`tree:AK-1` in both) read as live
///   while either is — permissive in the safe direction, by design.
///
///   A row whose stored provider this build cannot parse keeps that permissive
///   direction: it matches any pane on its surface rather than none, because the
///   asymmetry above says a session santree cannot classify must not be declared
///   dead.
///
/// - **`term_key` absent** — a session that lost its registry join (a `/clear`
///   mints a fresh id under the old terminal). Fall back to the status line: a
///   session that has *ever* rendered one but has now gone quiet past
///   [`HEARTBEAT_DEAD_MS`] is gone. One that never rendered one at all (any Codex
///   session — Codex has no status-line hook) yields `None`, not a guess.
fn terminal_liveness(
    term_key: Option<&str>,
    agent_kind: Option<AgentKind>,
    heartbeat_ms: Option<i64>,
    now_ms: i64,
    terminals: &Liveness,
) -> Option<bool> {
    match term_key {
        Some(key) => terminals.knows(|live| {
            live.term_key == key && (agent_kind.is_none() || live.agent_kind == agent_kind)
        }),
        None => heartbeat_ms.map(|ms| now_ms - ms < HEARTBEAT_DEAD_MS),
    }
}

/// Record that a terminal's agent sessions are over, because its PTY exited.
///
/// Called from the PTY exit sentinel (`terminal.rs`). This is the *write* half of
/// the liveness story; [`session_states`]'s join is the half that makes it
/// correct, and the ordering between them is deliberately not load-bearing —
/// a hook that straggles in after the process died can overwrite this row with
/// "active", and the read will still answer "exited" because no PTY holds that
/// `term_key` any more. That is why santree needs neither of Superset's
/// straggler windows: it has no stored liveness for a late write to corrupt.
///
/// What the write *is* for is everything that reads the row directly rather than
/// through the join — the realtime `SessionStateChanged` push, `updated_at_ms` as
/// "when this last did anything", and the stale-row prune. Only live-looking
/// states are retired: an already-`idle`/`exited` row is left alone so its
/// timestamp keeps meaning when the agent last worked.
///
/// Scoped by `cwd` as well as `term_key`, which the read-path join deliberately
/// is *not*. The two want opposite things from an ambiguous key. `term_key` is
/// only unique per repo, so two repos can both hold a `tree:AK-1`; on the read
/// side matching both of them is harmless (it can only keep a session looking
/// alive), but writing to both would stamp "exited" onto a *live* agent in the
/// other repo — and nothing would take it back, since the join only ever adds
/// `Exited`. Here the failure modes are reversed, so precision wins: if the two
/// `cwd` spellings ever disagree this updates nothing, and the read-path join
/// still gives the right answer on its own.
///
/// Scoped by the exiting pane's provider for the same reason: a surface holds a
/// row per provider, and quitting a Codex review of a PR must not stamp "exited"
/// on the Claude review of it that is still running. `None` — a pane santree
/// opened as a plain shell — retires the surface's rows as before, since there is
/// no provider to be more precise about.
pub async fn retire_terminal(
    db: &Db,
    term_key: &str,
    agent_kind: Option<AgentKind>,
    cwd: Option<&str>,
) -> Result<u64> {
    let agent_kind = agent_kind.map(AgentKind::as_str);
    // The dialog goes with the pane (the reader would no longer offer it
    // anyway: the row is not the write that stored it).
    let rows = sqlx::query(
        "UPDATE session_state SET state = ?, event = ?, message = NULL, asker = NULL, \
                                  pending_kind = NULL, pending_input = NULL, \
                                  pending_suggestions = NULL, updated_at_ms = ? \
         WHERE state IN ('active', 'delegating', 'permission', 'waiting') \
           AND session_id IN ( \
                 SELECT session_id FROM terminal_sessions \
                 WHERE term_key = ? AND (? IS NULL OR agent_kind = ?) \
                   AND (? IS NULL OR cwd = ?))",
    )
    .bind(AgentState::Exited.as_str())
    .bind(PTY_EXIT_EVENT)
    .bind(now_ms())
    .bind(term_key)
    .bind(agent_kind)
    .bind(agent_kind)
    .bind(cwd)
    .bind(cwd)
    .execute(db)
    .await?
    .rows_affected();
    Ok(rows)
}

/// The `event` a PTY-exit retirement stamps. Deliberately not one of Claude's or
/// Codex's own event names: this transition came from santree watching the
/// process, not from the CLI reporting anything, and `SessionState.event` is
/// rendered as provenance.
pub const PTY_EXIT_EVENT: &str = "PtyExit";

/// How much of a Claude transcript's tail [`claude_evidence`] reads. They grow
/// to many MB over a long session, but only the most recent few turns matter.
const CLAUDE_TAIL: u64 = 128 * 1024;

/// The last `max_bytes` of an opened record as text (lossy). A partial first
/// line (from seeking mid-file) just fails to parse and is skipped. Never more
/// than `max_bytes`, whatever the file claims: the handle is a regular file
/// ([`record_file::open`]), but its length can still change under the read.
fn read_tail(file: &mut std::fs::File, len: u64, max_bytes: u64) -> Option<String> {
    file.seek(SeekFrom::Start(len.saturating_sub(max_bytes)))
        .ok()?;
    let mut buf = Vec::new();
    file.take(max_bytes).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// How far past `recorded_at_ms` the transcript must have advanced before we call
/// a prompt resolved. The turn that *triggers* a prompt is written to the
/// transcript ~immediately before the hook records the state, so we need a small
/// margin to not mistake that triggering turn for a resolution. A real user
/// action (accept/reject/reply) always lands seconds later, well past this.
const RESOLVED_MARGIN_MS: i64 = 1_000;

/// How long the transcript must be quiet (no new conversation entry) before we
/// call a running agent idle. Long enough to sit through the agent's own pauses
/// (thinking, a slow tool) without flapping to idle; short enough that a finished
/// turn reads as idle promptly. Paired with the ~10s frontend poll.
const IDLE_QUIET_MS: i64 = 30_000;

/// The directories agent records are read from, in canonical form, resolved
/// once per batch: Claude's `projects` roots (an account folder links its
/// `projects` to the Default home's, so its transcripts resolve into these)
/// and Codex's `sessions` root.
struct RecordRoots {
    claude: Vec<PathBuf>,
    codex: Vec<PathBuf>,
}

impl RecordRoots {
    /// This Mac's. Blocking (it resolves the directories).
    fn here() -> Self {
        Self {
            claude: record_file::canonical(&crate::usage::projects_roots()),
            codex: record_file::canonical(
                &crate::codex_rollouts::sessions_root()
                    .into_iter()
                    .collect::<Vec<_>>(),
            ),
        }
    }
}

/// What a session's records say: its main loop, and when each of its subagents
/// last wrote.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Evidence {
    main: MainLoop,
    /// Each subagent transcript's newest write (mtime), by agent id. Subagent
    /// files are pure agent conversation (no remote-control trailer), so their
    /// mtime is a clean "a subagent just did something" signal.
    subagents: Vec<(String, i64)>,
}

/// What a session's main loop did, by its transcript.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct MainLoop {
    /// Epoch-ms of its newest activity; `None` if unreadable or there is none.
    last_ms: Option<i64>,
    /// Epoch-ms of the user's interrupt, when the newest main-chain record is
    /// the one Claude writes for it ([`is_interrupt_marker`]).
    interrupted_ms: Option<i64>,
    /// Epoch-ms of a prompt Claude delivered from its queue
    /// (`promptSource: "queued"`) when no turn end follows it in the record:
    /// the turn it started is still running.
    queued_ms: Option<i64>,
}

/// A row's records, read from where the row's session keeps them, whichever
/// provider wrote them. Nothing readable is "no evidence" (the default).
///
/// The two formats have nothing in common. A Claude transcript's conversation
/// records are `type: "assistant" | "user"`; a Codex *rollout*'s are
/// `session_meta` / `event_msg` / `response_item` / `turn_context`, and running
/// the Claude parser over one matches nothing — which the reconciler reads as
/// "no evidence", so a Codex session kept its last hook state forever.
///
/// `agent_kind` is the registry's answer and is used when it has one. When it
/// doesn't (a session that lost its `terminal_sessions` join — a `/clear`, a
/// `/new`), the reported file *name* decides: Codex names every rollout
/// `rollout-<timestamp>-<thread-id>.jsonl`. Guessing wrong reads nothing, the
/// same as an unreadable file; guessing right keeps an unjoined Codex session
/// reconciling.
fn evidence(row: &StateRow, agent_kind: Option<AgentKind>, roots: &RecordRoots) -> Evidence {
    let Some(reported) = row.transcript_path.as_deref() else {
        return Evidence::default();
    };
    if is_codex_record(agent_kind, reported) {
        return codex_evidence(&row.session_id, reported, &roots.codex);
    }
    let cwds = [row.launch_cwd.as_deref(), Some(row.cwd.as_str())];
    claude_evidence(&row.session_id, &cwds, reported, &roots.claude)
}

/// Whether a row's record is a Codex rollout: the registry's provider when it
/// has one, else the reported file's name (`rollout-<timestamp>-<thread>.jsonl`).
fn is_codex_record(agent_kind: Option<AgentKind>, reported: &str) -> bool {
    match agent_kind {
        Some(kind) => kind == AgentKind::Codex,
        None => Path::new(reported)
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-")),
    }
}

/// A Claude session's transcript and its subagents'. The file is derived from
/// the row — `<root>/<slug of the cwd>/<session id>.jsonl` under Claude's own
/// roots, for the directory santree launched it in and the one its hook last
/// reported — and the path the hook payload carried is taken only when it names
/// that same file, `<session id>.jsonl`, which covers a session whose working
/// directory moved since. Each is opened as a record inside Claude's roots
/// ([`record_file::open`]), so a link, a FIFO or a path elsewhere reads nothing.
fn claude_evidence(
    session_id: &str,
    cwds: &[Option<&str>],
    reported: &str,
    roots: &[PathBuf],
) -> Evidence {
    let Some(mut record) = open_claude_record(session_id, cwds, reported, roots) else {
        return Evidence::default();
    };
    let main = read_tail(&mut record.file, record.meta.len(), CLAUDE_TAIL)
        .map(|text| main_activity(&text))
        .unwrap_or_default();
    Evidence {
        main,
        subagents: subagent_writes(&record.path),
    }
}

/// [`claude_evidence`]'s file, opened: the first of the derived paths and the
/// reported one that opens as a record inside Claude's roots.
fn open_claude_record(
    session_id: &str,
    cwds: &[Option<&str>],
    reported: &str,
    roots: &[PathBuf],
) -> Option<record_file::Record> {
    if !crate::session::is_session_id(session_id) {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    let derived = roots.iter().flat_map(|root| {
        cwds.iter()
            .flatten()
            .filter_map(|cwd| crate::session::transcript_file(root, cwd, session_id))
    });
    let reported = Some(PathBuf::from(reported))
        .filter(|path| path.file_name().and_then(|n| n.to_str()) == Some(name.as_str()));
    derived
        .chain(reported)
        .find_map(|path| record_file::open(&path, roots).ok())
}

/// When each of a session's subagents last wrote its transcript, by agent id:
/// the contained listing of `<session>/subagents/agent-<id>.jsonl` next to the
/// opened main transcript (`usage::subagent_files`), a link in an entry's place
/// skipped.
fn subagent_writes(main: &Path) -> Vec<(String, i64)> {
    crate::usage::subagent_files(main)
        .into_iter()
        .filter_map(|path| {
            let id = path
                .file_name()?
                .to_str()?
                .strip_prefix("agent-")?
                .strip_suffix(".jsonl")?
                .to_string();
            let meta = std::fs::symlink_metadata(&path).ok()?;
            let ms = meta
                .is_file()
                .then(|| meta.modified().ok())
                .flatten()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis() as i64;
            Some((id, ms))
        })
        .collect()
}

/// A Codex session's rollout: the path the hook payload carried, taken only
/// when it is a rollout of this very thread (`rollout-<timestamp>-<thread
/// id>.jsonl`) and opens as a record inside Codex's `sessions` root.
fn codex_evidence(thread_id: &str, reported: &str, roots: &[PathBuf]) -> Evidence {
    let path = Path::new(reported);
    let suffix = format!("-{thread_id}.jsonl");
    let named = crate::session::is_session_id(thread_id)
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix));
    if !named {
        return Evidence::default();
    }
    let Ok(mut record) = record_file::open(path, roots) else {
        return Evidence::default();
    };
    Evidence {
        main: MainLoop {
            last_ms: crate::codex_rollouts::last_activity_ms(&mut record.file, record.meta.len()),
            ..MainLoop::default()
        },
        subagents: Vec::new(),
    }
}

/// The text of the user record Claude writes when the user interrupts a turn
/// (Esc): the CLI's own two constants, as real transcripts carry them.
const INTERRUPT_MARKERS: [&str; 2] = [
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
];

/// Whether a transcript record is Claude's interrupt marker: a `user` record
/// whose content is one text block holding one of [`INTERRUPT_MARKERS`]. A
/// prompt the user typed is a plain string (or carries its images beside the
/// text), so typing the same words is not one.
fn is_interrupt_marker(record: &Value) -> bool {
    let content = record.get("message").and_then(|m| m.get("content"));
    let Some([block]) = content.and_then(Value::as_array).map(Vec::as_slice) else {
        return false;
    };
    record.get("type").and_then(Value::as_str) == Some("user")
        && block.get("type").and_then(Value::as_str) == Some("text")
        && block
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|t| INTERRUPT_MARKERS.contains(&t))
}

/// A *Claude* transcript's main loop, from the text of its tail: the newest
/// `assistant`/`user` entry — how recently the main agent loop itself did
/// anything — and whether the newest main-chain one is an interrupt marker.
/// cmux/remote-control metadata lines (`mode`, `pr-link`, …) are ignored, so raw
/// file mtime is deliberately not used here (that trailer churns without a real
/// turn).
fn main_activity(text: &str) -> MainLoop {
    let mut main = MainLoop::default();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue; // partial/metadata line
        };
        let main_chain = v.get("isSidechain").and_then(Value::as_bool) != Some(true);
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") | Some("user") => {}
            // A turn's end: a prompt delivered before it has had its turn.
            Some("system")
                if main_chain
                    && matches!(
                        v.get("subtype").and_then(Value::as_str),
                        Some("turn_duration" | "stop_hook_summary")
                    ) =>
            {
                main.queued_ms = None;
                continue;
            }
            _ => continue, // skip metadata entries
        }
        let ms = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
            .map(|dt| dt.timestamp_millis());
        if let Some(ms) = ms {
            main.last_ms = Some(main.last_ms.map_or(ms, |cur| cur.max(ms)));
        }
        // Appended in order, so the last main-chain record read is the newest.
        if main_chain {
            let interrupted = is_interrupt_marker(&v);
            main.interrupted_ms = ms.filter(|_| interrupted);
            if interrupted {
                main.queued_ms = None;
            } else if v.get("promptSource").and_then(Value::as_str) == Some("queued") {
                // Two prompts delivered together start one turn: its start is
                // the first.
                main.queued_ms = main.queued_ms.or(ms);
            }
        }
    }
    main
}

/// Which thread put a pending prompt on screen, from `session_state.asker`
/// (santree-hook writes it, migration 0042).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Asker {
    /// The session's own thread: its `PermissionRequest`.
    Main,
    /// A subagent, by the agent id Claude names its transcript after.
    Subagent(String),
    /// Nobody said: a Notification, or a row older than the column.
    Unknown,
}

impl Asker {
    fn parse(stored: Option<&str>) -> Self {
        match stored {
            Some("main") => Self::Main,
            Some(other) => other
                .strip_prefix("agent:")
                .filter(|id| is_subagent_id(id))
                .map_or(Self::Unknown, |id| Self::Subagent(id.to_string())),
            None => Self::Unknown,
        }
    }
}

/// Reconcile a stored session state against the transcript — the ground truth for
/// what the agent is *actually* doing. The hooks reliably *set* a state (turn
/// start, a prompt appearing) but can't reliably *clear* it: a manual accept/
/// reject fires no hook, and a turn can end with no `Stop`. So the transcript's
/// activity, not the event stream, decides when running/pending is stale.
///
/// The signal is **how recently there was activity**, tracked separately for the
/// main loop and its subagents. We deliberately don't parse the transcript's
/// structure (`stop_reason`, tool_use vs result) — under remote control the last
/// line is often a bare tool_result or metadata, so structure is unreliable; a
/// plain "has it gone quiet" is not. The one record read for what it says is the
/// marker Claude writes when the user interrupts a turn, which fires no `Stop`.
///
/// Returns an override state (`None` keeps the stored one), and the marker's
/// time when it is what decided:
/// - interrupted: when the newest main-chain record is that marker and it is
///   newer than the recorded state, the turn is over — `idle`, whatever the
///   stored state was (an Esc at a prompt answers the prompt too).
/// - `permission`/`waiting`: pending until the thread that asked moves past
///   when we recorded the prompt — the main transcript for the session's own
///   prompt, the subagent's file for a subagent's; when nobody said who asked,
///   any of them. Another thread's progress proves nothing: a background
///   subagent writes away while the main thread's dialog is still up. Or until
///   the dialog's own signs say it closed (`closed_ms`, when it did:
///   [`DialogMarks::closed_at`]), which is also activity. Once resolved it
///   falls through to the liveness check below.
/// - resolved-prompt / `active`: `idle` once everything (main + subagents) has been
///   quiet for `IDLE_QUIET_MS`; else `delegating` if the freshest activity is a
///   subagent (the main loop is blocked on a Task subagent), else `active`.
/// - `idle`/`exited`: settled here (an idle row whose session runs a turn
///   Claude started from its queue, which no hook reports, is read apart, by
///   [`queued_delivery`]); otherwise `idle`→`active` only ever comes from
///   a real `UserPromptSubmit`; liveness owns `exited`).
fn reconcile_live_state(
    state: AgentState,
    asker: &Asker,
    evidence: &Evidence,
    recorded_at_ms: i64,
    now_ms: i64,
    closed_ms: Option<i64>,
) -> Reconciled {
    if !is_unsettled(state) {
        return Reconciled::default();
    }
    // Without a `Stop` the row would read "working" until the quiet window ran
    // out. A marker older than the recorded state ended an earlier turn: the one
    // the user has since started is still running.
    if let Some(ms) = evidence
        .main
        .interrupted_ms
        .filter(|ms| *ms > recorded_at_ms)
    {
        return Reconciled {
            state: Some(AgentState::Idle),
            interrupted_ms: Some(ms),
        };
    }
    Reconciled {
        state: reconcile_activity(
            state.is_blocked_on_user(),
            asker,
            evidence,
            recorded_at_ms,
            now_ms,
            closed_ms,
        ),
        interrupted_ms: None,
    }
}

/// What reconciling a stored state against its transcript concluded.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Reconciled {
    /// The state to show instead of the stored one; `None` keeps it.
    state: Option<AgentState>,
    /// The interrupt marker's time, when the marker ended the recorded turn.
    interrupted_ms: Option<i64>,
}

/// The activity half of [`reconcile_live_state`]: a pending prompt resolved by
/// the thread that asked moving past it, and a running turn gone quiet.
fn reconcile_activity(
    is_pending: bool,
    asker: &Asker,
    evidence: &Evidence,
    recorded_at_ms: i64,
    now_ms: i64,
    closed_ms: Option<i64>,
) -> Option<AgentState> {
    let main_ms = evidence.main.last_ms;
    let sub_ms = evidence.subagents.iter().map(|(_, ms)| *ms).max();

    // A pending prompt whose thread hasn't advanced past when we recorded it is
    // still genuinely waiting on the user — keep it, unless Claude's own signs
    // say its dialog closed (`closed_ms`, [`DialogMarks::closed_at`]).
    if is_pending && closed_ms.is_none() {
        let asked_ms = match asker {
            Asker::Main => main_ms,
            Asker::Subagent(id) => evidence
                .subagents
                .iter()
                .find(|(agent, _)| agent == id)
                .map(|(_, ms)| *ms),
            Asker::Unknown => main_ms.max(sub_ms),
        };
        if asked_ms.is_none_or(|ms| ms <= recorded_at_ms + RESOLVED_MARGIN_MS) {
            return None;
        }
    }

    // The hook clock counts as activity in its own right, and has to: the tool
    // heartbeats (`PostToolUse`/`PostToolUseFailure`) exist precisely to prove a
    // turn is still moving when the transcript is not moving with it — a long
    // build, a long think, or a session whose transcript writes are suppressed
    // altogether. Without this the heartbeats would land in the row and change
    // nothing, and the agent would still decay to "idle" mid-turn.
    //
    // Only while `active`. For a pending prompt `recorded_at_ms` is *when the
    // prompt was recorded*, and the comparison above is what notices the user
    // answered — folding it in as activity would resolve every prompt against
    // itself.
    // The sign that closed a dialog is the session moving too: an approved
    // tool writes nothing to the transcript until it ends.
    let event_ms = (!is_pending).then_some(recorded_at_ms);
    let last_ms = main_ms.max(sub_ms).max(event_ms).max(closed_ms)?; // None if nothing is readable

    if now_ms - last_ms >= IDLE_QUIET_MS {
        return Some(AgentState::Idle); // everything quiet → idle
    }

    // Active. Distinguish the main loop working from it being blocked on a subagent:
    // the freshest activity being a subagent write (main loop older / absent) means
    // the agent has delegated and is itself waiting on the Task subagent.
    let delegating = match (sub_ms, main_ms) {
        (Some(s), Some(m)) => s > m,
        (Some(_), None) => true,
        (None, _) => false,
    };
    Some(if delegating {
        AgentState::Delegating
    } else {
        AgentState::Active
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`reconcile_rows`] with nothing settled from an earlier read.
    fn reconcile(
        rows: Vec<StateRow>,
        now_ms: i64,
        terminals: &Liveness,
        roots: &RecordRoots,
    ) -> Vec<SessionState> {
        reconcile_rows(rows, now_ms, terminals, roots, &mut HashMap::new())
    }

    #[test]
    fn the_mcp_config_names_the_server_and_scopes_it_to_one_pull_request() {
        let cfg = mcp_config_json(
            Path::new("/Applications/santree.app/Contents/Resources/santree-hook"),
            Path::new("/Users/me/Library/Application Support/com.santree.desktop/santree.db"),
            "acme",
            "web",
            42,
            "abc1234",
            Path::new("/data/mcp/acme-web-42.diff.json"),
        )
        .unwrap();
        let server = &cfg["mcpServers"]["santree-review"];
        assert_eq!(server["type"], "stdio");
        let args: Vec<String> = server["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_string())
            .collect();
        // The scope is argv and nothing else: this is what makes "the model can't
        // retarget it" true rather than a hope.
        assert!(args.windows(2).any(|w| w == ["--pr", "acme/web"]));
        assert!(args.windows(2).any(|w| w == ["--number", "42"]));
        assert!(args.windows(2).any(|w| w == ["--head", "abc1234"]));
        // A path with a space survives: Claude spawns the server without a shell.
        assert!(args.iter().any(|a| a.contains("Application Support")));
    }

    #[test]
    fn anything_claude_would_expand_is_refused_rather_than_rewritten() {
        // Not just the paths: this file is what fixes the server's scope, so a
        // `${` in the slug could repoint it at another repository.
        let ok = Path::new("/opt/santree-hook");
        assert!(mcp_config_json(
            Path::new("/opt/${HOME}/santree-hook"),
            Path::new("/db.sqlite"),
            "acme",
            "web",
            1,
            "abc1234",
            Path::new("/diff.json")
        )
        .is_err());
        assert!(mcp_config_json(
            ok,
            Path::new("/db.sqlite"),
            "acme${IFS}",
            "web",
            1,
            "abc1234",
            Path::new("/diff.json")
        )
        .is_err());
    }

    #[test]
    fn the_config_filename_is_checked_where_it_becomes_a_path() {
        assert!(mcp_stem("acme", "web", 42).unwrap().starts_with("review-"));
        assert_ne!(
            mcp_stem("a-b", "c", 7).unwrap(),
            mcp_stem("a", "b-c", 7).unwrap()
        );
        assert!(mcp_stem("acme", "we/b", 42).is_err());
        assert!(mcp_stem(".", "web", 42).is_err());
    }

    #[test]
    fn the_ai_review_grant_is_added_without_dropping_the_tutors() {
        // The tutor's Edit grant is what keeps its hook from stopping every turn on
        // a permission prompt; overwriting `allow` instead of appending to it would
        // break the tutor for anyone who has it on.
        let mut root = Map::new();
        root.insert("permissions".into(), json!({ "allow": ["Edit(/log.md)"] }));
        merge_permissions(&mut root, &review_deny_rules(), &["mcp__santree-review"]).unwrap();
        let allow = root["permissions"]["allow"].as_array().unwrap();
        assert!(allow.iter().any(|r| r == "Edit(/log.md)"));
        assert!(allow.iter().any(|r| r == "mcp__santree-review"));
        // And the review session still can't speak for the user.
        let deny = root["permissions"]["deny"].as_array().unwrap();
        assert!(deny.iter().any(|r| r == "Bash(gh pr review:*)"));
        assert!(deny.iter().any(|r| r == "Bash(git push)"));
    }

    /// The set of `term_key`s the PTY manager would report as alive.
    fn live<const N: usize>(panes: [(&str, Option<AgentKind>); N]) -> Liveness {
        Liveness {
            live: panes
                .into_iter()
                .map(|(key, kind)| pane(key, kind))
                .collect(),
            complete: true,
        }
    }

    /// The same panes, as a host that couldn't be asked right now would report
    /// them: what is known, and not the whole of it.
    fn unsure<const N: usize>(panes: [(&str, Option<AgentKind>); N]) -> Liveness {
        Liveness {
            complete: false,
            ..live(panes)
        }
    }

    /// The pane a Claude row of these fixtures would be running in.
    const CLAUDE: Option<AgentKind> = Some(AgentKind::Claude);

    /// One live pane, addressed the way the manager reports it: the surface and
    /// the provider santree launched in it.
    fn pane(term_key: &str, agent_kind: Option<AgentKind>) -> crate::sessions::LiveTerminal {
        crate::sessions::LiveTerminal {
            term_key: term_key.to_string(),
            agent_kind,
        }
    }

    /// A stored row: session `s1`, recorded at [`T`], with no transcript and no
    /// terminal joined — each test sets what it is about.
    fn row(state: &str) -> StateRow {
        StateRow {
            session_id: "s1".into(),
            state: state.into(),
            event: "UserPromptSubmit".into(),
            cwd: "/w".into(),
            message: None,
            transcript_path: None,
            updated_at_ms: T,
            asker: None,
            permission_mode: None,
            effort_level: None,
            pending_kind: None,
            pending_tool: None,
            pending_input: None,
            pending_suggestions: None,
            pending_mcp_server: None,
            pending_agent_id: None,
            pending_agent_type: None,
            pending_mode: None,
            pending_prompt_id: None,
            pending_truncated: None,
            pending_at_ms: None,
            pending_stacked: None,
            pending_rendered_at_ms: None,
            pending_resolved_at_ms: None,
            repo: None,
            term_key: None,
            agent_kind: None,
            launch_cwd: None,
            heartbeat_ms: None,
        }
    }

    /// No record roots: for the rows that read no transcript.
    fn no_roots() -> RecordRoots {
        RecordRoots {
            claude: Vec::new(),
            codex: Vec::new(),
        }
    }

    // A conversation entry stamped `ms` epoch-millis. The reconciler reads its
    // `type` + `timestamp`, and its content only to tell an interrupt marker,
    // which an empty one never is.
    fn conv(role: &str, ms: i64) -> String {
        let ts = chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339();
        format!(
            r#"{{"type":"{role}","timestamp":"{ts}","message":{{"role":"{role}","content":[]}}}}"#
        )
    }
    // cmux/remote-control trailer noise — no role, no useful timestamp. Must be
    // ignored, else its churn would look like the transcript advancing.
    const META: &str = r#"{"type":"pr-link"}"#;

    const T: i64 = 1_700_000_000_000; // an arbitrary "prompt recorded at" instant

    /// What a session's records say: its main loop's newest entry, and its
    /// subagents' newest writes.
    fn seen(main_ms: Option<i64>, subagents: &[(&str, i64)]) -> Evidence {
        Evidence {
            main: MainLoop {
                last_ms: main_ms,
                ..MainLoop::default()
            },
            subagents: subagents
                .iter()
                .map(|(id, ms)| (id.to_string(), *ms))
                .collect(),
        }
    }

    /// The reconciled state alone, for the tests that only check that.
    fn live_state(
        state: AgentState,
        asker: &Asker,
        evidence: &Evidence,
        recorded_at_ms: i64,
        now_ms: i64,
    ) -> Option<AgentState> {
        reconcile_live_state(state, asker, evidence, recorded_at_ms, now_ms, None).state
    }

    #[test]
    fn shell_quoting_survives_hostile_paths() {
        // A home directory may legally contain any of these; double quotes would
        // let `$`, a backtick and `\` through to the shell.
        let path = "/Users/o'brien/$HOME `id` \\x/Application Support/santree.db";
        assert_eq!(
            sh_quote(path),
            r"'/Users/o'\''brien/$HOME `id` \x/Application Support/santree.db'"
        );
        // Round-trip through a real shell: the quoted form must echo back verbatim.
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {}", sh_quote(path)))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), path);
    }

    #[test]
    fn unknown_stored_state_drops_the_row() {
        // A stale santree-hook on disk writing a state this build doesn't know must
        // not surface as a wrong badge.
        let rows = vec![
            StateRow {
                event: "Notification".into(),
                ..row("teleporting")
            },
            StateRow {
                session_id: "s2".into(),
                event: "Stop".into(),
                repo: Some("canary".into()),
                term_key: Some("tree:AK-1".into()),
                agent_kind: Some("Claude".into()),
                ..row("idle")
            },
        ];
        let out = reconcile(rows, T, &live([("tree:AK-1", CLAUDE)]), &no_roots());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id, "s2");
        assert_eq!(out[0].state, AgentState::Idle);
        // The joined owner rides along untouched — it's what the Agents panel
        // attributes the session to.
        assert_eq!(out[0].term_key.as_deref(), Some("tree:AK-1"));
        assert_eq!(out[0].repo.as_deref(), Some("canary"));
    }

    /// A session bound to two surfaces — resumed into a new tab while its first
    /// tab was still running — must read as running, through the live one, and
    /// appear once. Reading it through the dead binding is how a working agent
    /// showed as exited and a click resumed it a second time.
    #[test]
    fn a_session_bound_twice_reads_through_its_live_terminal() {
        let bound = |term_key: &str| StateRow {
            repo: Some("canary".into()),
            term_key: Some(term_key.into()),
            agent_kind: Some("Claude".into()),
            ..row("active")
        };
        let live = live([("tree:AK-1:tab:live", CLAUDE)]);
        for rows in [
            vec![bound("tree:AK-1:tab:gone"), bound("tree:AK-1:tab:live")],
            vec![bound("tree:AK-1:tab:live"), bound("tree:AK-1:tab:gone")],
        ] {
            let out = one_per_session(reconcile(rows, T, &live, &no_roots()));
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].state, AgentState::Active);
            assert_eq!(out[0].term_key.as_deref(), Some("tree:AK-1:tab:live"));
        }
        // Bound twice and running in neither: still one row, and exited — while
        // what the hook stored stays what it was.
        let out = one_per_session(reconcile(
            vec![
                bound("tree:AK-1:tab:gone"),
                bound("tree:AK-1:tab:also-gone"),
            ],
            T,
            &live,
            &no_roots(),
        ));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].state, AgentState::Exited);
        assert_eq!(out[0].recorded_state, AgentState::Active);
    }

    /// The provider comes from the owning terminal's row, not from an assumption
    /// about who writes `session_state`. Hardcoding it is what would mislabel
    /// every row the moment a second provider registers one.
    #[test]
    fn the_agent_kind_comes_from_the_joined_terminal() {
        let joined = |kind: Option<&str>| StateRow {
            event: "Stop".into(),
            repo: Some("canary".into()),
            term_key: Some("tree:AK-1".into()),
            agent_kind: kind.map(str::to_string),
            ..row("idle")
        };
        assert_eq!(
            reconcile(
                vec![joined(Some("Codex"))],
                T,
                &live([("tree:AK-1", Some(AgentKind::Codex))]),
                &no_roots(),
            )[0]
            .agent_kind,
            Some(santree_core::domain::AgentKind::Codex)
        );
        // No join, no provider — and *no guess*. A terminal keeps one row per
        // logical surface, so minting a second session orphans the first, and a
        // Claude default would repaint that orphaned Codex session as Claude.
        assert_eq!(
            reconcile(
                vec![joined(None)],
                T,
                &live([("tree:AK-1", CLAUDE)]),
                &no_roots()
            )[0]
            .agent_kind,
            None
        );
        // A value this build doesn't know is unknown too — the row survives
        // (its state is still worth showing), it just claims no provider.
        assert_eq!(
            reconcile(
                vec![joined(Some("Cowork"))],
                T,
                &live([("tree:AK-1", CLAUDE)]),
                &no_roots(),
            )[0]
            .agent_kind,
            None
        );
    }

    /// A pending prompt (permission / waiting) resolves only when the thread
    /// that asked moves past the instant it was recorded — never from its own
    /// hook clock, which would resolve every prompt against itself, and never
    /// from another thread: a background subagent writes away while the main
    /// thread's dialog is up, and the main thread's turn ends while a
    /// subagent's dialog is up (CLI 2.1.312). With nobody on record as the
    /// asker, any thread's progress resolves it, as it always did. Once
    /// resolved it reads as running while the agent is busy and as idle once
    /// quiet. Settled states are never reconciled at all.
    #[test]
    fn a_pending_prompt_resolves_only_on_the_progress_of_the_thread_that_asked() {
        use santree_core::domain::AgentState::{
            Active, Delegating, Exited, Idle, Permission, Waiting,
        };
        let main = Asker::Main;
        let sub = |id: &str| Asker::Subagent(id.to_string());
        let unknown = Asker::Unknown;
        // The real failing case: the newest entry predates the prompt.
        let frozen = seen(Some(T - 40_000), &[]);
        // The main thread moved 3 s after the prompt.
        let answered = seen(Some(T + 3_000), &[]);
        // Only a subagent moved; the main thread didn't.
        let a1_moved = seen(Some(T - 40_000), &[("a1", T + 3_000)]);
        let a2_moved = seen(Some(T - 40_000), &[("a1", T - 10_000), ("a2", T + 3_000)]);
        let busy = T + 5_000;
        let quiet = T + 3_000 + IDLE_QUIET_MS + 1;
        for (why, state, asker, evidence, now, want) in [
            ("frozen", Permission, &main, &frozen, busy, None),
            ("frozen", Waiting, &unknown, &frozen, busy, None),
            (
                "main answered",
                Permission,
                &main,
                &answered,
                busy,
                Some(Active),
            ),
            (
                "main answered, then quiet",
                Permission,
                &main,
                &answered,
                quiet,
                Some(Idle),
            ),
            (
                "a subagent moved, the main thread asked",
                Permission,
                &main,
                &a1_moved,
                busy,
                None,
            ),
            (
                "the main thread moved, a subagent asked",
                Permission,
                &sub("a1"),
                &answered,
                busy,
                None,
            ),
            (
                "another subagent moved",
                Permission,
                &sub("a1"),
                &a2_moved,
                busy,
                None,
            ),
            (
                "the subagent that asked moved",
                Permission,
                &sub("a1"),
                &a1_moved,
                busy,
                Some(Delegating),
            ),
            (
                "nobody said who asked",
                Permission,
                &unknown,
                &a1_moved,
                busy,
                Some(Delegating),
            ),
            ("settled", Idle, &unknown, &answered, busy, None),
            ("settled", Exited, &unknown, &answered, busy, None),
        ] {
            assert_eq!(live_state(state, asker, evidence, T, now), want, "{why}");
        }
        // What santree-hook stores parses back to who asked; anything else is
        // nobody.
        assert_eq!(Asker::parse(Some("main")), main);
        assert_eq!(Asker::parse(Some("agent:a1")), sub("a1"));
        for stored in [None, Some("agent:"), Some("agent:../a1"), Some("someone")] {
            assert_eq!(Asker::parse(stored), unknown, "{stored:?}");
        }
    }

    #[test]
    fn subagent_run_reads_as_delegating_not_running() {
        // The main transcript last wrote 5 min ago — the agent handed off to a
        // subagent and the main transcript then stayed silent for its whole run.
        let silent = seen(Some(T - 300_000), &[]);
        assert_eq!(
            live_state(AgentState::Active, &Asker::Unknown, &silent, T - 600_000, T),
            Some(AgentState::Idle),
            "without the subagent that silence reads as idle"
        );
        // …but a subagent actively writing its own file means the main loop is
        // blocked on it → "delegating", distinct from the agent itself running.
        let writing = seen(Some(T - 300_000), &[("a1", T)]);
        assert_eq!(
            live_state(
                AgentState::Active,
                &Asker::Unknown,
                &writing,
                T - 600_000,
                T
            ),
            Some(AgentState::Delegating)
        );
    }

    /// The hook clock is evidence in its own right, which is why the tool
    /// heartbeats exist: a long build or a long think writes nothing to the
    /// transcript, and decaying that turn to idle is the reported bug. So:
    ///  - a running turn with a fresh hook stays active, transcript or none;
    ///  - one whose hook and transcript are both older than the quiet window
    ///    decays to idle;
    ///  - a pending prompt still abstains with nothing readable: only the
    ///    asking thread moving past the recorded time can show the user
    ///    answered, and `recorded_at_ms` would resolve it against itself.
    #[test]
    fn the_hook_clock_keeps_a_running_turn_alive_but_resolves_no_prompt() {
        let nothing = Evidence::default();
        let long_silent = seen(Some(T - IDLE_QUIET_MS * 3), &[]);
        for (why, state, evidence, recorded, now, want) in [
            (
                "a fresh heartbeat, no transcript",
                AgentState::Active,
                &nothing,
                T,
                T,
                Some(AgentState::Active),
            ),
            (
                "no transcript, no heartbeat",
                AgentState::Active,
                &nothing,
                T,
                T + IDLE_QUIET_MS,
                Some(AgentState::Idle),
            ),
            (
                "a fresh heartbeat, a silent transcript",
                AgentState::Active,
                &long_silent,
                T - 2_000,
                T,
                Some(AgentState::Active),
            ),
            (
                "a stale heartbeat, a silent transcript",
                AgentState::Active,
                &long_silent,
                T - IDLE_QUIET_MS * 2,
                T,
                Some(AgentState::Idle),
            ),
            (
                "a prompt, no transcript",
                AgentState::Permission,
                &nothing,
                T,
                T,
                None,
            ),
        ] {
            assert_eq!(
                live_state(state, &Asker::Unknown, evidence, recorded, now),
                want,
                "{why}"
            );
        }
    }

    /// A permission dialog reads closed, and the row as the turn it was part
    /// of, by Claude's own signs ([`DialogMarks::closed_at`]): a render after
    /// it, or its own call finishing when it wasn't stacked. Never a stacked
    /// one by its call, never an elicitation. What closed it is the turn's
    /// activity, not the status line's later renders (they come every 15 s
    /// whatever the session does). With no record here to read (a Daedalus
    /// session's is on the box) a closed dialog reads active until the next
    /// hook. The row keeps the state the hook stored. Only the call finishing
    /// ends the call (`call_ended_at_ms`): a render, which a late-starting
    /// process can fake, never does.
    #[test]
    fn a_dialog_reads_closed_by_its_own_signs_only() {
        use santree_core::domain::AgentState::{Active, Idle, Permission, Waiting};
        let on_record = |kind: DialogKind,
                         stacked: bool,
                         rendered: Option<i64>,
                         resolved: Option<i64>,
                         record: bool| StateRow {
            state: kind.state().as_str().into(),
            transcript_path: record.then(|| "/w/s1.jsonl".into()),
            pending_kind: Some(kind.as_str().into()),
            pending_at_ms: Some(T),
            pending_stacked: Some(stacked),
            pending_rendered_at_ms: rendered,
            pending_resolved_at_ms: resolved,
            ..row("permission")
        };
        let (form, asks) = (DialogKind::Elicitation, DialogKind::Permission);
        let (rendered, resolved) = (Some(T + 2_000), Some(T + 3_000));
        let busy = T + 5_000;
        let later = T + 2_000 + IDLE_QUIET_MS;
        for (why, row, now, want, closed, ended) in [
            (
                "open",
                on_record(asks, false, None, None, true),
                busy,
                Permission,
                None,
                None,
            ),
            (
                "rendered",
                on_record(asks, false, rendered, None, true),
                busy,
                Active,
                rendered,
                None,
            ),
            (
                "rendered, stacked",
                on_record(asks, true, rendered, None, true),
                busy,
                Active,
                rendered,
                None,
            ),
            (
                "rendered, then quiet",
                on_record(asks, true, rendered, None, true),
                later,
                Idle,
                rendered,
                None,
            ),
            (
                "its call finished",
                on_record(asks, false, None, resolved, true),
                busy,
                Active,
                resolved,
                resolved,
            ),
            (
                "rendered, then its call finished",
                on_record(asks, false, rendered, resolved, true),
                busy,
                Active,
                resolved,
                resolved,
            ),
            (
                "finished, stacked",
                on_record(asks, true, None, resolved, true),
                busy,
                Permission,
                None,
                None,
            ),
            (
                "a form, rendered",
                on_record(form, false, rendered, None, true),
                busy,
                Waiting,
                None,
                None,
            ),
            (
                "no record",
                on_record(asks, false, None, resolved, false),
                later * 2,
                Active,
                resolved,
                resolved,
            ),
            (
                "no record, stacked",
                on_record(asks, true, None, resolved, false),
                busy,
                Permission,
                None,
                None,
            ),
        ] {
            let stored = AgentState::parse(&row.state);
            let read = reconcile(vec![row], now, &live([]), &no_roots()).remove(0);
            let ms = |at: Option<i64>| at.map(|ms| ms as f64);
            assert_eq!(
                (
                    Some(read.recorded_state),
                    read.state,
                    read.prompt.map(|p| (p.closed_at_ms, p.call_ended_at_ms))
                ),
                (stored, want, Some((ms(closed), ms(ended)))),
                "{why}"
            );
        }
    }

    /// The bug: Claude fires no `Stop` for a turn the user interrupts, so after an
    /// Esc the row read "working" for the whole quiet window. The record Claude
    /// writes for the interrupt ends the turn, and its time is what the
    /// conversation composer takes as the turn's end (`interrupted_at_ms`).
    #[test]
    fn an_interrupted_turn_reads_idle_without_waiting_out_the_quiet_window() {
        use santree_core::domain::AgentState::{Active, Idle, Permission};
        // A main-chain record as real transcripts carry it (CLI 2.1.291–2.1.312):
        // the keys are Claude's, the values made up.
        let record = |ms: i64, fields: Value| {
            let mut r = json!({
                "parentUuid": "7d1e0c52-5b0a-4f3e-9c41-2a8f6b3d9e10",
                "isSidechain": false,
                "promptId": "c3a9f1e2-6d4b-4a7c-8e5f-1b2d3c4e5f60",
                "type": "user",
                "uuid": "e4b8d2a1-9c3f-4e6a-b5d7-0f1a2b3c4d5e",
                "timestamp": chrono::DateTime::from_timestamp_millis(ms)
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "userType": "external",
                "entrypoint": "cli",
                "cwd": "/Users/me/dev/app",
                "sessionId": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
                "session_id": "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
                "version": "2.1.309",
                "gitBranch": "main",
            });
            if let (Value::Object(r), Value::Object(fields)) = (&mut r, fields) {
                r.extend(fields);
            }
            r.to_string()
        };
        let marker = |text: &str, ms: i64| {
            record(
                ms,
                json!({
                    "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
                    "interruptedMessageId": "msg_01AbCdEfGhIjKlMnOpQrStUv",
                }),
            )
        };
        // An Esc at a permission prompt rejects the tool, then writes its marker.
        let rejected = |ms: i64| {
            record(
                ms,
                json!({
                    "message": { "role": "user", "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_01AbCdEfGhIjKlMnOpQrStUv",
                        "content": "(rejected)",
                        "is_error": true,
                    }] },
                    "toolUseResult": "(rejected)",
                    "toolDenialKind": "user-rejected",
                    "sourceToolAssistantUUID": "2b6f4c1d-8e3a-4f5b-9c7d-6e1f0a2b3c4d",
                }),
            )
        };

        let answering = vec![
            conv("user", T),
            conv("assistant", T + 1_000),
            marker("[Request interrupted by user]", T + 2_000),
            META.to_string(),
        ];
        let at_prompt = vec![
            conv("user", T - 5_000),
            conv("assistant", T - 1_000),
            rejected(T + 3_000),
            marker("[Request interrupted by user for tool use]", T + 3_000),
        ];
        let next_turn = [
            answering.clone(),
            vec![conv("user", T + 5_000), conv("assistant", T + 6_000)],
        ]
        .concat();
        // (transcript, stored state, recorded at T + _, read at T + _, read as, marker at T + _)
        for (tag, lines, state, recorded, now, want, interrupted) in [
            // Esc while Claude was answering: idle now, not 30 s from now.
            ("answering", &answering, Active, 0, 4_000, Idle, Some(2_000)),
            // Esc at a prompt answers it and ends the turn with it.
            (
                "at-prompt",
                &at_prompt,
                Permission,
                0,
                5_000,
                Idle,
                Some(3_000),
            ),
            // The next prompt's hook lands before its transcript line: the marker
            // ended the turn before this one, which is running.
            (
                "resubmitted",
                &answering,
                Active,
                10_000,
                11_000,
                Active,
                None,
            ),
            // Once that line lands, the marker is not the newest record any more.
            ("next-turn", &next_turn, Active, 5_000, 7_000, Active, None),
        ] {
            let evidence = Evidence {
                main: main_activity(&lines.join("\n")),
                subagents: Vec::new(),
            };
            assert_eq!(
                reconcile_live_state(
                    state,
                    &Asker::Unknown,
                    &evidence,
                    T + recorded,
                    T + now,
                    None
                ),
                Reconciled {
                    state: Some(want),
                    interrupted_ms: interrupted.map(|ms| T + ms),
                },
                "{tag}"
            );
        }
    }

    /// A directory under the test's own scratch dir, emptied first.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("santree-hooks-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A Codex rollout shares nothing with a Claude transcript but its extension,
    /// so the Claude parser matches nothing in one and the reconciler saw "no
    /// evidence" — leaving every Codex session on whatever its last hook wrote,
    /// forever. Both the registry's `agent_kind` and (when that join is gone) the
    /// `rollout-` file name have to route it to the rollout reader.
    #[test]
    fn a_codex_rollout_reconciles_where_the_claude_parser_sees_nothing() {
        let now = now_ms();
        let stamp = |ms: i64| {
            chrono::DateTime::from_timestamp_millis(ms)
                .unwrap()
                .to_rfc3339()
        };
        let base = scratch("rollout");
        let sessions = base.join("sessions");
        let day = sessions.join("2026/08/28");
        std::fs::create_dir_all(&day).unwrap();
        let thread = "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d";
        let path = day.join(format!("rollout-2026-08-28T10-00-00-{thread}.jsonl"));
        let text = format!(
            "{}\n{}\n",
            // `session_meta` is the thread's *opening* record and must never
            // count as activity, or a thread idle since it opened reads fresh.
            json!({"timestamp": stamp(now - 600_000), "type": "session_meta",
                   "payload": {"id": thread, "cwd": "/w"}}),
            json!({"timestamp": stamp(now - 2_000), "type": "event_msg",
                   "payload": {"type": "agent_message", "message": "working"}}),
        );
        std::fs::write(&path, &text).unwrap();
        let roots = RecordRoots {
            claude: Vec::new(),
            codex: record_file::canonical(std::slice::from_ref(&sessions)),
        };
        let rollout = StateRow {
            session_id: thread.into(),
            transcript_path: Some(path.to_string_lossy().into_owned()),
            ..row("active")
        };

        // The Claude reader finds nothing in it — the old behaviour, now scoped.
        assert_eq!(main_activity(&text), MainLoop::default());
        // Routed by the registry's provider, and by the file name alone when
        // the terminal join is gone.
        for kind in [Some(AgentKind::Codex), None] {
            let evidence = evidence(&rollout, kind, &roots);
            assert_eq!(
                live_state(AgentState::Active, &Asker::Unknown, &evidence, T, now),
                Some(AgentState::Active),
                "{kind:?}"
            );
        }
        // And it genuinely reads the record timestamps: rewind them past the quiet
        // window and the same file reports idle.
        std::fs::write(
            &path,
            format!(
                "{}\n",
                json!({"timestamp": stamp(now - IDLE_QUIET_MS * 3), "type": "event_msg",
                       "payload": {"type": "agent_message", "message": "done"}}),
            ),
        )
        .unwrap();
        let evidence = evidence(&rollout, Some(AgentKind::Codex), &roots);
        assert_eq!(
            live_state(
                AgentState::Active,
                &Asker::Unknown,
                &evidence,
                now - IDLE_QUIET_MS * 2,
                now
            ),
            Some(AgentState::Idle)
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The transcript path is whatever a hook payload said, and any process
    /// running as the user can run the hook. So the record read is the one the
    /// row names — `<root>/<slug of cwd>/<session id>.jsonl`, or the reported
    /// path when it names that very file inside the roots — opened without
    /// following a link, without blocking, and checked inside the roots by the
    /// handle's own path. Each case plants something where a read would land;
    /// only the session's own record (two of them, the second found through a
    /// reported path after its cwd moved) may be read.
    #[test]
    fn a_reported_transcript_path_reads_only_that_sessions_own_record() {
        let base = scratch("evidence");
        let projects = base.join("projects");
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let roots = RecordRoots {
            claude: Vec::new(),
            codex: Vec::new(),
        };
        let roots = RecordRoots {
            claude: {
                std::fs::create_dir_all(&projects).unwrap();
                record_file::canonical(std::slice::from_ref(&projects))
            },
            ..roots
        };
        let records = format!("{}\n", conv("user", T));
        let sid = |n: u8| format!("9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e{n:02x}");
        let cwd = |n: u8| format!("/Users/me/dev/app{n}");
        let at = |n: u8| {
            projects
                .join(crate::session::project_slug(&cwd(n)))
                .join(format!("{}.jsonl", sid(n)))
        };
        let put = |path: &Path, text: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };

        // 1: the session's own record, where its cwd derives it.
        put(&at(1), &records);
        // 2: a FIFO where the record should be (opening one blocks for a writer).
        std::fs::create_dir_all(at(2).parent().unwrap()).unwrap();
        let fifo = std::ffi::CString::new(at(2).to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        // 3: a link to another session's record inside the roots.
        std::fs::create_dir_all(at(3).parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(at(1), at(3)).unwrap();
        // 4: the project directory itself a link to a directory outside.
        let elsewhere = outside.join("project");
        put(&elsewhere.join(format!("{}.jsonl", sid(4))), &records);
        std::os::unix::fs::symlink(&elsewhere, at(4).parent().unwrap()).unwrap();
        // 5: the right name, outside the roots.
        let stray = outside.join(format!("{}.jsonl", sid(5)));
        put(&stray, &records);
        // 7: a session whose cwd moved: found through the reported path.
        let moved = projects
            .join("-Users-me-dev-app7-sub")
            .join(format!("{}.jsonl", sid(7)));
        put(&moved, &records);

        let evidence_of = |n: u8, reported: &Path| {
            let row = StateRow {
                session_id: sid(n),
                cwd: cwd(n),
                launch_cwd: Some(cwd(n)),
                transcript_path: Some(reported.to_string_lossy().into_owned()),
                ..row("active")
            };
            evidence(&row, Some(AgentKind::Claude), &roots)
        };
        let read = Evidence {
            main: MainLoop {
                last_ms: Some(T),
                ..MainLoop::default()
            },
            subagents: Vec::new(),
        };
        let nothing = Evidence::default();
        for (n, reported, want, why) in [
            (1, at(1), &read, "its own record"),
            (2, at(2), &nothing, "a FIFO"),
            (3, at(3), &nothing, "a link in the record's place"),
            (4, at(4), &nothing, "a link above the record"),
            (
                5,
                stray.clone(),
                &nothing,
                "a reported path outside the roots",
            ),
            (6, at(1), &nothing, "another session's record, reported"),
            (
                7,
                moved.clone(),
                &read,
                "its own record, its cwd since moved",
            ),
        ] {
            assert_eq!(&evidence_of(n, &reported), want, "{n}: {why}");
        }
        // A Codex row reads only a rollout of its own thread inside Codex's root.
        let rollout = outside.join(format!("rollout-2026-08-28T10-00-00-{}.jsonl", sid(8)));
        put(&rollout, &records);
        let codex = StateRow {
            session_id: sid(8),
            transcript_path: Some(rollout.to_string_lossy().into_owned()),
            ..row("active")
        };
        assert_eq!(evidence(&codex, Some(AgentKind::Codex), &roots), nothing);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A row with a live-looking state whose terminal is gone is not running,
    /// whatever it last stored. This is the property that makes a sweeper
    /// unnecessary: the answer is recomputed from live state on every read, so
    /// there is nothing for a straggling hook write to win against.
    #[test]
    fn a_session_whose_terminal_died_cannot_read_as_running() {
        let joined = |state: &str| StateRow {
            message: Some("run Bash".into()),
            updated_at_ms: now_ms(),
            repo: Some("canary".into()),
            term_key: Some("tree:AK-1".into()),
            agent_kind: Some("Claude".into()),
            ..row(state)
        };

        for state in ["active", "delegating", "permission", "waiting"] {
            // Terminal still open → the stored state stands.
            let out = reconcile(
                vec![joined(state)],
                now_ms(),
                &live([("tree:AK-1", CLAUDE)]),
                &no_roots(),
            );
            assert_ne!(out[0].state, AgentState::Exited, "{state} with a live pty");

            // Terminal gone (closed, crashed, or the app restarted) → exited, and
            // the now-meaningless prompt text goes with it.
            let out = reconcile(
                vec![joined(state)],
                now_ms(),
                &live([("tree:OTHER", CLAUDE)]),
                &no_roots(),
            );
            assert_eq!(out[0].state, AgentState::Exited, "{state} with a dead pty");
            assert_eq!(out[0].message, None, "{state} keeps no stale prompt text");
        }

        // An app restart with in-app terminals leaves none live, which is the
        // correct answer rather than a missing one: that pty could not outlive
        // the process that opened it. (With a local server the answer is only
        // "none" when it is complete: see the test below.)
        let out = reconcile(vec![joined("active")], now_ms(), &live([]), &no_roots());
        assert_eq!(out[0].state, AgentState::Exited);
    }

    /// An incomplete answer is "unknown", never "exited": a local server santree
    /// can't reach may be holding agents that are working. Every row keeps the
    /// state it had — the prompt text a blocked one shows included — and a pane
    /// that *is* known live is still live.
    #[test]
    fn an_incomplete_liveness_answer_keeps_every_agent_as_it_was() {
        let joined = |term_key: &str, state: &str| StateRow {
            session_id: format!("s-{term_key}"),
            message: Some("Allow Bash?".into()),
            updated_at_ms: now_ms(),
            repo: Some("repo".into()),
            term_key: Some(term_key.into()),
            agent_kind: Some("Claude".into()),
            ..row(state)
        };
        let read = |rows, liveness: &Liveness| reconcile(rows, now_ms(), liveness, &no_roots());
        for state in ["active", "delegating", "permission", "waiting"] {
            // Absent from an answer that couldn't see everything: unknown.
            let out = read(
                vec![joined("tree:AK-1", state)],
                &unsure([("tree:OTHER", CLAUDE)]),
            );
            assert_ne!(
                out[0].state,
                AgentState::Exited,
                "{state} was declared exited on a partial answer"
            );
            // Nothing at all known (the server is down or not yet adopted).
            let out = read(vec![joined("tree:AK-1", state)], &unsure([]));
            assert_ne!(out[0].state, AgentState::Exited, "{state}, nothing known");
        }
        // The prompt a blocked agent shows survives: the row was left alone.
        let out = read(vec![joined("tree:AK-1", "permission")], &unsure([]));
        assert_eq!(out[0].state, AgentState::Permission);
        assert_eq!(out[0].message.as_deref(), Some("Allow Bash?"));
        // Positive evidence still counts, complete or not.
        let out = read(
            vec![joined("tree:AK-1", "active")],
            &unsure([("tree:AK-1", CLAUDE)]),
        );
        assert_eq!(out[0].state, AgentState::Active);
        // And a complete answer is the join it always was.
        let out = read(vec![joined("tree:AK-1", "active")], &live([]));
        assert_eq!(out[0].state, AgentState::Exited);
        assert_eq!(out[0].message, None);
    }

    /// The bug this join was rebuilt for. A triage investigation and an AI review
    /// open their PTY like every other surface — under the plain `term_key`, with
    /// the provider beside it — so the join finds them. It used to be handed a
    /// label the launch site had decorated with the provider (`AK-1::codex`),
    /// which matched no `term_key` at all: every one of these rows was forced to
    /// `Exited` while its agent sat there working, and a `waiting` review lost the
    /// only signal saying it needed a human.
    #[test]
    fn a_live_triage_or_review_pane_is_not_retired_by_the_join() {
        let joined = |term_key: &str, kind: &str, state: &str| StateRow {
            event: "Notification".into(),
            message: Some("Which environment?".into()),
            updated_at_ms: now_ms(),
            repo: Some("canary".into()),
            term_key: Some(term_key.into()),
            agent_kind: Some(kind.into()),
            ..row(state)
        };
        for (term_key, kind, agent) in [
            ("triage:AK-1", "Codex", Some(AgentKind::Codex)),
            ("ai-review:acme/web#53957", "Claude", CLAUDE),
        ] {
            let live_now = live([(term_key, agent)]);
            for state in ["active", "delegating", "permission", "waiting"] {
                let out = reconcile(
                    vec![joined(term_key, kind, state)],
                    now_ms(),
                    &live_now,
                    &no_roots(),
                );
                assert_ne!(
                    out[0].state,
                    AgentState::Exited,
                    "{term_key} ({kind}) is running in a live pane, in state {state}"
                );
            }
            // The prompt text a `waiting` row carries is what the retirement ate.
            let out = reconcile(
                vec![joined(term_key, kind, "waiting")],
                now_ms(),
                &live_now,
                &no_roots(),
            );
            assert_eq!(out[0].message.as_deref(), Some("Which environment?"));
        }
    }

    /// The shape the real database already holds: one `ai-review:` surface with a
    /// row per provider. They are two sessions in two panes, and the join answers
    /// each on its own evidence — a Codex pane is not proof that the Claude
    /// session beside it is alive.
    #[test]
    fn two_providers_on_one_surface_are_joined_apart() {
        let surface = "ai-review:acme/web#53957";
        let joined = |kind: &str| StateRow {
            session_id: format!("s-{kind}"),
            updated_at_ms: now_ms(),
            repo: Some("canary".into()),
            term_key: Some(surface.into()),
            agent_kind: Some(kind.into()),
            ..row("active")
        };
        let rows = vec![joined("Claude"), joined("Codex")];

        // Both panes open: both rows stand.
        let out = reconcile(
            rows.clone(),
            now_ms(),
            &live([(surface, CLAUDE), (surface, Some(AgentKind::Codex))]),
            &no_roots(),
        );
        assert!(out.iter().all(|s| s.state != AgentState::Exited));

        // Only Codex's pane open: Claude's row retires, Codex's does not. Keyed by
        // the surface alone, the Codex pane would have kept the dead Claude
        // session looking alive.
        let out = reconcile(
            rows,
            now_ms(),
            &live([(surface, Some(AgentKind::Codex))]),
            &no_roots(),
        );
        let state_of = |id: &str| {
            out.iter()
                .find(|s| s.session_id == id)
                .map(|s| s.state)
                .expect("row")
        };
        assert_eq!(state_of("s-Claude"), AgentState::Exited);
        assert_eq!(state_of("s-Codex"), AgentState::Active);
    }

    /// A row that lost its `terminal_sessions` join (a `/clear` mints a fresh id
    /// under the same terminal) has no terminal to join to, so the status line —
    /// which re-renders every `STATUSLINE_REFRESH_SECS` — is the fallback proof of
    /// life. A session that never rendered one is unknown, not dead: a false
    /// "exited" hides an agent that is working, which is the failure this whole
    /// path exists to prevent.
    #[test]
    fn an_unjoined_row_falls_back_to_the_status_line_heartbeat() {
        let now = now_ms();
        let empty = live([]);
        assert_eq!(
            terminal_liveness(None, None, Some(now - 5_000), now, &empty),
            Some(true),
            "a status line rendered seconds ago is a live session"
        );
        assert_eq!(
            terminal_liveness(None, None, Some(now - HEARTBEAT_DEAD_MS - 1), now, &empty),
            Some(false),
            "one that has been silent for four missed renders is gone"
        );
        assert_eq!(
            terminal_liveness(None, None, None, now, &empty),
            None,
            "never rendered one at all (any Codex session) — unknown, not dead"
        );

        // And a row with no evidence either way is left exactly as stored.
        let unjoined = StateRow {
            updated_at_ms: now,
            agent_kind: Some("Codex".into()),
            ..row("active")
        };
        assert_eq!(
            reconcile(vec![unjoined], now, &empty, &no_roots())[0].state,
            AgentState::Active
        );
    }

    /// The PTY-exit write: only live-looking rows are retired, and only for the
    /// terminal that actually died. The `cwd` scope is the load-bearing half —
    /// `term_key` alone is unique per repo, so without it one repo's closing tab
    /// would stamp "exited" onto another repo's *running* agent, and nothing would
    /// take that back.
    #[tokio::test]
    async fn a_pty_exit_retires_only_its_own_live_rows() {
        let base = std::env::temp_dir().join(format!("santree-retire-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        // Two repos, same `term_key`, different worktrees — plus a settled row in
        // the dying terminal that must keep its own timestamp. That third row is
        // `Codex`, not a second `Claude`: `terminal_sessions` is UNIQUE on
        // (repo, term_key, agent_kind), so one terminal holds at most one live
        // session *per provider*, and a same-kind duplicate is unrepresentable.
        for (repo, session, cwd, kind) in [
            ("alpha", "s-alpha", "/w/alpha", "Claude"),
            ("beta", "s-beta", "/w/beta", "Claude"),
            ("alpha", "s-done", "/w/alpha", "Codex"),
        ] {
            sqlx::query(
                "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind) \
                 VALUES (?, 'tree:AK-1', ?, ?, ?)",
            )
            .bind(repo)
            .bind(cwd)
            .bind(session)
            .bind(kind)
            .execute(&db)
            .await
            .unwrap();
        }
        for (session, state) in [
            ("s-alpha", "active"),
            ("s-beta", "active"),
            ("s-done", "idle"),
        ] {
            sqlx::query(
                "INSERT INTO session_state (session_id, state, event, cwd, updated_at_ms) \
                 VALUES (?, ?, 'UserPromptSubmit', '/w', 1)",
            )
            .bind(session)
            .bind(state)
            .execute(&db)
            .await
            .unwrap();
        }

        let retired = retire_terminal(&db, "tree:AK-1", None, Some("/w/alpha"))
            .await
            .unwrap();
        assert_eq!(retired, 1, "only alpha's running session");

        let state_of = |id: &'static str| {
            let db = db.clone();
            async move {
                sqlx::query_as::<_, (String, String, i64)>(
                    "SELECT state, event, updated_at_ms FROM session_state WHERE session_id = ?",
                )
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap()
            }
        };
        let (state, event, _) = state_of("s-alpha").await;
        assert_eq!(state, "exited");
        assert_eq!(
            event, PTY_EXIT_EVENT,
            "provenance is santree watching the process, not a CLI event"
        );
        assert_eq!(
            state_of("s-beta").await.0,
            "active",
            "the other repo's live agent is untouched"
        );
        let (state, _, updated) = state_of("s-done").await;
        assert_eq!(state, "idle", "a settled row keeps its state…");
        assert_eq!(updated, 1, "…and its timestamp, which means 'last worked'");

        // With no cwd to scope by, every row under the key is fair game — the
        // caller only passes `None` when the pty never reported one.
        assert_eq!(
            retire_terminal(&db, "tree:AK-1", None, None).await.unwrap(),
            1
        );
        assert_eq!(state_of("s-beta").await.0, "exited");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A Claude event for session `sid`, through the hook's own code into
    /// `db` — the writes the binary makes for it.
    async fn hook(db: &crate::db::Db, event: &str, payload: Value) {
        let mut conn = db.acquire().await.unwrap();
        let applied = santree_hook::apply(
            &mut conn,
            &santree_hook::Invocation::Hook {
                event: event.into(),
                agent: AgentKind::Claude,
            },
            payload.to_string().as_bytes(),
            &santree_hook::HookEnv::default(),
        )
        .await;
        assert!(
            applied.failures.is_empty(),
            "{event}: {:?}",
            applied.failures
        );
    }

    /// The dialog a `PermissionRequest` put up reaches the frontend with the
    /// row it was stored with, by the migrated schema and the hook's own
    /// writes: through the Notification ~6 s later, and not past a write that
    /// isn't the one that stored it (an older hook binary's, which leaves the
    /// columns behind) or past the turn's end.
    #[tokio::test]
    async fn the_dialog_on_record_reaches_the_view_while_it_is_the_rows() {
        let base = scratch("dialog-e2e");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let sid = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e51";
        let asks = json!({
            "session_id": sid, "cwd": "/w", "prompt_id": "p-1",
            "permission_mode": "default", "effort": { "level": "medium" },
            "hook_event_name": "PermissionRequest", "tool_name": "Bash",
            "tool_input": { "command": "touch probe-a", "description": "Create probe file" },
            "permission_suggestions": [{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }],
        });
        let read = || {
            let db = db.clone();
            async move {
                let states = session_states(&db, live([])).await.unwrap();
                states.into_iter().find(|s| s.session_id == sid).unwrap()
            }
        };

        hook(&db, "PermissionRequest", asks.clone()).await;
        let state = read().await;
        let prompt = state.prompt.clone().expect("the dialog on record");
        assert_eq!(
            (
                prompt.kind,
                prompt.tool_name.as_deref(),
                serde_json::from_str::<Value>(&prompt.tool_input).unwrap(),
                prompt
                    .suggestions
                    .as_deref()
                    .map(|s| serde_json::from_str::<Value>(s).unwrap()),
                prompt.permission_mode.as_deref(),
                prompt.prompt_id.as_deref(),
                prompt.recorded_at_ms,
                prompt.truncated,
            ),
            (
                DialogKind::Permission,
                Some("Bash"),
                asks["tool_input"].clone(),
                Some(asks["permission_suggestions"].clone()),
                Some("default"),
                Some("p-1"),
                state.updated_at_ms,
                false,
            )
        );
        assert_eq!(
            (
                state.permission_mode.as_deref(),
                state.effort_level.as_deref()
            ),
            (Some("default"), Some("medium"))
        );

        hook(
            &db,
            "Notification",
            json!({ "session_id": sid, "cwd": "/w", "notification_type": "permission_prompt",
                    "message": "Claude needs your permission" }),
        )
        .await;
        assert_eq!(read().await.prompt, Some(prompt.clone()));

        // A write that didn't store the dialog leaves its columns, not its claim.
        sqlx::query("UPDATE session_state SET updated_at_ms = updated_at_ms + 1")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(read().await.prompt, None);

        hook(&db, "PermissionRequest", asks.clone()).await;
        assert!(read().await.prompt.is_some());
        // Its own call finishing closes it, and the row reads as the turn
        // going on, while it keeps what the hook stored.
        let mut ran = asks;
        ran["hook_event_name"] = "PostToolUse".into();
        ran["tool_response"] = json!({ "stdout": "", "stderr": "", "interrupted": false });
        ran["tool_use_id"] = "toolu_01AbCdEfGhIjKlMnOpQrStUv".into();
        hook(&db, "PostToolUse", ran).await;
        let state = read().await;
        assert_eq!(
            (
                state.recorded_state,
                state.state,
                state.prompt.map(|p| (
                    p.stacked,
                    p.call_ended_at_ms.is_some_and(|at| at >= p.recorded_at_ms),
                    p.closed_at_ms == p.call_ended_at_ms
                ))
            ),
            (
                AgentState::Permission,
                AgentState::Active,
                Some((false, true, true))
            )
        );
        hook(
            &db,
            "Stop",
            json!({ "session_id": sid, "cwd": "/w", "prompt_id": "p-1" }),
        )
        .await;
        let state = read().await;
        assert_eq!(
            (state.recorded_state, state.prompt),
            (AgentState::Idle, None)
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The reply as Claude draws it, from `MessageDisplay` payloads as CLI
    /// 2.1.312 sends them, through the hook into the migrated schema and back:
    /// batches that land out of order (captured) read in order, and only from
    /// the message's start; the next message replaces it; the cap keeps the
    /// tail; the turn's `Stop` ends it, and a batch landing after that `Stop`
    /// (they fire in the same millisecond) does not bring it back.
    #[tokio::test]
    async fn a_streaming_reply_reads_in_order_and_ends_with_its_turn() {
        let base = scratch("live-text");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let sid = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e52";
        let batch = |message: &str, index: u32, last: bool, delta: &str| {
            json!({
                "session_id": sid, "transcript_path": "/t.jsonl", "cwd": "/w",
                "prompt_id": "p-1", "hook_event_name": "MessageDisplay",
                "turn_id": "turn-1", "message_id": message, "index": index,
                "final": last, "delta": delta,
            })
        };
        let text = || {
            let db = db.clone();
            async move {
                session_live_text(&db, sid)
                    .await
                    .unwrap()
                    .map(|live| (live.text, live.complete, live.truncated))
            }
        };

        hook(
            &db,
            "UserPromptSubmit",
            json!({ "session_id": sid, "cwd": "/w", "prompt_id": "p-1", "prompt": "go" }),
        )
        .await;
        hook(
            &db,
            "MessageDisplay",
            batch("m-1", 1, true, "Alpha line three"),
        )
        .await;
        assert_eq!(text().await, None, "the start hasn't landed yet");
        hook(
            &db,
            "MessageDisplay",
            batch("m-1", 0, false, "Alpha line one\nAlpha line two\n"),
        )
        .await;
        assert_eq!(
            text().await,
            Some((
                "Alpha line one\nAlpha line two\nAlpha line three".into(),
                true,
                false
            ))
        );

        hook(&db, "MessageDisplay", batch("m-2", 0, false, "Beta one\n")).await;
        assert_eq!(text().await, Some(("Beta one\n".into(), false, false)));
        let long = "x".repeat(20 * 1024) + "\n";
        hook(&db, "MessageDisplay", batch("m-2", 1, false, &long)).await;
        hook(&db, "MessageDisplay", batch("m-2", 2, false, &long)).await;
        let (kept, _, cut) = text().await.unwrap();
        assert!(cut && kept == long, "the cap keeps the newest batches");

        hook(
            &db,
            "Stop",
            json!({ "session_id": sid, "cwd": "/w", "prompt_id": "p-1" }),
        )
        .await;
        assert_eq!(text().await, None);
        // A one-line reply is one batch (index 0, final) fired in the same
        // millisecond as the turn's `Stop`, and it can land after it.
        hook(&db, "MessageDisplay", batch("m-3", 0, true, "Gamma done")).await;
        assert_eq!(text().await, None, "a batch of a turn that is over");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A message queued while Claude worked starts its own turn right after the
    /// `Stop`, and no hook says so (CLI 2.1.312, captured): an idle row whose
    /// transcript holds that delivery, with no turn end after it, is working.
    /// Display only — the row keeps what the hook stored.
    #[test]
    fn a_queued_delivery_after_stop_reads_as_working() {
        let base = scratch("queued");
        let projects = base.join("projects");
        let sid = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e53";
        let cwd = "/Users/me/dev/app";
        let path = projects
            .join(crate::session::project_slug(cwd))
            .join(format!("{sid}.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let roots = RecordRoots {
            claude: record_file::canonical(std::slice::from_ref(&projects)),
            codex: Vec::new(),
        };
        let now = now_ms();
        let stopped = now - 2_000;
        let at = |ms: i64| {
            chrono::DateTime::from_timestamp_millis(ms)
                .unwrap()
                .to_rfc3339()
        };
        let user = |ms: i64, source: &str, text: &str| {
            json!({"type": "user", "isSidechain": false, "promptSource": source,
                   "timestamp": at(ms), "message": {"role": "user", "content": text}})
            .to_string()
        };
        let end = |ms: i64| {
            json!({"type": "system", "subtype": "turn_duration", "isSidechain": false,
                   "timestamp": at(ms)})
            .to_string()
        };
        let first_turn = [
            user(stopped - 10_000, "typed", "first"),
            conv("assistant", stopped - 5),
            end(stopped),
        ];
        let read = |lines: &[String], stored: i64| {
            std::fs::write(&path, lines.join("\n") + "\n").unwrap();
            let row = StateRow {
                session_id: sid.into(),
                event: "Stop".into(),
                cwd: cwd.into(),
                transcript_path: Some(path.to_string_lossy().into_owned()),
                updated_at_ms: stored,
                repo: Some("canary".into()),
                term_key: Some("tree:AK-1".into()),
                agent_kind: Some("Claude".into()),
                launch_cwd: Some(cwd.into()),
                ..row("idle")
            };
            let out = reconcile(vec![row], now, &live([("tree:AK-1", CLAUDE)]), &roots);
            (out[0].state, out[0].recorded_state)
        };
        let delivered = [
            first_turn.to_vec(),
            vec![user(stopped + 5, "queued", "queued while it worked")],
        ]
        .concat();

        assert_eq!(
            read(&first_turn, stopped),
            (AgentState::Idle, AgentState::Idle)
        );
        assert_eq!(
            read(&delivered, stopped),
            (AgentState::Active, AgentState::Idle)
        );
        // The delivered turn ended (its own `Stop` is on its way), or the user
        // stopped it: idle again.
        let interrupted =
            json!({"type": "user", "isSidechain": false, "timestamp": at(stopped + 900),
                                 "message": {"role": "user", "content": [
                                     {"type": "text", "text": "[Request interrupted by user]"}]}})
            .to_string();
        for ended in [end(stopped + 900), interrupted] {
            let lines = [delivered.clone(), vec![ended]].concat();
            assert_eq!(read(&lines, stopped), (AgentState::Idle, AgentState::Idle));
        }
        // A row stored well after the delivery is that turn's own `Stop`,
        // whatever records the CLI writes at a turn's end.
        let second_stop = now - 500;
        let answered = [
            user(second_stop - 30_000, "typed", "first"),
            end(second_stop - 20_005),
            user(second_stop - 20_000, "queued", "queued while it worked"),
            conv("assistant", second_stop - 100),
        ];
        assert_eq!(
            read(&answered, second_stop),
            (AgentState::Idle, AgentState::Idle)
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The heartbeat is injected for both providers, or the mid-turn signal it
    /// carries never fires and a working agent decays to "idle" mid-turn (it
    /// did, once, for Codex). `PreToolUse` races its own permission prompt, and
    /// Codex's subagent/compaction events carry neither a state nor liveness —
    /// registering them would run the hook binary on every tool call for nothing.
    #[test]
    fn both_providers_inject_the_heartbeat_and_none_of_the_noise() {
        for (provider, events) in [("Claude", EVENTS), ("Codex", CODEX_EVENTS)] {
            assert!(events.contains(&"PostToolUse"), "{provider}");
            assert!(!events.contains(&"PreToolUse"), "{provider}");
        }
        assert!(EVENTS.contains(&"PostToolUseFailure"));
        for noisy in ["SubagentStart", "SubagentStop", "PreCompact"] {
            assert!(!CODEX_EVENTS.contains(&noisy), "{noisy}");
        }
    }

    /// Split a command line into argv the way a POSIX shell would, for the
    /// subset of quoting santree emits: unquoted words, single-quoted runs, and
    /// the close-escape-reopen (`'\''`) idiom for an embedded quote.
    fn shell_split(line: &str) -> Vec<String> {
        let (mut argv, mut cur) = (Vec::new(), String::new());
        let (mut started, mut quoted) = (false, false);
        let mut chars = line.chars();
        while let Some(c) = chars.next() {
            match c {
                '\'' if quoted => quoted = false,
                '\'' => {
                    quoted = true;
                    started = true;
                }
                '\\' if !quoted => {
                    if let Some(escaped) = chars.next() {
                        cur.push(escaped);
                        started = true;
                    }
                }
                ' ' if !quoted => {
                    if started {
                        argv.push(std::mem::take(&mut cur));
                        started = false;
                    }
                }
                _ => {
                    cur.push(c);
                    started = true;
                }
            }
        }
        if started {
            argv.push(cur);
        }
        argv
    }

    /// The value of the TOML basic string starting at the first `"` in `s`, with
    /// escapes resolved — the inverse of [`toml_quote`].
    fn toml_unquote(s: &str) -> String {
        let mut chars = s[s.find('"').expect("a basic string") + 1..].chars();
        let mut out = String::new();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('r') => out.push('\r'),
                    Some('t') => out.push('\t'),
                    Some(other) => out.push(other),
                    None => break,
                },
                _ => out.push(c),
            }
        }
        out
    }

    /// All THREE quoting layers, pinned by taking a real flag apart again. The
    /// innermost one is where the bug lived: the db path is
    /// `~/Library/Application Support/…`, and unquoted it bound `--db` to
    /// `/Users/…/Library/Application`, so every hook wrote to a db that isn't
    /// there — which the hook binary treats as "nothing to do" and exits 0, so
    /// Codex reported the hook completed and santree recorded nothing. Building
    /// the command by hand from a space-free path is exactly what let that pass.
    #[test]
    fn the_codex_hook_flag_survives_all_three_quoting_layers() {
        let bin = r#"/Apps/My "App"/santree-hook"#;
        let db = "/Users/me/Library/Application Support/com.santree.desktop/santree.db";
        let flag = codex_hook_flag(
            &format!("{} --db {}", sh_quote(bin), sh_quote(db)),
            "SessionStart",
        );
        assert!(
            flag.contains(r#"My \"App\""#),
            "an embedded quote must be escaped for TOML, not left to end the string: {flag}"
        );

        // Layer 3: the whole assignment is ONE shell word after `-c`.
        let argv = shell_split(&flag);
        assert_eq!(argv.len(), 2, "expected `-c <entry>`, got {argv:?}");
        assert_eq!(argv[0], "-c");
        let entry = &argv[1];
        assert!(
            entry.starts_with(r#"hooks.SessionStart=[{hooks=[{type="command","#),
            "the TOML assignment must survive the shell word intact: {entry}"
        );

        // Layer 2: the command is a TOML basic string.
        let command = toml_unquote(&entry[entry.find(",command=").expect("a command key")..]);

        // Layer 1: the command line Codex hands to a shell must re-tokenise to
        // exactly the argv santree meant — spaced paths and all.
        assert_eq!(
            shell_split(&command),
            vec![bin, "--db", db, "--agent-kind", "Codex", "SessionStart"],
            "the hook command re-tokenised wrong: {command}"
        );
    }
}
