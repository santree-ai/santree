//! The pages themselves, kept on the main thread (every caller has hopped there,
//! `browser::on_main`). One host view is laid over the app's webview the first
//! time a page is shown; each tab's page lives in a slot inside it, placed over
//! the tab's placeholder.
//!
//! A tab that stops showing hides its slot: WebKit then throttles the page, and it
//! keeps its place, its scroll and anything typed into it. Past [`AWAKE_HIDDEN`]
//! hidden pages, the one hidden longest is put to sleep — closed, keeping its
//! back/forward list (`interactionState`) to wake on when its tab is shown again,
//! back at the top of its page — so a long day of tabs doesn't hold a web
//! process per tab.

mod classes;
mod delegate;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ptr::null_mut;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use base64::Engine as _;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker, Message};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSBitmapImageFileType, NSBitmapImageRep, NSImage,
    NSImageCompressionFactor, NSWindow, NSWindowOrderingMode,
};
use objc2_foundation::{
    NSAlignmentOptions, NSBundle, NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize,
    NSString, NSURLRequest, NSURL, NSUUID,
};
use objc2_quartz_core::CATransaction;
use objc2_web_kit::{
    WKSnapshotConfiguration, WKWebView, WKWebViewConfiguration, WKWebsiteDataStore,
};
use reqwest::Url;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use self::classes::{Host, PageView, Slot};
use self::delegate::Delegate;
use super::keys::BrowserCommand;
use super::{emit, BrowserHole, BrowserNav, BrowserOpened, BrowserRect, BrowserState};

/// How many hidden pages stay awake before the one hidden longest is put to sleep.
const AWAKE_HIDDEN: usize = 4;

/// How long a popup's page waits for the app to give it a tab.
const UNCLAIMED_FOR: Duration = Duration::from_secs(20);

/// The most of a page's title santree keeps.
const MAX_TITLE: usize = 300;

/// The cookie store every local Web tab shares — WebKit's named store for this
/// id, kept apart from the app's own webview's storage. Fixed for good: a new id
/// is a new, empty store, signing the user out of everything.
const LOCAL_PROFILE: [u8; 16] = [
    0x7c, 0x2e, 0x95, 0x1b, 0x4d, 0x63, 0x4a, 0x8f, 0xb0, 0x5e, 0x21, 0xd9, 0x3c, 0x77, 0x0a, 0xe4,
];

/// A page's zoom steps (⌘+ / ⌘−), Safari's ladder.
const ZOOM_STEPS: [f64; 13] = [
    0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];

thread_local! {
    static PAGES: RefCell<Pages> = RefCell::new(Pages::default());
}

#[derive(Default)]
struct Pages {
    /// The host view and the app's own webview it is laid over — made the first
    /// time a page is shown.
    host: Option<(Retained<Host>, Retained<WKWebView>)>,
    tabs: HashMap<String, Tab>,
    asleep: HashMap<String, Asleep>,
    /// A tab asked for the keyboard before its page existed (the first address
    /// typed into a blank tab races the page being made): it gets it once shown.
    focus_on_show: Option<String>,
}

struct Tab {
    slot: Retained<Slot>,
    page: Retained<PageView>,
    delegate: Retained<Delegate>,
    /// When the tab stopped showing; `None` while it shows.
    hidden_since: Option<Instant>,
    /// A tab has shown the page. A popup is made before the app has a tab for
    /// it, and one no tab ever claims is closed (`open_beside`).
    claimed: bool,
}

/// A page put to sleep: what it needs to wake where it was.
struct Asleep {
    url: Option<String>,
    /// WebKit's own record of the page's back/forward list. It doesn't bring
    /// back the scroll (measured): a woken page starts at its top.
    history: Option<Retained<AnyObject>>,
}

/// The pages, borrowed for one short step. Nothing that calls into WebKit runs
/// inside it: WebKit can call back synchronously, and the callback may need them.
fn pages<T>(f: impl FnOnce(&mut Pages) -> T) -> T {
    PAGES.with(|pages| f(&mut pages.borrow_mut()))
}

fn page(id: &str) -> Option<(Retained<Slot>, Retained<PageView>, Retained<Delegate>)> {
    pages(|p| {
        p.tabs
            .get(id)
            .map(|t| (t.slot.clone(), t.page.clone(), t.delegate.clone()))
    })
}

fn mtm() -> MainThreadMarker {
    MainThreadMarker::new().expect("the browser runs on the main thread")
}

