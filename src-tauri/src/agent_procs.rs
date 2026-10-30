//! Which coding agent is running in a terminal pane, observed in the process
//! table rather than remembered.
//!
//! santree has two *records* of an agent: what it launched (the terminal tab's
//! `AgentTabIdentity`) and what a provider's hooks reported (`session_state`).
//! This is the *observation*. For each live PTY it walks the processes descended
//! from that pane's root pid and asks which one owns the terminal's foreground
//! process group — the same shape Orca uses.
//!
//! It sees two things neither record can:
//!
//! * a **Codex tab opened and never prompted** — Codex creates its thread on the
//!   first submitted turn and fires `SessionStart` only there (measured on
//!   0.151.0), so nothing hook-fed knows the tab exists;
//! * an agent **the user started themselves**, by typing `codex` in a santree
//!   shell. santree's own bookkeeping can never know about that one.
//!
//! ## It answers identity, never status
//!
//! `src/lib/attention.ts` is this app's single agent-state vocabulary and there
//! is deliberately no second one. All this contributes is "a Codex is in the
//! foreground of pane X". What that agent is *doing* still comes from the hook
//! rows, and then from the terminal title — the existing three-tier arbiter,
//! untouched.
//!
//! ## Compliance
//!
//! Reading the OS process table is *observation*, the same passive class as
//! reading a pane's title, and it must stay one (COMPLIANCE.md, "No automated
//! control loop"). Nothing derived here is ever written back into a PTY, gates a
//! launch, chooses a prompt, or becomes an argument to a command: it reaches the
//! sidebar as a provider mark and stops there. The `ps` argv is a constant —
//! no IPC value reaches it — and no process is signalled or read beyond the
//! columns `ps` prints.

use std::collections::HashSet;

use santree_core::config;
use santree_core::domain::{AgentKind, AgentProcess};

use crate::proc_table::ProcTree;
use crate::settings::agent_binary;

/// Each provider's CLI basename, from the agent catalog — the same names
/// [`crate::settings::agent_executable`] probes for on `PATH`, so recognition
/// and launching can never drift onto different lists.
///
/// Only the catalog's default names. A user who points the exec setting at a
/// differently *named* binary is not recognised here, and falls back to
/// santree's launch record — see [`foreground_agent`] on why this supplements
/// that record rather than replacing it.
fn catalog() -> Vec<(&'static str, AgentKind)> {
    config::agents()
        .into_iter()
        .map(|def| (agent_binary(def.key), def.key))
        .collect()
}

/// Which agent, if any, owns the foreground of the pane rooted at `root`.
///
/// `ps`'s `+` flag is decisive: it marks the process group the terminal's input
/// actually reaches, which is the only sense in which an agent is "running in" a
/// pane. An agent the user suspended with ^Z, or left running in the background
/// while they work at the shell, is deliberately *not* claimed — the pane is
/// theirs at that moment, not the agent's.
///
/// Ties go to the shallowest process, which is why the walk is breadth-first: an
/// agent that shells out to another agent produces a second foreground match
/// (a child inherits its parent's process group), and it must not displace the
/// session the user is actually driving.
///
/// `None` is **unknown**, never "this is a plain shell". A `ps` that fails, a
/// pane whose root pid has already been reaped, and a CLI whose `argv[0]` is an
/// interpreter (an npm-installed agent behind a `#!/usr/bin/env node` shebang)
/// all land here — which is exactly why this supplements santree's launch record
/// instead of replacing it. The caller must treat a missing answer as no
/// information.
///
/// The answer carries the agent process's pid, for [`started_at_ms`].
pub fn foreground_agent(
    tree: &ProcTree,
    root: u32,
    catalog: &[(&str, AgentKind)],
) -> Option<(AgentKind, u32)> {
    // Nothing is accounted for elsewhere here — unlike the resource sums, panes
    // don't nest — so no subtree is pruned.
    tree.descend(root, &HashSet::new())
        .into_iter()
        .filter(|(_, p)| p.foreground && !p.zombie)
        .find_map(|(_, p)| {
            catalog
                .iter()
                .find(|(binary, _)| *binary == cli_name(&p.name))
                .map(|(_, kind)| (*kind, p.pid))
        })
}

/// The name a process goes by in the catalog: its `argv[0]` basename, less an
/// `.exe`. Claude Code's npm install links `claude` to its native binary,
/// `bin/claude.exe` (on macOS too), and santree launches the canonical path
/// ([`crate::settings::agent_executable`]), so that is what its own panes show.
fn cli_name(name: &str) -> &str {
    name.strip_suffix(".exe").unwrap_or(name)
}

