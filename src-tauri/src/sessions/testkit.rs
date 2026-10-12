//! Test support for anything that drives terminals: what a pane was sent, waits
//! on a condition (never a guessed interval), fast link options, the test
//! daemon as a swappable server, and local hosts a test controls.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::watch;

use santree_core::domain::AgentKind;
use santree_remote_client::fake::FakeDaemon;
use santree_remote_client::{
    ClientOptions, ConnectError, Connector, HostConfig, HostOptions, Link, RemoteHost, Required,
};

use super::backend::LocalHosts;
use super::ids::{HostKey, IdRegistry};
use super::remote::{Profile, RemoteTerminals, Timing};
use super::{PaneLink, Sinks, Spec};
use crate::terminal::RawBytes;

/// The longest any test waits for a condition.
pub const WAIT: Duration = Duration::from_secs(20);

/// Link options that reconnect in milliseconds and ask nothing of the link.
pub fn fast() -> HostOptions {
    HostOptions {
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(200),
        hello_timeout: Duration::from_secs(5),
        client: ClientOptions::default(),
        hooks: true,
        require: Required::Any,
    }
}

/// What a pane has been sent: its bytes, whether it was told the process
/// exited, and every link state in order. Every change bumps `changed`, so a
/// test waits on a condition over it rather than on time.
#[derive(Clone)]
pub struct Screen {
    out: Arc<Mutex<Vec<u8>>>,
    exited: Arc<Mutex<bool>>,
    links: Arc<Mutex<Vec<PaneLink>>>,
    changed: Arc<watch::Sender<u64>>,
}

impl Default for Screen {
    fn default() -> Self {
        Self::new()
    }
}

impl Screen {
    pub fn new() -> Self {
        Self {
            out: Arc::default(),
            exited: Arc::default(),
            links: Arc::default(),
            changed: Arc::new(watch::channel(0).0),
        }
    }

    fn output(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            *self.exited.lock().unwrap() = true;
        } else {
            self.out.lock().unwrap().extend(bytes);
        }
        self.changed.send_modify(|n| *n += 1);
    }

    fn link(&self, link: PaneLink) {
        self.links.lock().unwrap().push(link);
        self.changed.send_modify(|n| *n += 1);
    }

    /// The pane's sinks, as the facade takes them.
    pub fn sinks(&self) -> Sinks {
        let (out, link) = (self.clone(), self.clone());
        Sinks {
            output: Arc::new(move |bytes| out.output(bytes)),
            link: Arc::new(move |state| link.link(state)),
        }
    }

    /// The pane's channels, as `terminal::open` and `terminal::attach` take them.
    pub fn channels(&self) -> (Channel<RawBytes>, Channel<PaneLink>) {
        let (out, link) = (self.clone(), self.clone());
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                out.output(bytes);
            }
            Ok(())
        });
        let links = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                link.link(match json.as_str() {
                    "\"live\"" => PaneLink::Live,
                    "\"reconnecting\"" => PaneLink::Reconnecting,
                    "\"lost\"" => PaneLink::Lost,
                    other => panic!("unexpected link state {other}"),
                });
            }
            Ok(())
        });
        (output, links)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.out.lock().unwrap()).into_owned()
    }

    pub fn len(&self) -> u64 {
        self.out.lock().unwrap().len() as u64
    }

    pub fn count(&self, needle: &str) -> usize {
        self.text().matches(needle).count()
    }

    pub fn links(&self) -> Vec<PaneLink> {
        self.links.lock().unwrap().clone()
    }

    pub fn last_link(&self) -> Option<PaneLink> {
        self.links.lock().unwrap().last().copied()
    }

    pub fn exited(&self) -> bool {
        *self.exited.lock().unwrap()
    }

    pub async fn until(&self, what: &str, cond: impl Fn(&Screen) -> bool) {
        let mut changed = self.changed.subscribe();
        let met = tokio::time::timeout(WAIT, changed.wait_for(|_| cond(self))).await;
        assert!(
            met.is_ok(),
            "timed out waiting for {what}; the pane has {:?}, links {:?}",
            self.text(),
            self.links()
        );
    }
}

