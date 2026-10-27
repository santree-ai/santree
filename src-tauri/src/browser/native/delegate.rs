//! A page's delegate: what santree does when WebKit asks (may this navigate,
//! where does this download go, show this `alert`) and what it tells the app
//! (the page's state changed, a page opened another, a page closed itself).
//!
//! One per page, retained beside it (`native::Tab`): WebKit holds its delegates
//! weakly. It also observes the page's KVO properties, so the tab's title and
//! toolbar follow every change without polling.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly, Message};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSImage, NSModalResponse,
    NSModalResponseOK, NSOpenPanel, NSTextField, NSWorkspace,
};
use objc2_foundation::{
    ns_string, NSArray, NSData, NSDictionary, NSError, NSKeyValueChangeKey,
    NSKeyValueObservingOptions, NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSPoint,
    NSRect, NSSize, NSString, NSURLErrorCancelled, NSURLErrorCannotConnectToHost,
    NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed, NSURLErrorDataNotAllowed,
    NSURLErrorFailingURLErrorKey, NSURLErrorInternationalRoamingOff,
    NSURLErrorNotConnectedToInternet, NSURLErrorTimedOut, NSURLResponse, NSURL,
};
use objc2_web_kit::{
    WKDownload, WKDownloadDelegate, WKFrameInfo, WKMediaCaptureType, WKNavigation,
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationResponse,
    WKNavigationResponsePolicy, WKNavigationType, WKOpenPanelParameters, WKPermissionDecision,
    WKSecurityOrigin, WKUIDelegate, WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};
use tauri::{AppHandle, Manager};

use super::super::{
    emit, BrowserClosed, BrowserDownload, BrowserFailure, BrowserFailureReason, BrowserOpened,
};
use super::classes::PageView;

/// How recent the user's input must be for a link to open another app.
const LINK_INPUT: Duration = Duration::from_secs(2);

/// How recent it must be for a download — a server can take a while to answer.
const DOWNLOAD_INPUT: Duration = Duration::from_secs(60);

/// The page properties a tab draws; each change is pushed to the app.
const OBSERVED: [&str; 6] = [
    "URL",
    "title",
    "loading",
    "estimatedProgress",
    "canGoBack",
    "canGoForward",
];

pub struct DelegateIvars {
    id: String,
    app: AppHandle,
    /// The address the page last failed to open, until another page commits or
    /// the user goes back to the one behind it.
    failure: RefCell<Option<BrowserFailure>>,
    /// The page's web content process died.
    crashed: Cell<bool>,
    /// Downloads in flight: where each is being written, by its `WKDownload`.
    downloads: RefCell<Vec<(Retained<WKDownload>, PathBuf)>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    pub struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl WKNavigationDelegate for Delegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_action(
            &self,
            web_view: &WKWebView,
            action: &WKNavigationAction,
            decide: &DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            decide.call((self.action_policy(web_view, action),));
        }

        /// What WebKit can't show (a zip, a dmg) is downloaded instead — when
        /// the user asked for it (`download_allowed`).
        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        fn decide_response(
            &self,
            web_view: &WKWebView,
            response: &WKNavigationResponse,
            decide: &DynBlock<dyn Fn(WKNavigationResponsePolicy)>,
        ) {
            let download = unsafe { response.isForMainFrame() && !response.canShowMIMEType() };
            let url = unsafe { response.response().URL() };
            decide.call((match download {
                false => WKNavigationResponsePolicy::Allow,
                true if self.download_allowed(web_view, url.as_deref()) => {
                    WKNavigationResponsePolicy::Download
                }
                true => WKNavigationResponsePolicy::Cancel,
            },));
        }

