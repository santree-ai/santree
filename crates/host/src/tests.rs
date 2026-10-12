// Tests type into, open and close terminals directly: clippy.toml's PTY rules
// hold shipped code to its sanctioned sites.
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::{mpsc, oneshot};

use super::conn::Out;
use super::*;

fn options() -> HostOptions {
    HostOptions {
        hostname: "h".into(),
        user: "u".into(),
        home: "/h".into(),
        projects_root: "/".into(),
        hook_bin: "/bin/true".into(),
        ..HostOptions::local("test")
    }
}

fn open(host: &Host, argv: &[&str]) -> Outcome {
    host.pty_open(PtyOpenParams {
        command: argv[0].into(),
        args: argv[1..].iter().map(|a| a.to_string()).collect(),
        cols: 80,
        rows: 24,
        owner: "o".into(),
        label: "t".into(),
        ..Default::default()
    })
}

fn id_of(outcome: Outcome) -> SessionId {
    serde_json::from_str::<SessionInfo>(outcome.unwrap().get())
        .unwrap()
        .id
}

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A raw client on one end of an in-memory link: requests out, lines in.
struct Raw {
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<DuplexStream>>>,
    writer: tokio::io::WriteHalf<DuplexStream>,
    next: u64,
}

impl Raw {
    /// A greeted connection to `host` as `node`, over a pipe of `buffer` bytes.
    async fn connect(host: &Arc<Host>, node: &str, buffer: usize) -> Self {
        let (ours, theirs) = tokio::io::duplex(buffer);
        let (r, w) = tokio::io::split(theirs);
        tokio::spawn(serve_conn(
            host.clone(),
            r,
            w,
            Peer {
                node: node.into(),
                addr: "test".into(),
            },
        ));
        let (r, w) = tokio::io::split(ours);
        let mut raw = Self {
            lines: BufReader::new(r).lines(),
            writer: w,
            next: 1,
        };
        let id = raw
            .send(
                "hello",
                serde_json::json!({ "protocol": 1, "client": "t", "owner": "o" }),
            )
            .await;
        let answer = raw.answer(id).await;
        assert!(answer.get("ok").is_some(), "{answer}");
        raw
    }

    async fn send(&mut self, m: &str, p: serde_json::Value) -> u64 {
        let id = self.next;
        self.next += 1;
        let line = serde_json::json!({ "id": id, "m": m, "p": p }).to_string() + "\n";
        self.writer.write_all(line.as_bytes()).await.unwrap();
        id
    }

    async fn line(&mut self) -> Option<serde_json::Value> {
        let line = self.lines.next_line().await.ok()??;
        Some(serde_json::from_str(&line).unwrap())
    }

    /// The response to `id`; events and other responses on the way are
    /// dropped.
    async fn answer(&mut self, id: u64) -> serde_json::Value {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(10), self.line())
                .await
                .expect("an answer in time")
                .expect("the link stays up");
            if line.get("id").and_then(|v| v.as_u64()) == Some(id) {
                return line;
            }
        }
    }

    async fn call(&mut self, m: &str, p: serde_json::Value) -> serde_json::Value {
        let id = self.send(m, p).await;
        self.answer(id).await
    }
}

fn b64(data: &str) -> Vec<u8> {
    serde_json::from_value::<PtyData>(serde_json::json!({ "id": 0, "data": data }))
        .unwrap()
        .data
}

#[test]
fn exited_unattached_sessions_are_reaped_and_live_ones_are_not() {
    let host = Host::new(options(), None);
    let done = id_of(open(&host, &["true"]));
    let running = id_of(open(&host, &["sleep", "30"]));
    wait_for("true exits", || {
        host.mgr.sessions().iter().any(|s| s.id == done && !s.alive)
    });
    host.reap(Duration::from_secs(3600));
    assert_eq!(host.mgr.sessions().len(), 2);
    host.reap(Duration::ZERO);
    let left: Vec<SessionId> = host.mgr.sessions().iter().map(|s| s.id).collect();
    assert_eq!(left, vec![running]);
    host.close_all();
}

