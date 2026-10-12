//! One connection: its bounded outgoing queue ([`Out`]) and the pacing of
//! sessions against it, the read loop that dispatches its requests, its writer
//! and pings, and its teardown.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use santree_remote_proto::*;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinSet;

use super::pty::SessState;
use super::*;
use crate::framing::{read_line, ReadEnd};

/// How often a paced session looks again even without a wake-up.
const PACE_POLL: Duration = Duration::from_millis(250);
/// The most the writer puts on the link before counting it as progress.
const WRITE_SLICE: usize = 64 * 1024;

/// Raised by the writer each time it takes lines off the queue, and when the
/// connection closes; paced sessions wait on it.
#[derive(Default)]
struct Drained {
    lock: Mutex<()>,
    cv: Condvar,
}

/// One connection's outgoing queue, bounded by bytes
/// ([`Caps::out_queue_bytes`]). A send that finds it full closes the
/// connection instead of waiting.
#[derive(Clone)]
pub(crate) struct Out {
    tx: mpsc::UnboundedSender<String>,
    pub(crate) conn: u64,
    /// Bytes queued and not yet taken by the writer ([`queued_cost`]).
    queued: Arc<AtomicUsize>,
    full: Arc<AtomicBool>,
    /// Bytes the writer has put on the link, ever: what a paced session
    /// watches for progress, slice by slice, while a large batch goes out.
    written: Arc<AtomicU64>,
    close: Arc<Notify>,
    /// The connection is going: nothing waits for it to drain any more.
    closing: Arc<AtomicBool>,
    drained: Arc<Drained>,
    limit: usize,
    pace_high: usize,
    stall: Duration,
}

/// What a queued line counts against the queue's bytes.
fn queued_cost(line: &str) -> usize {
    line.len() + LINE_OVERHEAD
}

impl Out {
    pub(crate) fn new(conn: u64, tx: mpsc::UnboundedSender<String>, caps: &Caps) -> Self {
        Self {
            tx,
            conn,
            queued: Arc::new(AtomicUsize::new(0)),
            full: Arc::new(AtomicBool::new(false)),
            written: Arc::new(AtomicU64::new(0)),
            close: Arc::new(Notify::new()),
            closing: Arc::new(AtomicBool::new(false)),
            drained: Arc::new(Drained::default()),
            limit: caps.out_queue_bytes,
            pace_high: caps.pace_high,
            stall: caps.stall,
        }
    }

    /// Queue one line; false when it was not (the queue is full, and the
    /// connection is closing, or already gone).
    pub(crate) fn send(&self, line: String) -> bool {
        let cost = queued_cost(&line);
        if self.queued.fetch_add(cost, Ordering::AcqRel) + cost > self.limit {
            self.queued.fetch_sub(cost, Ordering::AcqRel);
            if !self.full.swap(true, Ordering::AcqRel) {
                log::warn!(
                    "connection {}: too much queued and unread; dropping the link",
                    self.conn
                );
                self.drop_link();
            }
            return false;
        }
        if self.tx.send(line).is_err() {
            self.queued.fetch_sub(cost, Ordering::AcqRel);
            return false;
        }
        true
    }

    /// Block until this connection has room for more session output: its
    /// queue is under [`Caps::pace_high`]. False when the output should not be
    /// sent after all — the connection is closing, or `superseded` says the
    /// session has a newer receiver. A connection that writes nothing to its
    /// peer for [`Caps::stall`] is dropped (its sessions park; the ring keeps
    /// what they print). Blocking: only a session's own reader thread calls
    /// this.
    pub(crate) fn wait_room(&self, superseded: impl Fn() -> bool) -> bool {
        let mut guard = lock(&self.drained.lock);
        let mut last = self.written.load(Ordering::Acquire);
        let mut deadline = Instant::now() + self.stall;
        loop {
            let queued = self.queued.load(Ordering::Acquire);
            if queued <= self.pace_high {
                return true;
            }
            if self.closing.load(Ordering::Acquire) || superseded() {
                return false;
            }
            let now = Instant::now();
            // Progress is bytes written, not the queue shrinking: the queue
            // only shrinks once a whole batch is out, and a batch of
            // megabytes on a slow link outlasts the stall window.
            let written = self.written.load(Ordering::Acquire);
            if written != last {
                last = written;
                deadline = now + self.stall;
            } else if now >= deadline {
                log::warn!(
                    "connection {}: read nothing for {}s; dropping the link",
                    self.conn,
                    self.stall.as_secs()
                );
                drop(guard);
                self.drop_link();
                return false;
            }
            guard = self
                .drained
                .cv
                .wait_timeout(guard, PACE_POLL.min(deadline - now))
                .map(|(g, _)| g)
                .unwrap_or_else(|e| e.into_inner().0);
        }
    }