        /// A failure stays up while the next load runs, as a browser keeps the
        /// last page until the next one commits — trying again doesn't flash the
        /// page behind it.
        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            self.changed(web_view);
        }

        #[unsafe(method(webView:didCommitNavigation:))]
        fn did_commit(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            self.ivars().crashed.set(false);
            self.ivars().failure.replace(None);
            self.changed(web_view);
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            self.changed(web_view);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(
            &self,
            web_view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            self.failed(web_view, error);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            self.failed(web_view, error);
        }

        /// The page's process died. Replacing the view from inside this callback
        /// crashes WebKit (cmux paid for that), so the tab shows a Reload instead.
        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn did_terminate(&self, web_view: &WKWebView) {
            self.ivars().crashed.set(true);
            self.changed(web_view);
        }

        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        fn action_became_download(
            &self,
            _web_view: &WKWebView,
            _action: &WKNavigationAction,
            download: &WKDownload,
        ) {
            unsafe { download.setDelegate(Some(ProtocolObject::from_ref(self))) };
        }

        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_became_download(
            &self,
            _web_view: &WKWebView,
            _response: &WKNavigationResponse,
            download: &WKDownload,
        ) {
            unsafe { download.setDelegate(Some(ProtocolObject::from_ref(self))) };
        }
    }

    unsafe impl WKUIDelegate for Delegate {
        /// `window.open` and `target=_blank` open a tab beside this one. The page
        /// must be made from WebKit's `configuration` — that is what keeps
        /// `window.opener`, which an OAuth popup reports back through.
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_web_view(
            &self,
            _web_view: &WKWebView,
            configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            self.open_from(action, configuration)
        }

        #[unsafe(method(webViewDidClose:))]
        fn did_close(&self, _web_view: &WKWebView) {
            emit(&self.ivars().app, BrowserClosed { id: self.ivars().id.clone() });
        }

        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn alert(
            &self,
            web_view: &WKWebView,
            message: &NSString,
            frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn()>,
        ) {
            if !shown(web_view) {
                return done.call(());
            }
            let done = done.copy();
            let alert = page_alert(web_view, frame, message);
            alert.addButtonWithTitle(ns_string!("OK"));
            sheet(web_view, &alert, move |_| done.call(()));
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn confirm(
            &self,
            web_view: &WKWebView,
            message: &NSString,
            frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn(objc2::runtime::Bool)>,
        ) {
            if !shown(web_view) {
                return done.call((objc2::runtime::Bool::NO,));
            }
            let done = done.copy();
            let alert = page_alert(web_view, frame, message);
            alert.addButtonWithTitle(ns_string!("OK"));
            alert.addButtonWithTitle(ns_string!("Cancel"));
            sheet(web_view, &alert, move |response| {
                done.call((objc2::runtime::Bool::new(response == NSAlertFirstButtonReturn),));
            });
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn prompt(
            &self,
            web_view: &WKWebView,
            prompt: &NSString,
            default_text: Option<&NSString>,
            frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn(*mut NSString)>,
        ) {
            if !shown(web_view) {
                return done.call((null_mut(),));
            }
            let done = done.copy();
            let mtm = self.mtm();
            let alert = page_alert(web_view, frame, prompt);
            alert.addButtonWithTitle(ns_string!("OK"));
            alert.addButtonWithTitle(ns_string!("Cancel"));
            let field = NSTextField::textFieldWithString(default_text.unwrap_or(ns_string!("")), mtm);
            field.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(280.0, 24.0)));
            alert.setAccessoryView(Some(&field));
            sheet(web_view, &alert, move |response| {
                if response == NSAlertFirstButtonReturn {
                    let text = field.stringValue();
                    done.call((Retained::as_ptr(&text).cast_mut(),));
                } else {
                    done.call((null_mut(),));
                }
            });
        }

        /// `<input type=file>`.
        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn open_panel(
            &self,
            web_view: &WKWebView,
            parameters: &WKOpenPanelParameters,
            _frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
        ) {
            let done = done.copy();
            let Some(window) = web_view.window() else {
                done.call((null_mut(),));
                return;
            };
            let panel = NSOpenPanel::openPanel(self.mtm());
            panel.setCanChooseFiles(true);
            unsafe {
                panel.setAllowsMultipleSelection(parameters.allowsMultipleSelection());
                panel.setCanChooseDirectories(parameters.allowsDirectories());
            }
            let chosen = panel.clone();
            let handler = RcBlock::new(move |response: NSModalResponse| {
                if response == NSModalResponseOK {
                    let urls = chosen.URLs();
                    done.call((Retained::as_ptr(&urls).cast_mut(),));
                } else {
                    done.call((null_mut(),));
                }
            });
            panel.beginSheetModalForWindow_completionHandler(&window, &handler);
        }

        /// No camera or microphone: santree asks macOS for neither.
        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn media_capture(
            &self,
            _web_view: &WKWebView,
            _origin: &WKSecurityOrigin,
            _frame: &WKFrameInfo,
            _kind: WKMediaCaptureType,
            decide: &DynBlock<dyn Fn(WKPermissionDecision)>,
        ) {
            decide.call((WKPermissionDecision::Deny,));
        }
    }

    unsafe impl WKDownloadDelegate for Delegate {
        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        fn download_destination(
            &self,
            download: &WKDownload,
            _response: &NSURLResponse,
            suggested: &NSString,
            done: &DynBlock<dyn Fn(*mut NSURL)>,
        ) {
            let Ok(dir) = self.ivars().app.path().download_dir() else {
                done.call((null_mut(),));
                return;
            };
            let path = free_path(&dir, &suggested.to_string());
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            self.ivars()
                .downloads
                .borrow_mut()
                .push((download.retain(), path));
            done.call((Retained::as_ptr(&url).cast_mut(),));
        }

        #[unsafe(method(downloadDidFinish:))]
        fn download_finished(&self, download: &WKDownload) {
            let Some(path) = self.take_download(download) else { return };
            quarantine(&path, download);
            self.download_ended(&path, None);
        }

        #[unsafe(method(download:didFailWithError:resumeData:))]
        fn download_failed(&self, download: &WKDownload, error: &NSError, _resume: Option<&NSData>) {
            let Some(path) = self.take_download(download) else { return };
            self.download_ended(&path, Some(error.localizedDescription().to_string()));
        }
    }

    impl Delegate {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe_value(
            &self,
            _key_path: Option<&NSString>,
            object: Option<&AnyObject>,
            _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>,
            _context: *mut c_void,
        ) {
            if let Some(web_view) = object.and_then(|o| o.downcast_ref::<WKWebView>()) {
                self.changed(web_view);
            }
        }
    }
);