/// An env name with `=` in it is a different variable to the OS than to the
/// marker strip: `CLAUDE_CODE_CHILD_SESSION=1` set to `x` reaches the child
/// as `CLAUDE_CODE_CHILD_SESSION` = `1=x`, past `env_remove`. Such names,
/// empty ones and ones with NUL are refused before anything spawns.
#[test]
fn an_env_name_the_os_would_read_differently_is_refused() {
    let host = Host::new(options(), None);
    let entry = |name: &str| vec![(name.to_string(), "x".to_string())];
    for (env, base_env) in [
        (entry("CLAUDE_CODE_CHILD_SESSION=1"), vec![]),
        (vec![], entry("CLAUDE_CODE_CHILD_SESSION=1")),
        (vec![], entry("")),
        (entry("A\0B"), vec![]),
    ] {
        let refused = host
            .pty_open(PtyOpenParams {
                command: "true".into(),
                cols: 80,
                rows: 24,
                env,
                base_env,
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::BadRequest, "{}", refused.msg);
    }
    assert!(host.mgr.sessions().is_empty(), "nothing was spawned");
}

/// A host that requires `baseEnv` never lets its own process environment
/// become a session's: an open without one is refused before anything spawns.
#[test]
fn a_host_requiring_a_base_env_refuses_an_open_without_one() {
    let host = Host::new(
        HostOptions {
            require_base_env: true,
            ..options()
        },
        None,
    );
    let refused = open(&host, &["true"]).unwrap_err();
    assert_eq!(refused.code, ErrorCode::BadRequest, "{}", refused.msg);
    assert!(
        refused.msg.contains("baseEnv is required"),
        "{}",
        refused.msg
    );
    assert!(host.mgr.sessions().is_empty(), "nothing was spawned");
    // With one it opens; a host that does not require one still opens without.
    let params = |base_env| PtyOpenParams {
        command: "true".into(),
        cols: 80,
        rows: 24,
        base_env,
        ..Default::default()
    };
    host.pty_open(params(vec![("PATH".into(), "/usr/bin:/bin".into())]))
        .unwrap();
    let lax = Host::new(options(), None);
    lax.pty_open(params(Vec::new())).unwrap();
    host.close_all();
    lax.close_all();
}

#[tokio::test]
async fn exec_refuses_an_env_name_the_os_would_read_differently() {
    for name in ["CLAUDE_CODE_CHILD_SESSION=1", "", "A\0B"] {
        let refused = exec::run(
            ExecParams {
                cwd: "/".into(),
                argv: vec!["true".into()],
                env: Some(vec![(name.into(), "x".into())]),
                ..Default::default()
            },
            "/".into(),
            &[],
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, ErrorCode::BadRequest, "{name:?}");
    }
}

/// The hook queue is bounded by bytes as well as count; the oldest go first
/// and are counted as dropped.
#[test]
fn the_hook_queue_is_bounded_by_bytes() {
    let mut q = HookQueue::new(100, 3 * (64 + 1 + 1000));
    for _ in 0..5 {
        q.push("e".into(), Vec::new(), vec![0u8; 1000]);
    }
    let seqs: Vec<u64> = q.items.iter().map(|h| h.seq).collect();
    assert_eq!(seqs, vec![3, 4, 5]);
    assert_eq!(q.dropped, 2);
    assert!(q.bytes <= q.max_bytes);
    // One larger than the whole budget is kept, alone.
    q.push("e".into(), Vec::new(), vec![0u8; 10_000]);
    assert_eq!(q.items.len(), 1);
    assert_eq!(q.dropped, 5);
    q.ack(6);
    assert_eq!((q.items.len(), q.bytes), (0, 0));
}

/// Blocking work is counted per node and held until it returns, not reset by
/// a reconnect.
#[test]
fn blocking_work_is_capped_per_node() {
    let host = Host::new(options(), None);
    let cap = host.opts.caps.max_blocking_per_node;
    let held: Vec<_> = (0..cap).map(|_| host.permit("a").unwrap()).collect();
    assert_eq!(
        host.permit("a").unwrap_err().code,
        ErrorCode::Other("busy".into())
    );
    assert!(host.permit("b").is_ok(), "another node is not affected");
    drop(held);
    assert!(host.permit("a").is_ok());
}

/// A `pty.write` into a terminal that does not read its input waits on the
/// session's own input thread, never the blocking pool; a full queue is
/// `busy`; and a close ends the session at once regardless.
#[test]
fn a_terminal_that_does_not_read_cannot_pin_writes_or_the_close() {
    let host = Host::new(options(), None);
    // Raw mode, so the line discipline stops taking input once full.
    let id = id_of(open(&host, &["sh", "-c", "stty raw -echo; exec sleep 60"]));
    std::thread::sleep(Duration::from_millis(500));

    let mut stuck = host.pty_input(id, vec![b'x'; 512 * 1024]).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        matches!(stuck.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
        "the write went in: the terminal was reading"
    );
    let full = host
        .pty_input(id, vec![b'y'; host.opts.caps.pty_input_queue])
        .unwrap_err();
    assert_eq!(full.code, ErrorCode::Other("busy".into()));

    let started = Instant::now();
    host.close_session(id);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the close waited {:?}",
        started.elapsed()
    );
    assert!(host.session(id).is_none());
    let gone = host.pty_input(id, b"z".to_vec()).unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
    assert!(host.inputs.load(Ordering::Acquire) <= 1);
    let _ = stuck.try_recv();
    host.close_all();
}

