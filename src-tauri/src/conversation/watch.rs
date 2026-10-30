//! Live updates for the Conversation view: a watch on Claude's transcript
//! roots, held only while views read, that tells a view its session's record
//! changed — at most once per [`THROTTLE`] per session, and the last change of
//! a burst always reaches it.
//!
//! Separate from the Usage panel's watcher (`usage::UsageWatcher`) on purpose:
//! that one is debounced two seconds and wakes a full re-aggregation; this one
//! wakes one view's incremental read, and a conversation lagging its terminal
//! by two seconds reads as broken.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::mpsc::{channel, Receiver, Sender};

use super::{lock, ConversationChanged};

/// The closest two signals for one session come.
const THROTTLE: Duration = Duration::from_millis(75);
/// Raw changes queued for the throttle. A change that finds the queue full is
/// dropped safely: everything queued ahead of it still ends in a signal, and
/// a view reads the file as it is then, not the change.
const QUEUE: usize = 1024;
/// A session no view has read for this long is no longer watched.
const IDLE: Duration = Duration::from_secs(180);
const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// After the OS refused a watch, how long before a read asks again.
const RETRY_AFTER: Duration = Duration::from_secs(60);

type Reading = Arc<Mutex<HashMap<String, Instant>>>;

pub(super) struct Watch {
    shared: Arc<Shared>,
    tx: Sender<String>,
}

struct Shared {
    /// The sessions views are reading, by when one last read. The OS callback
    /// consults it, and takes no other lock.
    reading: Reading,
    /// The OS watch, alive while anything is read. Taken before `reading`.
    os: Mutex<Os>,
}

#[derive(Default)]
struct Os {
    watcher: Option<RecommendedWatcher>,
    refused_at: Option<Instant>,
}

impl Watch {
    pub(super) fn new(app: &AppHandle) -> Self {
        let (tx, rx) = channel(QUEUE);
        let shared = Arc::new(Shared {
            reading: Reading::default(),
            os: Mutex::default(),
        });
        tauri::async_runtime::spawn(pump(app.clone(), shared.clone(), rx));
        Self { shared, tx }
    }

    /// A view read `session_id`: watch its record, and its subagents', until
    /// no view has read it for [`IDLE`]. Blocking — the first one starts the
    /// OS watch.
    pub(super) fn reading(&self, session_id: &str) {
        let mut os = lock(&self.shared.os);
        lock(&self.shared.reading).insert(session_id.to_string(), Instant::now());
        if os.watcher.is_some() || os.refused_at.is_some_and(|at| at.elapsed() < RETRY_AFTER) {
            return;
        }
        match start(self.shared.reading.clone(), self.tx.clone()) {
            Ok(watcher) => {
                os.watcher = Some(watcher);
                os.refused_at = None;
            }
            Err(e) => {
                log::warn!("conversation watch failed: {e}; an open conversation won't follow its session live");
                os.refused_at = Some(Instant::now());
            }
        }
    }
}

impl Shared {
    /// Forget the sessions no view reads any more, and stop watching once
    /// there are none. Blocking: stopping the OS watch joins its thread.
    fn sweep(&self) {
        let mut os = lock(&self.os);
        let idle = {
            let mut reading = lock(&self.reading);
            reading.retain(|_, at| at.elapsed() < IDLE);
            reading.is_empty()
        };
        if idle {
            drop(os.watcher.take());
        }
    }
}

/// One recursive watch per transcript root (`usage::projects_roots`, where
/// the reader locates transcripts too). Every account's transcripts are
/// there: an account folder links its `projects` to the Default home's.
fn start(reading: Reading, tx: Sender<String>) -> notify::Result<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        let reading = lock(&reading);
        for path in &event.paths {
            if let Some(session_id) = session_of(path).filter(|id| reading.contains_key(*id)) {
                let _ = tx.try_send(session_id.to_string());
            }
        }
    })?;
    let mut watched = 0;
    for root in crate::usage::projects_roots() {
        match watcher.watch(&root, RecursiveMode::Recursive) {
            Ok(()) => watched += 1,
            Err(e) => log::warn!("conversation watch of {} failed: {e}", root.display()),
        }
    }
    if watched == 0 {
        return Err(notify::Error::generic(
            "no Claude projects directory to watch",
        ));
    }
    Ok(watcher)
}

/// The session a changed path belongs to: `<root>/<slug>/<session>.jsonl`, or
/// anything under `<root>/<slug>/<session>/subagents/` — a subagent's write is
/// news for the session that spawned it.
fn session_of(path: &Path) -> Option<&str> {
    let parts: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    let root = parts.iter().rposition(|c| *c == "projects")?;
    match &parts[root + 1..] {
        [_, file] => file.strip_suffix(".jsonl"),
        [_, session, "subagents", ..] => Some(*session),
        _ => None,
    }
}

/// Turn raw changes into throttled signals, and sweep idle sessions.
async fn pump(app: AppHandle, shared: Arc<Shared>, mut changes: Receiver<String>) {
    use tokio::time::{interval, sleep_until, Instant as At, MissedTickBehavior};

    let mut last: HashMap<String, At> = HashMap::new();
    let mut due: HashMap<String, At> = HashMap::new();
    let mut sweep = interval(SWEEP_EVERY);
    sweep.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        let next = due.values().min().copied();
        tokio::select! {
            changed = changes.recv() => {
                let Some(session_id) = changed else {
                    return;
                };
                let now = At::now();
                match last.get(&session_id) {
                    Some(&at) if now < at + THROTTLE => {
                        due.entry(session_id).or_insert(at + THROTTLE);
                    }
                    _ => {
                        emit(&app, &session_id);
                        last.insert(session_id, now);
                    }
                }
            }
            () = sleep_until(next.unwrap_or_else(At::now)), if next.is_some() => {
                let now = At::now();
                let ready: Vec<String> = due
                    .iter()
                    .filter(|(_, at)| **at <= now)
                    .map(|(id, _)| id.clone())
                    .collect();
                for session_id in ready {
                    due.remove(&session_id);
                    emit(&app, &session_id);
                    last.insert(session_id, now);
                }
            }
            _ = sweep.tick() => {
                let now = At::now();
                last.retain(|_, at| now.duration_since(*at) < SWEEP_EVERY);
                let shared = shared.clone();
                tokio::task::spawn_blocking(move || shared.sweep());
            }
        }
    }
}

fn emit(app: &AppHandle, session_id: &str) {
    let changed = ConversationChanged {
        session_id: session_id.to_string(),
    };
    if let Err(e) = changed.emit(app) {
        log::debug!("conversation change for {session_id} not delivered: {e}");
    }
}
