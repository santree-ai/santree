//! What a Codex session launches *under*: its sandbox, its approval policy, its
//! model and reasoning effort, and — for a review — santree's own review MCP
//! server.
//!
//! These four used to be set server-side, in the `thread/start` call santree's
//! own `codex app-server` made. That server is gone (see COMPLIANCE.md, "Codex
//! has no control plane"), and for a while nothing replaced it: a Codex tab
//! launched as the bare `codex` binary with none of them, which is why a Codex
//! AI review produced no drafts at all — it had no tools to write them with.
//!
//! The plain CLI takes all four, so this module is the same decision expressed
//! as argv. Every value it emits is either a santree constant or a token that
//! passed [`safe_token`]; nothing typed by a user or written by a model reaches
//! a child process's argv through here.
//!
//! **santree only ever tightens.** Codex's sandbox and approval policy are
//! configurable by the user in their own `~/.codex/config.toml`, and santree
//! has no UI for either — so the only honest thing it can do with a value it
//! did not ask the user for is refuse to loosen it. The read-only surfaces get
//! `--sandbox read-only` and `--ask-for-approval never`, which are stricter than
//! any setting a user can hold; the Work surface gets neither, because pinning
//! `workspace-write` there would override a user who deliberately chose
//! `read-only` — COMPLIANCE.md's "santree never selects a permissive permission
//! mode or defaults to one", in Codex's vocabulary. That is the one place this
//! deliberately differs from the App Server's mapping, which pinned
//! `workspace-write` on Work and Fix-CI.
//!
//! `--dangerously-bypass-approvals-and-sandbox` is not here and must not be.
//! Other launchers default to it; santree's whole review story is that the
//! agent's findings reach GitHub only through `review_drafts::publish`, on a
//! click, and a bypassed sandbox is the first step to not needing that path.
//!
//! **`--add-dir` is the one thing here that loosens**, and it is the narrowest
//! shape that makes a broken session work. Naming no sandbox on Work and Fix-CI
//! leaves Codex's own default, `workspace-write`, whose only writable root is the
//! cwd — and a santree cwd is a *linked worktree*, whose `.git` is a file pointing
//! at `<repo>/.git/worktrees/<id>`. So `FETCH_HEAD`, `index`, `ORIG_HEAD`,
//! `objects/` and `refs/` all sit outside the writable root, and the agent could
//! edit the branch but not fetch, merge, rebase or commit on it. Three measured
//! things keep the grant honest: writable roots are **inert under `read-only`**,
//! so a user who chose that still gets it; it is one directory — git's own store,
//! never a parent; and it hands the session no capability it did not effectively
//! have, since an agent that can already write the checkout can commit those same
//! objects back through git. Network is the *other* half of `workspace-write`,
//! and it is not fixed here: it stays off unless the user turns
//! [`NETWORK_ACCESS_KEY`] on.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

use crate::git;
use crate::hooks::sh_quote;
use crate::provider::SessionSurface;

/// The `settings` key (app scope) behind Settings → Codex → "Allow network
/// access". Anything but `"true"` — including absence, the default — is off.
///
/// Opt-in because the flag it gates is not narrow: Codex has no host allowlist,
/// so `network_access = true` lifts *all* outbound network for model-generated
/// commands, not only git's. santree's own fetches run outside the sandbox, so
/// "Update base" keeps `origin/*` fresh without it.
pub const NETWORK_ACCESS_KEY: &str = "codex_sandbox_network_access";

/// How restricted a Codex launch is. Recovered from the `SessionSurface ->
/// CodexProfile` mapping the App Server used (`provider.rs` before the removal),
/// so a surface means the same thing it always did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexProfile {
    /// The worktree's work session: the user is driving, and their own Codex
    /// configuration decides how much it may do.
    Work,
    /// A read-only conversation about code — triage investigation, "ask AI"
    /// about someone else's PR.
    ReadOnly,
    /// The AI review. Read-only, and the one profile that carries santree's
    /// review tool server.
    Review,
    /// "Address review": it edits the branch, so it is not read-only, but it
    /// must not be able to talk its way past the sandbox either.
    FixCi,
}

