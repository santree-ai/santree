//! What environment a new terminal gets, by where its process runs.
//!
//! Three hosts, three answers, and the difference is the point:
//!
//! - **In-app** — the process inherits this app's own environment ambiently, so
//!   the only thing sent is the user's project env (`resolve_env`).
//! - **A local server** — the process's parent is the *server*, which was
//!   started with a minimal environment on purpose (an env_clear'd spawn), so
//!   the shell would otherwise never see the hydrated `PATH` or the user's
//!   locale. The server's profile therefore forwards the app's own environment
//!   as `base_env` ([`server_base_env`]), minus what must not travel. The
//!   project env's secrets go in `env` only: `env` is applied over `base_env` by
//!   the host, and unlike `base_env` it is never something a later reader of
//!   "what do our terminals inherit" has to audit.
//! - **Daedalus** — none of this Mac's environment is the box's to have
//!   (docs/remote.md): `TERM`, and for an agent the pair its relayed hooks carry
//!   back. Its profile has no `base_env`, which is the one place that keeps the
//!   Mac's environment off the box.
//!
//! `env` is built per open; `base_env` when the host opens the session, from the
//! process's environment as it is then (after `lib.rs`'s `hydrate_path`). The
//! functions that decide what goes where are pure; only [`session_env`] touches
//! the database.

use std::ffi::OsString;
use std::path::Path;

use anyhow::{anyhow, Result};

use santree_pty::INHERITED_SESSION_MARKERS;

use super::backend::Route;
use super::EnvVars;
use crate::db::Db;
use crate::terminal::TerminalOpenOpts;

/// Name prefixes that never travel into a session through `base_env`: santree's
/// own settings and the runtime it is built on. `DYLD_`/`LD_` are the dynamic
/// loader's — a variable a host process was *started* with, not one a shell
/// should have: forwarding them would load this app's libraries into every
/// agent.
const DENIED_PREFIXES: [&str; 4] = ["SANTREE_", "TAURI_", "WEBKIT_", "DYLD_"];
/// `LD_` apart because it reads as a prefix of unrelated names (`LDFLAGS`
/// doesn't match: the underscore does the work).
const DENIED_LOADER_PREFIX: &str = "LD_";

/// The `env` a new terminal opens with, for the route the facade decided.
///
/// Errors only for a Daedalus agent pane whose term key isn't one santree
/// would mint, or whose cwd is in no registered Daedalus project — the same
/// refusals the Daedalus open has always made.
pub async fn session_env(route: Route, db: &Db, opts: &TerminalOpenOpts) -> Result<EnvVars> {
    match route {
        Route::Local => Ok(crate::env::resolve_env(db, opts.cwd.as_deref()).await),
        Route::Daedalus => {
            let cwd = opts
                .cwd
                .as_deref()
                .ok_or_else(|| anyhow!("a Daedalus terminal needs a directory"))?;
            let repo = crate::repo::daedalus_repo_at(db, Path::new(cwd))
                .await?
                .ok_or_else(|| anyhow!("{cwd} is in no Daedalus project"))?;
            daedalus_env(&repo, opts)
        }
    }
}

/// What a local server's sessions inherit: this process's environment as it is
/// now — after `lib.rs`'s `hydrate_path`, so the login shell's `PATH` is in it —
/// minus the deny-list. For a [`super::remote::Profile::base_env`].
pub fn server_base_env() -> Vec<(String, String)> {
    forwardable(std::env::vars_os())
}

/// `ambient` as `base_env`: what is left after the deny-list, sorted so a
/// session's environment is the same every time it is built from the same
/// process.
///
/// Dropped, besides the deny-list: a variable whose name or value isn't UTF-8
/// (the wire is JSON; a lossy conversion would hand a shell a value nobody set)
/// and one whose name couldn't be an environment variable at all.
fn forwardable(ambient: impl Iterator<Item = (OsString, OsString)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = ambient
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(name, _)| !denied(name))
        .collect();
    out.sort();
    out
}