pub fn supported() -> bool {
    objc2::available!(macos = 14.0)
}

pub fn show(app: &AppHandle, id: &str, url: Option<&Url>, rect: BrowserRect) -> Result<bool> {
    if !supported() {
        bail!("Web tabs need macOS 14 or later");
    }
    if page(id).is_none() {
        match (pages(|p| p.asleep.remove(id)), url) {
            (Some(asleep), _) => wake(app, id, asleep)?,
            (None, Some(url)) => {
                make(app, id, None, None)?;
                load(app, id, url)?;
            }
            (None, None) => return Ok(false),
        }
    }
    place(id, rect);
    let Some((slot, _, _)) = page(id) else {
        return Ok(false);
    };
    slot.setHidden(false);
    let asked_for_keyboard = pages(|p| {
        if let Some(tab) = p.tabs.get_mut(id) {
            tab.hidden_since = None;
            tab.claimed = true;
        }
        p.focus_on_show.take_if(|asked| asked == id).is_some()
    });
    if asked_for_keyboard {
        focus(id);
    }
    Ok(true)
}

/// Make a tab's page, hidden, in a slot of the host. `configuration` is WebKit's
/// when a page opened it (`open_beside`); otherwise a fresh one on the shared
/// cookie store. `frame` sizes it before it is ever shown — a page laid out at
/// zero size keeps a stale scroll height when it grows (cmux).
fn make(
    app: &AppHandle,
    id: &str,
    configuration: Option<&WKWebViewConfiguration>,
    frame: Option<NSRect>,
) -> Result<()> {
    let mtm = mtm();
    let (host, _) = host(app)?;
    let configuration = match configuration {
        Some(configuration) => configuration.retain(),
        None => fresh_configuration(mtm),
    };
    let frame = frame.unwrap_or_else(|| host.bounds());
    let slot = Slot::new(mtm);
    slot.setFrame(frame);
    slot.setHidden(true);
    let page = PageView::new(mtm, id, app, slot.bounds(), &configuration);
    page.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    unsafe {
        // Right-click → Inspect Element, as in Safari with its developer menu on.
        page.setInspectable(true);
        page.setAllowsBackForwardNavigationGestures(true);
    }
    slot.addSubview(&page);
    host.addSubview(&slot);
    let delegate = Delegate::new(mtm, app, id);
    delegate.attach(&page);
    pages(|p| {
        p.tabs.insert(
            id.to_string(),
            Tab {
                slot,
                page,
                delegate,
                hidden_since: Some(Instant::now()),
                claimed: false,
            },
        )
    });
    Ok(())
}

/// What every new page starts from: the shared cookie store, and a user agent
/// that names the Safari this Mac has — a bare WKWebView's has no `Version/…
/// Safari/…` token, and some sites (Google Workspace) turn it away.
fn fresh_configuration(mtm: MainThreadMarker) -> Retained<WKWebViewConfiguration> {
    let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
    unsafe {
        let store =
            WKWebsiteDataStore::dataStoreForIdentifier(&NSUUID::from_bytes(LOCAL_PROFILE), mtm);
        configuration.setWebsiteDataStore(&store);
        configuration.setApplicationNameForUserAgent(Some(&NSString::from_str(&safari_token())));
        // A popup becomes a tab here, so only a click may open one — macOS's
        // WebKit lets a script open windows on its own unless told otherwise.
        configuration
            .preferences()
            .setJavaScriptCanOpenWindowsAutomatically(false);
    }
    configuration
}

/// `Version/<x> Safari/605.1.15`, from the Safari installed here.
fn safari_token() -> String {
    let version = NSBundle::bundleWithPath(&NSString::from_str("/Applications/Safari.app"))
        .and_then(|safari| {
            safari.objectForInfoDictionaryKey(&NSString::from_str("CFBundleShortVersionString"))
        })
        .and_then(|v| v.downcast::<NSString>().ok())
        .map(|v| v.to_string())
        // Safari ships with every macOS this runs on; the fallback is only so a
        // moved Safari can't leave the token out.
        .unwrap_or_else(|| "26.0".to_string());
    format!("Version/{version} Safari/605.1.15")
}