impl CodexProfile {
    pub fn for_surface(surface: SessionSurface) -> Self {
        match surface {
            SessionSurface::Work => Self::Work,
            SessionSurface::Review => Self::Review,
            SessionSurface::Investigate | SessionSurface::AskAi => Self::ReadOnly,
            SessionSurface::FixCi => Self::FixCi,
        }
    }

    /// `--sandbox`, or `None` to leave the user's own configuration alone. See
    /// the module note: santree names a sandbox only where naming one tightens.
    fn sandbox(self) -> Option<&'static str> {
        match self {
            Self::ReadOnly | Self::Review => Some("read-only"),
            Self::Work | Self::FixCi => None,
        }
    }

    /// `--ask-for-approval`. `never` does not mean "allowed"; it means the model
    /// is never offered the escalation prompt, and a denied command comes back
    /// as a failure. On a review that is the point: a session whose output is
    /// santree's own draft rows must not be able to ask the user for more.
    fn approval(self) -> Option<&'static str> {
        match self {
            Self::ReadOnly | Self::Review | Self::FixCi => Some("never"),
            Self::Work => None,
        }
    }

    /// Whether this profile launches with santree's review MCP server, and
    /// therefore fails closed without it.
    pub fn wants_review_tools(self) -> bool {
        matches!(self, Self::Review | Self::FixCi)
    }

    /// Whether the session is meant to change the checkout — the two profiles
    /// that need git to work, and so the only two that get [`LaunchConfig::cwd`]'s
    /// git directory as a writable root or the network knob. The read-only
    /// surfaces are pinned to `--sandbox read-only`, where both are inert anyway;
    /// gating on this keeps santree from *emitting* a widening flag on a surface
    /// whose whole point is that it cannot write.
    fn writes_the_checkout(self) -> bool {
        matches!(self, Self::Work | Self::FixCi)
    }

    /// Whether [`NETWORK_ACCESS_KEY`] may reach this surface at all — the user's
    /// own session, and nothing else.
    ///
    /// `FixCi` writes the checkout but is deliberately excluded: its whole
    /// premise (see its doc above) is that it edits the branch and still cannot
    /// talk its way past the sandbox. Outbound network is exactly that talking.
    /// santree's rule is that nothing an agent writes reaches GitHub without a
    /// click — the review tools write santree's own rows and `review_drafts::
    /// publish` is the only way out — and an Address-review session that can
    /// reach api.github.com posts without one. Off by default is not enough
    /// there: the setting is global, so a user who enables it for their own work
    /// would silently open that path too.
    fn may_reach_the_network(self) -> bool {
        matches!(self, Self::Work)
    }
}

/// Everything a Codex launch needs beyond the binary and the session id.
pub struct LaunchConfig<'a> {
    pub surface: SessionSurface,
    /// Fresh launches take the configured model and effort; a resume keeps the
    /// thread's own, exactly as Claude's `--model` is fresh-only.
    pub fresh: bool,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    /// santree's review MCP config (the JSON file Claude reads through
    /// `--mcp-config`), when this surface has one. Derived in Rust from the
    /// session's own row — never supplied over IPC.
    pub review_mcp_config: Option<&'a Path>,
    /// The directory the session runs in — santree's own worktree path, from the
    /// tab's row, never from the webview. Only its *git* directory is read out of
    /// this (see the module note on `--add-dir`); the cwd itself is already the
    /// sandbox's writable root, and santree does not name it.
    pub cwd: Option<&'a Path>,
    /// [`NETWORK_ACCESS_KEY`], already resolved. Off is the default and the whole
    /// point: a Codex sandbox has no host allowlist, so this is all-or-nothing.
    pub network_access: bool,
}

