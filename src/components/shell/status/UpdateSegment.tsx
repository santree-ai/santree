/**
 * Whether this install is current, and the one click that changes the answer.
 *
 * The updater otherwise only speaks through a toast that scrolls away and a
 * Settings pane nobody visits, so a release could sit uninstalled for weeks. The
 * bar is the one surface that is always on screen, which makes it the right place
 * for a fact that is boring until the moment it isn't.
 *
 * It runs its own check on mount: the background watcher's answer lives on the
 * mutation instance that asked for it and isn't readable from here, and every
 * updater call shares one mutation scope, so the duplicate is serialized rather
 * than racing the watcher for the backend's parked update handle. Until an answer
 * lands the segment renders nothing — "up to date" is a claim, not a default.
 */
import { useEffect, useRef } from "react";

import { useCheckForUpdate, useInstallUpdate, useUpdateProgress } from "../../../lib/queries";
import { DownloadIcon } from "../../icons";
import { StatusButton } from "./StatusSegment";

/** The updater's state as a single segment: current, downloading, or ready. */
export function UpdateSegment() {
  const check = useCheckForUpdate({ silent: true });
  const install = useInstallUpdate();
  const progress = useUpdateProgress();
  const { mutate: runCheck } = check;

  // Once per mount, not once per render — and guarded, so React's development
  // double-mount doesn't fire two checks at the backend.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    runCheck();
  }, [runCheck]);

  // `undefined` = no answer yet; `null` = checked and already current.
  const update = check.data;
  const percent = progress?.total
    ? Math.round(((progress.downloaded ?? 0) / progress.total) * 100)
    : null;

  if (install.isPending) {
    return (
      <StatusButton
        active
        disabled
        className="cursor-default"
        aria-label="Installing the update"
        title="Downloading the update. santree restarts when it lands."
      >
        <DownloadIcon size={11} />
        <span className="tabular-nums">
          {percent === null ? "updating…" : `updating ${percent}%`}
        </span>
      </StatusButton>
    );
  }

  if (update) {
    return (
      <StatusButton
        active
        onClick={() => install.mutate(undefined, { onError: () => check.reset() })}
        aria-label={`Install santree ${update.version} and restart`}
        title={`santree ${update.version} is ready. Click to install and restart.`}
      >
        <DownloadIcon size={11} />
        <span>restart to update</span>
      </StatusButton>
    );
  }

  if (update === null) {
    return (
      <StatusButton
        onClick={() => runCheck()}
        disabled={check.isPending}
        aria-label="Check for updates"
        title="santree is up to date. Click to check again."
      >
        <span>{check.isPending ? "checking…" : "up to date"}</span>
      </StatusButton>
    );
  }

  return null;
}
