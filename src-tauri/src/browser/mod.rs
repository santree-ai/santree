//! The Web tab's browser: a native WKWebView per tab, which santree creates and
//! lays over the tab's area of the window itself (docs/web.md).
//!
//! **Not a Tauri webview.** Tauri injects every plugin's init script into each
//! webview it creates, and two of santree's would change any site loaded there:
//! the opener plugin takes over `target=_blank` clicks and the dialog plugin
//! replaces `window.confirm` with IPC a website is refused. A WKWebView made here
//! loads a page the way Safari would, in a cookie store of its own, with nothing of
//! the app's in it.
//!
//! The page sits *above* the app's webview, so the frontend places it: the tab
//! renders a placeholder and sends its rectangle (`browser_show`/`browser_place`);
//! an app overlay crossing the page either cuts a hole in it (`browser_set_holes`)
//! or swaps it for a still (`browser_snapshot`, then `browser_hide`). Pages are
//! keyed by their tab's id, and closing the tab's row closes its page ([`close`]).
//!
//! AppKit and WebKit live on the main thread, so every command hops there
//! ([`on_main`]) and the pages are kept there (`native`).

pub mod address;
mod import;
mod keys;
mod native;

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::error::CmdResult;

/// A rectangle in the app webview's CSS pixels — what `getBoundingClientRect`
/// reports. The page multiplies it by the app's own zoom.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Type)]
pub struct BrowserRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A part of a page an app overlay covers (a menu, a toast), relative to the
/// page's top-left, in CSS pixels. The page doesn't draw there and clicks fall
/// through to the overlay. `radius` follows the overlay's own corners.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Type)]
pub struct BrowserHole {
    pub rect: BrowserRect,
    pub radius: f64,
}

/// A page's back, forward, reload and stop.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
pub enum BrowserNav {
    Back,
    Forward,
    Reload,
    Stop,
}

/// A page, as its tab and toolbar draw it. Pushed on every change
/// ([`BrowserChanged`]), so neither polls.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    pub id: String,
    /// The committed address; empty before the first page.
    pub url: String,
    pub title: String,
    pub loading: bool,
    /// 0–1, WebKit's estimate for the load in flight.
    pub progress: f64,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// An address the page couldn't open. It stands in front of the page until
    /// another one commits or the user goes back to the page behind it.
    pub failure: Option<BrowserFailure>,
    /// The page's process died. It shows nothing until it is reloaded.
    pub crashed: bool,
}

/// An address a page couldn't open, for its tab to say why.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct BrowserFailure {
    /// The address that failed. By the time WebKit reports a failure it is back
    /// to naming the page before it as the page's URL, so this is the only
    /// record of what was tried.
    pub url: String,
    pub reason: BrowserFailureReason,
    /// WebKit's own words for it.
    pub message: String,
}

/// What kept a page from opening.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
pub enum BrowserFailureReason {
    /// Nothing answered at that address: a server that isn't running.
    NotRunning,
    /// No host goes by that name.
    NoSuchHost,
    Offline,
    TimedOut,
    /// Anything else; the message says what.
    Other,
}

/// A page's state changed.
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct BrowserChanged(pub BrowserState);

/// One of santree's shortcuts was pressed while a page had the keyboard
/// (`keys::route`). The app replays it as if it had been pressed in its own
/// webview; `key` is what a DOM `KeyboardEvent.key` would carry.
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct BrowserShortcut {
    pub id: String,
    pub key: String,
    pub shift: bool,
}

/// The user pressed a mouse button in a page. A click there never reaches the
/// app's webview, so this is how its menus close and its split activates.
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct BrowserPointerDown {
    pub id: String,
}

/// A page took the keyboard (`focused`) or gave it up.
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct BrowserFocus {
    pub id: String,
    pub focused: bool,
}

/// A page opened another, which becomes a tab beside its opener: a script's
/// `window.open` or a `target=_blank` link (`existing`: the page was already made
/// here, from the opener's configuration, so it keeps `window.opener` — what an
/// OAuth popup reports back through), or a ⌘-click (`background`: a new page, left
/// behind the current one).
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOpened {
    pub opener: String,
    pub id: String,
    pub url: String,
    pub existing: bool,
    pub background: bool,
}

/// A page closed itself (`window.close()`), and its tab should go.
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct BrowserClosed {
    pub id: String,
}

