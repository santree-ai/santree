//! The three AppKit classes a Web tab is built from:
//!
//! - [`Host`]: one view laid over the app's webview, the size of the window's
//!   content, holding every page's slot. It takes no click itself.
//! - [`Slot`]: one per tab, placed over the tab's placeholder. It is what an
//!   app overlay cuts holes in, and what is hidden when the tab isn't showing.
//! - [`PageView`]: the WKWebView in the slot, which decides who a ⌘-chord
//!   belongs to and when the page may take the keyboard.

use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSBezierPath, NSEvent, NSEventModifierFlags, NSEventType, NSView, NSWindingRule,
};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect};
use objc2_quartz_core::{kCAFillRuleEvenOdd, CAShapeLayer};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};
use tauri::AppHandle;

use super::super::keys::{self, Chord};
use super::super::{emit, BrowserFocus, BrowserPointerDown, BrowserShortcut};

define_class!(
    /// Flipped, so a slot's frame reads top-down like the CSS rectangle it was
    /// placed from.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    pub struct Host;

    impl Host {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> Bool {
            Bool::YES
        }

        /// Only a page takes a click. Anywhere else is the app's webview below.
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> Option<Retained<NSView>> {
            self.page_at(point)
        }
    }

    unsafe impl NSObjectProtocol for Host {}
);

impl Host {
    pub fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        unsafe { msg_send![Self::alloc(mtm), initWithFrame: frame] }
    }

    fn page_at(&self, point: NSPoint) -> Option<Retained<NSView>> {
        let hit: Option<Retained<NSView>> = unsafe { msg_send![super(self), hitTest: point] };
        let me: &NSView = self;
        hit.filter(|view| !std::ptr::eq(&**view, me))
    }
}

#[derive(Default)]
pub struct SlotIvars {
    /// The overlays cut out of the page, in the slot's own coordinates (AppKit's
    /// bottom-up ones — the slot isn't flipped, so its layer's are the same), each
    /// with its corner radius.
    holes: RefCell<Vec<(NSRect, f64)>>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SlotIvars]
    pub struct Slot;

    impl Slot {
        /// A click in a hole is the overlay's: it falls through to the app's
        /// webview, which draws the overlay there.
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> Option<Retained<NSView>> {
            self.page_at(point)
        }
    }

    unsafe impl NSObjectProtocol for Slot {}
);

impl Slot {
    fn page_at(&self, point: NSPoint) -> Option<Retained<NSView>> {
        let superview = unsafe { self.superview() };
        let local = self.convertPoint_fromView(point, superview.as_deref());
        let in_hole = self
            .ivars()
            .holes
            .borrow()
            .iter()
            .any(|(rect, _)| contains(rect, local));
        if in_hole {
            return None;
        }
        unsafe { msg_send![super(self), hitTest: point] }
    }

    pub fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(SlotIvars::default());
        let this: Retained<Self> = unsafe { msg_send![super(this), init] };
        this.setWantsLayer(true);
        this
    }

    /// Cut `holes` out of the page — the page stops drawing there and clicks go
    /// through. Re-applied whenever the slot is resized, so the mask always spans
    /// the page.
    pub fn set_holes(&self, holes: Vec<(NSRect, f64)>) {
        *self.ivars().holes.borrow_mut() = holes;
        self.update_mask();
    }

    pub fn update_mask(&self) {
        let Some(layer) = self.layer() else { return };
        let holes = self.ivars().holes.borrow();
        if holes.is_empty() {
            unsafe { layer.setMask(None) };
            return;
        }
        // Even-odd: the page's bounds, minus each hole. The holes arrive disjoint
        // (`native::disjoint`), or an overlap would fill back in.
        let bounds = self.bounds();
        let path = NSBezierPath::bezierPathWithRect(bounds);
        for (rect, radius) in holes.iter() {
            path.appendBezierPath(&NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
                *rect, *radius, *radius,
            ));
        }
        path.setWindingRule(NSWindingRule::EvenOdd);
        let mask = CAShapeLayer::new();
        mask.setFrame(bounds);
        mask.setPath(Some(&path.CGPath()));
        mask.setFillRule(unsafe { kCAFillRuleEvenOdd });
        unsafe { layer.setMask(Some(&mask)) };
    }
}

fn contains(rect: &NSRect, point: NSPoint) -> bool {
    point.x >= rect.origin.x
        && point.x < rect.origin.x + rect.size.width
        && point.y >= rect.origin.y
        && point.y < rect.origin.y + rect.size.height
}

pub struct PageIvars {
    pub id: String,
    pub app: AppHandle,
    /// santree asked for this page to take the keyboard (`native::focus`).
    pub focus_requested: Cell<bool>,
    /// When the user last pressed a key or a button in this page, or navigated
    /// it from santree — what lets a page open another app or start a download.
    /// WebKit's own "clicked" can be a script's `a.click()`.
    input_at: Cell<Option<Instant>>,
}