/// The host view, laid over the app's webview the first time it is needed.
fn host(app: &AppHandle) -> Result<(Retained<Host>, Retained<WKWebView>)> {
    if let Some(host) = pages(|p| p.host.clone()) {
        return Ok(host);
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| anyhow!("the main window is gone"))?;
    let ns_window = window.ns_window()?.cast::<NSWindow>();
    // SAFETY: Tauri's main window is an NSWindow for the life of the app, and
    // this runs on the main thread it belongs to.
    let ns_window = unsafe { ns_window.as_ref() }.ok_or_else(|| anyhow!("no NSWindow"))?;
    let content = ns_window
        .contentView()
        .ok_or_else(|| anyhow!("the window has no content view"))?;
    // wry puts the app's webview straight into the content view.
    let app_view = content
        .subviews()
        .iter()
        .find_map(|view| view.downcast::<WKWebView>().ok())
        .ok_or_else(|| anyhow!("the app's webview isn't in the window"))?;
    let host = Host::new(mtm(), content.bounds());
    host.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content.addSubview_positioned_relativeTo(&host, NSWindowOrderingMode::Above, None);
    pages(|p| p.host = Some((host.clone(), app_view.clone())));
    Ok((host, app_view))
}

/// `rect` (CSS pixels of the app's webview) as a frame in the host: scaled by
/// the app's own zoom, offset to where the app's webview sits, snapped to pixels.
fn frame_in_host(host: &Host, app_view: &WKWebView, rect: BrowserRect) -> NSRect {
    let zoom = unsafe { app_view.pageZoom() };
    // The host is flipped, so the converted origin is the app webview's top-left.
    let origin = host
        .convertRect_fromView(app_view.bounds(), Some(app_view))
        .origin;
    let frame = NSRect::new(
        NSPoint::new(origin.x + rect.x * zoom, origin.y + rect.y * zoom),
        NSSize::new(rect.width * zoom, rect.height * zoom),
    );
    host.backingAlignedRect_options(frame, NSAlignmentOptions::AlignAllEdgesNearest)
}

pub fn place(id: &str, rect: BrowserRect) {
    let (Some((host, app_view)), Some((slot, _, _))) = (pages(|p| p.host.clone()), page(id)) else {
        return;
    };
    let frame = frame_in_host(&host, &app_view, rect);
    if slot.frame() == frame {
        return;
    }
    // In one transaction with animations off, so the page lands in a single
    // frame instead of easing over the app.
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    slot.setFrame(frame);
    slot.update_mask();
    CATransaction::commit();
}

pub fn hide(id: &str) {
    let Some((slot, page, _)) = page(id) else {
        return;
    };
    if page.has_keyboard() {
        release_focus();
    }
    slot.setHidden(true);
    // A tab shown again starts uncut; its placeholder measures anew (the
    // frontend forgets the holes it sent when the tab hides).
    slot.set_holes(Vec::new());
    pages(|p| {
        if let Some(tab) = p.tabs.get_mut(id) {
            tab.hidden_since = Some(Instant::now());
        }
    });
    put_extra_to_sleep();
}

/// Hide every page on screen. Each one's tab shows it again as it mounts.
pub fn hide_all() {
    let shown: Vec<String> = pages(|p| {
        p.focus_on_show = None;
        p.tabs
            .iter()
            .filter(|(_, tab)| tab.hidden_since.is_none())
            .map(|(id, _)| id.clone())
            .collect()
    });
    shown.iter().for_each(|id| hide(id));
}

/// Sleep the hidden pages past [`AWAKE_HIDDEN`], hidden longest first — never one
/// that is loading or downloading, which sleeping would cut off.
fn put_extra_to_sleep() {
    let mut hidden: Vec<(Instant, String)> = pages(|p| {
        p.tabs
            .iter()
            .filter_map(|(id, t)| t.hidden_since.map(|at| (at, id.clone())))
            .collect()
    });
    if hidden.len() <= AWAKE_HIDDEN {
        return;
    }
    hidden.sort();
    let excess = hidden.len() - AWAKE_HIDDEN;
    for (_, id) in hidden.into_iter().take(excess) {
        let Some((_, page, delegate)) = page(&id) else {
            continue;
        };
        if unsafe { page.isLoading() } || delegate.is_downloading() {
            continue;
        }
        let asleep = Asleep {
            url: unsafe { page.URL() }
                .and_then(|url| url.absoluteString())
                .map(|url| url.to_string()),
            history: unsafe { page.interactionState() },
        };
        close(&id);
        pages(|p| p.asleep.insert(id, asleep));
    }
}