impl Delegate {
    pub fn new(mtm: MainThreadMarker, app: &AppHandle, id: &str) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DelegateIvars {
            id: id.to_string(),
            app: app.clone(),
            failure: RefCell::new(None),
            crashed: Cell::new(false),
            downloads: RefCell::new(Vec::new()),
        });
        unsafe { msg_send![super(this), init] }
    }

    /// Become `web_view`'s delegate and start following its state.
    pub fn attach(&self, web_view: &WKWebView) {
        unsafe {
            web_view.setNavigationDelegate(Some(ProtocolObject::from_ref(self)));
            web_view.setUIDelegate(Some(ProtocolObject::from_ref(self)));
            for key in OBSERVED {
                web_view.addObserver_forKeyPath_options_context(
                    self,
                    &NSString::from_str(key),
                    NSKeyValueObservingOptions::New,
                    null_mut(),
                );
            }
        }
    }

    /// The reverse of [`attach`](Self::attach), before the page is let go: KVO
    /// left registered on a released observer is a crash on the next change.
    pub fn detach(&self, web_view: &WKWebView) {
        unsafe {
            for key in OBSERVED {
                web_view.removeObserver_forKeyPath(self, &NSString::from_str(key));
            }
            web_view.setNavigationDelegate(None);
            web_view.setUIDelegate(None);
        }
    }

    fn open_from(
        &self,
        action: &WKNavigationAction,
        configuration: &WKWebViewConfiguration,
    ) -> Option<Retained<WKWebView>> {
        let url = page_url(action)?;
        super::open_beside(&self.ivars().app, &self.ivars().id, &url, configuration)
    }

    pub fn failure(&self) -> Option<BrowserFailure> {
        self.ivars().failure.borrow().clone()
    }

    /// Take a failed address down, showing the page behind it again.
    pub fn clear_failure(&self, web_view: &WKWebView) {
        self.ivars().failure.replace(None);
        self.changed(web_view);
    }

    pub fn crashed(&self) -> bool {
        self.ivars().crashed.get()
    }

    pub fn is_downloading(&self) -> bool {
        !self.ivars().downloads.borrow().is_empty()
    }

    /// A download is the user's to start: a page that begins one on its own —
    /// a hidden tab on a timer — would fill ~/Downloads unasked. Refused, it is
    /// said so, with the file it would have been.
    fn download_allowed(&self, web_view: &WKWebView, url: Option<&NSURL>) -> bool {
        if acted(web_view, DOWNLOAD_INPUT) {
            return true;
        }
        let file = url
            .and_then(|url| url.lastPathComponent())
            .map(|name| name.to_string())
            .filter(|name| !name.is_empty() && name != "/")
            .unwrap_or_else(|| "a file".to_string());
        emit(
            &self.ivars().app,
            BrowserDownload {
                id: self.ivars().id.clone(),
                file,
                path: None,
                error: Some(
                    "The page started this download on its own, so santree didn't save it.".into(),
                ),
            },
        );
        false
    }

    /// Push the page's state to the app, and remember the page once it settles.
    fn changed(&self, web_view: &WKWebView) {
        let state = super::state_of(&self.ivars().id, web_view, self);
        if !state.loading && !state.crashed && state.failure.is_none() {
            super::super::remember(&self.ivars().app, &state.id, &state.url, &state.title);
        }
        emit(&self.ivars().app, super::super::BrowserChanged(state));
    }

    fn failed(&self, web_view: &WKWebView, error: &NSError) {
        let page = unsafe { web_view.URL() }
            .and_then(|url| url.absoluteString())
            .map(|url| url.to_string())
            .unwrap_or_default();
        if let Some(failure) = failure(error, &page) {
            self.ivars().failure.replace(Some(failure));
        }
        self.changed(web_view);
    }

    /// What a navigation in this page may do. Pages are http and https; a link to
    /// another app (`mailto:`, `zoommtg:`) opens that app, after asking, and only
    /// when the user clicked it. A ⌘- or middle-click opens a tab behind this one.
    fn action_policy(
        &self,
        web_view: &WKWebView,
        action: &WKNavigationAction,
    ) -> WKNavigationActionPolicy {
        unsafe {
            if action.shouldPerformDownload() {
                let url = action.request().URL();
                return match self.download_allowed(web_view, url.as_deref()) {
                    true => WKNavigationActionPolicy::Download,
                    false => WKNavigationActionPolicy::Cancel,
                };
            }
            let main_frame = action
                .targetFrame()
                .is_some_and(|frame| frame.isMainFrame());
            let clicked = action.navigationType() == WKNavigationType::LinkActivated;
            let Some(url) = action.request().URL() else {
                return WKNavigationActionPolicy::Allow;
            };
            let address = url
                .absoluteString()
                .map(|s| s.to_string())
                .unwrap_or_default();
            if !main_frame {
                return WKNavigationActionPolicy::Allow;
            }
            let web = super::super::address::checked(&address).is_ok();
            let in_background = action
                .modifierFlags()
                .contains(objc2_app_kit::NSEventModifierFlags::Command)
                // WebKit numbers buttons as bits — a middle click is 4 —
                // where AppKit counts them (2); either way it isn't the left.
                || matches!(action.buttonNumber(), 2 | 4);
            if clicked && web && in_background {
                emit(
                    &self.ivars().app,
                    BrowserOpened {
                        opener: self.ivars().id.clone(),
                        id: uuid::Uuid::new_v4().to_string(),
                        url: address,
                        existing: false,
                        background: true,
                    },
                );
                return WKNavigationActionPolicy::Cancel;
            }
            let scheme = url.scheme().map(|s| s.to_string()).unwrap_or_default();
            // `blob:` is how a page shows a file it made (a generated PDF). A
            // top-level `data:` page is how phishing dresses up as any site, and
            // a `data:` download is a download, decided above.
            if web || matches!(scheme.as_str(), "about" | "blob") {
                return WKNavigationActionPolicy::Allow;
            }
            // A page never reaches this Mac's files, not even by a click: a
            // `file:` link would open whatever it names, apps included.
            // "Clicked" is WebKit's word, and a script's `a.click()` earns it:
            // the user must really have acted on this page just now.
            if clicked && scheme != "file" && acted(web_view, LINK_INPUT) {
                open_elsewhere(web_view, &url, &scheme);
            }
            WKNavigationActionPolicy::Cancel
        }
    }

    fn take_download(&self, download: &WKDownload) -> Option<PathBuf> {
        let mut downloads = self.ivars().downloads.borrow_mut();
        let at = downloads
            .iter()
            .position(|(d, _)| std::ptr::eq(&**d, download))?;
        Some(downloads.remove(at).1)
    }

    fn download_ended(&self, path: &Path, error: Option<String>) {
        emit(
            &self.ivars().app,
            BrowserDownload {
                id: self.ivars().id.clone(),
                file: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: error.is_none().then(|| path.to_string_lossy().into_owned()),
                error,
            },
        );
    }
}

