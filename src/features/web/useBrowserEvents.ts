/** What the app does with the Web tab's backend events. Mounted once, at the
 *  root: a page reports in whether or not its tab is on screen.
 *
 *  A page is a native view, so the app's webview never sees what happens in it.
 *  These events are how the app catches up: a click there still closes the app's
 *  menus and activates the page's split; one of santree's shortcuts pressed there
 *  still runs; and while a page holds the keyboard, anything in the app taking
 *  focus (a field, the palette) takes it back. */
import { useEffect } from "react";

import { commands, events } from "../../bindings";
import { toast } from "../../state/toast";
import { hostOfTab } from "./hosts";
import { setPageState } from "./pageState";

/** The Web tab whose page holds the keyboard, if one does. */
let focusedPage: string | null = null;

/** The event a Web tab's toolbar listens for to take ⌘L. */
export const FOCUS_ADDRESS_EVENT = "santree:web-focus-address";

export function useBrowserEvents() {
  useEffect(() => {
    const listening = [
      events.browserChanged.listen(({ payload }) => setPageState(payload)),
      events.browserShortcut.listen(({ payload: { id, key, shift } }) => {
        // Whatever the shortcut opens — the palette, a new tab, the address bar —
        // types into the app, so the app takes the keyboard back first: a field
        // focused in a webview that isn't AppKit's first responder gets no keys.
        void commands.browserReleaseFocus().then(() => {
          // ⌘L is the page's own address bar; every other chord is the app's.
          if (key === "l") {
            window.dispatchEvent(new CustomEvent(FOCUS_ADDRESS_EVENT, { detail: id }));
            return;
          }
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              metaKey: true,
              shiftKey: shift,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      }),
      events.browserPointerDown.listen(({ payload: { id } }) => {
        // A press outside every app overlay, as far as the app can tell: the
        // menus' outside-click listeners close them.
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        hostOfTab(id)?.activate(id);
      }),
      events.browserFocus.listen(({ payload: { id, focused } }) => {
        if (focused) focusedPage = id;
        else if (focusedPage === id) focusedPage = null;
      }),
      events.browserOpened.listen(({ payload }) => {
        hostOfTab(payload.opener)?.open(payload.url, {
          id: payload.id,
          background: payload.background,
        });
      }),
      events.browserClosed.listen(({ payload: { id } }) => hostOfTab(id)?.close(id)),
      events.browserDownload.listen(({ payload }) => {
        if (payload.error)
          toast.error(payload.error, { title: `Couldn't download ${payload.file}` });
        else toast.success(`${payload.file} is in Downloads.`, { title: "Downloaded" });
      }),
    ];

    const takeFocusBack = () => {
      if (focusedPage === null) return;
      focusedPage = null;
      void commands.browserReleaseFocus();
    };
    document.addEventListener("focusin", takeFocusBack, true);

    return () => {
      for (const unlisten of listening) void unlisten.then((stop) => stop());
      document.removeEventListener("focusin", takeFocusBack, true);
    };
  }, []);
}
