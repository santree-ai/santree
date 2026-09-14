/**
 * The rail's way to a ticket tracker while none is connected.
 *
 * santree's work is a tracker's tickets: the Tickets list, the triage queue and
 * every ticket start read from a connected Linear workspace or Jira site, and
 * without one each of them shows an empty state that reads like "nothing to do".
 * This says why instead, once, above everything it explains, and takes you to the
 * place each tracker is connected (Settings → Integrations).
 *
 * Nothing renders until both connection reads have answered, so a cold start
 * never flashes a warning at an install that is connected.
 */
import { useNavigate } from "@tanstack/react-router";

import { useTrackerConnected } from "../../lib/queries";
import { TrackerLogo, WarningIcon } from "../icons";

const TRACKERS = [
  { provider: "Linear", section: "linear" },
  { provider: "Jira", section: "jira" },
] as const;

export function TrackerConnectPrompt() {
  const connected = useTrackerConnected();
  const navigate = useNavigate();
  if (connected !== false) return null;

  return (
    <div className="mx-2.5 mb-2 flex-none rounded-md border border-line bg-surface p-2">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
        <WarningIcon size={12} className="flex-none text-[var(--color-status-amber)]" />
        No ticket tracker connected
      </p>
      <p className="pt-0.5 pb-2 text-[11px] leading-4 text-muted-4">
        Tickets, triage and starting work all need a Linear workspace or a Jira site.
      </p>
      <div className="flex gap-1.5">
        {TRACKERS.map(({ provider, section }) => (
          <button
            key={provider}
            type="button"
            aria-label={`Connect ${provider}`}
            onClick={() => navigate({ to: "/settings", search: { section } })}
            className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line text-[12px] text-fg-2 transition-colors hover:border-line-strong hover:bg-hover"
          >
            <TrackerLogo provider={provider} size={11} />
            {provider}
          </button>
        ))}
      </div>
    </div>
  );
}