fn denied(name: &str) -> bool {
    name.is_empty()
        || name.contains(['=', '\0'])
        || INHERITED_SESSION_MARKERS.contains(&name)
        || name.starts_with(DENIED_LOADER_PREFIX)
        || DENIED_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// A Daedalus pane's env: `TERM` and, for an agent, what the hooks it fires on
/// the box carry back so the relay binds its session to this pane
/// (docs/remote.md). The launch seed exports the same pair; here they are the
/// pane's own.
///
/// Not [`crate::env::resolve_env`]: that is this Mac's project environment —
/// variables whose values live in this Mac's keychain and `.env` files read
/// from this Mac's disk — and none of it is the box's to have. The shell there
/// is the box's login shell under the session host, which already runs with the
/// operator's profile `PATH`; the box's own profile is where a Daedalus
/// project's environment belongs.
fn daedalus_env(repo: &str, opts: &TerminalOpenOpts) -> Result<Vec<(String, String)>> {
    let mut env = vec![("TERM".to_string(), "xterm-256color".to_string())];
    if opts.agent_kind.is_some() {
        crate::tabs::validate_term_key(&opts.label).map_err(anyhow::Error::msg)?;
        env.push(("SANTREE_REPO".into(), repo.to_string()));
        env.push(("SANTREE_TERM_KEY".into(), opts.label.clone()));
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use santree_core::domain::AgentKind;

    fn os(pairs: &[(&str, &str)]) -> impl Iterator<Item = (OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(*k), OsString::from(*v)))
            .collect::<Vec<_>>()
            .into_iter()
    }

    fn names(env: &[(String, String)]) -> Vec<&str> {
        env.iter().map(|(k, _)| k.as_str()).collect()
    }

    fn opts(label: &str, agent_kind: Option<AgentKind>) -> TerminalOpenOpts {
        TerminalOpenOpts {
            cwd: Some("/srv/web".into()),
            command: String::new(),
            args: Vec::new(),
            cols: 80,
            rows: 24,
            owner: "page".into(),
            label: label.into(),
            agent_kind,
        }
    }

    #[test]
    fn the_deny_list_names_every_session_marker_and_prefix() {
        let ambient = os(&[
            ("PATH", "/opt/homebrew/bin:/usr/bin"),
            ("HOME", "/Users/me"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_CHILD_SESSION", "1"),
            ("CLAUDE_CODE_SESSION_ID", "x"),
            ("AI_AGENT", "claude"),
            ("SANTREE_SMOKE", "1"),
            ("SANTREE_SERVER", "1"),
            ("TAURI_ENV_DEBUG", "true"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            ("DYLD_INSERT_LIBRARIES", "/x.dylib"),
            ("DYLD_LIBRARY_PATH", "/lib"),
            ("LD_PRELOAD", "/x.so"),
            ("LD_LIBRARY_PATH", "/lib"),
            ("LANG", "en_US.UTF-8"),
        ]);
        let base = forwardable(ambient);
        assert_eq!(names(&base), ["HOME", "LANG", "PATH"]);
    }

    #[test]
    fn every_inherited_session_marker_is_denied() {
        for marker in INHERITED_SESSION_MARKERS {
            let base = forwardable(os(&[(marker, "1"), ("KEEP", "1")]));
            assert_eq!(names(&base), ["KEEP"], "{marker} reached base_env");
        }
    }

    #[test]
    fn a_prefix_match_is_on_the_name_start_only() {
        // `LDFLAGS` and `MY_LD_X` merely contain the letters; a name that
        // *starts* with `SANTREE_` is santree's and nothing else is.
        let base = forwardable(os(&[
            ("LDFLAGS", "-L/x"),
            ("MY_LD_X", "1"),
            ("NOT_SANTREE_X", "1"),
            ("XTAURI_Y", "1"),
            ("SANTREE", "bare"),
        ]));
        assert_eq!(
            names(&base),
            ["LDFLAGS", "MY_LD_X", "NOT_SANTREE_X", "SANTREE", "XTAURI_Y"]
        );
    }

    /// An entry that cannot cross unchanged — a name or value that is not
    /// UTF-8, or a name no environment can hold — is dropped, not mangled.
    #[test]
    fn an_entry_that_cannot_cross_unchanged_is_dropped() {
        use std::os::unix::ffi::OsStringExt;
        let bad = OsString::from_vec(vec![b'o', b'k', 0xff]);
        let mut ambient: Vec<_> = os(&[("", "1"), ("A=B", "1"), ("GOOD", "1")]).collect();
        ambient.extend([
            (OsString::from("BAD_VALUE"), bad.clone()),
            (bad, OsString::from("1")),
        ]);
        let base = forwardable(ambient.into_iter());
        assert_eq!(base, vec![("GOOD".to_string(), "1".to_string())]);
    }

    /// A Daedalus session gets `TERM` and nothing of this Mac's environment;
    /// an agent also carries the pair its hooks bind back by.
    #[test]
    fn a_daedalus_session_gets_term_and_an_agent_its_hook_pair() {
        let term = ("TERM".to_string(), "xterm-256color".to_string());
        let shell = daedalus_env("acme/web", &opts("tree:AK-1:tab:t1", None)).unwrap();
        assert_eq!(shell, vec![term.clone()]);
        let agent = daedalus_env("acme/web", &opts("tree:AK-1", Some(AgentKind::Claude))).unwrap();
        assert_eq!(
            agent,
            vec![
                term,
                ("SANTREE_REPO".to_string(), "acme/web".to_string()),
                ("SANTREE_TERM_KEY".to_string(), "tree:AK-1".to_string()),
            ]
        );
    }

    #[test]
    fn a_daedalus_agent_with_a_term_key_santree_would_not_mint_is_refused() {
        let refused = daedalus_env("acme/web", &opts("tree:$(id)", Some(AgentKind::Claude)));
        assert!(refused.is_err());
    }
}