/// What a failed navigation's `error` means for its tab: `None` for a navigation
/// replaced by another or turned into a download, which nobody needs to see.
/// `page` is the page's own URL, for an error that names no address.
fn failure(error: &NSError, page: &str) -> Option<BrowserFailure> {
    let url_error = error.domain().to_string() == "NSURLErrorDomain";
    let code = error.code();
    // 102 is WebKit's "frame load interrupted": the response became a download.
    if url_error && code == NSURLErrorCancelled
        || error.domain().to_string() == "WebKitErrorDomain" && code == 102
    {
        return None;
    }
    // WebKit already names the page before this one as the page's URL again;
    // the address that failed is the error's.
    let url = error
        .userInfo()
        .objectForKey(unsafe { NSURLErrorFailingURLErrorKey })
        .and_then(|url| url.downcast::<NSURL>().ok())
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_else(|| page.to_string());
    let is = |codes: &[isize]| url_error && codes.contains(&code);
    let reason = if is(&[NSURLErrorCannotConnectToHost]) {
        BrowserFailureReason::NotRunning
    } else if is(&[NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed]) {
        BrowserFailureReason::NoSuchHost
    } else if is(&[
        NSURLErrorNotConnectedToInternet,
        NSURLErrorInternationalRoamingOff,
        NSURLErrorDataNotAllowed,
    ]) {
        BrowserFailureReason::Offline
    } else if is(&[NSURLErrorTimedOut]) {
        BrowserFailureReason::TimedOut
    } else {
        BrowserFailureReason::Other
    };
    Some(BrowserFailure {
        url,
        reason,
        message: error.localizedDescription().to_string(),
    })
}

