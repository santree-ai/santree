//! Self-update: the release channel, the update check, and the install.
//!
//! Channels are a *distribution* concern, not two builds — one binary serves
//! both. `stable` reads GitHub's `releases/latest` pointer, which skips
//! pre-releases; `beta` reads a rolling pre-release tag whose `latest.json` the
//! release workflow re-uploads on EVERY release, stable ones included. That last
//! part is what keeps a beta user from being stranded on an old beta once a
//! newer stable ships.
//!
//! The endpoint therefore can't come from `tauri.conf.json`: its list is baked
//! into the binary at build time, so each check builds an updater pointed at the
//! channel the setting names. The *public key* does stay in the config — it's
//! the same key for both channels, and the runtime builder inherits it.
//!
//! Nothing here can downgrade: the plugin only offers a strictly newer semver,
//! so beta -> stable is a wait (until stable passes the installed beta), not a
//! rollback. The Updates panel says so, because the silence is otherwise
//! indistinguishable from a broken updater.

use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_specta::Event;

use crate::db::Db;

/// The `settings` row (scope `"app"`) holding the channel. Absent = stable.
pub const UPDATE_CHANNEL_KEY: &str = "update_channel";

/// GitHub resolves `releases/latest` to the newest **non-pre-release**, which is
/// the stable channel with no extra machinery on our side.
const STABLE_MANIFEST: &str =
    "https://github.com/santree-ai/santree/releases/latest/download/latest.json";

/// A fixed pre-release tag whose `latest.json` every release overwrites. Fixed so
/// the URL never moves; pre-release so it can never become what `releases/latest`
/// resolves to.
const BETA_MANIFEST: &str =
    "https://github.com/santree-ai/santree/releases/download/updater-beta/latest.json";

/// Which manifest this install follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

impl UpdateChannel {
    /// Parse the stored value. Anything unrecognised (or absent) is stable —
    /// a hand-edited row must not strand someone on a channel that doesn't exist.
    fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("beta") => Self::Beta,
            _ => Self::Stable,
        }
    }

    fn manifest_url(self) -> &'static str {
        match self {
            Self::Stable => STABLE_MANIFEST,
            Self::Beta => BETA_MANIFEST,
        }
    }
}

/// What the Updates panel shows when a newer version exists.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// The version on offer.
    pub version: String,
    /// The version running now — rendered as "x -> y" rather than made the
    /// frontend's job to fetch separately.
    pub current_version: String,
    /// The release notes from the manifest, if the release carried a body.
    pub notes: Option<String>,
}

/// Download progress, emitted while [`install`] runs. `total` is `None` when the
/// server sends no content-length (the panel then shows an indeterminate bar).
/// Bytes cross as `f64` per the domain's "numbers are JS numbers" convention.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: f64,
    pub total: Option<f64>,
}

/// The [`Update`] handle produced by a check, held for the install that follows.
///
/// The plugin's `Update` is what knows the URL, the signature and the version to
/// install; re-deriving it inside `install_update` would mean a second network
/// round-trip that could legitimately answer differently (a release published
/// between the two calls). So the check parks it here and the install takes it.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

/// A poisoned lock means a previous holder panicked mid-update; there's nothing
/// to salvage, so surface it as an error rather than propagating the panic.
fn pending(app: &AppHandle) -> Result<MutexGuard<'_, Option<Update>>> {
    app.state::<PendingUpdate>()
        .inner()
        .0
        .lock()
        .map_err(|_| anyhow!("the update slot was poisoned by an earlier failure; restart santree"))
}

/// The channel this install follows.
pub async fn channel(db: &Db) -> Result<UpdateChannel> {
    let raw = crate::settings::get(db, "app", UPDATE_CHANNEL_KEY).await?;
    Ok(UpdateChannel::parse(raw.as_deref()))
}

/// Ask the channel's manifest whether anything newer exists, parking the handle
/// for [`install`]. `None` = already current.
pub async fn check(app: &AppHandle, db: &Db) -> Result<Option<UpdateInfo>> {
    let channel = channel(db).await?;
    let updater = app
        .updater_builder()
        .endpoints(vec![channel.manifest_url().parse::<Url>()?])?
        .build()?;

    let found = updater.check().await?;

    // Clear any handle from an earlier check before storing this one: after a
    // channel switch the parked update may be from the *other* manifest, and
    // installing it would silently ignore the toggle.
    let mut slot = pending(app)?;
    match found {
        Some(update) => {
            let info = UpdateInfo {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                notes: update.body.clone(),
            };
            *slot = Some(update);
            Ok(Some(info))
        }
        None => {
            *slot = None;
            Ok(None)
        }
    }
}

/// Download + install the update parked by [`check`], then relaunch.
///
/// Signature verification against the baked-in public key happens inside the
/// plugin: a payload that doesn't verify is rejected before anything is
/// replaced, which is the whole point of the updater key.
#[allow(unreachable_code)] // `AppHandle::restart` diverges.
pub async fn install(app: &AppHandle) -> Result<()> {
    // Take (not borrow) so a failed install can't be retried against a handle
    // whose temp download is already gone — the UI re-checks instead.
    let update = pending(app)?
        .take()
        .ok_or_else(|| anyhow!("no update is ready to install — check for updates first"))?;

    let handle = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = UpdateProgress {
                    downloaded: downloaded as f64,
                    total: total.map(|t| t as f64),
                }
                .emit(&handle);
            },
            || {},
        )
        .await?;

    // `restart` execs straight away: `RunEvent::ExitRequested` — where terminal
    // children are reaped — never fires. Without this, every update orphans the
    // user's agent terminals and any running setup script.
    if let Some(pty) = app.try_state::<santree_pty::PtyManager>() {
        pty.close_all();
    }
    crate::stream::RUNS.kill_all();

    app.restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_parses_beta_and_defaults_to_stable() {
        assert_eq!(UpdateChannel::parse(Some("beta")), UpdateChannel::Beta);
        assert_eq!(UpdateChannel::parse(Some("stable")), UpdateChannel::Stable);
        // The cases that must not strand anyone: unset, and a bad hand-edit.
        assert_eq!(UpdateChannel::parse(None), UpdateChannel::Stable);
        assert_eq!(UpdateChannel::parse(Some("nightly")), UpdateChannel::Stable);
    }

    #[test]
    fn beta_manifest_is_a_fixed_tag_not_the_latest_pointer() {
        // `releases/latest` skips pre-releases — if beta ever pointed there it
        // would silently become a second stable channel.
        assert!(UpdateChannel::Beta
            .manifest_url()
            .contains("/download/updater-beta/"));
        assert!(UpdateChannel::Stable
            .manifest_url()
            .contains("/releases/latest/"));
    }
}