    /// Wake whatever is paced on this connection to look again. Without
    /// taking `drained.lock` first: a pacer between its checks and its wait
    /// can miss this wake-up, but it waits at most [`PACE_POLL`] before it
    /// looks again, so the cost of a miss is bounded and nobody who wakes
    /// pacers ever waits on one.
    pub(crate) fn wake(&self) {
        self.drained.cv.notify_all();
    }

    fn drop_link(&self) {
        self.closing.store(true, Ordering::Release);
        self.close.notify_one();
        self.wake();
    }
}

pub(crate) struct Conn {
    pub(crate) id: u64,
    pub(crate) node: String,
    pub(crate) out: Out,
    /// Set before its sessions are parked at teardown: an attach that lands
    /// after that sweep parks the session again instead of routing it to a
    /// dead connection.
    pub(crate) closed: AtomicBool,
}

// ── one connection ────────────────────────────────────────────────────────

/// Who is on the other end of a connection the embedder admitted.
#[derive(Debug, Clone)]
pub struct Peer {
    /// Whose blocking work, connection count and sessions this is (the
    /// session host's node id; the local server's one user).
    pub node: String,
    /// Where it came from, for the log.
    pub addr: String,
}

/// Serve one admitted connection until it closes or stops reading.
pub async fn serve_conn<R, W>(host: Arc<Host>, reader: R, writer: W, peer: Peer)
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let caps = &host.opts.caps;
    let id = host.next_conn.fetch_add(1, Ordering::Relaxed);
    let (tx, out_rx) = mpsc::unbounded_channel::<String>();
    let out = Out::new(id, tx, caps);
    {
        let mut conns = lock(&host.conns);
        let held = conns
            .values()
            .filter(|(node, _)| *node == peer.node)
            .count();
        if held >= caps.max_conns_per_node {
            log::warn!(
                "node {} from {}: already holds {held} connections; closed",
                peer.node,
                peer.addr
            );
            return;
        }
        conns.insert(id, (peer.node.clone(), out.close.clone()));
    }
    log::info!(
        "node {} connection {id}: opened from {}",
        peer.node,
        peer.addr
    );
    host.touch();

    let close = out.close.clone();
    let conn = Arc::new(Conn {
        id,
        node: peer.node.clone(),
        out,
        closed: AtomicBool::new(false),
    });

    // Stopped by the teardown (`stop`), it writes what is still queued and
    // shuts its side down within WRITER_CLOSE, so the peer reads its last
    // answers and then a clean close.
    let (stop, stopped) = oneshot::channel::<()>();
    let mut writer_task = tokio::spawn(write_out(writer, out_rx, conn.out.clone(), stopped));
    let ping_task = {
        let conn = conn.clone();
        let every = host.opts.ping_interval;
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                conn.out.send(Event::Ping.encode());
            }
        })
    };

    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut greeted = false;
    let mut requests = JoinSet::new();
    loop {
        // `read_line` is only ever cancelled here, when the connection ends.
        let read = tokio::select! {
            read = read_line(&mut reader, &mut line, MAX_REQUEST_LINE) => read,
            _ = close.notified() => break,
        };
        if let Err(end) = read {
            if let ReadEnd::Failed(reason) = end {
                log::warn!("connection {id}: {reason}");
            }
            break;
        }
        if line.is_empty() {
            continue;
        }
        let request = match std::str::from_utf8(&line)
            .map_err(|e| e.to_string())
            .and_then(|text| decode_request(text).map_err(|e| e.to_string()))
        {
            Ok(request) => request,
            Err(_) => {
                // No id to answer to; a host can only log it.
                log::warn!("connection {id}: {}", undecodable_note(&line));
                continue;
            }
        };
        // `hello` is handled in line so nothing overtakes it.
        if request.m == m::Hello::NAME {
            let outcome = match host.hello(&request) {
                Ok((params, result)) => {
                    greeted = true;
                    let client: String = params.client.chars().take(MAX_CLIENT_NAME).collect();
                    log::info!("connection {id}: hello from {client:?}");
                    Ok(result)
                }
                Err(e) => Err(e),
            };
            reply(&conn, &request, outcome);
            continue;
        }
        if !greeted {
            reply(
                &conn,
                &request,
                Err(err(ErrorCode::BadRequest, "send hello first")),
            );
            continue;
        }
        while requests.try_join_next().is_some() {}
        if requests.len() >= caps.max_in_flight {
            reply(
                &conn,
                &request,
                Err(busy(format!(
                    "{} requests are already running",
                    caps.max_in_flight
                ))),
            );
            continue;
        }
        let host = host.clone();
        let conn = conn.clone();
        requests.spawn(async move {
            if let Reply::Answer(outcome) = host.handle(&conn, &request).await {
                reply(&conn, &request, outcome);
            }
            // No await since the answer was queued, so no abort between.
            if let Some(ext) = &host.extension {
                ext.answered(&request);
            }
        });
    }

    // Whatever is still running for this connection has no one to answer:
    // an `exec.run` among it kills its process group.
    requests.abort_all();
    // Before the sweep: an attach still running parks again (`Conn`), and a
    // session paced on this connection stops waiting for it.
    conn.closed.store(true, Ordering::SeqCst);
    conn.out.closing.store(true, Ordering::Release);
    conn.out.wake();
    // A dropped connection detaches, never closes.
    let routed: Vec<(SessionId, Arc<SessState>)> = lock(&host.sessions)
        .iter()
        .map(|(id, sess)| (*id, sess.clone()))
        .collect();
    tokio::task::spawn_blocking({
        let host = host.clone();
        move || {
            for (sid, sess) in routed {
                host.park(sid, &sess, Some(id));
            }
        }
    })
    .await
    .ok();
    lock(&host.hooks).unsubscribe(id);
    lock(&host.conns).remove(&id);
    ping_task.abort();
    let _ = stop.send(());
    if tokio::time::timeout(WRITER_CLOSE, &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
    }
    log::info!("node {} connection {id}: closed", peer.node);
    host.touch();
}

