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
pub fn foreground_agent(
    tree: &ProcTree,
    root: u32,
    catalog: &[(&str, AgentKind)],
) -> Option<AgentKind> {
    // Nothing is accounted for elsewhere here — unlike the resource sums, panes
    // don't nest — so no subtree is pruned.
    tree.descend(root, &HashSet::new())
        .into_iter()
        .filter(|(_, p)| p.foreground && !p.zombie)
        .find_map(|(_, p)| {
            catalog
                .iter()
                .find(|(binary, _)| *binary == p.name)
                .map(|(_, kind)| *kind)
        })
}

/// Scan every live pane. `panes` is `(pane address, root pid)` — see
/// [`crate::terminal::pane_roots`]. The address is the pair, not the `term_key`
/// alone: one surface can host a pane per provider, and a result keyed by the
/// key alone would attribute one of them to the other.
///
/// A pane that cannot be attributed is simply absent from the result. That
/// includes an unreadable process table: `ps` is a process spawn and it can be
/// slow, fail, or be killed, and none of those may error a query — or delay one
/// by more than the single bounded read [`crate::proc_table::snapshot`] allows,
/// whose failure is itself cached so the next caller is answered immediately.
/// The failure mode is "we don't know yet", which the frontend already has to
/// handle for every pane the walk finds nothing in.
pub async fn detect(panes: &[(crate::terminal::LiveTerminal, u32)]) -> Vec<AgentProcess> {
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
    let catalog = catalog();
    panes
        .iter()
        .filter_map(|(pane, pid)| {
            foreground_agent(&tree, *pid, &catalog).map(|agent_kind| AgentProcess {
                term_key: pane.term_key.clone(),
                pane_agent_kind: pane.agent_kind,
                agent_kind,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc_table::parse_ps;

    /// One host with four panes:
    ///
    /// * 200 — a shell whose foreground is `claude` (santree's own `exec` launch
    ///   leaves the CLI as the pane root; this is the shape where a shell is
    ///   still in between, which is what a user-typed agent looks like);
    /// * 300 — a shell at its own prompt, with a `codex` the user suspended and
    ///   a `vim` open on a file called `codex`;
    /// * 400 — a plain shell running a build;
    /// * 500 — `codex` as the pane root, unprompted, exactly as santree launches
    ///   it, with a `claude -p` helper it shelled out to.
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
";

    fn tree() -> ProcTree {
        ProcTree::new(parse_ps(LISTING))
    }

    fn agent(root: u32) -> Option<AgentKind> {
        foreground_agent(&tree(), root, &catalog())
    }

    /// The catalog is the list. A provider added there is recognised here with
    /// no second list to update.
    #[test]
    fn every_catalogued_provider_is_recognisable_by_its_own_binary_name() {
        let catalog = catalog();
        assert_eq!(catalog.len(), config::agents().len());
        for (binary, kind) in &catalog {
            assert_eq!(*binary, agent_binary(*kind));
            assert!(!binary.is_empty());
        }
        assert!(catalog.contains(&("claude", AgentKind::Claude)));
        assert!(catalog.contains(&("codex", AgentKind::Codex)));
    }

    /// The case the whole feature exists for: a Codex sitting at its prompt,
    /// having said nothing to any hook, is still recognised.
    #[test]
    fn an_unprompted_codex_pane_is_recognised() {
        assert_eq!(agent(500), Some(AgentKind::Codex));
    }

    /// A descendant, not just the root: the agent the user typed into a shell.
    #[test]
    fn an_agent_started_by_hand_inside_a_shell_is_found() {
        assert_eq!(agent(200), Some(AgentKind::Claude));
    }

    /// Foreground is decisive both ways. A suspended `codex` is not claimed, and
    /// neither is a `vim` whose *argument* happens to be called `codex` — only
    /// `argv[0]` names a process.
    #[test]
    fn a_backgrounded_agent_does_not_claim_its_pane() {
        assert_eq!(agent(300), None);
    }

    /// A shallower foreground match wins, so an agent's own helper can't take
    /// the pane's identity from it.
    #[test]
    fn the_agent_nearest_the_pane_root_wins_over_one_it_shelled_out_to() {
        assert_eq!(
            agent(500),
            Some(AgentKind::Codex),
            "the Claude helper at depth 1 must not outrank the Codex at depth 0"
        );
    }

    /// Unattributable is `None`, never a default provider: a plain shell, a pane
    /// whose root has been reaped, and a zombie all mean "we don't know", and
    /// nothing may render a guess as live data.
    #[test]
    fn a_pane_with_no_agent_is_unknown_rather_than_defaulted() {
        assert_eq!(agent(400), None, "a build is not an agent");
        assert_eq!(agent(999), None, "a vanished pane root");
        assert_eq!(agent(600), None, "a zombie is nobody's foreground");
    }

    /// The scan over the real thing: no panes means no `ps` at all, and this
    /// process's own pane-less pid attributes to nothing.
    #[tokio::test]
    async fn detect_reports_only_what_it_can_attribute() {
        assert!(detect(&[]).await.is_empty());
        let mine = std::process::id();
        let found = detect(&[(
            crate::terminal::LiveTerminal {
                term_key: "term:test".to_string(),
                agent_kind: None,
            },
            mine,
        )])
        .await;
        assert!(
            found.iter().all(|p| p.term_key == "term:test"),
            "a result can only ever name the pane it was asked about"
        );
    }
}