/// Bring a sleeping page back on the page it was on: with its history if WebKit
/// kept one, else at its last address.
fn wake(app: &AppHandle, id: &str, asleep: Asleep) -> Result<()> {
    make(app, id, None, None)?;
    let (_, page, _) = page(id).ok_or_else(|| anyhow!("the page didn't open"))?;
    match (&asleep.history, &asleep.url) {
        (Some(history), _) => unsafe { page.setInteractionState(Some(history)) },
        (None, Some(url)) => load(app, id, &super::address::checked(url)?)?,
        (None, None) => {}
    }
    Ok(())
}

pub fn load(app: &AppHandle, id: &str, url: &Url) -> Result<()> {
    // A sleeping page wakes on the new address instead of where it was.
    let asleep = pages(|p| match p.asleep.get_mut(id) {
        Some(asleep) => {
            *asleep = Asleep {
                url: Some(url.to_string()),
                history: None,
            };
            true
        }
        None => false,
    });
    if asleep {
        return Ok(());
    }
    if page(id).is_none() {
        // A tab can be sent somewhere before its page is made — a link for the
        // site of a tab restored from the last session and not shown since — so
        // the page is made now, hidden, and shown when its tab is.
        make(app, id, None, None)?;
        close_unless_claimed(app, id);
    }
    let (_, page, _) = page(id).ok_or_else(|| anyhow!("that tab has no page"))?;
    navigate(&page, url)
}

/// Point `page` at `url`, as the user's own navigation.
fn navigate(page: &PageView, url: &Url) -> Result<()> {
    let url = NSURL::URLWithString(&NSString::from_str(url.as_str()))
        .ok_or_else(|| anyhow!("WebKit can't read that address"))?;
    page.note_input();
    unsafe { page.loadRequest(&NSURLRequest::requestWithURL(&url)) };
    Ok(())
}

pub fn nav(id: &str, nav: BrowserNav) {
    let Some((_, page, delegate)) = page(id) else {
        return;
    };
    page.note_input();
    // A failed address stands in front of the page before it, the way a
    // browser's error page does, but WebKit never committed it: Back is that
    // page, Reload tries the address again, and nothing lies forward of it.
    if let Some(failure) = delegate.failure() {
        match nav {
            BrowserNav::Back if unsafe { page.URL() }.is_some() => {
                return delegate.clear_failure(&page);
            }
            BrowserNav::Reload => {
                if let Ok(url) = super::address::checked(&failure.url) {
                    let _ = navigate(&page, &url);
                }
                return;
            }
            BrowserNav::Forward => return,
            BrowserNav::Back | BrowserNav::Stop => {}
        }
    }
    unsafe {
        match nav {
            BrowserNav::Back => drop(page.goBack()),
            BrowserNav::Forward => drop(page.goForward()),
            BrowserNav::Reload => drop(page.reload()),
            BrowserNav::Stop => page.stopLoading(),
        }
    }
}

/// A ⌘-chord the page's browser answers (`keys::BrowserCommand`).
fn run(page: &PageView, command: BrowserCommand) {
    let zoom = unsafe { page.pageZoom() };
    let step = |up: bool| {
        let at = ZOOM_STEPS
            .iter()
            .position(|s| (s - zoom).abs() < 0.01)
            .unwrap_or(5);
        let next = if up { at + 1 } else { at.saturating_sub(1) };
        ZOOM_STEPS[next.min(ZOOM_STEPS.len() - 1)]
    };
    match command {
        BrowserCommand::Reload => nav(page.id(), BrowserNav::Reload),
        BrowserCommand::Back => nav(page.id(), BrowserNav::Back),
        BrowserCommand::Forward => nav(page.id(), BrowserNav::Forward),
        BrowserCommand::ZoomIn => unsafe { page.setPageZoom(step(true)) },
        BrowserCommand::ZoomOut => unsafe { page.setPageZoom(step(false)) },
        BrowserCommand::ZoomReset => unsafe { page.setPageZoom(1.0) },
    }
}

/// Give a page the keyboard — once it is on screen: AppKit would let a hidden
/// one take it, and typing would go somewhere no one can see.
pub fn focus(id: &str) {
    match page(id) {
        Some((slot, page, _)) if !slot.isHidden() => page.request_focus(),
        _ => pages(|p| p.focus_on_show = Some(id.to_string())),
    }
}