/// Methods whose params carry an environment or input bytes. A failure's
/// message can quote them — portable-pty's spawn error names the `PATH` it
/// searched, a decode error quotes the value it choked on — so for these the
/// log keeps the code and the client alone gets the message.
const QUIET_FAILURES: &[&str] = &[
    m::PtyOpen::NAME,
    m::PtyWrite::NAME,
    m::ExecRun::NAME,
    m::HooksPush::NAME,
    m::FsWrite::NAME,
];

/// What the log says of a failed `method`, after its code.
fn logged_failure<'a>(method: &str, e: &'a WireError) -> &'a str {
    if QUIET_FAILURES.contains(&method) {
        "(message sent to the client only)"
    } else {
        &e.msg
    }
}

fn reply(conn: &Conn, request: &RawRequest, outcome: Outcome) {
    match &outcome {
        Ok(_) => log::debug!("connection {}: {} #{} ok", conn.id, request.m, request.id),
        Err(e) => log::info!(
            "node {} connection {}: {} #{} failed: {}: {}",
            conn.node,
            conn.id,
            request.m,
            request.id,
            e.code,
            logged_failure(&request.m, e)
        ),
    }
    conn.out.send(match outcome {
        Ok(result) => encode_ok(request.id, &result).expect("raw results serialize"),
        Err(e) => encode_err(request.id, &e),
    });
}

/// One connection's writer: every queued line, batched into as few flushes
/// as what is already waiting allows, until the queue closes or `stopped` —
/// after which what is already queued still goes out (the connection's last
/// answers; the teardown bounds it by [`WRITER_CLOSE`]); then its side is
/// shut down.
async fn write_out<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut out_rx: mpsc::UnboundedReceiver<String>,
    out: Out,
    mut stopped: oneshot::Receiver<()>,
) {
    let mut stopping = false;
    loop {
        let line = if stopping {
            match out_rx.try_recv() {
                Ok(line) => line,
                Err(_) => break,
            }
        } else {
            tokio::select! {
                biased;
                _ = &mut stopped => {
                    stopping = true;
                    continue;
                }
                line = out_rx.recv() => match line {
                    Some(line) => line,
                    None => break,
                },
            }
        };
        let mut taken = queued_cost(&line);
        let mut batch = line;
        batch.push('\n');
        // Whatever else is already queued goes in the same flush.
        while let Ok(mut more) = out_rx.try_recv() {
            taken += queued_cost(&more);
            more.push('\n');
            batch.push_str(&more);
            if batch.len() > 1024 * 1024 {
                break;
            }
        }
        // In slices, each counted as it goes out, so a paced session sees a
        // long batch moving (`Out::wait_room`).
        let mut written = true;
        for slice in batch.as_bytes().chunks(WRITE_SLICE) {
            if writer.write_all(slice).await.is_err() {
                written = false;
                break;
            }
            out.written.fetch_add(slice.len() as u64, Ordering::AcqRel);
            out.wake();
        }
        let written = written && writer.flush().await.is_ok();
        // Counted as drained once written, not when taken: a paced session
        // waits for the peer, not for this task's buffer.
        out.queued.fetch_sub(taken, Ordering::AcqRel);
        out.wake();
        if !written {
            // The peer is gone or the link broke: end the connection now,
            // not at the next ping, so its read loop and pacers stop.
            log::info!("connection {}: write failed; closing", out.conn);
            out.drop_link();
            break;
        }
    }
    let _ = writer.shutdown().await;
}

