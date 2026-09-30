//! Claude and Codex in a Daedalus project, end to end over the link: the hook
//! settings written on the box, the launch resolved against the box's records
//! and CLIs, the pane's argv and env, the box's hooks relayed back into this
//! app's database, and which agent a pane runs read from the box's process
//! table — through the app's `DaedalusHost` to a fake session host
//! (`FakeAgent` in front of a `FakeDaemon`, real PTYs and real processes).
//!
//! The "box" is this machine's temp dir, with a home of its own (`BoxHome`)
//! whose `bin/` holds stand-in `claude` / `codex` scripts: the fake host's
//! children get that home and `PATH`, as the real host's get its unit's. Every
//! wait is on a condition, never a guessed interval.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use santree_core::domain::{AgentKind, AgentProcess, AgentSession, AgentState, DaedalusLink};
use santree_pty::PtyManager;
use santree_remote_client::fake::{FakeAgent, FakeDaemon, FakeOptions};

use super::agents;
use super::host::{describe, DaedalusHost};
use super::terminal_tests::{fast, registered, server, until, Screen, Server, WAIT};
use crate::db::Db;
use crate::provider::{SessionRequest, SessionSurface};
use crate::terminal::{self, LiveTerminal, PaneLink, TerminalOpenOpts};
use crate::worktree;

/// `hello.hookBin` on the fake box.
const HOOK_BIN: &str = "/opt/daedalus/bin/daedalus-session-host";

/// The operator's home on the box: `bin/` first on `PATH` (for the host's
/// children directly, and for a login shell through `.bash_profile`, since a
/// login shell resets `PATH`).
struct BoxHome {
    home: PathBuf,
}

impl BoxHome {
    fn new(scratch: &Path) -> Self {
        let home = scratch.join("box-home");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(
            home.join(".bash_profile"),
            "PATH=\"$HOME/bin:$PATH\"; export PATH\n",
        )
        .unwrap();
        Self { home }
    }

