//! Daedalus projects' app icons: the session host's `workspaces.icon`
//! (docs/remote.md), asked once per workspace and kept.
//!
//! The box is asked only when its `hello` announces the method, and then once
//! per workspace per link: an answer — an icon, or `not_found` — holds until
//! the link reconnects or a day passes. Every answer is also written under the
//! app data dir, so a launch away from home, or before the link is up, draws
//! the icon it drew last time instead of the generic mark it would then swap.
//!
//! The bytes are the box's, so they are re-checked here (type, size, and that
//! they sniff as the type they claim) and handed to the frontend only to draw
//! as an image.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use santree_core::domain::DaedalusIcon;
use santree_remote_client::proto::{m, ErrorCode, WorkspaceIcon, WorkspacesIconParams};

use super::host::{DaedalusHost, CONNECT_WAIT};

/// How long an answer holds on one link before the box is asked again.
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// One workspace's last answer.
#[derive(Clone)]
struct Answer {
    /// `None`: the box has no icon for it.
    icon: Option<WorkspaceIcon>,
    fetched_at: SystemTime,
    /// The link it was asked on ([`DaedalusHost::generation`]); `None` for an
    /// answer read back from disk, which no link of this run has confirmed.
    generation: Option<u64>,
}

/// An answer as it is kept on disk, one file per workspace.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    /// Unix seconds.
    fetched_at: u64,
    icon: Option<WorkspaceIcon>,
}

type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// The icon cache. Tauri-managed; one per app.
pub struct Icons {
    dir: PathBuf,
    answers: Mutex<HashMap<String, Answer>>,
    /// One ask at a time: concurrent rows asking for one workspace wait for
    /// the first answer rather than each asking the box.
    asking: tokio::sync::Mutex<()>,
    now: Clock,
}

impl Icons {
    /// A cache kept in `dir` (created on the first write).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self::with_clock(dir, Arc::new(SystemTime::now))
    }

    fn with_clock(dir: impl Into<PathBuf>, now: Clock) -> Self {
        Self {
            dir: dir.into(),
            answers: Mutex::new(HashMap::new()),
            asking: tokio::sync::Mutex::new(()),
            now,
        }
    }

    /// Workspace `name`'s icon, or `None` for the generic mark: the box has
    /// none, doesn't serve icons, or the link is down with nothing kept.
    pub async fn get(&self, link: &DaedalusHost, name: &str) -> Result<Option<DaedalusIcon>> {
        super::validate_workspace_name(name)?;
        let mut hello = link.hello();
        if hello.is_none() {
            // Down, or still coming up: the last answer, never an ask.
            if let Some(kept) = self.kept(name) {
                return Ok(kept.icon.map(view));
            }
            // Nothing kept: a link a moment from up is worth the wait, rather
            // than the generic mark now and a swap to the icon a second later.
            if link.client_within(CONNECT_WAIT).await.is_err() {
                return Ok(None);
            }
            hello = link.hello();
        }
        let Some(hello) = hello else {
            return Ok(None);
        };
        if !hello.supports::<m::WorkspacesIcon>() {
            return Ok(None);
        }
        let generation = link.generation();
        if let Some(answer) = self.current(name, generation) {
            return Ok(answer.icon.map(view));
        }
        let _asking = self.asking.lock().await;
        if let Some(answer) = self.current(name, generation) {
            return Ok(answer.icon.map(view));
        }
        let kept = || self.kept(name).and_then(|a| a.icon).map(view);
        let Ok(client) = link.client() else {
            return Ok(kept());
        };
        let params = WorkspacesIconParams { name: name.into() };
        let icon = match client.call::<m::WorkspacesIcon>(&params).await {
            Ok(icon) => {
                let checked = icon.checked();
                if checked.is_none() {
                    log::warn!("daedalus: the icon for {name} isn't an image santree draws");
                }
                checked
            }
            Err(e) if e.code() == Some(&ErrorCode::NotFound) => None,
            // Busy, a dropped link: keep what there was, and ask next time.
            Err(e) => {
                log::warn!("daedalus: asking for {name}'s icon failed: {e}");
                return Ok(kept());
            }
        };
        self.store(
            name,
            Answer {
                icon: icon.clone(),
                fetched_at: (self.now)(),
                generation: Some(generation),
            },
        );
        Ok(icon.map(view))
    }

    /// The answer for `name` if this link gave it and it is under a day old.
    fn current(&self, name: &str, generation: u64) -> Option<Answer> {
        let answer = self.kept(name)?;
        let age = (self.now)()
            .duration_since(answer.fetched_at)
            .unwrap_or_default();
        (answer.generation == Some(generation) && age < MAX_AGE).then_some(answer)
    }

    /// The last answer for `name`, from memory or else from disk.
    fn kept(&self, name: &str) -> Option<Answer> {
        let mut answers = self.answers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(answer) = answers.get(name) {
            return Some(answer.clone());
        }
        let stored: Stored = serde_json::from_slice(&std::fs::read(self.path(name)).ok()?).ok()?;
        let answer = Answer {
            // Checked again: the file is outside the app, and older builds
            // may have checked less.
            icon: stored.icon.and_then(WorkspaceIcon::checked),
            fetched_at: UNIX_EPOCH + Duration::from_secs(stored.fetched_at),
            generation: None,
        };
        answers.insert(name.to_string(), answer.clone());
        Some(answer)
    }

    fn store(&self, name: &str, answer: Answer) {
        let stored = Stored {
            fetched_at: answer
                .fetched_at
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs()),
            icon: answer.icon.clone(),
        };
        self.answers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name.to_string(), answer);
        if let Err(e) = self.write(name, &stored) {
            log::warn!("daedalus: keeping {name}'s icon on disk failed: {e:#}");
        }
    }

    fn write(&self, name: &str, stored: &Stored) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join(format!(".{name}.json.tmp"));
        std::fs::write(&tmp, serde_json::to_vec(stored)?)?;
        std::fs::rename(&tmp, self.path(name))?;
        Ok(())
    }

    /// `name` is a checked workspace name: one plain path component.
    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.json"))
    }
}