/// An attach that fails on a session this host still holds is `io`, not
/// `not_found`: the client would forget a session that is still there.
#[test]
fn a_failed_attach_to_a_known_session_is_io() {
    let host = Host::new(options(), None);
    let id = id_of(open(&host, &["sleep", "30"]));
    let (tx, _rx) = mpsc::unbounded_channel();
    let conn = Conn {
        id: 1,
        node: "a".into(),
        out: Out::new(1, tx, &Caps::default()),
        closed: AtomicBool::new(false),
    };
    // Gone from the manager, still in the host's map.
    host.mgr.close(id).unwrap();
    let attach = |id| {
        let params = PtyAttachParams {
            id,
            anchor: Anchor::Fresh,
        };
        match host.pty_attach(&conn, 7, params) {
            Reply::Answer(Err(e)) => e.code,
            _ => panic!("the attach did not fail"),
        }
    };
    assert_eq!(attach(id), ErrorCode::Io);
    lock(&host.sessions).remove(&id);
    assert_eq!(attach(id), ErrorCode::NotFound);
    host.close_all();
}

/// The first ping comes after one interval, not at once (on paused time:
/// nothing else on the connection is timed).
#[tokio::test(start_paused = true)]
async fn the_first_ping_comes_after_one_interval() {
    let host = Host::new(options(), None);
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    let (r, w) = tokio::io::split(theirs);
    let started = tokio::time::Instant::now();
    tokio::spawn(serve_conn(
        host.clone(),
        r,
        w,
        Peer {
            node: "a".into(),
            addr: "test".into(),
        },
    ));
    let mut lines = BufReader::new(ours).lines();
    let first = lines.next_line().await.unwrap().unwrap();
    assert_eq!(first, r#"{"e":"ping"}"#);
    assert_eq!(started.elapsed(), PING_INTERVAL);
}

/// A host serving PTYs only answers the other groups as unknown methods —
/// what an older host does, so a client's feature checks are what decide.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pty_only_host_does_not_serve_exec_fs_or_hooks() {
    let host = Host::new(options(), None);
    let mut c = Raw::connect(&host, "a", 1 << 20).await;
    for m in ["exec.run", "fs.read", "hooks.subscribe", "hooks.push"] {
        let answer = c.call(m, serde_json::json!({})).await;
        assert_eq!(answer["err"]["code"], "bad_request", "{m}: {answer}");
        assert!(
            answer["err"]["msg"]
                .as_str()
                .unwrap()
                .contains("unknown method"),
            "{m}: {answer}"
        );
    }
    let hello = c
        .call(
            "hello",
            serde_json::json!({ "protocol": 1, "client": "t", "owner": "o" }),
        )
        .await;
    assert_eq!(
        hello["ok"]["features"],
        serde_json::json!(["pty.baseEnv", "pty.modes"])
    );
}