/// One live pane to scan: its address, the pid its process tree hangs from,
/// and its PTY session id ([`AgentProcess::pane_id`]). The address is the
/// pair, not the `term_key` alone: one surface can host a pane per provider,
/// and a result keyed by the key alone would attribute one of them to the
/// other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRoot {
    pub pane: crate::terminal::LiveTerminal,
    pub pid: u32,
    pub id: Option<u32>,
}

/// Scan every live pane on this Mac ([`crate::terminal::pane_roots`]).
///
/// A pane that cannot be attributed is simply absent from the result. That
/// includes an unreadable process table: `ps` is a process spawn and it can be
/// slow, fail, or be killed, and none of those may error a query — or delay one
/// by more than the single bounded read [`crate::proc_table::snapshot`] allows,
/// whose failure is itself cached so the next caller is answered immediately.
/// The failure mode is "we don't know yet", which the frontend already has to
/// handle for every pane the walk finds nothing in.
pub async fn detect(panes: &[PaneRoot]) -> Vec<AgentProcess> {
    if panes.is_empty() {
        return Vec::new();
    }
    let tree = match crate::proc_table::snapshot().await {
        Ok(tree) => tree,
        Err(error) => {
            log::warn!("could not read the process table for agent detection: {error:#}");
            return Vec::new();
        }
    };
    attribute(&tree, panes, started_at_ms)
}

/// The agent in each pane's foreground, in a process table already read — this
/// Mac's ([`detect`]), or the box's for the panes of a Daedalus project
/// (`daedalus::agents`), whose root pids are the box's. `started` answers
/// when a pid of that table started, which only this Mac's kernel can do for
/// its own processes; a Daedalus caller passes one that never answers.
pub(crate) fn attribute(
    tree: &ProcTree,
    panes: &[PaneRoot],
    started: impl Fn(u32) -> Option<f64>,
) -> Vec<AgentProcess> {
    let catalog = catalog();
    panes
        .iter()
        .filter_map(|root| {
            foreground_agent(tree, root.pid, &catalog).map(|(agent_kind, pid)| AgentProcess {
                term_key: root.pane.term_key.clone(),
                pane_agent_kind: root.pane.agent_kind,
                agent_kind,
                pane_id: root.id,
                started_at_ms: started(pid),
            })
        })
        .collect()
}

