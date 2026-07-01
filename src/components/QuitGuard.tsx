/**
 * Confirms before the app quits. Covers both quit paths:
 *   - the red traffic-light / ⌘W → the window's `onCloseRequested`, cancelled here
 *     and finished with `destroy()` (closes the window without re-emitting).
 *   - ⌘Q / the app menu → a *custom* Quit menu item in Rust (the predefined one
 *     calls the native terminate, which can't be intercepted) emits `quit-requested`
 *     instead of quitting; confirming runs the `quit_app` command to exit the process.
 * When the "confirm before quitting" setting is off, both paths pass straight
 * through. The dialog carries a "Don't ask again" checkbox that flips the setting
 * off (the same setting lives in Settings → General).
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import { commands } from "../bindings";
import { CONFIRM_ON_QUIT_KEY, useSetSetting, useSetting } from "../lib/queries";
import { ConfirmDialog } from "./primitives";

export function QuitGuard() {
  const { data } = useSetting("app", CONFIRM_ON_QUIT_KEY);
  // Defaults ON: a missing value still confirms (only an explicit "false" opts out).
  const confirmOnQuit = data !== "false";
  const { mutateAsync: setSettingAsync } = useSetSetting();

  const [asking, setAsking] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  // Which path opened the dialog: ⌘W/close → destroy the window; ⌘Q → exit the app.
  const viaQuit = useRef(false);

  // The listeners are registered once; read the latest setting through a ref so
  // toggling the preference doesn't re-register them (and the handlers never close
  // over a stale value). ⌘Q is already gated in Rust — the event only fires when
  // the setting is on — but the window close path is gated here.
  const confirmRef = useRef(confirmOnQuit);
  confirmRef.current = confirmOnQuit;

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenClose = win.onCloseRequested((e) => {
      if (!confirmRef.current) return; // setting off → let it close
      e.preventDefault();
      viaQuit.current = false;
      setDontAsk(false);
      setAsking(true);
    });
    const unlistenQuit = win.listen("quit-requested", () => {
      viaQuit.current = true;
      setDontAsk(false);
      setAsking(true);
    });
    return () => {
      void unlistenClose.then((off) => off());
      void unlistenQuit.then((off) => off());
    };
  }, []);

  const onConfirm = async () => {
    // Persist "don't ask again" before tearing things down (best-effort — a failed
    // write must not block quitting).
    if (dontAsk) {
      try {
        await setSettingAsync({ scope: "app", key: CONFIRM_ON_QUIT_KEY, value: "false" });
      } catch {
        // ignore — quit anyway
      }
    }
    if (viaQuit.current) {
      // ⌘Q was prevented in Rust; fully exit the process now.
      await commands.quitApp();
    } else {
      await getCurrentWindow().destroy();
    }
  };

  return (
    <ConfirmDialog
      open={asking}
      danger
      title="Quit santree?"
      message="Any running agent terminals in this window will be stopped."
      confirmLabel="Quit"
      busyLabel="Quitting…"
      extra={
        <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-muted-2 hover:text-fg-2">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
          />
          Don't ask again
        </label>
      }
      onConfirm={onConfirm}
      onClose={() => setAsking(false)}
    />
  );
}