define_class!(
    #[unsafe(super(WKWebView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PageIvars]
    pub struct PageView;

    impl PageView {
        /// AppKit offers a ⌘-chord to every view in the window, focused or not;
        /// this page only answers for the ones pressed while it has the keyboard.
        #[unsafe(method(performKeyEquivalent:))]
        fn perform_key_equivalent(&self, event: &NSEvent) -> Bool {
            if !self.has_keyboard() {
                return Bool::NO;
            }
            if self.take_chord(event) {
                return Bool::YES;
            }
            unsafe { msg_send![super(self), performKeyEquivalent: event] }
        }

        /// Some ⌘-chords reach WebKit as a plain key-down instead.
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            self.note_input();
            if !self.take_chord(event) {
                unsafe { msg_send![super(self), keyDown: event] }
            }
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            self.pointer_down();
            unsafe { msg_send![super(self), mouseDown: event] }
        }

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, event: &NSEvent) {
            self.pointer_down();
            unsafe { msg_send![super(self), rightMouseDown: event] }
        }

        #[unsafe(method(otherMouseDown:))]
        fn other_mouse_down(&self, event: &NSEvent) {
            self.pointer_down();
            unsafe { msg_send![super(self), otherMouseDown: event] }
        }

        /// A page takes the keyboard when the user clicks into it or santree hands
        /// it over — never because a page focused one of its own fields, which a
        /// tab in the background would otherwise do to whatever you are typing in.
        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> Bool {
            let asked = self.ivars().focus_requested.replace(false) || self.clicked_into();
            if !asked {
                return Bool::NO;
            }
            let took: Bool = unsafe { msg_send![super(self), becomeFirstResponder] };
            if took.as_bool() {
                self.emit_focus(true);
            }
            took
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> Bool {
            let gave: Bool = unsafe { msg_send![super(self), resignFirstResponder] };
            if gave.as_bool() {
                self.emit_focus(false);
            }
            gave
        }
    }

    unsafe impl NSObjectProtocol for PageView {}
);

impl PageView {
    pub fn new(
        mtm: MainThreadMarker,
        id: &str,
        app: &AppHandle,
        frame: NSRect,
        configuration: &WKWebViewConfiguration,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PageIvars {
            id: id.to_string(),
            app: app.clone(),
            focus_requested: Cell::new(false),
            input_at: Cell::new(None),
        });
        unsafe { msg_send![super(this), initWithFrame: frame, configuration: configuration] }
    }

    pub fn id(&self) -> &str {
        &self.ivars().id
    }

    /// The user acted on this page: a key, a button, or a navigation from
    /// santree's toolbar.
    pub fn note_input(&self) {
        self.ivars().input_at.set(Some(Instant::now()));
    }

    /// Whether the user acted on this page within `window` — not a script.
    pub fn had_input_within(&self, window: Duration) -> bool {
        self.ivars()
            .input_at
            .get()
            .is_some_and(|at| at.elapsed() <= window)
    }

    /// Whether the window's keyboard focus is this page (or a view WebKit put
    /// inside it).
    pub fn has_keyboard(&self) -> bool {
        let Some(window) = self.window() else {
            return false;
        };
        let Some(responder) = window.firstResponder() else {
            return false;
        };
        let responder: &AnyObject = &responder;
        let me: &NSView = self;
        responder
            .downcast_ref::<NSView>()
            .is_some_and(|view| view.isDescendantOf(me))
    }

    /// Ask for the keyboard on santree's behalf (`native::focus`).
    pub fn request_focus(&self) {
        let Some(window) = self.window() else { return };
        self.ivars().focus_requested.set(true);
        let me: &NSView = self;
        window.makeFirstResponder(Some(me));
        self.ivars().focus_requested.set(false);
    }

    /// Handle a ⌘-chord `keys::route` gives to someone other than the page.
    /// `false` leaves it to WebKit.
    fn take_chord(&self, event: &NSEvent) -> bool {
        let flags = event.modifierFlags();
        if !flags.contains(NSEventModifierFlags::Command) {
            return false;
        }
        let key = event
            .charactersIgnoringModifiers()
            .map(|key| key.to_string())
            .unwrap_or_default();
        let shift = flags.contains(NSEventModifierFlags::Shift);
        let chord = keys::route(
            &key,
            shift,
            flags.contains(NSEventModifierFlags::Option),
            flags.contains(NSEventModifierFlags::Control),
        );
        match chord {
            Chord::Page => false,
            Chord::Menu => NSApplication::sharedApplication(self.mtm())
                .mainMenu()
                .is_some_and(|menu| menu.performKeyEquivalent(event)),
            Chord::Browser(command) => {
                super::run(self, command);
                true
            }
            Chord::App => {
                emit(
                    &self.ivars().app,
                    BrowserShortcut {
                        id: self.id().to_string(),
                        key,
                        shift,
                    },
                );
                true
            }
        }
    }

    /// Whether the event being handled is a click that lands on this page: the
    /// window's own hit test, so a hidden page, one covered by another, or the
    /// part of it an overlay is cut from never counts.
    fn clicked_into(&self) -> bool {
        let mtm = self.mtm();
        let Some(event) = NSApplication::sharedApplication(mtm).currentEvent() else {
            return false;
        };
        let click = matches!(
            event.r#type(),
            NSEventType::LeftMouseDown | NSEventType::RightMouseDown | NSEventType::OtherMouseDown
        );
        let window = self.window();
        if !click || event.window(mtm) != window {
            return false;
        }
        let Some(content) = window.and_then(|w| w.contentView()) else {
            return false;
        };
        // `hitTest:` takes a point in the content view's superview (the frame).
        let frame = unsafe { content.superview() };
        let at = match &frame {
            Some(frame) => frame.convertPoint_fromView(event.locationInWindow(), None),
            None => event.locationInWindow(),
        };
        let me: &NSView = self;
        content
            .hitTest(at)
            .is_some_and(|hit| hit.isDescendantOf(me))
    }

    fn pointer_down(&self) {
        self.note_input();
        emit(
            &self.ivars().app,
            BrowserPointerDown {
                id: self.id().to_string(),
            },
        );
    }

    fn emit_focus(&self, focused: bool) {
        emit(
            &self.ivars().app,
            BrowserFocus {
                id: self.id().to_string(),
                focused,
            },
        );
    }
}