/// `baseEnv` is the client's inheritance: its markers are stripped like the
/// host's own, and its `PATH` and `SHELL` win over the host's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_base_env_reaches_the_session_without_its_markers() {
    let host = Host::new(options(), None);
    let mut c = Raw::connect(&host, "a", 1 << 20).await;
    let opened = c
        .call(
            "pty.open",
            serde_json::json!({
                "command": "/bin/sh",
                "args": ["-c", "echo \"marker=${CLAUDECODE:-none} path=$PATH mine=$MINE\"; sleep 5"],
                "cols": 80, "rows": 24, "owner": "o", "label": "t",
                "env": [["MINE", "set"]],
                "baseEnv": [["PATH", "/caller/bin:/usr/bin:/bin"], ["CLAUDECODE", "1"]],
            }),
        )
        .await;
    let id = opened["ok"]["id"].as_u64().expect("opened");
    c.send(
        "pty.attach",
        serde_json::json!({ "id": id, "anchor": "fresh" }),
    )
    .await;
    let mut seen = String::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !seen.contains("mine=set") {
        assert!(Instant::now() < deadline, "no output: {seen:?}");
        let Some(line) = c.line().await else { break };
        if let Some(data) = line["ok"]["data"].as_str().or(line["p"]["data"].as_str()) {
            seen.push_str(&String::from_utf8_lossy(&b64(data)));
        }
    }
    assert!(seen.contains("marker=none"), "{seen:?}");
    assert!(seen.contains("path=/caller/bin:/usr/bin:/bin"), "{seen:?}");
    host.close_all();
}

/// A session printing faster than its receiver reads is paced, not dropped:
/// every byte arrives, in order, and the link stays up. The queue's hard cap
/// is a fraction of the output, so a host that did not pace would have to
/// drop the link.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fast_session_is_paced_to_a_slow_reader_and_loses_nothing() {
    const LINES: u64 = 40_000;
    let mut opts = options();
    opts.caps.pace_high = 64 * 1024;
    opts.caps.out_queue_bytes = 512 * 1024;
    let host = Host::new(opts, None);
    let mut c = Raw::connect(&host, "a", 16 * 1024).await;
    // ~1.5 MiB of numbered lines, from a generator faster than this reader.
    let script = format!(
        "awk 'BEGIN {{ for (i = 0; i < {LINES}; i++) printf \"line %d abcdefghijklmnopqrstuvwxyz\\n\", i }}'; echo DONE"
    );
    let opened = c
        .call(
            "pty.open",
            serde_json::json!({
                "command": "/bin/sh", "args": ["-c", format!("stty -onlcr; {script}; sleep 5")],
                "cols": 200, "rows": 50, "owner": "o", "label": "t",
            }),
        )
        .await;
    let id = opened["ok"]["id"].as_u64().expect("opened");
    c.send(
        "pty.attach",
        serde_json::json!({ "id": id, "anchor": "fresh" }),
    )
    .await;
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !out.ends_with(b"DONE\n") {
        assert!(Instant::now() < deadline, "stalled at {} bytes", out.len());
        // Slow: a pause every so often, so the queue fills and pacing bites.
        if out.len() % (128 * 1024) < 8192 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let line = c.line().await.expect("the link stays up");
        if line.get("e").and_then(|e| e.as_str()) == Some("pty.exit") {
            break;
        }
        if let Some(data) = line["ok"]["data"].as_str().or(line["p"]["data"].as_str()) {
            out.extend(b64(data));
        }
    }
    let text = String::from_utf8_lossy(&out);
    let numbers: Vec<u64> = text
        .lines()
        .filter_map(|l| l.strip_prefix("line ")?.split(' ').next()?.parse().ok())
        .collect();
    assert_eq!(numbers.len() as u64, LINES, "every line arrived");
    assert!(numbers.windows(2).all(|w| w[1] == w[0] + 1), "in order");
    assert_eq!(host.connection_count(), 1, "the link was never dropped");
    host.close_all();
}

