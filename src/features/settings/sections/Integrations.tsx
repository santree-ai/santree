/** The Integrations section: connect a task tracker (Linear) and show GitHub CLI
 *  status (GitHub isn't optional — it powers PRs and Reviews — so it can't be
 *  toggled; instead we surface whether `gh` is installed and signed in). */

import { GitHubLogo, LinearLogo, RefreshIcon, WarningIcon } from "../../../components/icons";
import { Badge } from "../../../components/primitives";
import { useGithubStatus, useLinearConnect, useLinearOrgs } from "../../../lib/queries";
import { useApp } from "../../../state/AppContext";
import { LINEAR_BRAND } from "../../../theme/colors";
import { Heading, KvRow } from "../widgets";

/** The Linear brand square — reused as a leading badge in a few cards. */
export const linearBadge = (
  <div
    className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] text-white"
    style={{ background: LINEAR_BRAND }}
  >
    <LinearLogo size={19} />
  </div>
);

export function IntegrationsSection() {
  const { settings } = useApp();
  const { data: orgs = [] } = useLinearOrgs();
  const connect = useLinearConnect();
  if (!settings) return null;
  const connected = orgs.length > 0;

  return (
    <>
      <Heading
        title="Integrations"
        subtitle="Connect a task tracker. Each repo picks which connected org it uses (Settings → repo → Linear)."
      />

      <div className="mb-3.5 overflow-hidden rounded-xl border border-line-2 bg-raised">
        <div className="flex items-center gap-[13px] p-4">
          {linearBadge}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-fg-bright">Linear</span>
              {connected && <Badge color="var(--color-status-green)">connected</Badge>}
            </div>
            <div className="mt-[3px] text-[11.5px] text-muted-3">
              {connected
                ? `${orgs.length} ${orgs.length === 1 ? "org" : "orgs"} connected · chosen per repo`
                : "Connect to sync your assigned issues"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
            className="cursor-pointer rounded-md border-none px-3 py-1.5 text-[12px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
            style={{ background: LINEAR_BRAND }}
          >
            {connect.isPending ? "Connecting…" : connected ? "Add org" : "Connect"}
          </button>
        </div>

        {connected && (
          <div className="border-t border-line bg-surface px-4 py-2">
            {orgs.map((org) => (
              <div key={org.slug} className="flex items-center gap-2 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: LINEAR_BRAND }} />
                <span className="text-[12px] text-fg-3">{org.name}</span>
                <span className="font-mono text-[10.5px] text-muted-4">{org.slug}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <GitHubCard />
    </>
  );
}

/** GitHub CLI status. GitHub is required (PR creation + Reviews dashboard), so
 *  there's no on/off toggle — we report whether `gh` is found and authenticated,
 *  and warn when it isn't. Auth is borrowed from the `gh` CLI's own session. */
function GitHubCard() {
  const { data: gh, refetch, isFetching } = useGithubStatus();

  const badge = !gh ? null : !gh.installed ? (
    <Badge color="var(--color-status-amber)">not found</Badge>
  ) : gh.authenticated ? (
    <Badge color="var(--color-status-green)">connected</Badge>
  ) : (
    <Badge color="var(--color-status-amber)">signed out</Badge>
  );

  const subtitle = gh?.authenticated
    ? `Signed in as ${gh.account}`
    : "Powers pull-request creation and the Reviews dashboard";

  return (
    <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
      <div className="flex items-center gap-[13px] p-4">
        <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] border border-line-strong bg-input-alt text-fg-2">
          <GitHubLogo size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-fg-bright">GitHub</span>
            {badge}
          </div>
          <div className="mt-[3px] truncate text-[11.5px] text-muted-3">{subtitle}</div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex flex-none cursor-pointer items-center gap-1.5 text-[11.5px] text-muted-2 transition-colors hover:text-fg-2"
        >
          <RefreshIcon size={12} className={isFetching ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {gh && !gh.installed && (
        <div className="flex items-start gap-2 border-t border-line bg-surface px-4 py-3 text-[11.5px]">
          <WarningIcon size={13} className="mt-px flex-none text-status-amber" />
          <div className="text-muted-3">
            <span className="font-medium text-status-amber">
              GitHub CLI not found on your PATH.
            </span>{" "}
            Install it (<span className="font-mono text-fg-3">brew install gh</span>) and run{" "}
            <span className="font-mono text-fg-3">gh auth login</span> — without it, pull-request
            creation and the Reviews tab stay empty.
          </div>
        </div>
      )}

      {gh?.installed && (
        <div className="border-t border-line bg-surface">
          {gh.authenticated && <KvRow label="Account" value={gh.account} />}
          {gh.authenticated && gh.name && <KvRow label="Name" value={gh.name} />}
          {gh.authenticated && <KvRow label="Host" value={gh.host} />}
          <KvRow label="CLI path" value={gh.detectedExec} />
          {gh.version && <KvRow label="Version" value={gh.version} />}
          {!gh.authenticated && (
            <div className="flex items-start gap-2 border-t border-line px-4 py-3 text-[11.5px]">
              <WarningIcon size={13} className="mt-px flex-none text-status-amber" />
              <div className="text-muted-3">
                <span className="font-medium text-status-amber">Not signed in.</span> Run{" "}
                <span className="font-mono text-fg-3">gh auth login</span> in a terminal, then
                Refresh.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