/// The flag string a Codex launch is spliced with, already shell-quoted.
///
/// `Err` rather than a quieter answer whenever a review's tools cannot be
/// described: a review that runs without them looks like it is working right up
/// until it has nowhere to put what it found, which is the exact failure this
/// whole path exists to prevent.
pub fn launch_flags(config: &LaunchConfig<'_>) -> Result<String> {
    let profile = CodexProfile::for_surface(config.surface);
    let mut flags: Vec<String> = Vec::new();

    if let Some(sandbox) = profile.sandbox() {
        flags.push(format!("--sandbox {sandbox}"));
    }
    if let Some(approval) = profile.approval() {
        flags.push(format!("--ask-for-approval {approval}"));
    }

    if profile.writes_the_checkout() {
        // The one directory outside the worktree that git *must* be able to write
        // — see the module note. Resolved from the checkout's own pointer files,
        // and `None` for anything that is not demonstrably a git directory, so an
        // unreadable or bogus `.git` degrades to no flag rather than to a wider
        // root. `to_str` and not `to_string_lossy`: a path we cannot reproduce
        // byte-for-byte is not one to hand a child process as a writable root.
        if let Some(dir) = config.cwd.and_then(git::common_git_dir) {
            if let Some(dir) = dir.to_str() {
                flags.push(format!("--add-dir {}", sh_quote(dir)));
            } else {
                log::warn!("{} is not valid UTF-8, so this Codex session launches without git metadata writes", dir.display());
            }
        }
        // Off by default, and deliberately not inferred from "the agent needs to
        // pull": Codex has no host allowlist, so this is every outbound connection
        // a model-generated command makes. Scoped to the user's own session — see
        // `may_reach_the_network` for why Address-review is excluded even when the
        // user has turned this on.
        if config.network_access && profile.may_reach_the_network() {
            flags.push(config_flag("sandbox_workspace_write.network_access=true"));
        }
    }

    if config.fresh {
        if let Some(model) = config.model.map(str::trim).filter(|m| !m.is_empty()) {
            let model = safe_token(model, "model")?;
            flags.push(format!("--model {}", sh_quote(model)));
        }
        if let Some(effort) = config.effort.map(str::trim).filter(|e| !e.is_empty()) {
            let effort = safe_token(effort, "reasoning effort")?;
            flags.push(config_flag(&format!(
                "model_reasoning_effort={}",
                toml_string(effort)
            )));
        }
    }

    match (profile.wants_review_tools(), config.review_mcp_config) {
        (true, Some(path)) => flags.push(config_flag(&review_server_override(path)?)),
        (true, None) => bail!(
            "santree's review tools are unavailable, so this review would run with \
             nowhere to record what it finds"
        ),
        (false, Some(_)) => bail!("only a review session launches with santree's review tools"),
        (false, None) => {}
    }

    Ok(flags.join(" "))
}

/// One `-c key=value` override, as a single shell word.
///
/// Codex parses the value as TOML and **silently ignores a key it does not
/// recognise** unless `--strict-config` is passed — which is how santree shipped
/// a decorative `-c sandbox_permissions=[]` for months. `--strict-config` cannot
/// ride on the interactive launch (it would also validate the *user's*
/// `~/.codex/config.toml`, so one unrecognised key of theirs would block a launch
/// that works today); [`validate_overrides`] is how these are proved to land
/// instead.
fn config_flag(assignment: &str) -> String {
    format!("-c {}", sh_quote(assignment))
}