/// A download a page started ended: saved at `path`, or failed with `error`.
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct BrowserDownload {
    pub id: String,
    pub file: String,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// Whether this Mac can run a Web tab: its cookie store is one of WebKit's named
/// stores (`WKWebsiteDataStore(forIdentifier:)`), which is macOS 14 and later.
#[tauri::command]
#[specta::specta]
pub fn browser_supported() -> bool {
    native::supported()
}

/// The address bar's text as the URL a page would load (`address::resolve`).
#[tauri::command]
#[specta::specta]
pub fn browser_resolve(input: String) -> CmdResult<String> {
    Ok(address::resolve(&input)?.to_string())
}

/// Show a tab's page over `rect`, creating it on `url` the first time. `false`
/// when there is no page yet and no `url` to make one with — a new, blank tab.
#[tauri::command]
#[specta::specta]
pub async fn browser_show(
    app: AppHandle,
    id: String,
    url: Option<String>,
    rect: BrowserRect,
) -> CmdResult<bool> {
    let id = tab_id(id)?;
    let url = url.map(|u| address::checked(&u)).transpose()?;
    let rect = checked_rect(rect)?;
    Ok(on_main(&app, move |app| native::show(app, &id, url.as_ref(), rect)).await??)
}

/// Move a shown page onto `rect` — its placeholder moved or resized.
#[tauri::command]
#[specta::specta]
pub async fn browser_place(app: AppHandle, id: String, rect: BrowserRect) -> CmdResult<()> {
    let id = tab_id(id)?;
    let rect = checked_rect(rect)?;
    on_main(&app, move |_| native::place(&id, rect)).await?;
    Ok(())
}

/// Hide a page whose tab stopped showing. It keeps running (throttled by WebKit),
/// and the oldest of the hidden pages past a few are put to sleep (`native`).
#[tauri::command]
#[specta::specta]
pub async fn browser_hide(app: AppHandle, id: String) -> CmdResult<()> {
    let id = tab_id(id)?;
    on_main(&app, move |_| native::hide(&id)).await?;
    Ok(())
}

/// Load `url` in a tab's page.
#[tauri::command]
#[specta::specta]
pub async fn browser_load(app: AppHandle, id: String, url: String) -> CmdResult<()> {
    let id = tab_id(id)?;
    let url = address::checked(&url)?;
    Ok(on_main(&app, move |app| native::load(app, &id, &url)).await??)
}

#[tauri::command]
#[specta::specta]
pub async fn browser_nav(app: AppHandle, id: String, nav: BrowserNav) -> CmdResult<()> {
    let id = tab_id(id)?;
    on_main(&app, move |_| native::nav(&id, nav)).await?;
    Ok(())
}

/// Give a page the keyboard — its tab was just picked.
#[tauri::command]
#[specta::specta]
pub async fn browser_focus(app: AppHandle, id: String) -> CmdResult<()> {
    let id = tab_id(id)?;
    on_main(&app, move |_| native::focus(&id)).await?;
    Ok(())
}

/// Hand the keyboard back to the app's webview: something there took focus (a
/// field, the palette) while a page still held it natively.
#[tauri::command]
#[specta::specta]
pub async fn browser_release_focus(app: AppHandle) -> CmdResult<()> {
    on_main(&app, |_| native::release_focus()).await?;
    Ok(())
}

/// Cut the app overlays crossing a page out of it (an empty list restores it).
#[tauri::command]
#[specta::specta]
pub async fn browser_set_holes(
    app: AppHandle,
    id: String,
    holes: Vec<BrowserHole>,
) -> CmdResult<()> {
    let id = tab_id(id)?;
    let holes = checked_holes(holes)?;
    on_main(&app, move |_| native::set_holes(&id, &holes)).await?;
    Ok(())
}

/// A still of a page (a JPEG `data:` URL), to stand in for it while a modal
/// covers it — the modal's blurred scrim then draws over a picture of the page
/// instead of over nothing. `None` when there is no page or WebKit can't draw one.
#[tauri::command]
#[specta::specta]
pub async fn browser_snapshot(app: AppHandle, id: String) -> CmdResult<Option<String>> {
    let id = tab_id(id)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    on_main(&app, move |_| native::snapshot(&id, tx)).await?;
    Ok(rx.await.unwrap_or(None))
}

/// A page's current state, for a toolbar mounting after the page was made.
#[tauri::command]
#[specta::specta]
pub async fn browser_state(app: AppHandle, id: String) -> CmdResult<Option<BrowserState>> {
    let id = tab_id(id)?;
    Ok(on_main(&app, move |_| native::state(&id)).await?)
}

/// The browser profiles on this Mac whose cookies could be imported into the Web
/// tabs' store (`import::sources`). Empty when none is installed.
#[tauri::command]
#[specta::specta]
pub fn browser_cookie_sources(app: AppHandle) -> CmdResult<Vec<import::CookieSource>> {
    Ok(import::sources(&support_dir(&app)?))
}

/// The sites a chosen profile has cookies for, so the user can pick which to
/// bring over. Reads no cookie value and asks for no Keychain access — only which
/// sites are there.
#[tauri::command]
#[specta::specta]
pub async fn browser_cookie_sites(
    app: AppHandle,
    source: String,
) -> CmdResult<Vec<import::CookieSite>> {
    Ok(import::sites(&support_dir(&app)?, &source).await?)
}

/// Copy the chosen profile's cookies for `sites` into the Web tabs' own store.
/// For a Chromium profile this reads its cookie key from the login Keychain, so
/// macOS asks the user to allow it. Nothing is kept but the cookies themselves,
/// in WebKit's store.
#[tauri::command]
#[specta::specta]
pub async fn browser_import_cookies(
    app: AppHandle,
    source: String,
    sites: Vec<String>,
) -> CmdResult<import::CookieImport> {
    let read = import::read(&support_dir(&app)?, &source, &sites).await?;
    let offered = read.cookies.len();
    let taken = on_main(&app, move |_| native::import_cookies(read.cookies)).await?;
    Ok(import::CookieImport {
        cookies: taken as u32,
        // Decryption failures, plus any WebKit itself turned away.
        skipped: read.skipped + (offered - taken) as u32,
    })
}

/// The user's `~/Library/Application Support`, where the browsers keep their
/// profiles. This reads other apps' folders there, never santree's own.
fn support_dir(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    app.path()
        .data_dir()
        .map_err(|_| anyhow::anyhow!("the Application Support folder is unavailable"))
}

/// Close a tab's page, if it has one. Called with the tab's row going away
/// (`remove_worktree_tab`, and every web tab of a removed worktree), so a page
/// never outlives its tab.
pub async fn close(app: &AppHandle, ids: Vec<String>) {
    if ids.is_empty() {
        return;
    }
    {
        let mut seen = SEEN.lock().unwrap_or_else(|p| p.into_inner());
        ids.iter().for_each(|id| drop(seen.remove(id)));
    }
    if let Err(e) = on_main(app, move |_| ids.iter().for_each(|id| native::close(id))).await {
        log::warn!("closing web tabs' pages failed: {e:#}");
    }
}

/// The app's webview started loading its page again (a reload). The tabs that
/// placed the pages are gone until the new page mounts them, and a page left up
/// meanwhile would float over whatever the app shows next.
pub fn hide_all(app: &AppHandle) {
    if let Err(e) = app.run_on_main_thread(native::hide_all) {
        log::warn!("hiding web tabs' pages failed: {e:#}");
    }
}

/// `holes` with every overlapping pair merged into the rectangle around both.
///
/// The page is masked with an even-odd path — its bounds, then each hole — and
/// under even-odd a spot two holes share is filled back in. Overlays over a page
/// rarely overlap each other, so merging them square (radius 0) costs nothing
/// anyone sees.
fn disjoint(holes: &[BrowserHole]) -> Vec<BrowserHole> {
    let mut out: Vec<BrowserHole> = Vec::with_capacity(holes.len());
    for hole in holes {
        let mut hole = *hole;
        // Absorb every hole this one now touches, until it touches none.
        while let Some(at) = out.iter().position(|h| overlaps(&h.rect, &hole.rect)) {
            let other = out.swap_remove(at).rect;
            let (x, y) = (hole.rect.x.min(other.x), hole.rect.y.min(other.y));
            let right = (hole.rect.x + hole.rect.width).max(other.x + other.width);
            let bottom = (hole.rect.y + hole.rect.height).max(other.y + other.height);
            hole = BrowserHole {
                rect: BrowserRect {
                    x,
                    y,
                    width: right - x,
                    height: bottom - y,
                },
                radius: 0.0,
            };
        }
        out.push(hole);
    }
    out
}

fn overlaps(a: &BrowserRect, b: &BrowserRect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/// The most any CSS length from the app's webview can be, in either direction —
/// past any display. A huge value overflows AppKit's geometry into NaN, and a
/// NaN frame or bezier path aborts the app.
const MAX_LENGTH: f64 = 100_000.0;

/// More overlays than any screen holds at once: the masks are merged pairwise.
const MAX_HOLES: usize = 32;

/// A rectangle from IPC, held to one a window could have.
fn checked_rect(rect: BrowserRect) -> anyhow::Result<BrowserRect> {
    let position = |v: f64| v.is_finite() && v.abs() <= MAX_LENGTH;
    let size = |v: f64| v.is_finite() && (0.0..=MAX_LENGTH).contains(&v);
    if !(position(rect.x) && position(rect.y) && size(rect.width) && size(rect.height)) {
        anyhow::bail!("that rectangle is outside any window");
    }
    Ok(rect)
}

fn checked_holes(holes: Vec<BrowserHole>) -> anyhow::Result<Vec<BrowserHole>> {
    if holes.len() > MAX_HOLES {
        anyhow::bail!("more overlays than a page can be cut around");
    }
    for hole in &holes {
        checked_rect(hole.rect)?;
        if !(hole.radius.is_finite() && (0.0..=MAX_LENGTH).contains(&hole.radius)) {
            anyhow::bail!("that corner radius is outside any window");
        }
    }
    Ok(holes)
}

/// A tab id from IPC: a UUID as the frontend mints them (and `native` does for a
/// popup), or nothing santree would ever have made.
fn tab_id(id: String) -> anyhow::Result<String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        anyhow::bail!("invalid web tab id");
    }
    Ok(id)
}