/// Give the keyboard back to the app's webview, if a page holds it.
pub fn release_focus() {
    let Some((_, app_view)) = pages(|p| p.host.clone()) else {
        return;
    };
    let Some(window) = app_view.window() else {
        return;
    };
    let held = pages(|p| p.tabs.values().map(|t| t.page.clone()).collect::<Vec<_>>())
        .iter()
        .any(|page| page.has_keyboard());
    if held {
        window.makeFirstResponder(Some(&app_view));
    }
}

pub fn set_holes(id: &str, holes: &[BrowserHole]) {
    let (Some((_, app_view)), Some((slot, _, _))) = (pages(|p| p.host.clone()), page(id)) else {
        return;
    };
    let zoom = unsafe { app_view.pageZoom() };
    let height = slot.bounds().size.height;
    // The slot isn't flipped: a hole measured from the page's top sits that far
    // below the top of a bottom-up frame.
    let holes = super::disjoint(holes)
        .into_iter()
        .map(|hole| {
            let r = hole.rect;
            let frame = NSRect::new(
                NSPoint::new(r.x * zoom, height - (r.y + r.height) * zoom),
                NSSize::new(r.width * zoom, r.height * zoom),
            );
            (frame, hole.radius * zoom)
        })
        .collect();
    slot.set_holes(holes);
}

/// A JPEG of the page, sent on `reply` once WebKit has drawn it.
pub fn snapshot(id: &str, reply: oneshot::Sender<Option<String>>) {
    let Some((_, page, _)) = page(id) else {
        let _ = reply.send(None);
        return;
    };
    let reply = Cell::new(Some(reply));
    let done = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        // SAFETY: WebKit hands either nil or an image it keeps alive for the call.
        let still = unsafe { image.as_ref() }.and_then(jpeg_data_url);
        if let Some(reply) = reply.take() {
            let _ = reply.send(still);
        }
    });
    unsafe {
        let configuration = WKSnapshotConfiguration::new(mtm());
        page.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &done);
    }
}

fn jpeg_data_url(image: &NSImage) -> Option<String> {
    let cg = unsafe { image.CGImageForProposedRect_context_hints(null_mut(), None, None) }?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
    let quality = NSNumber::new_f64(0.8);
    let quality: &AnyObject = &quality;
    let properties = NSDictionary::from_slices(&[unsafe { NSImageCompressionFactor }], &[quality]);
    let jpeg = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties)
    }?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg.to_vec());
    Some(format!("data:image/jpeg;base64,{encoded}"))
}

pub fn state(id: &str) -> Option<BrowserState> {
    let (_, page, delegate) = page(id)?;
    Some(state_of(id, &page, &delegate))
}

fn state_of(id: &str, web_view: &WKWebView, delegate: &Delegate) -> BrowserState {
    let failure = delegate.failure();
    unsafe {
        BrowserState {
            id: id.to_string(),
            url: web_view
                .URL()
                .and_then(|url| url.absoluteString())
                .map(|url| url.to_string())
                .unwrap_or_default(),
            // A page names itself; a tab and a row need no more than this of it.
            title: web_view
                .title()
                .map(|t| t.to_string().chars().take(MAX_TITLE).collect())
                .unwrap_or_default(),
            loading: web_view.isLoading(),
            progress: web_view.estimatedProgress(),
            // Back from a failed address is the page behind it (`nav`).
            can_go_back: web_view.canGoBack() || failure.is_some() && web_view.URL().is_some(),
            can_go_forward: failure.is_none() && web_view.canGoForward(),
            failure,
            crashed: delegate.crashed(),
        }
    }
}

/// Close a tab's page for good (or for sleep, which then records it again).
pub fn close(id: &str) {
    let Some(tab) = pages(|p| {
        p.asleep.remove(id);
        p.tabs.remove(id)
    }) else {
        return;
    };
    if tab.page.has_keyboard() {
        release_focus();
    }
    tab.delegate.detach(&tab.page);
    unsafe { tab.page.stopLoading() };
    tab.slot.removeFromSuperview();
}

/// Put `cookies` (read from another browser, [`super::import`]) into the shared
/// store every local Web tab uses, so a page there opens signed in. Returns how
/// many WebKit took — a cookie whose fields it won't accept is dropped, never
/// forced. The store is the one [`fresh_configuration`] gives every page, reached
/// here even when no page is open yet.
pub fn import_cookies(cookies: Vec<super::import::Cookie>) -> usize {
    let store = unsafe {
        WKWebsiteDataStore::dataStoreForIdentifier(&NSUUID::from_bytes(LOCAL_PROFILE), mtm())
            .httpCookieStore()
    };
    let mut taken = 0;
    for cookie in cookies {
        let Some(cookie) = make_cookie(&cookie) else {
            continue;
        };
        unsafe { store.setCookie_completionHandler(&cookie, None) };
        taken += 1;
    }
    taken
}