/// Codex's inline-table form of santree's review MCP server, read out of the
/// same JSON config Claude is handed. One server, ours, named explicitly —
/// `mcp_servers.santree-review=…` adds it beside whatever the user configured
/// rather than replacing the map, which is what `mcp_servers={…}` would do.
///
/// `required = true` is the fail-closed half, and it is load-bearing: with it,
/// a server that cannot start makes Codex refuse to create the session at all
/// ("required MCP servers failed to initialize"). Without it the session comes
/// up as an ordinary agent, told to review a PR, with no way to record a single
/// finding and nothing on screen saying so.
fn review_server_override(path: &Path) -> Result<String> {
    let raw = std::fs::read(path).with_context(|| {
        format!(
            "reading santree's review tool configuration at {}",
            path.display()
        )
    })?;
    let value: Value =
        serde_json::from_slice(&raw).context("parsing santree's review tool configuration")?;
    let server = value
        .pointer("/mcpServers/santree-review")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("santree's review configuration names no review server"))?;
    let command = server
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("santree's review configuration has no command"))?;
    let args = server
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("santree's review configuration has no arguments"))?
        .iter()
        .map(|arg| {
            arg.as_str()
                .ok_or_else(|| anyhow!("santree's review configuration has a non-string argument"))
        })
        .collect::<Result<Vec<_>>>()?;

    // The provider the tools attribute their writes to. Claude's server takes it
    // from the same config file; here it is appended because the file is written
    // for Claude and read by both.
    let args = args
        .into_iter()
        .map(toml_string)
        .chain(["--agent-kind", "Codex"].map(toml_string))
        .collect::<Vec<_>>()
        .join(",");

    // `enabled_tools` is an allowlist, and this session's approval policy is
    // `never`: a tool missing from it is not un-approved, it is rejected, with
    // no prompt and no explanation. Hence the one shared list — the drift it
    // exists to stop already happened once, when the two work-item tools were
    // added to the server and not to the allowlist.
    let tools = santree_core::review_tools::REVIEW_TOOL_NAMES
        .iter()
        .map(|name| toml_string(name))
        .collect::<Vec<_>>()
        .join(",");
    let approvals = santree_core::review_tools::REVIEW_TOOL_NAMES
        .iter()
        .map(|name| format!("{}={{approval_mode=\"approve\"}}", toml_key(name)))
        .collect::<Vec<_>>()
        .join(",");

    Ok(format!(
        "mcp_servers.santree-review={{command={},args=[{}],enabled=true,required=true,\
         enabled_tools=[{}],default_tools_approval_mode=\"prompt\",tools={{{}}}}}",
        toml_string(command),
        args,
        tools,
        approvals,
    ))
}

/// Prove the `-c` overrides in `flags` are keys this Codex actually understands,
/// by handing them to the CLI's own strict validator.
///
/// This is the answer to "the flag parses" not being proof. `codex exec
/// --strict-config` rejects an unrecognised override by name; `--ephemeral
/// --ignore-user-config` keep the check to *our* overrides — no session, no
/// rollout, no model call, and the user's own config is not read, so a stray key
/// of theirs can never fail a launch of ours. With stdin closed it answers in
/// about 20ms and exits before it would start a single MCP server.
///
/// Paired with `required = true`, the two ends close the loop: a key Codex stops
/// recognising fails here, and a server that cannot start fails there.
pub async fn validate_overrides(executable: &str, flags: &str) -> Result<()> {
    let overrides = config_overrides_of(flags);
    if overrides.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec![
        "exec",
        "--strict-config",
        "--ephemeral",
        "--ignore-user-config",
    ];
    for value in &overrides {
        args.push("-c");
        args.push(value);
    }
    // The prompt argument, with stdin closed: the CLI validates its config, finds
    // no prompt, and stops.
    args.push("-");

    let output = tokio::process::Command::new(executable)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), output)
        .await
        .map_err(|_| anyhow!("checking santree's Codex launch configuration timed out"))?
        .context("checking santree's Codex launch configuration")?;

    let mut text = String::from_utf8_lossy(&output.stderr).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    if let Some(line) = text
        .lines()
        .find(|line| line.contains("Error loading config.toml"))
    {
        bail!("this Codex build rejected santree's launch configuration: {line}");
    }
    Ok(())
}