/// Run `f` on the main thread, where every page lives, and wait for its answer.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> anyhow::Result<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&handle));
    })?;
    Ok(rx.await?)
}

/// How long a page has to stay on an address before it is written down — so a
/// site that rewrites its URL as you scroll costs one write, not one per scroll.
const REMEMBER_AFTER: Duration = Duration::from_millis(800);

/// The latest page each tab was seen on, by tab: the write that finds its own
/// address still there after [`REMEMBER_AFTER`] is the one that persists it.
static SEEN: LazyLock<Mutex<HashMap<String, (String, String)>>> = LazyLock::new(Default::default);

/// Persist the page a tab shows (`tabs::set_page`), settled first.
fn remember(app: &AppHandle, id: &str, url: &str, title: &str) {
    if address::checked(url).is_err() || url == "about:blank" {
        return;
    }
    let seen = (url.to_string(), title.to_string());
    let mut latest = SEEN.lock().unwrap_or_else(|p| p.into_inner());
    if latest.get(id) == Some(&seen) {
        return;
    }
    latest.insert(id.to_string(), seen.clone());
    drop(latest);
    let (app, id) = (app.clone(), id.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REMEMBER_AFTER).await;
        let current = SEEN
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&id)
            .cloned();
        if current.as_ref() != Some(&seen) {
            return;
        }
        let db = app.state::<Db>();
        if let Err(e) = crate::tabs::set_page(&db, &id, &seen.0, &seen.1).await {
            log::warn!("remembering web tab {id}'s page failed: {e:#}");
        }
    });
}

