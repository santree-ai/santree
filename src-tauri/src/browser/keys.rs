//! Who a ⌘-chord belongs to while a page has the keyboard.
//!
//! The page is a native view, so keystrokes go to WebKit and never reach the
//! app's webview, where santree's shortcuts listen. The web view hands every
//! ⌘-chord to [`route`] first. The rule is a browser's: a short list of chords
//! belongs to the app around the page (switching tabs and views, the palette, the
//! address bar) and to the page's browser commands (reload, back, forward, zoom);
//! every other chord is the page's, so ⌘B still bolds in an editor and ⌘F still
//! finds in a site that binds it. The one contested chord santree keeps is ⌘K:
//! it is the palette, wherever focus is (Superset decides the same).

/// What a ⌘-chord pressed in a page does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chord {
    /// WebKit gets it: editing (⌘C, ⌘V, ⌘Z…) and whatever the page binds.
    Page,
    /// The app's native menu: quit, close the window, hide, minimize.
    Menu,
    /// The page's browser command, done natively without a round trip.
    Browser(BrowserCommand),
    /// santree's own shortcut, replayed in the app's webview.
    App,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserCommand {
    Reload,
    Back,
    Forward,
    ZoomIn,
    ZoomOut,
    ZoomReset,
}

/// Route a chord pressed with ⌘ held. `key` is the character the key types with
/// Shift applied but no other modifier (AppKit's `charactersIgnoringModifiers`),
/// which is also what a DOM `KeyboardEvent.key` carries for the same press.
pub fn route(key: &str, shift: bool, alt: bool, ctrl: bool) -> Chord {
    if ctrl {
        // ⌃⌘F is the menu's full screen; nothing else with ⌃ is ours.
        return if key.eq_ignore_ascii_case("f") {
            Chord::Menu
        } else {
            Chord::Page
        };
    }
    match key {
        "q" | "w" | "h" | "m" => return Chord::Menu,
        _ if alt => return Chord::Page,
        _ => {}
    }
    match (key, shift) {
        ("r", false) => Chord::Browser(BrowserCommand::Reload),
        ("[", false) => Chord::Browser(BrowserCommand::Back),
        ("]", false) => Chord::Browser(BrowserCommand::Forward),
        ("=" | "+", _) => Chord::Browser(BrowserCommand::ZoomIn),
        ("-" | "_", _) => Chord::Browser(BrowserCommand::ZoomOut),
        ("0", false) => Chord::Browser(BrowserCommand::ZoomReset),
        // ⌘⇧R re-pulls Linear and GitHub (`useKeyboardShortcuts`).
        ("R", true) => Chord::App,
        ("t" | "k" | "l" | ";" | "," | "/", false) => Chord::App,
        (d, false) if d.len() == 1 && d.as_bytes()[0].is_ascii_digit() => Chord::App,
        _ => Chord::Page,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use BrowserCommand::*;

    #[test]
    fn a_page_keeps_every_chord_but_the_app_and_browser_ones() {
        let cases = [
            // (key, shift, alt, ctrl) → route
            (("c", false, false, false), Chord::Page),
            (("v", false, false, false), Chord::Page),
            (("z", true, false, false), Chord::Page),
            (("b", false, false, false), Chord::Page),
            (("f", false, false, false), Chord::Page),
            (("Enter", false, false, false), Chord::Page),
            (("i", false, true, false), Chord::Page),
            (("q", false, false, false), Chord::Menu),
            (("w", false, false, false), Chord::Menu),
            (("h", false, true, false), Chord::Menu),
            (("f", false, false, true), Chord::Menu),
            (("r", false, false, false), Chord::Browser(Reload)),
            (("[", false, false, false), Chord::Browser(Back)),
            (("]", false, false, false), Chord::Browser(Forward)),
            (("+", true, false, false), Chord::Browser(ZoomIn)),
            (("=", false, false, false), Chord::Browser(ZoomIn)),
            (("-", false, false, false), Chord::Browser(ZoomOut)),
            (("0", false, false, false), Chord::Browser(ZoomReset)),
            (("R", true, false, false), Chord::App),
            (("t", false, false, false), Chord::App),
            (("k", false, false, false), Chord::App),
            (("l", false, false, false), Chord::App),
            (("1", false, false, false), Chord::App),
            ((",", false, false, false), Chord::App),
        ];
        for ((key, shift, alt, ctrl), want) in cases {
            assert_eq!(
                route(key, shift, alt, ctrl),
                want,
                "⌘{key} shift={shift} alt={alt} ctrl={ctrl}"
            );
        }
    }
}
