/** Settings → Integrations → Daedalus: the home server that Daedalus projects
 *  live and run on (docs/remote.md).
 *
 *  Nothing to configure: santree reaches Daedalus through the Daedalus agent on
 *  this Mac, which the box already knows and approves. The pane is one status
 *  card — how the link is, what to do when it isn't, and a way to try again
 *  now. Not reaching it is normal, so every state is a line here, never a
 *  toast. */

import type { DaedalusLink } from "../../../bindings";
import {
  CheckIcon,
  CloseIcon,
  DaedalusLogo,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { Button } from "../../../components/primitives";
import { type LinkTone, linkNotice } from "../../../lib/daedalusLink";
import { useDaedalusHealth, useDaedalusStatus } from "../../../lib/queries";
import { formatRelativeTime, isoMs, useLiveNow } from "../../../lib/relativeTime";
import { Heading, KvRow } from "../widgets";

export function DaedalusSection() {
  return (
    <>
      <Heading
        title="Daedalus"
        subtitle="Add the projects Daedalus keeps. A Daedalus project's shells, agents and git run on Daedalus, and santree draws them here. santree reaches Daedalus through the Daedalus agent on this Mac, so there is nothing to set up here."
      />
      <StatusCard />
    </>
  );
}

const TONE: Record<LinkTone, { className: string; name: string }> = {
  ok: { className: "text-status-green", name: "OK" },
  pending: { className: "text-muted-4", name: "Checking" },
  warn: { className: "text-status-amber", name: "Needs attention" },
  error: { className: "text-status-red", name: "Not connected" },
};

function ToneGlyph({ tone }: { tone: LinkTone }) {
  const { className, name } = TONE[tone];
  const glyph = {
    ok: <CheckIcon size={12} />,
    pending: <RefreshIcon size={12} className="animate-spin" />,
    warn: <WarningIcon size={12} />,
    error: <CloseIcon size={12} />,
  }[tone];
  return (
    <span role="img" aria-label={name} className={`mt-[3px] flex-none ${className}`}>
      {glyph}
    </span>
  );
}

/** The link's state, live, with "Run check" to try again now. */
function StatusCard() {
  const status = useDaedalusStatus();
  const health = useDaedalusHealth();
  const now = useLiveNow();
  const checking = health.isFetching;
  const checkedMs = isoMs(health.data?.checkedAt);
  // The live status is the fresher answer; the check's is there first.
  const link: DaedalusLink | undefined = status.data ?? health.data?.link;
  const notice =
    checking || !link
      ? { tone: "pending" as const, title: "Checking…", detail: null }
      : linkNotice(link);

  return (
    <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
      <div className="flex items-center gap-[13px] p-4">
        <DaedalusLogo size={34} className="flex-none" />
        <div className="min-w-0 flex-1">
          <span className="text-[13.5px] font-semibold text-fg-bright">Daedalus</span>
          <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
            Through the Daedalus agent on this Mac.
          </div>
        </div>
        <Button
          onClick={() => void health.refetch().then(() => status.refetch())}
          disabled={checking}
        >
          <RefreshIcon size={12} className={checking ? "animate-spin" : ""} />
          Run check
        </Button>
      </div>

      <section
        aria-label="Connection"
        aria-live="polite"
        aria-busy={checking}
        className="border-t border-line bg-surface px-4 py-3"
      >
        <div className="flex items-start gap-2.5">
          <ToneGlyph tone={notice.tone} />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-fg-3">{notice.title}</div>
            {notice.detail && link?.kind !== "Connected" && (
              <div className="mt-0.5 text-[11.5px] leading-[1.5] break-words text-muted-3">
                {notice.detail}
              </div>
            )}
          </div>
          {checkedMs !== null && !checking && (
            <span className="flex-none text-[11px] text-muted-4">
              Checked {formatRelativeTime(checkedMs, now)}
            </span>
          )}
        </div>
        {!checking && link?.kind === "Connected" && (
          <div className="mt-3 overflow-hidden rounded-lg border border-line-3 bg-raised">
            <KvRow label="Box" value={link.hostname} />
            <KvRow label="Session host" value={link.version} />
            <KvRow label="Daedalus agent" value={link.agent ?? "—"} />
            <KvRow label="Projects root" value={link.projectsRoot} />
          </div>
        )}
      </section>
    </div>
  );
}
