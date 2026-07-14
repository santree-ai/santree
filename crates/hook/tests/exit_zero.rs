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