/// The `-c` values inside a built flag string, unquoted. The flags are our own
/// output, so this is the exact inverse of [`config_flag`] rather than a general
/// shell parser.
fn config_overrides_of(flags: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = flags;
    while let Some(at) = rest.find("-c '") {
        let after = &rest[at + 4..];
        let Some(end) = closing_quote(after) else {
            break;
        };
        out.push(after[..end].replace(r"'\''", "'"));
        rest = &after[end + 1..];
    }
    out
}

/// Where the single-quoted word starting a [`sh_quote`] output ends: the first
/// `'` that is not part of the `'\''` escape it emits for an embedded quote.
fn closing_quote(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if s[i..].starts_with(r"'\''") {
                i += 4;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

/// A vendor-supplied identifier on its way to a child process: a model slug
/// (`gpt-5.6-sol`) or a reasoning effort (`xhigh`).
///
/// Deliberately a character class rather than an allowlist of known values: the
/// catalog is Codex's, it grows, and a santree that pinned its vocabulary would
/// reject a model the CLI itself offers. What it must never do is let a settings
/// value become an extra flag or break out of a TOML string, so: bounded,
/// printable, no leading `-`, and nothing a shell or TOML parser reads as syntax.
fn safe_token<'a>(value: &'a str, what: &str) -> Result<&'a str> {
    let ok = !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if !ok {
        bail!("'{value}' is not a valid Codex {what}");
    }
    Ok(value)
}

/// A TOML basic string. Every value passed here is santree's own (a path it
/// derived, a token [`safe_token`] cleared), so this escapes rather than
/// validates — it is the layer that keeps a path with a quote in it from ending
/// the string early.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
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