/// One imported cookie as an `NSHTTPCookie`, or `None` if WebKit can't make one
/// from its fields (an empty name or domain). A session cookie (no expiry) is
/// written without `NSHTTPCookieExpires`.
fn make_cookie(cookie: &super::import::Cookie) -> Option<Retained<objc2_foundation::NSHTTPCookie>> {
    use objc2_foundation::{
        NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieExpires, NSHTTPCookieName, NSHTTPCookiePath,
        NSHTTPCookieSameSiteLax, NSHTTPCookieSameSitePolicy, NSHTTPCookieSameSiteStrict,
        NSHTTPCookieSecure, NSHTTPCookieValue,
    };

    let mut keys: Vec<&NSString> = vec![
        unsafe { NSHTTPCookieName },
        unsafe { NSHTTPCookieValue },
        unsafe { NSHTTPCookieDomain },
        unsafe { NSHTTPCookiePath },
    ];
    let name = NSString::from_str(&cookie.name);
    let value = NSString::from_str(&cookie.value);
    let domain = NSString::from_str(&cookie.domain);
    let path = NSString::from_str(&cookie.path);
    let mut values: Vec<&AnyObject> = vec![&name, &value, &domain, &path];

    let expires;
    if let Some(at) = cookie.expires {
        expires = objc2_foundation::NSDate::dateWithTimeIntervalSince1970(at);
        keys.push(unsafe { NSHTTPCookieExpires });
        values.push(&expires);
    }
    // The cookie is secure or http-only only when it says so: NSHTTPCookie reads
    // the key's mere presence as true, whatever string it holds. "HttpOnly" has
    // no exported constant; its literal name is what NSHTTPCookie reads (measured).
    let yes = NSString::from_str("TRUE");
    let http_only = NSString::from_str("HttpOnly");
    if cookie.secure {
        keys.push(unsafe { NSHTTPCookieSecure });
        values.push(&yes);
    }
    if cookie.http_only {
        keys.push(&http_only);
        values.push(&yes);
    }
    if let Some(same_site) = cookie.same_site {
        keys.push(unsafe { NSHTTPCookieSameSitePolicy });
        values.push(match same_site {
            super::import::SameSite::Lax => unsafe { NSHTTPCookieSameSiteLax },
            super::import::SameSite::Strict => unsafe { NSHTTPCookieSameSiteStrict },
        });
    }
    let properties = NSDictionary::from_slices(&keys, &values);
    unsafe { NSHTTPCookie::cookieWithProperties(&properties) }
}

/// A page opened by another (`window.open`, `target=_blank`), made from WebKit's
/// `configuration` so it keeps its opener, and handed to the app as a new tab
/// beside the one that opened it.
fn open_beside(
    app: &AppHandle,
    opener: &str,
    url: &str,
    configuration: &WKWebViewConfiguration,
) -> Option<Retained<WKWebView>> {
    let id = uuid::Uuid::new_v4().to_string();
    let frame = pages(|p| p.tabs.get(opener).map(|t| t.slot.frame()));
    if let Err(e) = make(app, &id, Some(configuration), frame) {
        log::warn!("opening a page from web tab {opener} failed: {e:#}");
        return None;
    }
    emit(
        app,
        BrowserOpened {
            opener: opener.to_string(),
            id: id.clone(),
            url: url.to_string(),
            existing: true,
            background: false,
        },
    );
    close_unless_claimed(app, &id);
    page(&id).map(|(_, page, _)| Retained::into_super(page))
}

/// Close a page made ahead of its tab (a popup, an address sent to a tab not
/// shown yet) if no tab has shown it within [`UNCLAIMED_FOR`]: one whose tab
/// never comes — its strip is gone, its row was refused — would otherwise run
/// hidden with nothing to close it.
fn close_unless_claimed(app: &AppHandle, id: &str) {
    let (app, id) = (app.clone(), id.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(UNCLAIMED_FOR).await;
        let _ = app.run_on_main_thread(move || {
            if pages(|p| p.tabs.get(&id).is_some_and(|t| !t.claimed)) {
                close(&id);
            }
        });
    });
}