    /// A stand-in CLI on the box: a script, or a link to a real program.
    fn cli(&self, name: &str, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = self.home.join("bin").join(name);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn link(&self, name: &str, target: &str) {
        std::os::unix::fs::symlink(target, self.home.join("bin").join(name)).unwrap();
    }

    fn env(&self) -> Vec<(String, String)> {
        let path = std::env::var("PATH").unwrap_or_default();
        vec![
            ("HOME".into(), self.home.to_string_lossy().into_owned()),
            (
                "PATH".into(),
                format!("{}:{path}", self.home.join("bin").display()),
            ),
        ]
    }
}

fn fake_agent(server: &Server, home: &BoxHome, socket_dir: &Path) -> (FakeAgent, FakeDaemon) {
    let daemon = FakeDaemon::with_options(FakeOptions {
        projects_root: server.root.to_string_lossy().into_owned(),
        home: home.home.to_string_lossy().into_owned(),
        hook_bin: HOOK_BIN.into(),
        env: home.env(),
        ..FakeOptions::default()
    });
    let agent = FakeAgent::serve(socket_dir.join("santree.sock"), daemon.clone()).unwrap();
    (agent, daemon)
}

async fn connected(agent: &FakeAgent) -> DaedalusHost {
    let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
    link.resume(None);
    link.client_within(WAIT).await.expect("the link comes up");
    link
}

/// A launch of `kind` in `cwd`, resolved as `agent_session` resolves one in a
/// Daedalus project.
async fn resolve(
    link: &DaedalusHost,
    db: &Db,
    repo: &str,
    kind: AgentKind,
    cwd: &Path,
    term_key: &str,
    effort: Option<&str>,
) -> anyhow::Result<AgentSession> {
    let root = worktree::root(db, link, repo).await?;
    agents::resolve_session(
        link,
        &root,
        kind,
        SessionRequest {
            db,
            repo,
            term_key,
            cwd,
            allow_fresh: true,
            model: None,
            effort,
            surface: SessionSurface::Work,
            review_mcp_config: None,
        },
    )
    .await
}

/// An agent pane in `cwd` under `label`, as a launch opens one: a shell whose
/// seed then `exec`s the agent.
async fn agent_pane(
    manager: &PtyManager,
    db: &Db,
    link: &DaedalusHost,
    cwd: &Path,
    label: &str,
) -> (santree_pty::SessionId, Screen) {
    let screen = Screen::new();
    let (output, links) = screen.channels();
    let opts = TerminalOpenOpts {
        cwd: Some(cwd.to_string_lossy().into_owned()),
        command: "/bin/sh".into(),
        args: Vec::new(),
        cols: 120,
        rows: 30,
        owner: "page-1".into(),
        label: label.into(),
        agent_kind: Some(AgentKind::Claude),
    };
    let id = terminal::open(manager, db, link, opts, output, links)
        .await
        .unwrap();
    screen
        .until("the pane to go live", |s| {
            s.last_link() == Some(PaneLink::Live)
        })
        .await;
    (id, screen)
}

/// The words a settings file's hook command runs after `<hookBin> hook` — what
/// the box's hook subcommand queues as the event.
fn relayed_event(settings: &Value, event: &str) -> String {
    let command = settings["hooks"][event][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    command
        .strip_prefix(&format!("'{HOOK_BIN}' hook "))
        .unwrap_or_else(|| panic!("not a box hook command: {command}"))
        .to_string()
}

fn read_json(path: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn launching_an_agent_writes_its_hooks_on_the_box_and_runs_it_there() {
    let _serial = crate::stream::pty_guard().await;
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let home = BoxHome::new(scratch.path());
    // Prints the argv it got and the pane's own SANTREE_* pair, then holds the
    // pane like an interactive agent does.
    home.cli(
        "claude",
        "#!/bin/sh\nprintf 'ARGV:'; printf '%s|' \"$@\"; \
         printf '\\nENV:%s|%s\\n' \"$SANTREE_REPO\" \"$SANTREE_TERM_KEY\"; exec cat\n",
    );
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, &home, scratch.path());
    let link = connected(&agent).await;

    // The hooks: written in santree's directory in the checkout's git dir on
    // the box, every command the session host's hook subcommand.
    let hooks = agents::hooks(&db, &link, &repo).await.unwrap();
    let santree = server.web.join(".git/santree");
    assert_eq!(
        hooks.claude_settings,
        santree.join("claude-hooks.json").to_string_lossy()
    );
    let settings = read_json(&hooks.claude_settings);
    for event in ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] {
        assert_eq!(relayed_event(&settings, event), event);
    }
    assert_eq!(
        settings["statusLine"]["command"],
        format!("'{HOOK_BIN}' hook statusline"),
        "the status line runs on the box and records only"
    );
    let no_git = read_json(&hooks.claude_settings_no_git);
    assert_eq!(relayed_event(&no_git, "Stop"), "Stop");
    assert!(
        no_git["permissions"]["deny"]
            .as_array()
            .unwrap()
            .contains(&"Bash(git push)".into()),
        "{no_git}"
    );
    assert!(
        hooks.codex_flags.contains(HOOK_BIN)
            && hooks
                .codex_flags
                .contains("hook --agent-kind Codex SessionStart")
            && !hooks.codex_flags.contains("--db"),
        "{}",
        hooks.codex_flags
    );
    assert!(
        daemon.exec_log().iter().any(|argv| argv
            == &[
                "git",
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir"
            ]),
        "the git dir is the box's: {:?}",
        daemon.exec_log()
    );

    // The launch: a fresh Claude session under an id santree minted, run by
    // the box's own `claude`.
    let session = resolve(
        &link,
        &db,
        &repo,
        AgentKind::Claude,
        &server.worktree,
        "tree:AK-1",
        None,
    )
    .await
    .unwrap();
    let AgentSession::Fresh {
        executable,
        session_id: Some(id),
        ..
    } = session
    else {
        panic!("a fresh Claude launch: {session:?}");
    };
    assert_eq!(executable, "claude");

    // The pane: on the box, in the worktree, as the agent's; the seed typed
    // into it is the frontend's (`agentSessionSeed`), minus the `env` words —
    // the pane's own env carries the pair the hooks bind by.
    let manager = PtyManager::new();
    let (pane, screen) = agent_pane(&manager, &db, &link, &server.worktree, "tree:AK-1").await;
    let seed = format!(
        "exec 'claude' --settings '{}' --session-id '{id}'",
        hooks.claude_settings
    );
    link.terminals().seed(pane, format!("{seed}\r")).unwrap();
    let argv = format!(
        "ARGV:--settings|{}|--session-id|{id}|",
        hooks.claude_settings
    );
    screen
        .until("the agent's argv", |s| s.text().contains(&argv))
        .await;
    screen
        .until("the pane's SANTREE_* pair", |s| {
            s.text().contains(&format!("ENV:{repo}|tree:AK-1"))
        })
        .await;
    let on_box: Vec<_> = daemon
        .pty()
        .sessions()
        .into_iter()
        .filter(|s| s.alive)
        .collect();
    assert_eq!(on_box.len(), 1);
    assert_eq!(on_box[0].label, "tree:AK-1");
    assert_eq!(on_box[0].agent_kind, Some(AgentKind::Claude));
    assert_eq!(
        on_box[0].cwd.as_deref(),
        Some(&*server.worktree.to_string_lossy())
    );
    assert!(manager.sessions().is_empty(), "nothing ran on this Mac");

    // Its transcript on the box makes the next launch a resume of it.
    let transcripts = home
        .home
        .join(".claude/projects")
        .join(crate::session::project_slug(
            &server.worktree.to_string_lossy(),
        ));
    std::fs::create_dir_all(&transcripts).unwrap();
    std::fs::write(transcripts.join(format!("{id}.jsonl")), "{}\n").unwrap();
    let again = resolve(
        &link,
        &db,
        &repo,
        AgentKind::Claude,
        &server.worktree,
        "tree:AK-1",
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        again,
        AgentSession::Resume {
            agent_kind: AgentKind::Claude,
            executable: "claude".into(),
            session_id: id,
            launch_flags: String::new(),
        }
    );

    link.terminals().close(pane);
    until("the box's PTY closed", || {
        daemon.pty().sessions().iter().all(|s| !s.alive)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_codex_launch_is_configured_and_checked_against_the_boxs_codex() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let home = BoxHome::new(scratch.path());
    home.cli("claude", "#!/bin/sh\nexit 0\n");
    // Answers the strict-config check the way a Codex that knows the key does.
    home.cli("codex", "#!/bin/sh\nexit 0\n");
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, &home, scratch.path());
    let link = connected(&agent).await;

    assert_eq!(
        link.agents().clis(&link).await,
        Some(vec![AgentKind::Claude, AgentKind::Codex])
    );
    let session = resolve(
        &link,
        &db,
        &repo,
        AgentKind::Codex,
        &server.worktree,
        "tree:AK-1",
        Some("high"),
    )
    .await
    .unwrap();
    let AgentSession::Fresh {
        executable,
        session_id: None,
        launch_flags,
        ..
    } = session
    else {
        panic!("a fresh Codex launch: {session:?}");
    };
    assert_eq!(executable, "codex");
    // Its git writes may reach the repo's git dir — the box's.
    let git_dir = server.web.join(".git");
    assert!(
        launch_flags.contains(&format!("--add-dir '{}'", git_dir.display())),
        "{launch_flags}"
    );
    assert!(
        launch_flags.contains("model_reasoning_effort"),
        "{launch_flags}"
    );
    let checked = daemon
        .exec_log()
        .into_iter()
        .find(|argv| argv.first().map(String::as_str) == Some("codex"))
        .expect("the overrides were checked on the box");
    assert_eq!(checked[1..3], ["exec", "--strict-config"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cli_the_box_lacks_is_a_state_not_a_failing_launch() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let home = BoxHome::new(scratch.path());
    home.cli("claude", "#!/bin/sh\nexit 0\n");
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, &home, scratch.path());
    let link = connected(&agent).await;

    // Asked of the box's login shell, the one a pane launches from.
    assert_eq!(
        link.agents().clis(&link).await,
        Some(vec![AgentKind::Claude])
    );
    assert!(
        daemon
            .exec_log()
            .iter()
            .any(|argv| argv[..2] == ["bash", "-lc"]
                && argv.ends_with(&["claude".into(), "codex".into()])),
        "{:?}",
        daemon.exec_log()
    );

    let codex = resolve(
        &link,
        &db,
        &repo,
        AgentKind::Codex,
        &server.worktree,
        "tree:AK-1",
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(codex.to_string(), agents::not_installed(AgentKind::Codex));
    assert!(codex
        .to_string()
        .contains("Codex isn't installed on Daedalus"));
    assert!(daemon.pty().sessions().is_empty(), "nothing was started");
    assert!(
        !daemon
            .exec_log()
            .iter()
            .any(|argv| argv.first().map(String::as_str) == Some("codex")),
        "no codex was run"
    );
}

/// Every row the relay writes that the refusals must leave alone.
async fn state_of(db: &Db, session_id: &str) -> Option<(String, String)> {
    sqlx::query_as("SELECT state, event FROM session_state WHERE session_id = ?")
        .bind(session_id)
        .fetch_optional(db)
        .await
        .unwrap()
}

async fn binding_of(db: &Db, session_id: &str) -> Option<(String, String)> {
    sqlx::query_as("SELECT repo, term_key FROM terminal_sessions WHERE session_id = ?")
        .bind(session_id)
        .fetch_optional(db)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relayed_hooks_from_the_box_drive_the_panes_agent_state() {
    let _serial = crate::stream::pty_guard().await;
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let home = BoxHome::new(scratch.path());
    home.cli("claude", "#!/bin/sh\nexit 0\n");
    let (db, repo) = registered(&server, scratch.path()).await;
    let db_path = scratch
        .path()
        .join("test.db")
        .to_string_lossy()
        .into_owned();
    let (agent, daemon) = fake_agent(&server, &home, scratch.path());
    let link = connected(&agent).await;
    tokio::spawn(
        link.hook_relay(db.clone(), db_path, |_| {})
            .expect("one relay per link"),
    );

    let hooks = agents::hooks(&db, &link, &repo).await.unwrap();
    let settings = read_json(&hooks.claude_settings);
    let session = resolve(
        &link,
        &db,
        &repo,
        AgentKind::Claude,
        &server.worktree,
        "tree:AK-1",
        None,
    )
    .await
    .unwrap();
    let AgentSession::Fresh {
        session_id: Some(id),
        ..
    } = session
    else {
        panic!("{session:?}");
    };
    let manager = PtyManager::new();
    let (pane, _screen) = agent_pane(&manager, &db, &link, &server.worktree, "tree:AK-1").await;
    let address = LiveTerminal {
        term_key: "tree:AK-1".into(),
        agent_kind: Some(AgentKind::Claude),
    };
    assert!(link.terminals().live().contains(&address));

    // What the box's hook subcommand queues: the settings' own event words,
    // the pane's SANTREE_* pair, and the CLI's payload.
    let worktree = server.worktree.to_string_lossy().into_owned();
    let env = |repo: &str, term_key: &str| {
        vec![
            ("SANTREE_REPO".to_string(), repo.to_string()),
            ("SANTREE_TERM_KEY".to_string(), term_key.to_string()),
            ("CLAUDE_PROJECT_DIR".to_string(), worktree.clone()),
        ]
    };
    let payload = |session_id: &str| {
        format!(
            r#"{{"session_id":"{session_id}","cwd":"{worktree}","transcript_path":"/box/t.jsonl"}}"#
        )
        .into_bytes()
    };
    let states = || {
        let (db, live) = (db.clone(), link.terminals().live());
        async move { crate::hooks::session_states(&db, live).await.unwrap() }
    };
    let drained = || daemon.queued_hooks().is_empty();

    daemon.push_hook(
        &relayed_event(&settings, "SessionStart"),
        env(&repo, "tree:AK-1"),
        payload(&id),
    );
    until("SessionStart relayed", drained).await;
    let started = states()
        .await
        .into_iter()
        .find(|s| s.session_id == id)
        .expect("the session is on the registry");
    assert_eq!(started.state, AgentState::Idle);
    assert_eq!(started.term_key.as_deref(), Some("tree:AK-1"));
    assert_eq!(started.repo.as_deref(), Some(repo.as_str()));
    assert_eq!(started.agent_kind, Some(AgentKind::Claude));
    assert_eq!(
        started.transcript_path, None,
        "a box path names nothing here"
    );

    daemon.push_hook(
        &relayed_event(&settings, "UserPromptSubmit"),
        env(&repo, "tree:AK-1"),
        payload(&id),
    );
    until("UserPromptSubmit relayed", drained).await;
    assert_eq!(
        state_of(&db, &id).await,
        Some(("active".into(), "UserPromptSubmit".into()))
    );

    // The refusals. A local project's session, which the box may not touch.
    const LOCAL: &str = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f";
    const FOREIGN: &str = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e60";
    sqlx::query("INSERT INTO repos (name, path) VALUES ('acme/local', '/Users/me/dev/local')")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
         VALUES ('acme/local', 'tree:AK-9', '/Users/me/dev/local', ?, 'Claude')",
    )
    .bind(LOCAL)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO session_state (session_id, state, event, cwd, updated_at_ms)
         VALUES (?, 'permission', 'PermissionRequest', '/Users/me/dev/local', 1)",
    )
    .bind(LOCAL)
    .execute(&db)
    .await
    .unwrap();
    let stop = relayed_event(&settings, "Stop");
    // …a terminal key santree would never mint;
    daemon.push_hook(&stop, env(&repo, "tree:AK-1;touch /tmp/x"), payload(&id));
    // …a session id that isn't one;
    daemon.push_hook(&stop, env(&repo, "tree:AK-1"), payload("../../etc/passwd"));
    // …a local project's session;
    daemon.push_hook(&stop, env(&repo, "tree:AK-1"), payload(LOCAL));
    // …a mode that isn't an event (no AI review on Daedalus);
    daemon.push_hook("mcp", env(&repo, "tree:AK-1"), b"{}".to_vec());
    // …and a project that isn't a Daedalus one, which records state but binds
    // no terminal.
    daemon.push_hook(
        &relayed_event(&settings, "SessionStart"),
        env("acme/local", "tree:AK-2"),
        payload(FOREIGN),
    );
    until("every refusal acked", drained).await;

    assert_eq!(
        state_of(&db, &id).await,
        Some(("active".into(), "UserPromptSubmit".into())),
        "no refused Stop reached the pane's session"
    );
    assert_eq!(
        state_of(&db, LOCAL).await,
        Some(("permission".into(), "PermissionRequest".into())),
        "the local session is untouched"
    );
    assert_eq!(binding_of(&db, FOREIGN).await, None, "nothing bound");
    assert_eq!(
        binding_of(&db, &id).await,
        Some((repo.clone(), "tree:AK-1".into()))
    );
    let log = std::fs::read_to_string(scratch.path().join("santree-hook-errors.log")).unwrap();
    assert!(log.contains("belongs to a local project"), "{log}");
    assert!(log.contains("terminal key"), "{log}");
    assert!(log.contains("session id"), "{log}");

    // The pane closing on the box ends the agent's session here.
    link.terminals().close(pane);
    until("the box's PTY closed", || {
        daemon.pty().sessions().iter().all(|s| !s.alive)
    })
    .await;
    assert!(!link.terminals().live().contains(&address));
    let ended = states()
        .await
        .into_iter()
        .find(|s| s.session_id == id)
        .unwrap();
    assert_eq!(ended.state, AgentState::Exited);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn which_agent_runs_in_a_daedalus_pane_is_read_from_the_boxs_process_table() {
    let _serial = crate::stream::pty_guard().await;
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let home = BoxHome::new(scratch.path());
    // `claude` by argv[0], holding the pane's foreground like the real CLI.
    home.link("claude", "/bin/cat");
    let (db, _repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, &home, scratch.path());
    let link = connected(&agent).await;

    let manager = PtyManager::new();
    let label = "tree:AK-1:tab:d1";
    let (pane, _screen) = agent_pane(&manager, &db, &link, &server.worktree, label).await;
    link.terminals().seed(pane, "exec claude\r".into()).unwrap();

    let expected = vec![AgentProcess {
        term_key: label.into(),
        pane_agent_kind: Some(AgentKind::Claude),
        agent_kind: AgentKind::Claude,
    }];
    let found = tokio::time::timeout(WAIT, async {
        loop {
            let found = link.agents().detect(&link).await;
            if found == expected {
                return found;
            }
            // The box's table is cached for half a second; ask again after it.
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    assert!(
        found.is_ok(),
        "never saw the agent in the pane's foreground"
    );
    let ps = daemon
        .exec_log()
        .into_iter()
        .find(|argv| argv.first().map(String::as_str) == Some("ps"))
        .expect("ps ran on the box");
    assert_eq!(ps[1..], ["-axo", "pid=,ppid=,pcpu=,rss=,stat=,command="]);
    assert!(manager.sessions().is_empty(), "nothing ran on this Mac");

    link.terminals().close(pane);
    until("closed", || {
        daemon.pty().sessions().iter().all(|s| !s.alive)
    })
    .await;
    assert!(link.agents().detect(&link).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_work_prompt_is_rendered_from_the_boxs_layer_and_written_there() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let home = BoxHome::new(scratch.path());
    std::fs::create_dir_all(server.web.join(".santree/prompts")).unwrap();
    std::fs::write(
        server.web.join(".santree/prompts/work.njk"),
        "Box layer for {{ ticket_id }}.",
    )
    .unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, &home, scratch.path());
    let link = connected(&agent).await;
    let local = scratch.path().join("mac-prompts");

    let path = worktree::work_prompt(&db, &link, &repo, "AK-1", &local)
        .await
        .unwrap();
    assert!(
        Path::new(&path).starts_with(server.web.join(".git/santree/prompts")),
        "{path}"
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "Box layer for AK-1."
    );
    assert!(!local.exists(), "nothing was written on this Mac");
    assert!(
        daemon
            .exec_log()
            .iter()
            .any(|argv| argv[0] == "find" && argv[1].ends_with(".santree/prompts")),
        "the layer was listed on the box: {:?}",
        daemon.exec_log()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_agent_related_runs_while_the_link_is_down() {
    let _serial = crate::stream::pty_guard().await;
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let home = BoxHome::new(scratch.path());
    home.link("claude", "/bin/cat");
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, &home, scratch.path());
    agent.refuse("santree_off", "santree is off for this machine");
    let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
    link.resume(None);
    let off = link.settled(Duration::from_secs(5)).await;
    assert_eq!(off, DaedalusLink::SantreeOff);

    let hooks = agents::hooks(&db, &link, &repo).await.unwrap_err();
    assert_eq!(hooks.to_string(), describe(&off));
    assert_eq!(link.agents().clis(&link).await, None);
    assert!(resolve(
        &link,
        &db,
        &repo,
        AgentKind::Claude,
        &server.worktree,
        "tree:AK-1",
        None
    )
    .await
    .is_err());
    let local = scratch.path().join("mac-prompts");
    assert!(worktree::work_prompt(&db, &link, &repo, "AK-1", &local)
        .await
        .is_err());

    // The agent's pane waits for the link; nothing starts anywhere meanwhile.
    let manager = PtyManager::new();
    let screen = Screen::new();
    let (output, links) = screen.channels();
    let opts = TerminalOpenOpts {
        cwd: Some(server.worktree.to_string_lossy().into_owned()),
        command: "/bin/sh".into(),
        args: Vec::new(),
        cols: 80,
        rows: 24,
        owner: "page-1".into(),
        label: "tree:AK-1".into(),
        agent_kind: Some(AgentKind::Claude),
    };
    let pane = terminal::open(&manager, &db, &link, opts, output, links)
        .await
        .unwrap();
    assert_eq!(screen.links(), [PaneLink::Reconnecting]);
    link.terminals().seed(pane, "exec claude\r".into()).unwrap();
    assert!(link.agents().detect(&link).await.is_empty());

    assert!(manager.sessions().is_empty(), "nothing ran on this Mac");
    assert!(daemon.pty().sessions().is_empty(), "nor on the box");
    assert!(daemon.exec_log().is_empty(), "no command either");
    assert!(!server.web.join(".git/santree").exists(), "nothing written");
    assert!(!local.exists());

    link.terminals().close(pane);
    link.stop();
}
