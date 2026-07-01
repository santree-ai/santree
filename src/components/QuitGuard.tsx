/**
 * Confirms before the app window closes. Listens for the window's close request
 * (the red traffic-light / ⌘W), and — when the "confirm before quitting" setting
 * is on — cancels it and shows a confirmation dialog instead. The dialog carries a
 * "Don't ask again" checkbox that flips the setting off (the same setting lives in
 * Settings → General), so the choice is reachable from both places.
 *
 * Confirming calls `destroy()`, which closes the window without re-emitting the
 * close request, so it bypasses this guard cleanly.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import { CONFIRM_ON_QUIT_KEY, useSetSetting, useSetting } from "../lib/queries";
import { ConfirmDialog } from "./primitives";

export function QuitGuard() {
  const { data } = useSetting("app", CONFIRM_ON_QUIT_KEY);
  // Defaults ON: a missing value still confirms (only an explicit "false" opts out).
  const confirmOnQuit = data !== "false";
  const { mutateAsync: setSettingAsync } = useSetSetting();

  const [asking, setAsking] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);

  // The close listener is registered once; read the latest setting through a ref so
  // toggling the preference doesn't re-register it (and the handler never closes
  // over a stale value).
  const confirmRef = useRef(confirmOnQuit);
  confirmRef.current = confirmOnQuit;

  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((e) => {
      if (!confirmRef.current) return; // setting off → let it close
      e.preventDefault();
      setDontAsk(false);
      setAsking(true);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const onConfirm = async () => {
    // Persist "don't ask again" before tearing the window down (best-effort — a
    // failed write must not block quitting).
    if (dontAsk) {
      try {
        await setSettingAsync({ scope: "app", key: CONFIRM_ON_QUIT_KEY, value: "false" });
      } catch {
        // ignore — quit anyway
      }
    }
    await getCurrentWindow().destroy();
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