/// What a host logs of a request line it could not decode: a fixed message and
/// the line's length. Never the decoder's error, which quotes the value that
/// did not fit — and the line is a `pty.open` with its environment as often as
/// not.
fn undecodable_note(line: &[u8]) -> String {
    format!("undecodable request ({} bytes)", line.len())
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use tokio::io::AsyncReadExt;

    use super::*;

    /// serde's own messages quote what they could not parse, so a request whose
    /// field holds a secret would be written to the host's log by the line that
    /// meant to say "undecodable".
    #[test]
    fn an_undecodable_request_is_logged_by_length_never_by_content() {
        let line = br#"{"id":"hunter2-the-password","m":"pty.open"}"#;
        let err = decode_request(std::str::from_utf8(line).unwrap()).unwrap_err();
        assert!(
            err.to_string().contains("hunter2"),
            "the premise: serde quotes the value ({err})"
        );
        let note = undecodable_note(line);
        assert!(!note.contains("hunter2"), "{note}");
        assert!(note.contains(&line.len().to_string()), "{note}");
    }

    /// A batch bigger than the stall window takes to write — an attach's
    /// megabytes of replay on a slow link — is progress, not a stall: a
    /// session paced behind it waits, and the link stays up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_slow_but_moving_write_is_not_a_stall() {
        let caps = Caps {
            pace_high: 1024,
            stall: Duration::from_millis(200),
            ..Caps::default()
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let out = Out::new(1, tx, &caps);
        assert!(out.send("x".repeat(1024 * 1024)));
        let (ours, mut theirs) = tokio::io::duplex(64 * 1024);
        let (_stop, stopped) = oneshot::channel();
        tokio::spawn(write_out(ours, rx, out.clone(), stopped));
        // ~64 KiB every 50ms: the line takes ~0.8s, never 200ms without moving.
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if matches!(theirs.read(&mut buf).await, Ok(0) | Err(_)) {
                    return;
                }
            }
        });
        let room = tokio::task::spawn_blocking({
            let out = out.clone();
            move || out.wait_room(|| false)
        })
        .await
        .unwrap();
        assert!(room, "a link that was still writing was dropped as stalled");
        assert!(!out.closing.load(Ordering::Acquire));
    }

    /// A failure of a request that carries an environment or input is
    /// logged without its message, which can quote them; others keep it.
    #[test]
    fn a_failure_that_may_quote_env_or_input_is_logged_without_its_message() {
        let spawn = WireError::new(
            ErrorCode::Io,
            "No viable candidates found in PATH \"/secret/bin:/usr/bin\"",
        );
        for method in [
            "pty.open",
            "pty.write",
            "exec.run",
            "hooks.push",
            "fs.write",
        ] {
            let logged = logged_failure(method, &spawn);
            assert!(!logged.contains("/secret/bin"), "{method}: {logged}");
        }
        let missing = WireError::new(ErrorCode::NotFound, "no terminal session 4");
        assert_eq!(
            logged_failure("pty.attach", &missing),
            "no terminal session 4"
        );
        assert_eq!(logged_failure("fs.read", &missing), "no terminal session 4");
    }

    /// Lines queued when the connection is told to stop still go out, in
    /// order: the last answer (`server.stop`'s own) is not dropped for being
    /// queued an instant before the close.
    #[tokio::test]
    async fn a_stopped_writer_drains_what_was_queued() {
        let (tx, rx) = mpsc::unbounded_channel();
        let out = Out::new(1, tx, &Caps::default());
        for n in 0..3 {
            assert!(out.send(format!("line {n}")));
        }
        let (stop, stopped) = oneshot::channel();
        stop.send(()).unwrap();
        let (ours, mut theirs) = tokio::io::duplex(64 * 1024);
        write_out(ours, rx, out.clone(), stopped).await;
        let mut got = String::new();
        theirs.read_to_string(&mut got).await.unwrap();
        assert_eq!(got, "line 0\nline 1\nline 2\n");
        assert_eq!(out.queued.load(Ordering::Acquire), 0);
    }

    struct Broken;

    impl AsyncWrite for Broken {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Ready(Err(std::io::Error::other("cut")))
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// A write that fails ends the connection: its read loop and its paced
    /// sessions stop at once instead of at the next ping or stall.
    #[tokio::test]
    async fn a_failed_write_drops_the_link() {
        let (tx, rx) = mpsc::unbounded_channel();
        let out = Out::new(1, tx, &Caps::default());
        assert!(out.send("x".into()));
        let (_stop, stopped) = oneshot::channel();
        write_out(Broken, rx, out.clone(), stopped).await;
        assert!(out.closing.load(Ordering::Acquire), "its pacers still wait");
        tokio::time::timeout(Duration::from_secs(1), out.close.notified())
            .await
            .expect("its read loop was never told to end");
    }
}
