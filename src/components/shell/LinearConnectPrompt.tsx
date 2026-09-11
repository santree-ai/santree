/**
 * The rail's way to Linear while no workspace is connected.
 *
 * santree's work is Linear's tickets: the Tickets list, the triage queue and every
 * ticket start read from a connected workspace, and without one each of them
 * shows an empty state that reads like "nothing to do". This says why instead,
 * once, above everything it explains, and takes you to the one place a workspace
 * is connected (Settings → Integrations → Linear).
 *
 * Nothing renders until the org read has answered, so a cold start never flashes
 * a warning at an install that is connected.
 */
import { useNavigate } from "@tanstack/react-router";

import { useLinearConnected } from "../../lib/queries";
import { LinearLogo, WarningIcon } from "../icons";

export function LinearConnectPrompt() {
  const connected = useLinearConnected();
  const navigate = useNavigate();
  if (connected !== false) return null;

  return (
    <div className="mx-2.5 mb-2 flex-none rounded-md border border-line bg-surface p-2">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
        <WarningIcon size={12} className="flex-none text-[var(--color-status-amber)]" />
        Linear isn't connected
      </p>
      <p className="pt-0.5 pb-2 text-[11px] leading-4 text-muted-4">
        Tickets, triage and starting work all need a Linear workspace.
      </p>
      <button
        type="button"
        onClick={() => navigate({ to: "/settings", search: { section: "linear" } })}
        className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line text-[12px] text-fg-2 transition-colors hover:border-line-strong hover:bg-hover"
      >
        <LinearLogo size={11} />
        Connect Linear
      </button>
    </div>
  );
}
