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

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use santree_core::domain::{
    AgentKind, AgentState, ClaudeRateLimitWindow, SessionState, SessionUsageLive,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::db::Db;

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
/// Every name here is verified against the CLI's own embedded hook-event table
/// (`claude.exe`, the "### Hook Events" doc block), not guessed.
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
];

/// Resolve the absolute path to the bundled `santree-hook` binary: the resource
/// dir in a bundled build, else a sibling of the running executable in dev (both
/// land in `target/debug`). `None` if neither exists.
pub(crate) fn hook_bin(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("santree-hook");
        if p.exists() {
            return Some(p);
        }
    }
    let sib = std::env::current_exe().ok()?.parent()?.join("santree-hook");
    sib.exists().then_some(sib)
}

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
/// `tutor` is the rendered English-tutor instruction, or `None` when the tutor is
/// off — see [`tutor_entry`]. It's passed in rather than read here because it's an
/// editable prompt with a db-backed override, and this builder is sync.
fn base_settings_map(app: &AppHandle, tutor: Option<&str>) -> Option<Map<String, Value>> {
    // Both the hooks and the statusline invoke `santree-hook` against the db, so
    // resolve them once.
    let (bin, db_pathbuf) = (hook_bin(app)?, db_path(app)?);
    // Claude runs `command` through a shell, so both paths are shell-quoted:
    // app_data_dir always has a space ("Application Support") and a home directory
    // may contain `$`/backtick/quote characters too.
    let (bin, db) = (sh_quote(bin.to_str()?), sh_quote(db_pathbuf.to_str()?));

    let mut root = Map::new();

    let mut hooks = Map::new();
    for &event in EVENTS {
        // SessionEnd runs synchronously (short timeout) so "exited" reliably lands
        // before session teardown; the rest are async so they never add latency to
        // a turn — and, crucially, so this hook can never gate a Claude decision.
        let is_end = event == "SessionEnd";
        let command = format!("{bin} --db {db} {event}");

        let mut hook = Map::new();
        hook.insert("type".into(), json!("command"));
        hook.insert("command".into(), json!(command));
        hook.insert("timeout".into(), json!(if is_end { 5 } else { 10 }));
        if !is_end {
            hook.insert("async".into(), json!(true));
        }

        hooks.insert(
            event.to_string(),
            json!([{ "hooks": [Value::Object(hook)] }]),
        );
    }

    // The English tutor rides along as a *second* `UserPromptSubmit` entry, next to
    // the state hook above (Claude runs every entry for an event). Two things about
    // it are load-bearing and easy to get wrong:
    //  - it is **synchronous** — no `async: true`. An async hook is fire-and-forget
    //    and its stdout is discarded, so the instruction would never reach the model
    //    and the tutor would silently do nothing.
    //  - it grants `Edit` on the log, because the instruction ends by telling the
    //    agent to append the corrections there; without the grant every turn stops
    //    on a permission prompt.
    if let Some(instruction) = tutor {
        if let Some((prompt_file, log)) = tutor_files(app, instruction) {
            if let Some(entries) = hooks
                .get_mut("UserPromptSubmit")
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

    root.insert("hooks".into(), Value::Object(hooks));

    // santree's own status line: the `statusline` mode of the same binary. Prints
    // a context-fill bar AND captures Claude's authoritative usage into the db.
    // Always injected — the app gates *display* of the inline bar at runtime, so
    // capture must run regardless of the setting (see [`claude_settings`]).
    root.insert(
        "statusLine".into(),
        json!({
            "type": "command",
            "command": statusline_command(&bin, &db, None),
            "refreshInterval": STATUSLINE_REFRESH_SECS,
        }),
    );

    Some(root)
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
    let mut command = format!("{bin} --db {db} statusline");
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
/// (see `transcript_activity_ms`). Codex has no `PostToolUseFailure`.
///
/// The other five (`PreToolUse`, `SubagentStart`, `SubagentStop`, `PreCompact`,
/// `PostCompact`) would fire the hook binary for no state change, so they are
/// left unregistered rather than registered-and-ignored.
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
    let (bin, db_pathbuf) = (hook_bin(app)?, db_path(app)?);
    let (bin, db) = (bin.to_str()?, db_pathbuf.to_str()?);

    let flags: Vec<String> = CODEX_EVENTS
        .iter()
        .map(|event| codex_hook_flag(bin, db, event))
        .collect();
    Some(flags.join(" "))
}

/// The single `-c 'hooks.<Event>=[…]'` flag for one event, from the *unquoted*
/// binary and db paths. Split out from [`codex_hook_flags`] so the three quoting
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
fn codex_hook_flag(bin: &str, db: &str, event: &str) -> String {
    let (bin, db) = (sh_quote(bin), sh_quote(db));
    // The event is the positional arg, exactly as Claude's is: the injected
    // command is what santree decided this hook means, so it must not depend on
    // the payload agreeing.
    let command = format!("{bin} --db {db} --agent-kind Codex {event}");
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

pub fn claude_settings(app: &AppHandle, tutor: Option<&str>) -> Option<String> {
    write_settings(app, "claude-hooks.json", base_settings_map(app, tutor)?)
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
pub fn claude_settings_no_git(app: &AppHandle, tutor: Option<&str>) -> Option<String> {
    restricted_settings(app, NO_GIT_SETTINGS_FILE, &NO_GIT_RULES, &[], tutor)
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
pub fn claude_settings_ai_review(app: &AppHandle, tutor: Option<&str>) -> Option<String> {
    let allow = format!("mcp__{MCP_SERVER_NAME}");
    restricted_settings(
        app,
        AI_REVIEW_SETTINGS_FILE,
        &review_deny_rules(),
        &[&allow],
        tutor,
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
    tutor: Option<&str>,
) -> Option<String> {
    let mut root = base_settings_map(app, tutor)?;
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
    let bin = hook_bin(app).ok_or_else(|| {
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
    Ok(())
}

/// Every session's live usage row (from the status-line capture), newest first.
pub async fn session_usage_live(db: &Db) -> Result<Vec<SessionUsageLive>> {
    let rows = sqlx::query_as::<_, (String, f64, i64, i64, String, f64, i64)>(
        "SELECT session_id, used_pct, input_tokens, context_size, model, cost_usd, updated_at_ms \
         FROM session_usage_live ORDER BY updated_at_ms DESC LIMIT ?",
    )
    .bind(MAX_SESSION_ROWS)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(session_id, used_pct, input_tokens, context_size, model, cost_usd, updated_at_ms)| {
                SessionUsageLive {
                    agent_kind: santree_core::domain::AgentKind::Claude,
                    session_id,
                    used_pct,
                    input_tokens: input_tokens as f64,
                    context_size: context_size as f64,
                    model,
                    cost_usd,
                    updated_at_ms: updated_at_ms as f64,
                }
            },
        )
        .collect())
}

/// Claude's account rate-limit windows as the status line last reported them
/// (`claude_rate_limits`, one row per window, written by the hook's statusline
/// mode). Empty until a santree-launched subscriber session has rendered a status
/// line after its first API response — API-key sessions never report any.
pub async fn claude_rate_limits(db: &Db) -> Result<Vec<ClaudeRateLimitWindow>> {
    let rows = sqlx::query_as::<_, (String, f64, Option<i64>, i64)>(
        "SELECT window, used_pct, resets_at_ms, updated_at_ms \
         FROM claude_rate_limits ORDER BY window",
    )
    .fetch_all(db)
    .await?;
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
/// **Alive** is a join, never a stored record. `live_terminals` is the set of
/// `term_key`s that have a live PTY *right now*, straight out of the in-memory
/// [`santree_pty::PtyManager`]. A row whose terminal is not in that set cannot be
/// running, whatever it last stored — so a dead agent is unrepresentable as a
/// live-looking state, no matter how its terminal died (a kill -9, a crash, the
/// app quitting). santree is unusually well placed to do this: the seed is
/// `exec <cli>`, so the PTY *is* the agent process, and there is no daemon — a
/// PTY cannot outlive the app. That is why this needs no sweeper, no decay timer
/// and no background poll, and why a straggling hook write cannot defeat it: the
/// join is re-evaluated from live state on every read, so there is nothing for a
/// late write to win against.
///
/// **Doing** is reconciled against the transcript (see [`reconcile_live_state`]):
/// the "needs-you" states are set by a hook, but the user *resolving* the prompt
/// in the terminal (accept / reject a permission, or type a reply) fires no hook,
/// so a stored row can be stale.
pub async fn session_states(db: &Db, live_terminals: HashSet<String>) -> Result<Vec<SessionState>> {
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
                s.updated_at_ms, t.repo, t.term_key, t.agent_kind, u.updated_at_ms \
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
    Ok(tokio::task::spawn_blocking(move || reconcile_rows(rows, now_ms, &live_terminals)).await?)
}

/// A `session_state` row as stored (`state` is the TEXT column, still unparsed),
/// with the owning logical terminal joined on and the status line's last render:
/// `(session_id, state, event, cwd, message, transcript_path, updated_at_ms,
/// repo, term_key, agent_kind, heartbeat_ms)`.
type StateRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

/// Parse + reconcile a batch of stored rows. Blocking (transcript fs reads) —
/// always call from `spawn_blocking`.
fn reconcile_rows(
    rows: Vec<StateRow>,
    now_ms: i64,
    live_terminals: &HashSet<String>,
) -> Vec<SessionState> {
    rows.into_iter()
        .filter_map(
            |(
                session_id,
                stored,
                event,
                cwd,
                mut message,
                transcript_path,
                updated_at_ms,
                repo,
                term_key,
                agent_kind,
                heartbeat_ms,
            )| {
                let Some(mut state) = AgentState::parse(&stored) else {
                    // The hook binary is built separately, so a stale copy on disk
                    // can write a state this build doesn't know. Drop the row rather
                    // than guess — a wrong badge is worse than a missing one.
                    log::warn!("session {session_id}: unknown state {stored:?}, skipping");
                    return None;
                };
                let kind = agent_kind.as_deref().and_then(|k| k.parse().ok());
                // The hook events set a state but can't reliably clear it (a manual
                // accept/reject and a turn that ends without a `Stop` both fire
                // nothing). So we reconcile the live state against the transcript —
                // the ground truth — and drop the now-irrelevant prompt text when the
                // state is no longer a "needs-you" one.
                if let Some(live) = reconcile_live_state(
                    state,
                    transcript_path.as_deref(),
                    kind,
                    updated_at_ms,
                    now_ms,
                ) {
                    if !live.is_blocked_on_user() {
                        message = None;
                    }
                    state = live;
                }
                // …and whatever the events and the transcript agree on, a session
                // whose terminal is gone is not running. This is the last word
                // because it is the only one derived from live state rather than a
                // record: see [`session_states`].
                if state != AgentState::Exited
                    && terminal_liveness(term_key.as_deref(), heartbeat_ms, now_ms, live_terminals)
                        == Some(false)
                {
                    state = AgentState::Exited;
                    message = None;
                }
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
                    session_id,
                    state,
                    event,
                    cwd,
                    message,
                    transcript_path,
                    updated_at_ms: updated_at_ms as f64,
                    repo,
                    term_key,
                })
            },
        )
        .collect()
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
const HEARTBEAT_DEAD_MS: i64 = STATUSLINE_REFRESH_SECS as i64 * 1_000 * 4;

/// Is the terminal hosting this session still alive? `None` = no evidence either
/// way, and the caller must leave the row alone.
///
/// The asymmetry is deliberate. A false "dead" **hides an agent that is working**
/// — the exact complaint this whole path exists to fix — while a false "alive"
/// only delays a retirement until the transcript-quiet check catches it. So this
/// answers `Some(false)` only on positive evidence of death, and shrugs
/// otherwise.
///
/// - **`term_key` present** — decisive, both ways. `live_terminals` comes from
///   the in-memory PTY manager, which is the whole truth about what is running:
///   santree has no daemon, so a session with no live PTY has no process. This is
///   also what makes an app restart correct for free — nothing is live, so every
///   stored row retires instead of sitting at "active" until a timer notices.
///
///   Matched on `term_key` alone, never on `cwd`. The key is santree's own opaque
///   string, compared byte-for-byte against the `label` the same frontend value
///   opened the PTY under; a `cwd` would have to survive path normalization
///   (`/var` vs `/private/var` on macOS alone), and a normalization mismatch here
///   would retire *every* session at once. The cost is that two repos sharing a
///   `term_key` (`tree:AK-1` in both) read as live while either is — permissive
///   in the safe direction, by design.
///
/// - **`term_key` absent** — a session that lost its registry join (a `/clear`
///   mints a fresh id under the old terminal). Fall back to the status line: a
///   session that has *ever* rendered one but has now gone quiet past
///   [`HEARTBEAT_DEAD_MS`] is gone. One that never rendered one at all (any Codex
///   session — Codex has no status-line hook) yields `None`, not a guess.
fn terminal_liveness(
    term_key: Option<&str>,
    heartbeat_ms: Option<i64>,
    now_ms: i64,
    live_terminals: &HashSet<String>,
) -> Option<bool> {
    match term_key {
        Some(key) => Some(live_terminals.contains(key)),
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
pub async fn retire_terminal(db: &Db, term_key: &str, cwd: Option<&str>) -> Result<u64> {
    let rows = sqlx::query(
        "UPDATE session_state SET state = ?, event = ?, message = NULL, updated_at_ms = ? \
         WHERE state IN ('active', 'delegating', 'permission', 'waiting') \
           AND session_id IN ( \
                 SELECT session_id FROM terminal_sessions \
                 WHERE term_key = ? AND (? IS NULL OR cwd = ?))",
    )
    .bind(AgentState::Exited.as_str())
    .bind(PTY_EXIT_EVENT)
    .bind(now_ms())
    .bind(term_key)
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

/// Read the last `max_bytes` of a file as text (lossy). Used to scan a session
/// transcript's tail cheaply — they grow to many MB over a long session, but the
/// only thing that matters here is the most recent few conversation turns. A
/// partial first line (from seeking mid-file) just fails to parse and is skipped.
fn read_tail(path: &str, max_bytes: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(max_bytes)))
        .ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
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

/// The `subagents/` dir for a session, derived from its transcript path:
/// `.../<sid>.jsonl` → `.../<sid>/subagents`. Claude writes each Task-tool
/// subagent's transcript to its own `agent-*.jsonl` here.
fn subagents_dir(transcript_path: &str) -> Option<PathBuf> {
    let p = Path::new(transcript_path);
    Some(p.parent()?.join(p.file_stem()?).join("subagents"))
}

/// Newest mtime (epoch-ms) across the session's subagent transcript files, or
/// `None` if there are none. While a subagent (Task tool) runs, the *main*
/// transcript stays silent for its whole duration — only the spawn + the final
/// result land there — so without this a subagent running longer than
/// `IDLE_QUIET_MS` would make the parent look idle. Subagent files are pure agent
/// conversation (no remote-control trailer), so their mtime is a clean "a
/// subagent just did something" signal.
fn newest_subagent_write_ms(transcript_path: &str) -> Option<i64> {
    let dir = subagents_dir(transcript_path)?;
    let mut newest: Option<i64> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if entry.path().extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(ms) = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
        {
            newest = Some(newest.map_or(ms, |cur| cur.max(ms)));
        }
    }
    newest
}

/// Epoch-ms of the newest activity in a session's transcript, whichever provider
/// wrote it.
///
/// The two formats have nothing in common. A Claude transcript's conversation
/// records are `type: "assistant" | "user"`; a Codex *rollout*'s are
/// `session_meta` / `event_msg` / `response_item` / `turn_context`, and running
/// the Claude parser over one matches nothing and returns `None` — which the
/// reconciler reads as "no evidence", so a Codex session kept its last hook state
/// forever and got no reconciliation at all.
///
/// `agent_kind` is the registry's answer and is used when it has one. When it
/// doesn't (a session that lost its `terminal_sessions` join — a `/clear`, a
/// `/new`), the file *name* decides: Codex names every rollout
/// `rollout-<timestamp>-<thread-id>.jsonl`, so the prefix identifies the format
/// without opening the file. Guessing wrong is not harmful — the wrong parser
/// matches nothing and yields `None`, the same as an unreadable file — but
/// guessing right is what keeps an unjoined Codex session reconciling.
fn transcript_activity_ms(transcript_path: &str, agent_kind: Option<AgentKind>) -> Option<i64> {
    let is_codex = match agent_kind {
        Some(kind) => kind == AgentKind::Codex,
        None => Path::new(transcript_path)
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-")),
    };
    if is_codex {
        return crate::codex_rollouts::last_activity_ms(Path::new(transcript_path));
    }
    main_activity_ms(transcript_path)
}

/// Epoch-ms of the newest `assistant`/`user` entry in a *Claude* transcript — how
/// recently the main agent loop itself did anything. `None` if unreadable / no
/// such entry. cmux/remote-control metadata lines (`mode`, `pr-link`, …) are
/// ignored, so raw file mtime is deliberately not used here (that trailer churns
/// without a real turn).
fn main_activity_ms(transcript_path: &str) -> Option<i64> {
    let text = read_tail(transcript_path, 128 * 1024)?;
    let mut newest_ms: Option<i64> = None;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue; // partial/metadata line
        };
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") | Some("user") => {}
            _ => continue, // skip metadata entries
        }
        if let Some(ms) = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
            .map(|dt| dt.timestamp_millis())
        {
            newest_ms = Some(newest_ms.map_or(ms, |cur| cur.max(ms)));
        }
    }
    newest_ms
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
/// plain "has it gone quiet" is not.
///
/// Returns an override state, or `None` to keep the stored one.
/// - `permission`/`waiting`: while genuinely pending the transcript is *frozen* at
///   the pre-prompt turn (Claude withholds the blocked `tool_use` until you
///   approve it). So it's still pending until the transcript advances past when we
///   recorded the prompt; once it has, the prompt is resolved and it falls through
///   to the liveness check below.
/// - resolved-prompt / `active`: `idle` once everything (main + subagents) has been
///   quiet for `IDLE_QUIET_MS`; else `delegating` if the freshest activity is a
///   subagent (the main loop is blocked on a Task subagent), else `active`.
/// - `idle`/`exited`: settled — left untouched (`idle`→`active` only ever comes
///   from a real `UserPromptSubmit`; liveness owns `exited`).
///
/// `agent_kind` picks the transcript reader: the two providers' files share
/// nothing but the `.jsonl` extension (see [`transcript_activity_ms`]).
fn reconcile_live_state(
    state: AgentState,
    transcript_path: Option<&str>,
    agent_kind: Option<AgentKind>,
    recorded_at_ms: i64,
    now_ms: i64,
) -> Option<AgentState> {
    let is_pending = state.is_blocked_on_user();
    if !is_pending && state != AgentState::Active {
        return None; // idle / exited: settled
    }
    let path = transcript_path?;

    let main_ms = transcript_activity_ms(path, agent_kind);
    let sub_ms = newest_subagent_write_ms(path);
    // The hook clock counts as activity in its own right, and has to: the tool
    // heartbeats (`PostToolUse`/`PostToolUseFailure`) exist precisely to prove a
    // turn is still moving when the transcript is not moving with it — a long
    // build, a long think, or a session whose transcript writes are suppressed
    // altogether. Without this the heartbeats would land in the row and change
    // nothing, and the agent would still decay to "idle" mid-turn.
    //
    // Only while `active`. For a pending prompt `recorded_at_ms` is *when the
    // prompt was recorded*, and the comparison just below is what notices the
    // user answered — folding it in as activity would resolve every prompt
    // against itself.
    let event_ms = (!is_pending).then_some(recorded_at_ms);
    let last_ms = main_ms.max(sub_ms).max(event_ms)?; // None if nothing is readable

    // A pending prompt whose transcript hasn't advanced past when we recorded it is
    // still genuinely waiting on the user — keep it.
    if is_pending && last_ms <= recorded_at_ms + RESOLVED_MARGIN_MS {
        return None;
    }

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
    fn live<const N: usize>(keys: [&str; N]) -> HashSet<String> {
        keys.iter().map(|k| k.to_string()).collect()
    }

    // Write a throwaway transcript; the unique name per call avoids cross-test
    // collisions (no tempfile dep in src-tauri — mirrors the hook crate's tests).
    fn transcript(tag: &str, lines: &[String]) -> String {
        let path = std::env::temp_dir().join(format!(
            "santree-reconcile-{}-{tag}.jsonl",
            std::process::id()
        ));
        std::fs::write(&path, lines.join("\n")).unwrap();
        path.to_str().unwrap().to_string()
    }

    // A conversation entry stamped `ms` epoch-millis (only `type` + `timestamp`
    // are read by the reconciler; content shape is irrelevant now).
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
    fn settled_states_are_never_reconciled() {
        let p = transcript("settled", &[conv("assistant", T + 5000)]);
        assert_eq!(
            reconcile_live_state(AgentState::Idle, Some(&p), None, T, T + 5000),
            None
        );
        assert_eq!(
            reconcile_live_state(AgentState::Exited, Some(&p), None, T, T + 5000),
            None
        );
    }

    #[test]
    fn unknown_stored_state_drops_the_row() {
        // A stale santree-hook on disk writing a state this build doesn't know must
        // not surface as a wrong badge.
        let rows = vec![
            (
                "s1".into(),
                "teleporting".into(),
                "Notification".into(),
                "/w".into(),
                None,
                None,
                T,
                None,
                None,
                None,
                None,
            ),
            (
                "s2".into(),
                "idle".into(),
                "Stop".into(),
                "/w".into(),
                None,
                None,
                T,
                Some("canary".into()),
                Some("tree:AK-1".into()),
                Some("Claude".into()),
                None,
            ),
        ];
        let out = reconcile_rows(rows, T, &live(["tree:AK-1"]));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id, "s2");
        assert_eq!(out[0].state, AgentState::Idle);
        // The joined owner rides along untouched — it's what the Agents panel
        // attributes the session to.
        assert_eq!(out[0].term_key.as_deref(), Some("tree:AK-1"));
        assert_eq!(out[0].repo.as_deref(), Some("canary"));
    }

    /// The provider comes from the owning terminal's row, not from an assumption
    /// about who writes `session_state`. Hardcoding it is what would mislabel
    /// every row the moment a second provider registers one.
    #[test]
    fn the_agent_kind_comes_from_the_joined_terminal() {
        let row = |kind: Option<&str>| {
            (
                "s1".to_string(),
                "idle".to_string(),
                "Stop".to_string(),
                "/w".to_string(),
                None,
                None,
                T,
                Some("canary".to_string()),
                Some("tree:AK-1".to_string()),
                kind.map(str::to_string),
                None,
            )
        };
        assert_eq!(
            reconcile_rows(vec![row(Some("Codex"))], T, &live(["tree:AK-1"]))[0].agent_kind,
            Some(santree_core::domain::AgentKind::Codex)
        );
        // No join, no provider — and *no guess*. A terminal keeps one row per
        // logical surface, so minting a second session orphans the first, and a
        // Claude default would repaint that orphaned Codex session as Claude.
        assert_eq!(
            reconcile_rows(vec![row(None)], T, &live(["tree:AK-1"]))[0].agent_kind,
            None
        );
        // A value this build doesn't know is unknown too — the row survives
        // (its state is still worth showing), it just claims no provider.
        assert_eq!(
            reconcile_rows(vec![row(Some("Cowork"))], T, &live(["tree:AK-1"]))[0].agent_kind,
            None
        );
    }

    #[test]
    fn pending_when_transcript_is_frozen_before_the_prompt() {
        // The real failing case: a permission is showing, but its tool_use is
        // withheld from the transcript — the newest entry predates the prompt, and
        // a trailing metadata line must not be mistaken for progress.
        let p = transcript(
            "frozen",
            &[
                conv("assistant", T - 60_000),
                conv("user", T - 40_000),
                META.to_string(),
            ],
        );
        let now = T + 5_000;
        assert_eq!(
            reconcile_live_state(AgentState::Permission, Some(&p), None, T, now),
            None
        );
        assert_eq!(
            reconcile_live_state(AgentState::Waiting, Some(&p), None, T, now),
            None
        );
    }

    #[test]
    fn resolved_prompt_is_running_while_still_active() {
        // Reject/accept fed back; the agent is still busy (recent activity).
        let p = transcript(
            "mid",
            &[conv("assistant", T - 60_000), conv("user", T + 3_000)],
        );
        let now = T + 5_000; // only 2s since the last entry → not quiet
        assert_eq!(
            reconcile_live_state(AgentState::Permission, Some(&p), None, T, now),
            Some(AgentState::Active)
        );
    }

    #[test]
    fn resolved_prompt_goes_idle_once_quiet() {
        // The user's ask: after a reject, once the agent stops doing anything the
        // badge flips to idle — even under remote control where the last transcript
        // line is a bare tool_result, not an `end_turn`.
        let p = transcript("reject-idle", &[conv("user", T + 5_000)]);
        let now = T + 5_000 + IDLE_QUIET_MS + 1; // quiet past the threshold
        assert_eq!(
            reconcile_live_state(AgentState::Permission, Some(&p), None, T, now),
            Some(AgentState::Idle)
        );
    }

    #[test]
    fn active_goes_idle_when_quiet_but_stays_running_when_recent() {
        let p = transcript("active", &[conv("assistant", T)]);
        // Quiet long enough → idle even though no `Stop` fired.
        assert_eq!(
            reconcile_live_state(AgentState::Active, Some(&p), None, T, T + IDLE_QUIET_MS + 1),
            Some(AgentState::Idle)
        );
        // Recent main-loop activity (mid-turn / thinking pause) → running.
        assert_eq!(
            reconcile_live_state(AgentState::Active, Some(&p), None, T, T + 2_000),
            Some(AgentState::Active)
        );
    }

    #[test]
    fn subagent_run_reads_as_delegating_not_running() {
        // Real `now`, because we compare against a real file mtime below.
        let now = now_ms();
        // Main transcript last wrote 5 min ago — the agent handed off to a subagent
        // and the main transcript then stayed silent for the whole subagent run.
        let main = transcript("subagent", &[conv("assistant", now - 300_000)]);
        // Without the subagent that silence reads as idle…
        assert_eq!(
            reconcile_live_state(AgentState::Active, Some(&main), None, now - 600_000, now),
            Some(AgentState::Idle)
        );
        // …but a subagent actively writing its own file means the main loop is
        // blocked on it → "delegating", distinct from the agent itself running.
        let dir = subagents_dir(&main).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent-x.jsonl"), "{}").unwrap(); // mtime ≈ now
        assert_eq!(
            reconcile_live_state(AgentState::Active, Some(&main), None, now - 600_000, now),
            Some(AgentState::Delegating)
        );
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    /// With no transcript to read, the *hook clock* is the only evidence left —
    /// and it is real evidence, which is why the tool heartbeats exist. So an
    /// unreadable transcript is not automatically "no opinion":
    ///  - a pending prompt still abstains; only the transcript moving past the
    ///    recorded time can show the user answered, and `recorded_at_ms` would
    ///    otherwise resolve the prompt against itself;
    ///  - an active session with a *fresh* hook stays active (a long build writes
    ///    nothing to the transcript, and decaying it to idle is the reported bug);
    ///  - an active session whose last hook is older than the quiet window decays
    ///    to idle, transcript or no transcript.
    #[test]
    fn an_unreadable_transcript_falls_back_to_the_hook_clock() {
        assert_eq!(
            reconcile_live_state(AgentState::Permission, None, None, T, T),
            None,
            "a pending prompt has nothing to resolve it but the transcript"
        );
        assert_eq!(
            reconcile_live_state(AgentState::Active, Some("/no/such/file.jsonl"), None, T, T),
            Some(AgentState::Active),
            "the heartbeat just fired; a silent transcript doesn't mean idle"
        );
        assert_eq!(
            reconcile_live_state(
                AgentState::Active,
                Some("/no/such/file.jsonl"),
                None,
                T,
                T + IDLE_QUIET_MS
            ),
            Some(AgentState::Idle),
            "no transcript and no heartbeat for the whole quiet window"
        );
    }

    /// The reported bug, at the unit that caused it: a turn whose transcript has
    /// gone quiet past `IDLE_QUIET_MS` is NOT idle if the hooks are still firing.
    /// `PostToolUse` is the only thing that fires mid-turn, so its timestamp is
    /// the evidence that a long build / long think is still a running turn.
    #[test]
    fn a_tool_heartbeat_keeps_a_long_turn_from_decaying_to_idle() {
        let now = now_ms();
        // Transcript last moved well past the quiet window — a single slow tool.
        let p = transcript("heartbeat", &[conv("assistant", now - IDLE_QUIET_MS * 3)]);

        // The hook clock is stale too: genuinely finished, nothing running.
        assert_eq!(
            reconcile_live_state(
                AgentState::Active,
                Some(&p),
                None,
                now - IDLE_QUIET_MS * 2,
                now
            ),
            Some(AgentState::Idle)
        );
        // Same silent transcript, but a heartbeat landed a moment ago → still working.
        assert_eq!(
            reconcile_live_state(AgentState::Active, Some(&p), None, now - 2_000, now),
            Some(AgentState::Active),
            "a fresh tool heartbeat is activity even when the transcript is silent"
        );
    }

    /// A pending prompt must not treat its own recording as activity — that is
    /// what the transcript comparison is for, and folding the hook clock in would
    /// resolve every prompt against itself and clear it instantly.
    #[test]
    fn the_hook_clock_is_not_activity_for_a_pending_prompt() {
        let now = now_ms();
        let p = transcript("pending-clock", &[conv("assistant", now - 60_000)]);
        // Prompt recorded after the last transcript entry: still genuinely pending.
        assert_eq!(
            reconcile_live_state(AgentState::Permission, Some(&p), None, now - 1_000, now),
            None
        );
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
        let dir = std::env::temp_dir().join(format!("santree-rollout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-2026-08-28T10-00-00-abc123.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                // `session_meta` is the thread's *opening* record and must never
                // count as activity, or a thread idle since it opened reads fresh.
                serde_json::json!({"timestamp": stamp(now - 600_000), "type": "session_meta",
                                   "payload": {"id": "abc123", "cwd": "/w"}}),
                serde_json::json!({"timestamp": stamp(now - 2_000), "type": "event_msg",
                                   "payload": {"type": "agent_message", "message": "working"}}),
            ),
        )
        .unwrap();
        let p = path.to_str().unwrap();

        // The Claude reader finds nothing in it — the old behaviour, now scoped.
        assert_eq!(main_activity_ms(p), None);
        // Routed by the registry's provider…
        assert_eq!(
            reconcile_live_state(AgentState::Active, Some(p), Some(AgentKind::Codex), T, now),
            Some(AgentState::Active)
        );
        // …and by the file name alone when the terminal join is gone.
        assert_eq!(
            reconcile_live_state(AgentState::Active, Some(p), None, T, now),
            Some(AgentState::Active)
        );
        // And it genuinely reads the record timestamps: rewind them past the quiet
        // window and the same file reports idle.
        std::fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::json!({"timestamp": stamp(now - IDLE_QUIET_MS * 3), "type": "event_msg",
                                   "payload": {"type": "agent_message", "message": "done"}}),
            ),
        )
        .unwrap();
        assert_eq!(
            reconcile_live_state(
                AgentState::Active,
                Some(p),
                Some(AgentKind::Codex),
                now - IDLE_QUIET_MS * 2,
                now
            ),
            Some(AgentState::Idle)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A row with a live-looking state whose terminal is gone is not running,
    /// whatever it last stored. This is the property that makes a sweeper
    /// unnecessary: the answer is recomputed from live state on every read, so
    /// there is nothing for a straggling hook write to win against.
    #[test]
    fn a_session_whose_terminal_died_cannot_read_as_running() {
        let row = |state: &str| {
            (
                "s1".to_string(),
                state.to_string(),
                "UserPromptSubmit".to_string(),
                "/w".to_string(),
                Some("run Bash".to_string()),
                None,
                now_ms(),
                Some("canary".to_string()),
                Some("tree:AK-1".to_string()),
                Some("Claude".to_string()),
                None,
            )
        };

        for state in ["active", "delegating", "permission", "waiting"] {
            // Terminal still open → the stored state stands.
            let out = reconcile_rows(vec![row(state)], now_ms(), &live(["tree:AK-1"]));
            assert_ne!(out[0].state, AgentState::Exited, "{state} with a live pty");

            // Terminal gone (closed, crashed, or the app restarted) → exited, and
            // the now-meaningless prompt text goes with it.
            let out = reconcile_rows(vec![row(state)], now_ms(), &live(["tree:OTHER"]));
            assert_eq!(out[0].state, AgentState::Exited, "{state} with a dead pty");
            assert_eq!(out[0].message, None, "{state} keeps no stale prompt text");
        }

        // An app restart leaves no live terminals at all, which is the correct
        // answer rather than a missing one: santree has no daemon, so a pty cannot
        // outlive the process that opened it.
        let out = reconcile_rows(vec![row("active")], now_ms(), &live([]));
        assert_eq!(out[0].state, AgentState::Exited);
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
            terminal_liveness(None, Some(now - 5_000), now, &empty),
            Some(true),
            "a status line rendered seconds ago is a live session"
        );
        assert_eq!(
            terminal_liveness(None, Some(now - HEARTBEAT_DEAD_MS - 1), now, &empty),
            Some(false),
            "one that has been silent for four missed renders is gone"
        );
        assert_eq!(
            terminal_liveness(None, None, now, &empty),
            None,
            "never rendered one at all (any Codex session) — unknown, not dead"
        );

        // And a row with no evidence either way is left exactly as stored.
        let row = (
            "s1".to_string(),
            "active".to_string(),
            "UserPromptSubmit".to_string(),
            "/w".to_string(),
            None,
            None,
            now,
            None,
            None,
            Some("Codex".to_string()),
            None,
        );
        assert_eq!(
            reconcile_rows(vec![row], now, &empty)[0].state,
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

        let retired = retire_terminal(&db, "tree:AK-1", Some("/w/alpha"))
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
        assert_eq!(retire_terminal(&db, "tree:AK-1", None).await.unwrap(), 1);
        assert_eq!(state_of("s-beta").await.0, "exited");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Both heartbeat events must actually be injected, or the mid-turn signal
    /// they carry never fires. Guarded because the settings map is built from this
    /// list and nothing else would notice one going missing.
    #[test]
    fn the_injected_claude_events_include_the_mid_turn_heartbeats() {
        for event in ["PostToolUse", "PostToolUseFailure"] {
            assert!(EVENTS.contains(&event), "{event} is not injected");
        }
        // `PreToolUse` races its own permission prompt — deliberately absent.
        assert!(!EVENTS.contains(&"PreToolUse"));
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
        let flag = codex_hook_flag(bin, db, "SessionStart");
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

    /// Only the events santree can act on are registered. Codex fires eleven;
    /// registering the rest would run the hook binary on every tool call to
    /// report nothing.
    #[test]
    fn only_state_bearing_codex_events_are_registered() {
        assert_eq!(
            CODEX_EVENTS,
            &[
                "SessionStart",
                "UserPromptSubmit",
                "PostToolUse",
                "PermissionRequest",
                "Stop",
                "SessionEnd"
            ]
        );
        // `PostToolUse` earns its place despite carrying no state *change*: it is
        // the mid-turn heartbeat, and the only proof a long tool call is still
        // running when the rollout isn't advancing. Dropping it is what let a
        // working agent decay to "idle" mid-turn.
        assert!(CODEX_EVENTS.contains(&"PostToolUse"));
        for noisy in ["PreToolUse", "SubagentStart", "SubagentStop", "PreCompact"] {
            assert!(
                !CODEX_EVENTS.contains(&noisy),
                "{noisy} carries neither a state change nor liveness, \
                 and must not spawn the hook"
            );
        }
    }
}