fn view(icon: WorkspaceIcon) -> DaedalusIcon {
    DaedalusIcon {
        content_type: icon.content_type,
        data: STANDARD.encode(&icon.data),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use santree_remote_client::fake::{FakeAgent, FakeDaemon, FakeOptions};
    use santree_remote_client::proto::Method;
    use santree_remote_client::{ClientOptions, HostOptions};

    use super::*;

    const SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#;
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];

    fn icon(content_type: &str, data: &[u8]) -> WorkspaceIcon {
        WorkspaceIcon {
            content_type: content_type.into(),
            data: data.to_vec(),
        }
    }

    fn fast() -> HostOptions {
        HostOptions {
            backoff_min: Duration::from_millis(20),
            backoff_max: Duration::from_millis(200),
            hello_timeout: Duration::from_secs(5),
            client: ClientOptions::default(),
        }
    }

    /// A clock that only moves when the test says so.
    fn clock() -> (Clock, Arc<AtomicU64>) {
        let secs = Arc::new(AtomicU64::new(1_800_000_000));
        let read = secs.clone();
        (
            Arc::new(move || UNIX_EPOCH + Duration::from_secs(read.load(Ordering::SeqCst))),
            secs,
        )
    }

    struct Setup {
        daemon: FakeDaemon,
        agent: FakeAgent,
        link: DaedalusHost,
        _dir: tempfile::TempDir,
    }

    async fn linked(opts: FakeOptions) -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let daemon = FakeDaemon::with_options(opts);
        let agent = FakeAgent::serve(dir.path().join("santree.sock"), daemon.clone()).unwrap();
        let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
        link.resume(None);
        link.settled(Duration::from_secs(10)).await;
        assert!(link.hello().is_some(), "the fake link came up");
        Setup {
            daemon,
            agent,
            link,
            _dir: dir,
        }
    }

    fn with_icons(icons: &[(&str, WorkspaceIcon)]) -> FakeOptions {
        FakeOptions {
            icons: icons
                .iter()
                .map(|(n, i)| (n.to_string(), i.clone()))
                .collect(),
            ..Default::default()
        }
    }

    /// Wait for the link after `from` to come up.
    async fn reconnected(link: &DaedalusHost, from: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while link.generation() == from || link.hello().is_none() {
            assert!(tokio::time::Instant::now() < deadline, "no reconnect");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn each_workspace_is_asked_once_then_kept() {
        let s = linked(with_icons(&[("web", icon("image/svg+xml", SVG))])).await;
        let cache = tempfile::tempdir().unwrap();
        let icons = Icons::new(cache.path());

        let want = DaedalusIcon {
            content_type: "image/svg+xml".into(),
            data: STANDARD.encode(SVG),
        };
        for _ in 0..3 {
            assert_eq!(icons.get(&s.link, "web").await.unwrap(), Some(want.clone()));
            // No icon is an answer too, and kept like one.
            assert_eq!(icons.get(&s.link, "infra").await.unwrap(), None);
        }
        // Concurrent asks for one workspace share the one ask.
        let (a, b) = tokio::join!(icons.get(&s.link, "api"), icons.get(&s.link, "api"));
        assert_eq!((a.unwrap(), b.unwrap()), (None, None));
        assert_eq!(s.daemon.icon_log(), ["web", "infra", "api"]);
        assert!(cache.path().join("web.json").is_file());
        assert!(cache.path().join("infra.json").is_file());

        // A name that isn't a workspace's is refused before the box sees it.
        assert!(icons.get(&s.link, "../web").await.is_err());
        assert_eq!(s.daemon.icon_log().len(), 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reconnect_or_a_day_asks_again() {
        let s = linked(with_icons(&[("web", icon("image/svg+xml", SVG))])).await;
        let cache = tempfile::tempdir().unwrap();
        let (now, secs) = clock();
        let icons = Icons::with_clock(cache.path(), now);
        assert_eq!(
            icons
                .get(&s.link, "web")
                .await
                .unwrap()
                .unwrap()
                .content_type,
            "image/svg+xml"
        );

        // A new icon on the box is seen after a reconnect, not before.
        s.daemon.set_icon("web", Some(icon("image/png", PNG)));
        assert_eq!(
            icons
                .get(&s.link, "web")
                .await
                .unwrap()
                .unwrap()
                .content_type,
            "image/svg+xml"
        );
        let generation = s.link.generation();
        s.daemon.disconnect_all();
        reconnected(&s.link, generation).await;
        assert_eq!(
            icons
                .get(&s.link, "web")
                .await
                .unwrap()
                .unwrap()
                .content_type,
            "image/png"
        );
        assert_eq!(s.daemon.icon_log(), ["web", "web"]);

        // Within the day, the answer holds; past it, the box is asked.
        s.daemon.set_icon("web", None);
        secs.fetch_add(MAX_AGE.as_secs() - 60, Ordering::SeqCst);
        assert!(icons.get(&s.link, "web").await.unwrap().is_some());
        assert_eq!(s.daemon.icon_log().len(), 2);
        secs.fetch_add(120, Ordering::SeqCst);
        assert_eq!(icons.get(&s.link, "web").await.unwrap(), None);
        assert_eq!(s.daemon.icon_log().len(), 3);
    }

    /// Away from home, or before the link is up, the last icon drawn is drawn
    /// again — from disk on a fresh launch — and the box isn't asked.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_link_that_is_down_draws_what_was_kept() {
        let s = linked(with_icons(&[("web", icon("image/png", PNG))])).await;
        let cache = tempfile::tempdir().unwrap();
        assert!(Icons::new(cache.path())
            .get(&s.link, "web")
            .await
            .unwrap()
            .is_some());

        s.agent.refuse("santree_off", "off");
        s.daemon.disconnect_all();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while s.link.hello().is_some() {
            assert!(tokio::time::Instant::now() < deadline, "the link stayed up");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let relaunched = Icons::new(cache.path());
        let kept = relaunched.get(&s.link, "web").await.unwrap().unwrap();
        assert_eq!(kept.content_type, "image/png");
        assert_eq!(kept.data, STANDARD.encode(PNG));
        // Nothing kept: the generic mark.
        assert_eq!(relaunched.get(&s.link, "infra").await.unwrap(), None);
        assert_eq!(s.daemon.icon_log(), ["web"]);

        // A tampered file is checked like an answer from the box.
        std::fs::write(
            cache.path().join("web.json"),
            r#"{"fetchedAt":0,"icon":{"contentType":"image/png","data":"PHN2Zy8+"}}"#,
        )
        .unwrap();
        assert_eq!(
            Icons::new(cache.path()).get(&s.link, "web").await.unwrap(),
            None
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_host_that_does_not_announce_icons_is_never_asked() {
        let s = linked(FakeOptions {
            features: vec![m::WorkspacesList::NAME.into()],
            ..with_icons(&[("web", icon("image/png", PNG))])
        })
        .await;
        let cache = tempfile::tempdir().unwrap();
        let icons = Icons::new(cache.path());
        assert_eq!(icons.get(&s.link, "web").await.unwrap(), None);
        assert!(s.daemon.icon_log().is_empty());
    }

    /// An answer whose bytes aren't what it says is no icon — the box is not
    /// trusted to have sniffed them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_icon_that_is_not_what_it_says_is_no_icon() {
        let mut big = PNG.to_vec();
        big.resize(64 * 1024 + 1, 0);
        let s = linked(with_icons(&[
            ("lying", icon("image/svg+xml", PNG)),
            ("html", icon("text/html", b"<html><svg/></html>")),
            ("big", icon("image/png", &big)),
        ]))
        .await;
        let cache = tempfile::tempdir().unwrap();
        let icons = Icons::new(cache.path());
        for name in ["lying", "html", "big"] {
            assert_eq!(icons.get(&s.link, name).await.unwrap(), None, "{name}");
        }
    }
}
