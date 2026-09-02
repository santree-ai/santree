/**
 * Keeps the webview's own context menu — Back · Reload · Inspect Element — off
 * the app's chrome. A right-click on something santree has a menu for opens
 * that menu (`ContextMenu` and the graph prevent the default themselves);
 * everywhere else the native one used to appear, offering to reload the app
 * from a sidebar row.
 *
 * It is still the right answer in three places, and stays there: a text field
 * (cut · copy · paste), a terminal (paste, the same way), and selected text
 * anywhere (copy · look up). A dev build keeps one way to Inspect Element at
 * the pointer: ⌥-right-click.
 *
 * A document listener rather than a prop on the frame, so a portal — a dialog,
 * a menu, a toast — is covered too.
 */
import { useEffect } from "react";

import { inEditable, inTerminal } from "./useKeyboardShortcuts";

/** True when the pointer is on text the user has selected: the element under it
 *  meets the selection. `intersectsNode`, not `containsNode` — a selection made
 *  inside one paragraph is *contained by* that paragraph, which the latter
 *  reads as the paragraph not being in it. */
function onSelectedText(target: EventTarget | null): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const node = target as Node | null;
  if (!node) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    if (selection.getRangeAt(i).intersectsNode(node)) return true;
  }
  return false;
}

export function useNativeContextMenu() {
  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      if (e.defaultPrevented) return;
      if (import.meta.env.DEV && e.altKey) return;
      if (inEditable(e.target) || inTerminal(e.target) || onSelectedText(e.target)) return;
      e.preventDefault();
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