/// The page address a popup asks for, if it is one santree loads. A popup with
/// no address yet is `about:blank`: OAuth libraries open an empty one first and
/// point it at the provider after, so the popup isn't blocked as unprompted.
fn page_url(action: &WKNavigationAction) -> Option<String> {
    let address = unsafe { action.request().URL() }
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| "about:blank".to_string());
    super::super::address::checked(&address).ok()?;
    Some(address)
}

/// An alert a page asked for, headed with who is asking: the site's host, the
/// way Safari names it, so a page can't pass its text off as santree's own.
fn page_alert(web_view: &WKWebView, frame: &WKFrameInfo, message: &NSString) -> Retained<NSAlert> {
    // A sandboxed frame has no host of its own; the page it sits in does.
    let host = Some(unsafe { frame.securityOrigin().host() }.to_string())
        .filter(|host| !host.is_empty())
        .or_else(|| {
            unsafe { web_view.URL() }
                .and_then(|url| url.host())
                .map(|h| h.to_string())
        })
        .unwrap_or_else(|| "This page".to_string());
    let alert = NSAlert::new(MainThreadMarker::from(web_view));
    alert.setMessageText(&NSString::from_str(&format!("{host} says")));
    alert.setInformativeText(message);
    // A globe, not santree's icon: the words are the site's, not the app's.
    if let Some(globe) =
        NSImage::imageWithSystemSymbolName_accessibilityDescription(ns_string!("globe"), None)
    {
        unsafe { alert.setIcon(Some(&globe)) };
    }
    alert
}

/// Whether the page is on screen. A hidden tab's page can't put a dialog over
/// whatever the user is doing; it gets the answer a dismissed one gives.
fn shown(web_view: &WKWebView) -> bool {
    !web_view.isHiddenOrHasHiddenAncestor()
}

/// Whether the user really acted on this page (a key, a button, a navigation
/// from santree) within `window`.
fn acted(web_view: &WKWebView, window: Duration) -> bool {
    let web_view: &AnyObject = web_view;
    web_view
        .downcast_ref::<PageView>()
        .is_some_and(|page| page.had_input_within(window))
}

/// Show `alert` as a sheet on the page's window, then `then` with the answer.
fn sheet(web_view: &WKWebView, alert: &NSAlert, then: impl Fn(NSModalResponse) + 'static) {
    let handler = RcBlock::new(then);
    match web_view.window() {
        Some(window) => alert.beginSheetModalForWindow_completionHandler(&window, Some(&handler)),
        // Not in a window (a page whose tab was just closed): the page gets
        // the answer a dismissed dialog gives.
        None => handler.call((NSAlertSecondButtonReturn,)),
    }
}