/// A TOML key. The tool names are compile-time constants from one shared list,
/// but a bare key may not contain a `-`, and two of them do not today only by
/// luck — so they are quoted, which is legal for any key.
fn toml_key(value: &str) -> String {
    toml_string(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(surface: SessionSurface) -> LaunchConfig<'static> {
        LaunchConfig {
            surface,
            fresh: true,
            model: None,
            effort: None,
            review_mcp_config: None,
            cwd: None,
            network_access: false,
        }
    }

    #[test]
    fn a_read_only_surface_is_sandboxed_and_cannot_ask_for_more() {
        for surface in [SessionSurface::Investigate, SessionSurface::AskAi] {
            let flags = launch_flags(&config(surface)).unwrap();
            assert_eq!(flags, "--sandbox read-only --ask-for-approval never");
        }
    }

    /// Fix-CI edits the branch, so it is not sandboxed to read-only — but it
    /// still may not be offered an escalation prompt.
    #[test]
    fn fixing_a_review_cannot_escalate_past_the_users_own_sandbox() {
        let mut config = config(SessionSurface::FixCi);
        let path = write_review_config("fixci");
        config.review_mcp_config = Some(&path);
        let flags = launch_flags(&config).unwrap();
        assert!(!flags.contains("--sandbox"), "{flags}");
        assert!(flags.contains("--ask-for-approval never"), "{flags}");
        std::fs::remove_file(path).unwrap();
    }

    /// COMPLIANCE.md, "santree never selects a permissive permission mode or
    /// defaults to one": the work session runs under the user's own Codex
    /// configuration, so santree names neither knob.
    #[test]
    fn the_work_surface_does_not_override_the_users_own_sandbox() {
        assert_eq!(launch_flags(&config(SessionSurface::Work)).unwrap(), "");

        // Still true once it is given a worktree to widen: `--add-dir` adds a
        // writable root to whatever sandbox the user chose, and never names one.
        let tree = write_linked_worktree("keeps-user-sandbox");
        let mut cfg = config(SessionSurface::Work);
        cfg.cwd = Some(&tree.worktree);
        let flags = launch_flags(&cfg).unwrap();
        assert!(!flags.contains("--sandbox"), "{flags}");
        assert!(!flags.contains("--ask-for-approval"), "{flags}");
        tree.remove();
    }

    /// The bug this exists for: `workspace-write`'s only writable root is the
    /// cwd, a santree cwd is a *linked* worktree, and everything git writes for a
    /// fetch/merge/rebase lives in the main repo's `.git`. So the flag must name
    /// the common directory, not the worktree's own pointer.
    #[test]
    fn a_writing_session_may_write_the_repos_git_directory() {
        let tree = write_linked_worktree("git-writes");
        let common = std::fs::canonicalize(tree.repo.join(".git")).unwrap();

        for surface in [SessionSurface::Work, SessionSurface::FixCi] {
            let mut cfg = config(surface);
            cfg.cwd = Some(&tree.worktree);
            let review = write_review_config("git-writes");
            if CodexProfile::for_surface(surface).wants_review_tools() {
                cfg.review_mcp_config = Some(&review);
            }
            let flags = launch_flags(&cfg).unwrap();
            std::fs::remove_file(review).unwrap();
            assert!(
                flags.contains(&format!("--add-dir {}", sh_quote(common.to_str().unwrap()))),
                "{surface:?}: {flags}"
            );
        }

        // Never on a surface that is pinned read-only: santree does not emit a
        // widening flag on a session whose point is that it cannot write.
        for surface in [
            SessionSurface::Investigate,
            SessionSurface::AskAi,
            SessionSurface::Review,
        ] {
            let mut cfg = config(surface);
            cfg.cwd = Some(&tree.worktree);
            let review = write_review_config("git-writes-ro");
            if CodexProfile::for_surface(surface).wants_review_tools() {
                cfg.review_mcp_config = Some(&review);
            }
            let flags = launch_flags(&cfg).unwrap();
            std::fs::remove_file(review).unwrap();
            assert!(!flags.contains("--add-dir"), "{surface:?}: {flags}");
        }
        tree.remove();
    }

    /// A cwd whose git directory cannot be resolved loses the grant rather than
    /// widening it: no flag beats a flag naming the wrong root.
    #[test]
    fn an_unresolvable_git_directory_drops_the_grant_rather_than_widening_it() {
        let tree = write_linked_worktree("unresolvable");
        std::fs::write(tree.worktree.join(".git"), "gitdir: /\n").unwrap();
        let mut cfg = config(SessionSurface::Work);
        cfg.cwd = Some(&tree.worktree);
        assert_eq!(launch_flags(&cfg).unwrap(), "");

        std::fs::remove_file(tree.worktree.join(".git")).unwrap();
        assert_eq!(launch_flags(&cfg).unwrap(), "");
        tree.remove();
    }

    /// The network half of `workspace-write` is a user decision, not a
    /// consequence of needing git: absent the setting there is no flag at all.
    #[test]
    fn network_access_is_opt_in_and_never_reaches_a_read_only_surface() {
        let mut cfg = config(SessionSurface::Work);
        assert!(!launch_flags(&cfg).unwrap().contains("network_access"));

        cfg.network_access = true;
        assert!(launch_flags(&cfg)
            .unwrap()
            .contains(r#"-c 'sandbox_workspace_write.network_access=true'"#));

        for surface in [SessionSurface::Investigate, SessionSurface::AskAi] {
            let mut cfg = config(surface);
            cfg.network_access = true;
            let flags = launch_flags(&cfg).unwrap();
            assert!(!flags.contains("network_access"), "{surface:?}: {flags}");
        }
    }

    /// The setting is global, so turning it on for your own work must not also
    /// hand it to the sessions santree points at a pull request. Address-review is
    /// the case that needs saying: it *does* write the checkout, so it takes the
    /// git-metadata root and would take this too by that test alone. But an agent
    /// that can reach api.github.com posts without the click `review_drafts::
    /// publish` exists to require, so the network half stops at `Work`. (The AI
    /// review itself needs no test here — it is pinned `--sandbox read-only`, where
    /// `writes_the_checkout` is already false and both wideners are inert.)
    #[test]
    fn address_review_never_gets_the_network_even_when_the_user_opted_in() {
        let mut cfg = config(SessionSurface::FixCi);
        let path = write_review_config("fixci-network");
        cfg.review_mcp_config = Some(&path);
        cfg.network_access = true;
        let flags = launch_flags(&cfg).unwrap();
        assert!(!flags.contains("network_access"), "{flags}");
        std::fs::remove_file(path).unwrap();
    }

    /// A linked worktree's on-disk shape, written directly rather than via `git`
    /// (the resolution itself is `git::common_git_dir`'s to test against a real
    /// repo): `<base>/wt/.git` is a file pointing at `<base>/repo/.git/worktrees/wt`,
    /// whose `commondir` points back at `<base>/repo/.git`.
    struct LinkedWorktree {
        base: std::path::PathBuf,
        repo: std::path::PathBuf,
        worktree: std::path::PathBuf,
    }

    impl LinkedWorktree {
        fn remove(self) {
            let _ = std::fs::remove_dir_all(self.base);
        }
    }

    fn write_linked_worktree(tag: &str) -> LinkedWorktree {
        let base =
            std::env::temp_dir().join(format!("santree-codex-cwd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        let git_dir = repo.join(".git");
        std::fs::create_dir_all(git_dir.join("objects")).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let per_worktree = git_dir.join("worktrees/wt");
        std::fs::create_dir_all(&per_worktree).unwrap();
        std::fs::write(per_worktree.join("commondir"), "../..\n").unwrap();

        let worktree = base.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", per_worktree.display()),
        )
        .unwrap();
        LinkedWorktree {
            base,
            repo,
            worktree,
        }
    }

    /// The flag every other launcher reaches for, and the one santree must never
    /// emit — from any surface, with any settings.
    #[test]
    fn no_surface_can_produce_the_bypass_flag() {
        // With both wideners turned all the way up, since they are the only two
        // things here that loosen at all.
        let tree = write_linked_worktree("bypass");
        for surface in [
            SessionSurface::Work,
            SessionSurface::Investigate,
            SessionSurface::AskAi,
            SessionSurface::Review,
            SessionSurface::FixCi,
        ] {
            let mut config = config(surface);
            config.cwd = Some(&tree.worktree);
            config.network_access = true;
            let path = write_review_config("bypass");
            if CodexProfile::for_surface(surface).wants_review_tools() {
                config.review_mcp_config = Some(&path);
            }
            let flags = launch_flags(&config).unwrap();
            assert!(!flags.contains("dangerously"), "{surface:?}: {flags}");
            assert!(
                !flags.contains("danger-full-access"),
                "{surface:?}: {flags}"
            );
            std::fs::remove_file(path).unwrap();
        }
        tree.remove();
    }

    #[test]
    fn model_and_effort_ride_a_fresh_launch_only() {
        let mut config = config(SessionSurface::Work);
        config.model = Some("gpt-5.6-sol");
        config.effort = Some("xhigh");
        let fresh = launch_flags(&config).unwrap();
        assert!(fresh.contains("--model 'gpt-5.6-sol'"), "{fresh}");
        assert!(
            fresh.contains(r#"-c 'model_reasoning_effort="xhigh"'"#),
            "{fresh}"
        );

        config.fresh = false;
        assert_eq!(launch_flags(&config).unwrap(), "");
    }

    /// A settings value reaches a child process's argv, so it is checked rather
    /// than quoted-and-hoped: a leading dash would be read as a flag, and the
    /// rest would end a shell word or a TOML string.
    #[test]
    fn a_settings_value_cannot_become_another_flag() {
        for hostile in [
            "--dangerously-bypass-approvals-and-sandbox",
            "-s danger-full-access",
            "gpt' --sandbox danger-full-access '",
            "high\", sandbox_mode=\"danger-full-access\", x=\"",
            "a b",
        ] {
            // Named `cfg`, not `config`: a local binding of that name shadows the
            // `config()` helper for the rest of the block, so the second case
            // below would try to call a `LaunchConfig`.
            let mut cfg = config(SessionSurface::Work);
            cfg.model = Some(hostile);
            assert!(launch_flags(&cfg).is_err(), "model {hostile:?}");

            let mut cfg = config(SessionSurface::Work);
            cfg.effort = Some(hostile);
            assert!(launch_flags(&cfg).is_err(), "effort {hostile:?}");
        }
        assert!(safe_token("gpt-5.6-sol", "model").is_ok());
        assert!(safe_token("xhigh", "effort").is_ok());
    }

    /// COMPLIANCE.md, "Review MCP server": a review that could not describe its
    /// tools must not launch as an ordinary agent instead.
    #[test]
    fn a_review_without_its_tools_refuses_to_launch() {
        let error = launch_flags(&config(SessionSurface::Review)).unwrap_err();
        assert!(error.to_string().contains("nowhere to record"), "{error:#}");

        // And the mirror: the tools are not smuggled onto a surface that has no
        // business writing drafts.
        let path = write_review_config("misrouted");
        let mut config = config(SessionSurface::Investigate);
        config.review_mcp_config = Some(&path);
        assert!(launch_flags(&config).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_review_server_carries_every_shared_tool_and_fails_closed() {
        let path = write_review_config("full");
        let mut config = config(SessionSurface::Review);
        config.review_mcp_config = Some(&path);
        let flags = launch_flags(&config).unwrap();
        std::fs::remove_file(path).unwrap();

        assert!(flags.starts_with("--sandbox read-only --ask-for-approval never"));
        assert!(flags.contains("required=true"), "{flags}");
        assert!(flags.contains("mcp_servers.santree-review="), "{flags}");
        // Not the whole map: the user's own servers stay.
        assert!(!flags.contains("-c 'mcp_servers={"), "{flags}");
        assert!(flags.contains(r#"--agent-kind","Codex""#), "{flags}");
        for name in santree_core::review_tools::REVIEW_TOOL_NAMES {
            assert!(flags.contains(&format!("\"{name}\"")), "{name} in {flags}");
            assert!(
                flags.contains(&format!("\"{name}\"={{approval_mode=\"approve\"}}")),
                "{name} approval in {flags}"
            );
        }
    }

    /// [`validate_overrides`] reads back exactly what [`config_flag`] wrote,
    /// including a path with a quote in it — the one shape the round trip can
    /// lose.
    #[test]
    fn the_overrides_handed_to_the_validator_are_the_ones_that_were_built() {
        let flags = format!(
            "--sandbox read-only {} {}",
            config_flag(r#"model_reasoning_effort="high""#),
            config_flag(r#"mcp_servers.santree-review={command="/Users/o'brien/hook"}"#),
        );
        assert_eq!(
            config_overrides_of(&flags),
            vec![
                r#"model_reasoning_effort="high""#.to_string(),
                r#"mcp_servers.santree-review={command="/Users/o'brien/hook"}"#.to_string(),
            ]
        );
        assert!(config_overrides_of("--sandbox read-only").is_empty());
    }

    fn write_review_config(tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "santree-codex-config-{tag}-{}.json",
            std::process::id()
        ));
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "mcpServers": {
                    "santree-review": {
                        "type": "stdio",
                        "command": "/Applications/santree.app/santree-hook",
                        "args": ["--db", "/data/santree.db", "mcp", "--pr", "acme/web",
                                 "--number", "42"],
                    },
                    "someone-elses": { "command": "/tmp/nope", "args": [] }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        path
    }
}