/// When process `pid` of this Mac started, epoch ms, from the kernel's own
/// record of it (`proc_pidinfo`). The fork time: a process that `exec`s
/// another program keeps it, which is why a pane santree launched as
/// `exec claude` reports when the pane was spawned.
///
/// Identity, like the rest of this module: the start time is read and nothing
/// else of the process (`pbi_start_tv*` out of the BSD info). A pid that has
/// gone, or one the kernel won't describe, is `None`.
pub(crate) fn started_at_ms(pid: u32) -> Option<f64> {
    let pid = libc::c_int::try_from(pid).ok()?;
    // SAFETY: an all-zero `proc_bsdinfo` is a valid value of that plain C
    // struct, and the kernel writes at most `size` bytes into it.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: `info` is a live, writable `proc_bsdinfo` of exactly `size` bytes.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    let ms = info
        .pbi_start_tvsec
        .checked_mul(1_000)?
        .checked_add(info.pbi_start_tvusec / 1_000)?;
    Some(ms as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc_table::parse_ps;

    /// One host with five panes:
    ///
    /// * 200 — a shell whose foreground is `claude` (santree's own `exec` launch
    ///   leaves the CLI as the pane root; this is the shape where a shell is
    ///   still in between, which is what a user-typed agent looks like);
    /// * 300 — a shell at its own prompt, with a `codex` the user suspended and
    ///   a `vim` open on a file called `codex`;
    /// * 400 — a plain shell running a build;
    /// * 500 — `codex` as the pane root, unprompted, exactly as santree launches
    ///   it, with a `claude -p` helper it shelled out to;
    /// * 700 — `claude` as santree launches it on a real npm install: the
    ///   canonical path, whose native binary is `bin/claude.exe`.
    const LISTING: &str = "\
    1     0   0.0  24688 Ss   /sbin/launchd
  100     1   1.5  50000 S    /Applications/santree.app/Contents/MacOS/santree
  200   100   0.0   4000 Ss   /bin/zsh -l
  201   200  12.5 300000 S+   /opt/homebrew/bin/claude --settings /tmp/h.json
  202   201   0.5  20000 S+   /usr/bin/git status
  300   100   0.0   4000 Ss+  /bin/zsh -l
  301   300   0.0  90000 T    /opt/homebrew/bin/codex
  302   300   0.0  10000 S    /usr/bin/vim codex
  400   100   0.0   4000 Ss   /bin/zsh -l
  401   400  50.0  80000 R+   /usr/bin/make -j8
  500   100   1.0  70000 Ss+  /opt/homebrew/bin/codex
  501   500   0.5  60000 S+   /opt/homebrew/bin/claude -p summarize
  600   100   0.0   3000 Z    /bin/zsh
  700   100  12.5 300000 Ss+  /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --settings /tmp/h.json
";

    fn tree() -> ProcTree {
        ProcTree::new(parse_ps(LISTING))
    }

    fn agent(root: u32) -> Option<AgentKind> {
        foreground_agent(&tree(), root, &catalog()).map(|(kind, _)| kind)
    }

    /// Each pane is named by the agent in its foreground, or by nothing:
    ///
    /// * a Codex sitting unprompted at the pane root — the case the whole
    ///   feature exists for, having said nothing to any hook — is recognised,
    ///   and its own `claude -p` helper at depth 1 can't take the pane from it;
    /// * an agent the user typed into a shell is found as a descendant;
    /// * foreground is decisive: a suspended `codex` is not claimed, and nor is
    ///   a `vim` whose *argument* is called `codex` — only `argv[0]` names one;
    /// * unattributable is `None`, never a default provider: a build, a
    ///   vanished pane root and a zombie all mean "we don't know".
    #[test]
    fn a_pane_is_its_foreground_agent_or_unknown() {
        for (root, want, why) in [
            (
                500,
                Some(AgentKind::Codex),
                "an unprompted codex at the root",
            ),
            (
                200,
                Some(AgentKind::Claude),
                "an agent started inside a shell",
            ),
            (
                700,
                Some(AgentKind::Claude),
                "claude.exe, the canonical path santree launches",
            ),
            (300, None, "a backgrounded agent"),
            (400, None, "a build is not an agent"),
            (999, None, "a vanished pane root"),
            (600, None, "a zombie is nobody's foreground"),
        ] {
            assert_eq!(agent(root), want, "{why}");
        }
    }

    /// With a local santree server the panes' roots are the server's children,
    /// outside the app's subtree entirely (it hangs from launchd after a
    /// relaunch). The walk starts from each pane's own root pid
    /// (`SessionInfo.pid`), so it finds the agent wherever the pane lives, and
    /// still answers identity only.
    #[test]
    fn panes_hosted_by_a_server_outside_the_apps_subtree_are_attributed() {
        let listing = "\
    1     0   0.0  24688 Ss   /sbin/launchd
  100     1   1.5  50000 S    /Applications/santree.app/Contents/MacOS/santree
  150     1   0.2   9000 S    /Users/me/Library/Application Support/com.santree.desktop/server/r1/santree-server
  250   150   0.0   4000 Ss   /bin/zsh -l
  251   250  12.5 300000 S+   /opt/homebrew/bin/claude --settings /tmp/h.json
  260   150   1.0  70000 Ss+  /opt/homebrew/bin/codex
  270   150   0.0   4000 Ss+  /bin/zsh -l
";
        let tree = ProcTree::new(parse_ps(listing));
        let pane = |key: &str, pid: u32| PaneRoot {
            pane: crate::terminal::LiveTerminal {
                term_key: key.to_string(),
                agent_kind: None,
            },
            pid,
            id: Some(pid),
        };
        // The start time asked for is the agent's own process, not the pane
        // root's: here a shell (250) is between them.
        let found = attribute(
            &tree,
            &[
                pane("tree:A", 250),
                pane("tree:B", 260),
                pane("tree:C", 270),
            ],
            |pid| Some(f64::from(pid)),
        );
        let by_key = |key: &str| {
            found
                .iter()
                .find(|p| p.term_key == key)
                .map(|p| (p.agent_kind, p.pane_id, p.started_at_ms))
        };
        assert_eq!(
            by_key("tree:A"),
            Some((AgentKind::Claude, Some(250), Some(251.0)))
        );
        assert_eq!(
            by_key("tree:B"),
            Some((AgentKind::Codex, Some(260), Some(260.0)))
        );
        assert_eq!(
            by_key("tree:C"),
            None,
            "a plain shell is unknown, not defaulted"
        );
        // …and the walk stays inside each pane: the server above it, whose
        // other children are other panes, claims nothing for this one.
        assert_eq!(
            attribute(&tree, &[pane("tree:C", 270)], |_| None),
            Vec::new()
        );
    }

    /// The scan over the real thing: no panes means no `ps` at all, and this
    /// process's own pane-less pid attributes to nothing.
    #[tokio::test]
    async fn detect_reports_only_what_it_can_attribute() {
        assert!(detect(&[]).await.is_empty());
        let mine = std::process::id();
        let found = detect(&[PaneRoot {
            pane: crate::terminal::LiveTerminal {
                term_key: "term:test".to_string(),
                agent_kind: None,
            },
            pid: mine,
            id: None,
        }])
        .await;
        assert!(
            found.iter().all(|p| p.term_key == "term:test"),
            "a result can only ever name the pane it was asked about"
        );
    }
}