/// Offer to open a link to another app (`mailto:`, `slack:`) with that app.
fn open_elsewhere(web_view: &WKWebView, url: &NSURL, scheme: &str) {
    let alert = NSAlert::new(MainThreadMarker::from(web_view));
    let link: String = url
        .absoluteString()
        .map(|link| link.to_string())
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect();
    alert.setMessageText(&NSString::from_str(&format!("Open this {scheme}: link?")));
    alert.setInformativeText(&NSString::from_str(&format!(
        "The page wants to open another app on this Mac with:\n{link}"
    )));
    // Cancel first, so Return — say, mid-sentence in a terminal — opens nothing.
    alert.addButtonWithTitle(ns_string!("Cancel"));
    alert.addButtonWithTitle(ns_string!("Open"));
    let url = url.retain();
    sheet(web_view, &alert, move |response| {
        if response == NSAlertSecondButtonReturn {
            NSWorkspace::sharedWorkspace().openURL(&url);
        }
    });
}

/// Where a download lands: the name the server suggested, reduced to a plain
/// file name (it is the server's to choose, so `../` and `/` are not), made free
/// the way Safari does — `name (1).ext`.
fn free_path(dir: &Path, suggested: &str) -> PathBuf {
    let name = Path::new(&suggested.replace([':', '/'], "-"))
        .file_name()
        .map(|n| n.to_string_lossy().trim_start_matches('.').to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "download".to_string());
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (name.clone(), String::new()),
    };
    let mut path = dir.join(&name);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    path
}

/// Mark a downloaded file as coming from the web, as Safari does, so Gatekeeper
/// checks it before it can run.
fn quarantine(path: &Path, download: &WKDownload) {
    let file = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let origin = unsafe { download.originalRequest() }
        .and_then(|request| request.URL())
        .and_then(|url| url.absoluteString())
        .unwrap_or_else(|| NSString::from_str(""));
    let keys = [
        ns_string!("LSQuarantineAgentName"),
        ns_string!("LSQuarantineType"),
        ns_string!("LSQuarantineDataURL"),
    ];
    let values: [&AnyObject; 3] = [
        ns_string!("santree"),
        ns_string!("LSQuarantineTypeWebDownload"),
        &origin,
    ];
    let properties = NSDictionary::from_slices(&keys, &values);
    if let Err(e) = unsafe {
        file.setResourceValue_forKey_error(
            Some(&properties),
            objc2_foundation::NSURLQuarantinePropertiesKey,
        )
    } {
        log::warn!(
            "couldn't quarantine download {}: {}",
            path.display(),
            e.localizedDescription()
        );
    }
}

#[cfg(test)]
mod tests {
    use objc2_foundation::NSURLErrorDomain;

    use super::*;

    fn url_error(code: isize, url: &str) -> Retained<NSError> {
        let url = NSURL::URLWithString(&NSString::from_str(url)).unwrap();
        let url: &AnyObject = &url;
        let info = NSDictionary::from_slices(&[unsafe { NSURLErrorFailingURLErrorKey }], &[url]);
        // SAFETY: the user info is keyed by strings, as NSError's is.
        unsafe { NSError::errorWithDomain_code_userInfo(NSURLErrorDomain, code, Some(&info)) }
    }

    /// The bug: typing `localhost:3000` with nothing running there reported the
    /// failure as the page before it (a Google search), and Try again reloaded
    /// that — WebKit names the previous page as the URL again before it says.
    #[test]
    fn a_failed_load_names_the_address_that_failed_not_the_page_before_it() {
        let before = "https://www.google.com/search?q=rust";
        let error = url_error(NSURLErrorCannotConnectToHost, "http://localhost:3000/");
        let failed = failure(&error, before).unwrap();
        assert_eq!(failed.url, "http://localhost:3000/");
        assert_eq!(failed.reason, BrowserFailureReason::NotRunning);
        // A load replaced by the next one isn't a failure to show.
        let replaced = url_error(NSURLErrorCancelled, "http://localhost:3000/");
        assert_eq!(failure(&replaced, before), None);
    }
}
