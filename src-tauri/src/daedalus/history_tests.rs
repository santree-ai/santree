//! A Daedalus project's session history, read from the box: the History pane's
//! commands (`worktree::sessions`, `session_detail`, `session_subagents`,
//! `resume_session`) through the app's `DaedalusHost` to a fake session host,
//! whose "box" home holds Claude transcripts and a Codex rollout written here.
//! Everything the pane shows comes over the link — the listing by `find`, the
//! reads by `fs.read` — and a transcript too big to fetch whole is summarised
//! from its first and last pages.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use santree_core::domain::{AgentKind, DaedalusLink, LastMessageFrom};
use santree_remote_client::fake::{FakeAgent, FakeDaemon, FakeOptions};

use super::history::{HEAD, TAIL, WHOLE_MAX};
use super::host::{describe, DaedalusHost};
use super::terminal_tests::{fast, registered, server, Server, WAIT};
use crate::db::Db;
use crate::session;
use crate::worktree;

const MAIN: &str = "11111111-1111-4111-8111-111111111111";
const BY_HAND: &str = "22222222-2222-4222-8222-222222222222";
const BIG: &str = "33333333-3333-4333-8333-333333333333";
const SIBLING: &str = "44444444-4444-4444-8444-444444444444";
const PRUNED: &str = "55555555-5555-4555-8555-555555555555";
const ESCAPED: &str = "66666666-6666-4666-8666-666666666666";
const THREAD: &str = "77777777-7777-4777-8777-777777777777";

fn user(cwd: &Path, ts: &str, text: &str) -> String {
    serde_json::json!({
        "type": "user", "timestamp": ts, "cwd": cwd,
        "message": { "role": "user", "content": text },
    })
    .to_string()
}

fn assistant(cwd: &Path, ts: &str, id: &str, text: &str) -> String {
    serde_json::json!({
        "type": "assistant", "timestamp": ts, "cwd": cwd, "requestId": format!("r-{id}"),
        "message": {
            "id": id, "model": "claude-sonnet-4-5",
            "usage": { "input_tokens": 10, "output_tokens": 5 },
            "content": [{ "type": "text", "text": text }],
        },
    })
    .to_string()
}

fn write_lines(path: &Path, lines: &[String]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, lines.join("\n") + "\n").unwrap();
}

/// The box's operator home, as `hello` names it.
struct Box {
    home: PathBuf,
}

impl Box {
    fn projects(&self) -> PathBuf {
        self.home.join(".claude/projects")
    }

    fn transcript(&self, cwd: &Path, id: &str) -> PathBuf {
        self.projects()
            .join(session::project_slug(&cwd.to_string_lossy()))
            .join(format!("{id}.jsonl"))
    }
}

async fn connected(
    server: &Server,
    home: &Path,
    socket_dir: &Path,
) -> (FakeAgent, FakeDaemon, DaedalusHost) {
    let daemon = FakeDaemon::with_options(FakeOptions {
        projects_root: server.root.to_string_lossy().into_owned(),
        home: home.to_string_lossy().into_owned(),
        ..FakeOptions::default()
    });
    let agent = FakeAgent::serve(socket_dir.join("santree.sock"), daemon.clone()).unwrap();
    let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
    link.resume(None);
    link.client_within(WAIT).await.expect("the link comes up");
    (agent, daemon, link)
}

