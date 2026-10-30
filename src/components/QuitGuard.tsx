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
 *
 * It asks only about what quitting really ends: `quit_summary` counts the
 * terminals that die with the app — the in-app ones, a worktree setup script
 * among them. Sessions held by the santree server (every terminal and setup run
 * on a build that has one) survive a quit and are not counted, so there such a
 * quit never asks; with nothing to end, the quit goes straight through, setting
 * or not. What is left to warn about is a build without the server (unsigned,
 * dev, Linux).
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import { commands, type QuitSummary } from "../bindings";
import { CONFIRM_ON_QUIT_KEY, useSetSetting, useSetting } from "../lib/queries";
import { ConfirmDialog } from "./primitives";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What quitting will do, in the words of what the summary says ends. `summary`
 *  is null when it couldn't be read: the old, general warning stands in. */
function quitMessage(summary: QuitSummary | null): string {
  if (!summary) return "Any running agent terminals in this window will be stopped.";
  return `${plural(summary.terminalsEnd, "running terminal")} in this window will be stopped.`;
}

export function QuitGuard() {
  const { data } = useSetting("app", CONFIRM_ON_QUIT_KEY);
  // Defaults ON: a missing value still confirms (only an explicit "false" opts out).
  const confirmOnQuit = data !== "false";
  const { mutateAsync: setSettingAsync } = useSetSetting();

  const [asking, setAsking] = useState(false);
  const [summary, setSummary] = useState<QuitSummary | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  // Which path opened the dialog: ⌘W/close → destroy the window; ⌘Q → exit the app.
  const viaQuit = useRef(false);

  // The listeners are registered once; read the latest setting through a ref so
  // toggling the preference doesn't re-register them (and the handlers never close
  // over a stale value). ⌘Q is already gated in Rust — the event only fires when
  // the setting is on — but the window close path is gated here.
  const confirmRef = useRef(confirmOnQuit);
  confirmRef.current = confirmOnQuit;

  const finish = async () => {
    if (viaQuit.current) {
      // ⌘Q was prevented in Rust; fully exit the process now.
      await commands.quitApp();
    } else {
      await getCurrentWindow().destroy();
    }
  };

  // Ask the dialog only when quitting ends something. A summary that can't be
  // read asks anyway (with the general warning): a needless prompt is cheaper
  // than a silent loss.
  const request = async (viaQuitPath: boolean) => {
    viaQuit.current = viaQuitPath;
    setDontAsk(false);
    let read: QuitSummary | null = null;
    try {
      // An in-memory count in the backend: it answers at once, never waits on a
      // server, so there is no hang to guard against here.
      read = await commands.quitSummary();
    } catch {
      // fall through to the general warning
    }
    if (read && read.terminalsEnd === 0) {
      await finish();
      return;
    }
    setSummary(read);
    setAsking(true);
  };
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenClose = win.onCloseRequested((e) => {
      if (!confirmRef.current) return; // setting off → let it close
      // Prevented up front: the summary is read asynchronously, and the window
      // is closed by `finish` once there turns out to be nothing to confirm.
      e.preventDefault();
      void requestRef.current(false);
    });
    const unlistenQuit = win.listen("quit-requested", () => {
      void requestRef.current(true);
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
    await finish();
  };

  return (
    <ConfirmDialog
      open={asking}
      danger
      title="Quit santree?"
      message={quitMessage(summary)}
      confirmLabel="Quit"
      busyLabel="Quitting…"
      extra={
        <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-muted-2 hover:text-fg-2">
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