/// A receiver that reads nothing at all loses its link after the stall
/// window; the session is parked, not killed, and a new receiver picks it up.
/// A newer attach meanwhile takes the session over at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stalled_reader_is_dropped_and_its_session_survives() {
    let mut opts = options();
    opts.caps.pace_high = 64 * 1024;
    opts.caps.stall = Duration::from_secs(1);
    let host = Host::new(opts, None);
    let mut stalled = Raw::connect(&host, "a", 4 * 1024).await;
    let opened = stalled
        .call(
            "pty.open",
            serde_json::json!({
                "command": "/bin/sh", "args": ["-c", "yes santree | head -c 50000000; sleep 30"],
                "cols": 80, "rows": 24, "owner": "o", "label": "t",
            }),
        )
        .await;
    let id = opened["ok"]["id"].as_u64().expect("opened");
    stalled
        .send(
            "pty.attach",
            serde_json::json!({ "id": id, "anchor": "fresh" }),
        )
        .await;
    // Never read again: the queue fills, the session paces, then the link goes.
    let deadline = Instant::now() + Duration::from_secs(20);
    while host.connection_count() == 1 {
        assert!(
            Instant::now() < deadline,
            "the stalled link was never dropped"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let alive = host
        .mgr
        .sessions()
        .iter()
        .any(|s| s.id == id as SessionId && s.alive);
    assert!(alive, "the session outlives its receiver");

    let mut fresh = Raw::connect(&host, "a", 1 << 20).await;
    let attached = fresh
        .call(
            "pty.attach",
            serde_json::json!({ "id": id, "anchor": "unknown" }),
        )
        .await;
    assert!(attached.get("ok").is_some(), "{attached}");
    host.close_all();
}

/// An extension's handler that panics answers `io`; the host goes on serving
/// and its sessions live.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_panicking_extension_answers_io_and_the_host_goes_on() {
    struct Boom;
    impl Extension for Boom {
        fn handle(&self, _host: &Arc<Host>, request: &RawRequest) -> Option<BoxFuture<Outcome>> {
            (request.m == "boom")
                .then(|| -> BoxFuture<Outcome> { Box::pin(async { panic!("boom") }) })
        }
    }
    let host = Host::new(options(), Some(Arc::new(Boom)));
    let mut c = Raw::connect(&host, "a", 1 << 20).await;
    let opened = c
        .call(
            "pty.open",
            serde_json::json!({ "command": "sleep", "args": ["30"], "cols": 80, "rows": 24, "owner": "o", "label": "t" }),
        )
        .await;
    let id = opened["ok"]["id"].as_u64().expect("opened");
    let answer = c.call("boom", serde_json::json!({})).await;
    assert_eq!(answer["err"]["code"], "io", "{answer}");
    let sessions = c.call("pty.sessions", serde_json::json!({})).await;
    let listed: HashMap<u64, bool> = sessions["ok"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["id"].as_u64().unwrap(), s["alive"].as_bool().unwrap()))
        .collect();
    assert_eq!(listed.get(&id), Some(&true));
    host.close_all();
}

/// A connection over its node's limit is closed at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connections_are_capped_per_node() {
    let mut opts = options();
    opts.caps.max_conns_per_node = 1;
    let host = Host::new(opts, None);
    let _first = Raw::connect(&host, "a", 1 << 20).await;

    let (ours, theirs) = tokio::io::duplex(1 << 20);
    let (r, w) = tokio::io::split(theirs);
    serve_conn(
        host.clone(),
        r,
        w,
        Peer {
            node: "a".into(),
            addr: "test".into(),
        },
    )
    .await;
    let mut second = BufReader::new(ours).lines();
    assert_eq!(second.next_line().await.unwrap(), None, "closed at once");
}