async fn register(db: &Db, repo: &str, term_key: &str, cwd: &Path, id: &str, kind: AgentKind) {
    sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(repo)
    .bind(term_key)
    .bind(cwd.to_string_lossy())
    .bind(id)
    .bind(kind.as_str())
    .execute(db)
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_worktrees_session_history_is_read_on_the_box() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let boxed = Box {
        home: std::fs::canonicalize(scratch.path())
            .unwrap()
            .join("box-home"),
    };
    let wt = server.worktree.clone();
    let (db, repo) = registered(&server, scratch.path()).await;

    // A registered session, with a subagent and its sidecar.
    let main = boxed.transcript(&wt, MAIN);
    write_lines(
        &main,
        &[
            user(&wt, "2026-09-30T10:00:00Z", "Fix the login redirect"),
            assistant(&wt, "2026-09-30T10:01:00Z", "m1", "Fixed and tested."),
        ],
    );
    let subagents = main.with_extension("").join("subagents");
    write_lines(
        &subagents.join("agent-a1.jsonl"),
        &[
            user(&wt, "2026-09-30T10:00:10Z", "Find the redirect handler"),
            assistant(&wt, "2026-09-30T10:00:20Z", "s1", "It is in auth.rs."),
        ],
    );
    std::fs::write(
        subagents.join("agent-a1.meta.json"),
        r#"{"agentType":"Explore","description":"find the handler","spawnDepth":1}"#,
    )
    .unwrap();
    register(&db, &repo, "tree:AK-1", &wt, MAIN, AgentKind::Claude).await;

    // Launched by hand in the worktree: no row, found by its cwd.
    write_lines(
        &boxed.transcript(&wt, BY_HAND),
        &[user(&wt, "2026-09-29T09:00:00Z", "Who calls login?")],
    );
    // A sibling checkout whose path merely extends the worktree's: not listed.
    let sibling = PathBuf::from(format!("{}-other", wt.display()));
    write_lines(
        &boxed.transcript(&sibling, SIBLING),
        &[user(
            &sibling,
            "2026-09-29T09:00:00Z",
            "Not this worktree's",
        )],
    );
    // A symlink in the transcripts' dir, to a file outside them: never read.
    let outside = scratch.path().join("outside.jsonl");
    write_lines(&outside, &[user(&wt, "2026-09-29T09:00:00Z", "escaped")]);
    std::os::unix::fs::symlink(&outside, boxed.transcript(&wt, ESCAPED)).unwrap();

    // Too big to fetch whole: its opening and its end are what the row shows.
    let big = boxed.transcript(&wt, BIG);
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&big).unwrap();
        writeln!(
            f,
            "{}",
            user(&wt, "2026-09-28T08:00:00Z", "Port the importer")
        )
        .unwrap();
        let filler =
            serde_json::json!({ "type": "progress", "data": "x".repeat(1000) }).to_string();
        let mut written = 0u64;
        while written < WHOLE_MAX + HEAD + TAIL {
            writeln!(f, "{filler}").unwrap();
            written += filler.len() as u64 + 1;
        }
        writeln!(
            f,
            "{}",
            assistant(&wt, "2026-09-28T09:00:00Z", "mb", "Importer ported.")
        )
        .unwrap();
    }
    register(&db, &repo, "tree:AK-1:tab:big", &wt, BIG, AgentKind::Claude).await;

    // A Codex thread, registered, its rollout under the box's sessions dir.
    let rollout = boxed
        .home
        .join(".codex/sessions/2026/09/30")
        .join(format!("rollout-2026-09-30T11-00-00-{THREAD}.jsonl"));
    write_lines(
        &rollout,
        &[
            format!(
                r#"{{"timestamp":"2026-09-30T11:00:00Z","type":"session_meta","payload":{{"id":"{THREAD}","timestamp":"2026-09-30T11:00:00Z","cwd":"{}","thread_source":"user"}}}}"#,
                wt.display()
            ),
            r#"{"timestamp":"2026-09-30T11:00:05Z","type":"event_msg","payload":{"type":"user_message","message":"Bump the parser"}}"#.into(),
            r#"{"timestamp":"2026-09-30T11:02:00Z","type":"event_msg","payload":{"type":"agent_message","message":"Bumped."}}"#.into(),
        ],
    );
    register(
        &db,
        &repo,
        "tree:AK-1:tab:codex",
        &wt,
        THREAD,
        AgentKind::Codex,
    )
    .await;

    let (_agent, daemon, link) = connected(&server, &boxed.home, scratch.path()).await;

    let listed = worktree::sessions(&db, &link, &repo, "AK-1").await.unwrap();
    let ids: Vec<&str> = listed.iter().map(|s| s.session_id.as_str()).collect();
    assert_eq!(
        ids,
        [THREAD, MAIN, BY_HAND, BIG],
        "newest first, ours alone"
    );

    let main_row = &listed[1];
    assert_eq!(main_row.title.as_deref(), Some("Fix the login redirect"));
    assert_eq!(main_row.last_message.as_deref(), Some("Fixed and tested."));
    assert_eq!(main_row.last_message_from, Some(LastMessageFrom::Agent));
    assert_eq!((main_row.message_count, main_row.subagent_count), (2, 1));
    assert_eq!(main_row.model.as_deref(), Some("claude-sonnet-4-5"));
    assert!(!main_row.sampled);
    // Priced over the session and its subagent (two turns of 15 tokens).
    assert_eq!(main_row.spend.as_ref().map(|s| s.total_tokens), Some(30.0));
    assert_eq!(main_row.term_key.as_deref(), Some("tree:AK-1"));

    let by_hand = &listed[2];
    assert_eq!(by_hand.term_key, None);
    assert_eq!(by_hand.title.as_deref(), Some("Who calls login?"));

    let big_row = &listed[3];
    assert!(big_row.sampled, "read from its first and last pages only");
    assert_eq!(big_row.title.as_deref(), Some("Port the importer"));
    assert_eq!(big_row.last_message.as_deref(), Some("Importer ported."));
    assert_eq!(big_row.message_count, 2);
    assert_eq!(big_row.spend, None, "a part is no total");

    let codex = &listed[0];
    assert_eq!(codex.agent_kind, AgentKind::Codex);
    assert_eq!(codex.title.as_deref(), Some("Bump the parser"));
    assert_eq!(codex.last_message.as_deref(), Some("Bumped."));

    // The listing ran on the box.
    let ran = daemon.exec_log();
    assert!(ran
        .iter()
        .any(|argv| argv.first().map(String::as_str) == Some("find")));

    // The expanded row and its subagents.
    let detail = worktree::session_detail(&db, &link, &repo, "AK-1", MAIN)
        .await
        .unwrap();
    assert_eq!(
        detail.first_prompt.as_deref(),
        Some("Fix the login redirect")
    );
    assert_eq!(detail.recent_turns.len(), 2);
    assert_eq!(detail.cwd.as_deref(), Some(&*wt.to_string_lossy()));
    let subs = worktree::session_subagents(&db, &link, &repo, "AK-1", MAIN)
        .await
        .unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].agent_id, "a1");
    assert_eq!(subs[0].agent_type.as_deref(), Some("Explore"));
    assert_eq!(subs[0].message_count, 2);
    assert!(subs[0].last_activity_ms.is_some());
    // An id the listing doesn't hold is refused; a Codex one has no transcript.
    assert!(worktree::session_detail(&db, &link, &repo, "AK-1", SIBLING)
        .await
        .is_err());
    assert_eq!(
        worktree::session_detail(&db, &link, &repo, "AK-1", THREAD)
            .await
            .unwrap()
            .first_prompt,
        None
    );

    // A session that goes on: only what it appended is read, and counted.
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&main)
            .unwrap();
        writeln!(f, "{}", user(&wt, "2026-09-30T10:05:00Z", "Now push it")).unwrap();
    }
    let again = worktree::sessions(&db, &link, &repo, "AK-1").await.unwrap();
    let main_row = again.iter().find(|s| s.session_id == MAIN).unwrap();
    assert_eq!(main_row.message_count, 3);
    assert_eq!(main_row.last_message.as_deref(), Some("Now push it"));

    // Resume: a new tab points at the box's session once its record is there.
    worktree::resume_session(
        &db,
        &link,
        &repo,
        "AK-1",
        "tree:AK-1:tab:t2",
        BY_HAND,
        AgentKind::Claude,
    )
    .await
    .unwrap();
    let rows = session::history_rows(&db, &repo, "AK-1").await.unwrap();
    assert!(rows
        .iter()
        .any(|r| r.0 == BY_HAND && r.2 == "tree:AK-1:tab:t2"));
    // A registered session whose transcript is gone: nothing to resume.
    register(
        &db,
        &repo,
        "tree:AK-1:tab:old",
        &wt,
        PRUNED,
        AgentKind::Claude,
    )
    .await;
    let err = worktree::resume_session(
        &db,
        &link,
        &repo,
        "AK-1",
        "tree:AK-1:tab:t3",
        PRUNED,
        AgentKind::Claude,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("no conversation"), "{err:#}");

    // Revealing a transcript on the box in this Mac's file browser: no.
    assert!(
        worktree::reveal_session_transcript(&db, &repo, "AK-1", MAIN)
            .await
            .is_err()
    );
}

/// The link down: the pane's reads say why, and nothing is read on this
/// Mac in their place.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_history_is_read_while_the_link_is_down() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let daemon = FakeDaemon::with_options(FakeOptions {
        projects_root: server.root.to_string_lossy().into_owned(),
        ..FakeOptions::default()
    });
    let agent = FakeAgent::serve(scratch.path().join("santree.sock"), daemon.clone()).unwrap();
    agent.refuse("santree_off", "santree is off for this machine");
    let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
    link.resume(None);
    let off = link.settled(Duration::from_secs(5)).await;
    assert_eq!(off, DaedalusLink::SantreeOff);
    let err = worktree::sessions(&db, &link, &repo, "AK-1")
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), describe(&off));
    assert!(daemon.exec_log().is_empty());
}