/// Send `event` to the frontend; a page has no one to report a failure to.
fn emit(app: &AppHandle, event: impl tauri_specta::Event + Serialize + Clone) {
    let _ = event.emit(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hole(x: f64, y: f64, width: f64, height: f64) -> BrowserHole {
        BrowserHole {
            rect: BrowserRect {
                x,
                y,
                width,
                height,
            },
            radius: 8.0,
        }
    }

    /// AppKit turns a huge rectangle into NaN geometry, and a NaN frame or path
    /// aborts the app — so nothing from IPC reaches it unchecked.
    #[test]
    fn geometry_no_window_could_have_is_refused() {
        let rect = |x: f64, y: f64, width: f64, height: f64| BrowserRect {
            x,
            y,
            width,
            height,
        };
        assert!(checked_rect(rect(-120.0, 46.0, 800.0, 600.0)).is_ok());
        for bad in [
            rect(-1e308, 0.0, 1e308, 100.0),
            rect(0.0, f64::NAN, 10.0, 10.0),
            rect(0.0, 0.0, -1.0, 10.0),
            rect(0.0, 0.0, 10.0, f64::INFINITY),
        ] {
            assert!(checked_rect(bad).is_err(), "{bad:?}");
        }
        let hole = |radius: f64| BrowserHole {
            rect: rect(0.0, 0.0, 10.0, 10.0),
            radius,
        };
        assert!(checked_holes(vec![hole(8.0); MAX_HOLES]).is_ok());
        assert!(checked_holes(vec![hole(8.0); MAX_HOLES + 1]).is_err());
        assert!(checked_holes(vec![hole(1e308)]).is_err());
    }

    /// Under the even-odd mask, two overlapping holes would show the page again
    /// where they meet — through the middle of a menu.
    #[test]
    fn overlapping_holes_merge_and_separate_ones_keep_their_corners() {
        let merged = disjoint(&[
            hole(0.0, 0.0, 10.0, 10.0),
            hole(100.0, 100.0, 10.0, 10.0),
            hole(5.0, 5.0, 10.0, 10.0),
            // Touches the merged pair only once they are one.
            hole(14.0, 0.0, 4.0, 4.0),
        ]);
        assert_eq!(merged.len(), 2);
        let far = merged.iter().find(|h| h.rect.x == 100.0).unwrap();
        assert_eq!(far.radius, 8.0);
        let near = merged.iter().find(|h| h.rect.x == 0.0).unwrap();
        assert_eq!(
            (near.rect.width, near.rect.height, near.radius),
            (18.0, 15.0, 0.0)
        );
    }
}
