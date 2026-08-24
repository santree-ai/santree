//! The load-bearing invariant from COMPLIANCE.md: `santree-hook` must never disrupt
//! the user's Claude session. Whatever it is handed — no args, garbage on stdin, a
//! db that isn't there, a db that isn't a database — it exits 0 and stays silent on
//! the hook path. A non-zero exit is surfaced by Claude, and `SessionEnd` (the one
//! synchronous hook) would surface it right at teardown.
//!
//! These drive the real compiled binary, so they cover the panic path too: the
//! process-level exit code is what's asserted, not a return value.

use std::io::Write;
use std::process::{Command, Stdio};

/// Run the real binary with `args`, piping `stdin` in. Returns (exit code, stdout).
fn run(args: &[&str], stdin: &str) -> (Option<i32>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_santree-hook"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn santree-hook");
    // A bad-args invocation exits before it ever reads stdin, so this write can lose
    // the race and hit EPIPE. That's the binary behaving correctly, not a failure —
    // the exit code below is what's under test.
    let _ = child
        .stdin
        .take()
        .expect("stdin")
        .write_all(stdin.as_bytes());
    let out = child.wait_with_output().expect("wait");
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    )
}

#[test]
fn every_hook_failure_path_exits_zero_and_silently() {
    let missing_db = std::env::temp_dir().join("santree-hook-does-not-exist.db");
    let missing_db = missing_db.to_str().unwrap();

    let cases: Vec<(&str, Vec<&str>, String)> = vec![
        ("no args at all", vec![], String::new()),
        ("--db with no value", vec!["--db"], String::new()),
        ("event but no --db", vec!["Stop"], "{}".into()),
        (
            "unparseable stdin",
            vec!["--db", missing_db, "Stop"],
            "not json {{{".into(),
        ),
        (
            "empty stdin",
            vec!["--db", missing_db, "SessionEnd"],
            String::new(),
        ),
        (
            "payload with no session_id",
            vec!["--db", missing_db, "Stop"],
            r#"{"cwd":"/tmp"}"#.into(),
        ),
        (
            "db file does not exist",
            vec!["--db", missing_db, "SessionEnd"],
            r#"{"session_id":"s1","cwd":"/tmp"}"#.into(),
        ),
        (
            "unknown event",
            vec!["--db", missing_db, "SomeFutureEvent"],
            r#"{"session_id":"s1"}"#.into(),
        ),
        (
            "--db points at a directory, not a database",
            vec!["--db", "/tmp", "Stop"],
            r#"{"session_id":"s1"}"#.into(),
        ),
    ];

    for (name, args, stdin) in cases {
        let (code, stdout) = run(&args, &stdin);
        assert_eq!(code, Some(0), "{name}: must exit 0");
        assert!(stdout.is_empty(), "{name}: hook path must print nothing");
    }
}

/// The status line is the one path that *does* print — Claude renders whatever it
/// emits — and it must still exit 0 and print a usable bar when the payload is junk
/// or the db is missing.
#[test]
fn statusline_always_exits_zero_and_prints_a_bar() {
    let missing_db = std::env::temp_dir().join("santree-hook-does-not-exist.db");
    let missing_db = missing_db.to_str().unwrap();

    for stdin in [
        "",
        "not json {{{",
        "{}",
        r#"{"session_id":"s1","context_window":{"used_percentage":50,"total_input_tokens":604000},"model":{"id":"claude-opus-4-8","display_name":"Opus"}}"#,
    ] {
        let (code, stdout) = run(&["--db", missing_db, "statusline"], stdin);
        assert_eq!(code, Some(0), "statusline must exit 0 for stdin {stdin:?}");
        assert!(
            stdout.contains('['),
            "statusline should still render a bar for stdin {stdin:?}, got {stdout:?}"
        );
    }
}

/// The MCP server is the one long-lived mode, and its stdout *is* the transport:
/// a stray print corrupts the protocol and the tools vanish mid-review. It also
/// has to survive the failure the hook path treats as routine — a database that
/// isn't there — by telling the model, not by dying.
#[test]
fn mcp_mode_speaks_only_json_and_reports_failures_to_the_model() {
    let dir = std::env::temp_dir().join(format!("santree-hook-mcp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let diff = dir.join("diff.json");
    std::fs::write(
        &diff,
        r#"{"headSha":"abc1234","filesTruncated":false,
            "files":[{"path":"src/a.rs","old":[[40,52]],"new":[[40,52]]}]}"#,
    )
    .unwrap();
    let missing_db = dir.join("santree.db");

    let session = [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_review_comment","arguments":{"path":"src/a.rs","line":44,"body":"b"}}}"#,
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_review_comment","arguments":{"path":"src/ghost.rs","line":44,"body":"b"}}}"#,
    ]
    .join("\n");

    let (code, stdout) = run(
        &[
            "--db",
            missing_db.to_str().unwrap(),
            "mcp",
            "--pr",
            "acme/web",
            "--number",
            "42",
            "--head",
            "abc1234",
            "--diff",
            diff.to_str().unwrap(),
        ],
        &format!("{session}\n"),
    );

    assert_eq!(code, Some(0), "the server must exit 0 when stdin closes");
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    // Four requests, one notification: exactly four replies, each one line of JSON.
    assert_eq!(lines.len(), 4, "unexpected transport traffic: {stdout:?}");
    let msgs: Vec<serde_json::Value> = lines
        .iter()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON: {l:?} ({e})")))
        .collect();

    assert_eq!(msgs[0]["result"]["serverInfo"]["name"], "santree-review");
    let names: Vec<&str> = msgs[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "set_review_brief",
            "add_review_comment",
            "list_review_comments",
            "update_review_comment",
            "delete_review_comment"
        ]
    );
    // A missing database and a bad anchor both come back as readable tool errors.
    assert_eq!(msgs[2]["result"]["isError"], true);
    assert!(msgs[2]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("isn't reachable"));
    assert_eq!(msgs[3]["result"]["isError"], true);
    assert!(msgs[3]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("isn't a changed file"));
    assert!(!missing_db.exists(), "must never create the app's db");
}

/// Argv the app got wrong must not start a server scoped to nothing.
#[test]
fn mcp_mode_with_incomplete_args_exits_zero_without_serving() {
    let (code, stdout) = run(
        &["--db", "/tmp/nope.db", "mcp", "--pr", "acme/web"],
        r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
    );
    assert_eq!(code, Some(0));
    assert!(stdout.is_empty(), "nothing should have been served");
}