/// What a session inherits: what the client forwarded, or — when it forwarded
/// nothing — this process's environment, either way under the host's own.
#[test]
fn a_session_inherits_the_forwarded_env_or_this_process_s() {
    use super::pty::session_base_env;
    let host_env = vec![("HOST_OWN".to_string(), "h".to_string())];
    let forwarded = vec![("PATH".to_string(), "/from/the/app".to_string())];
    assert_eq!(
        session_base_env(forwarded.clone(), &host_env),
        [forwarded[0].clone(), host_env[0].clone()],
        "a forwarded env is the whole inheritance, the host's own on top"
    );
    let standing_in = session_base_env(Vec::new(), &host_env);
    let path = std::env::var("PATH").unwrap();
    assert!(
        standing_in.iter().any(|(k, v)| k == "PATH" && *v == path),
        "with nothing forwarded, this process's env is the inheritance"
    );
    assert_eq!(
        standing_in.last(),
        Some(&host_env[0]),
        "the host's own last"
    );
    assert!(
        session_base_env(Vec::new(), &[]).is_empty(),
        "nothing forwarded and nothing added: santree-pty inherits as is"
    );
}

/// A TUI sets bracketed paste once and then prints more than the ring keeps. A
/// viewer that attaches afterwards (an app relaunched against a server that
/// kept the process) is told the mode first; a viewer whose replay still holds
/// the DECSET is not told twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fresh_attach_after_the_decset_scrolled_out_gets_the_mode_first() {
    let host = Host::new(options(), None);
    let mut c = Raw::connect(&host, "a", 1 << 20).await;
    // ~2.8 MiB of numbered lines after the DECSET: past the 2 MiB ring.
    let script = "stty -onlcr; printf '\\033[?2004h'; \
        awk 'BEGIN { for (i = 0; i < 45000; i++) printf \"line %d abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv\\n\", i }'; \
        echo DONE; sleep 20";
    let opened = c
        .call(
            "pty.open",
            serde_json::json!({
                "command": "/bin/sh", "args": ["-c", script],
                "cols": 200, "rows": 50, "owner": "o", "label": "t",
            }),
        )
        .await;
    let id = opened["ok"]["id"].as_u64().expect("opened");
    c.send(
        "pty.attach",
        serde_json::json!({ "id": id, "anchor": "fresh" }),
    )
    .await;
    // The first viewer reads the whole thing live (and sees the DECSET itself).
    let mut live = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !live.ends_with(b"DONE\n") {
        assert!(Instant::now() < deadline, "stalled at {} bytes", live.len());
        let line = c.line().await.expect("the link stays up");
        if let Some(data) = line["ok"]["data"].as_str().or(line["p"]["data"].as_str()) {
            live.extend(b64(data));
        }
    }
    assert!(live.starts_with(b"\x1b[?2004h"), "the live viewer saw it");

    // A second, later viewer: the retained tail has no DECSET, the preamble does.
    let mut late = Raw::connect(&host, "a", 1 << 20).await;
    let attached = late
        .call(
            "pty.attach",
            serde_json::json!({ "id": id, "anchor": "fresh" }),
        )
        .await;
    assert_eq!(attached["ok"]["mode"], "tail", "{attached}");
    let replay = b64(attached["ok"]["data"].as_str().expect("replay bytes"));
    assert!(
        replay.starts_with(b"\x1b[?2004h"),
        "{:?}",
        String::from_utf8_lossy(&replay[..40.min(replay.len())])
    );
    assert_eq!(
        replay.windows(8).filter(|w| *w == b"\x1b[?2004h").count(),
        1,
        "once, and not from the tail"
    );
    host.close_all();
}
