/** Settings → Integrations → Jira: the Atlassian connection.
 *
 *  App-scoped, like Linear's card: sites are connected once for the whole
 *  install. One Atlassian authorization grants every site the account can reach,
 *  so connecting again is how a newly joined site arrives. *Which* site a repo
 *  reads is the per-repo Ticket tracker pane (`RepoTracker.tsx`). */

import { JiraLogo } from "../../../components/icons";
import { Badge, Button } from "../../../components/primitives";
import { useJiraConnect, useJiraSites } from "../../../lib/queries";
import { JIRA_BRAND } from "../../../theme/colors";
import { Heading } from "../widgets";

/** Jira's app-icon treatment — the white mark on its brand blue tile. */
export const jiraBadge = (
  <div
    className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] text-white"
    style={{ background: JIRA_BRAND }}
  >
    <JiraLogo size={18} />
  </div>
);

/** A site's address without the scheme — what people call their site. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function JiraSection() {
  const { data: sites = [] } = useJiraSites();
  const connect = useJiraConnect();
  const connected = sites.length > 0;

  return (
    <>
      <Heading
        title="Jira"
        subtitle="Connect Jira Cloud. Each repo picks its tracker and site (Settings → Repo → Ticket tracker)."
      />

      <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
        <div className="flex items-center gap-[13px] p-4">
          {jiraBadge}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-fg-bright">Jira Cloud</span>
              {connected && <Badge color="var(--color-status-green)">connected</Badge>}
            </div>
            <div className="mt-[3px] text-[11.5px] text-muted-3">
              {connected
                ? `${sites.length} ${sites.length === 1 ? "site" : "sites"} connected, chosen per repo`
                : "Connect to sync your assigned issues"}
            </div>
          </div>
          {/* Brand-colored primary, as Linear's card does: the one deliberate
              exception to the accent fill (a "connect to Jira" cue). */}
          <Button
            variant="primary"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
            style={{ background: JIRA_BRAND, color: "#ffffff" }}
          >
            {connect.isPending ? "Connecting…" : connected ? "Reconnect" : "Connect"}
          </Button>
        </div>

        {connected && (
          <div className="border-t border-line bg-surface px-4 py-2">
            {sites.map((site) => (
              <div key={site.cloudId} className="flex items-center gap-2 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: JIRA_BRAND }} />
                <span className="text-[12px] text-fg-3">{site.siteName}</span>
                <span className="font-mono text-[10.5px] text-muted-4">{hostOf(site.siteUrl)}</span>
                {!site.canWrite && <Badge>read-only</Badge>}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