/// Wait for state outside a pane: checked on every scheduler turn until it
/// holds, bounded by [`WAIT`].
pub async fn until(what: &str, cond: impl Fn() -> bool) {
    let met = tokio::time::timeout(WAIT, async {
        while !cond() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(met.is_ok(), "timed out waiting for {what}");
}

/// A shell in `cwd`, as the "+" opens one.
pub fn shell(cwd: &str, label: &str, agent_kind: Option<AgentKind>) -> Spec {
    Spec {
        cwd: Some(cwd.to_string()),
        command: "/bin/sh".into(),
        args: Vec::new(),
        env: Vec::new(),
        label: label.into(),
        agent_kind,
    }
}

/// Whichever daemon is current, or none: swapping it is a server restart (a new
/// `bootId`, session ids from 1 again), and none is a server that isn't there.
#[derive(Clone, Default)]
pub struct Daemons(Arc<Mutex<Option<FakeDaemon>>>);

impl Daemons {
    pub fn of(daemon: &FakeDaemon) -> Self {
        let cell = Self::default();
        cell.set(Some(daemon.clone()));
        cell
    }

    pub fn set(&self, daemon: Option<FakeDaemon>) {
        *self.0.lock().unwrap() = daemon;
    }

    pub fn connector(&self) -> Arc<dyn Connector> {
        let cell = self.0.clone();
        Arc::new(move || -> BoxFuture<'static, Result<Link, ConnectError>> {
            let link = cell.lock().unwrap().as_ref().map(FakeDaemon::connect);
            Box::pin(async move { link.ok_or_else(|| ConnectError::Failed("no server".into())) })
        })
    }
}

/// An app run's terminals over a host on `daemons` that hasn't started linking
/// yet ([`start`] does that), watching it.
pub fn build(
    daemons: &Daemons,
    ids: &Arc<IdRegistry>,
    key: HostKey,
    profile: Profile,
    timing: Timing,
) -> (RemoteTerminals, Arc<RemoteHost>) {
    let host = Arc::new(RemoteHost::new(daemons.connector(), fast()));
    let terminals = RemoteTerminals::with_timing(host.clone(), key, ids.clone(), profile, timing);
    terminals.watch();
    (terminals, host)
}

/// Start `host` linking.
pub fn start(host: &RemoteHost) {
    host.configure(Some(HostConfig {
        client: "santree/test".into(),
        owner: "app".into(),
        hook_cursor: None,
        boot_id: None,
    }));
}

/// An app run: [`build`] with the default pacing, linking.
pub fn run(
    daemons: &Daemons,
    ids: &Arc<IdRegistry>,
    key: HostKey,
    profile: Profile,
) -> (RemoteTerminals, Arc<RemoteHost>) {
    let (terminals, host) = build(daemons, ids, key, profile, Timing::default());
    start(&host);
    (terminals, host)
}

/// Local servers a test holds: the first is the one new panes open on.
/// Whether the set is the whole of what runs is the test's to say, as the
/// supervisor's is (false while a server that may hold sessions can't be
/// reached), and a release is recorded.
pub struct TestHosts {
    pub hosts: Vec<RemoteTerminals>,
    pub complete: AtomicBool,
    pub released: AtomicBool,
}

impl TestHosts {
    pub fn of(hosts: Vec<RemoteTerminals>) -> Arc<Self> {
        Arc::new(Self {
            hosts,
            complete: AtomicBool::new(true),
            released: AtomicBool::new(false),
        })
    }
}

impl LocalHosts for TestHosts {
    fn current(&self) -> Option<RemoteTerminals> {
        self.hosts.first().cloned()
    }

    fn all(&self) -> Vec<RemoteTerminals> {
        self.hosts.clone()
    }

    fn adopt_ready(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Some(current) = self.hosts.first() {
                current.adopt_ready().await;
            }
        })
    }

    fn complete(&self) -> bool {
        self.complete.load(Ordering::SeqCst)
    }

    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
    }
}
