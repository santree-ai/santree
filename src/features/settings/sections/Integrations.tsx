/** The Integrations section: connect a task tracker (Linear) and toggle GitHub. */

import { GitHubLogo, LinearLogo } from "../../../components/icons";
import { Badge, Toggle } from "../../../components/primitives";
import { useLinearConnect, useLinearOrgs } from "../../../lib/queries";
import { useApp } from "../../../state/AppContext";
import { LINEAR_BRAND } from "../../../theme/colors";
import { Heading } from "../widgets";

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
  const { settings, toggleIntegration } = useApp();
  const { data: orgs = [] } = useLinearOrgs();
  const connect = useLinearConnect();
  if (!settings) return null;
  const { github } = settings.integrations;
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
              {connected && <Badge color="#3fb950">connected</Badge>}
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

      <div className="flex items-center gap-[13px] rounded-xl border border-line-2 bg-raised p-4">
        <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] border border-line-strong bg-input-alt text-fg-2">
          <GitHubLogo size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-fg-bright">GitHub</span>
            <Badge color="#3fb950">connected</Badge>
          </div>
          <div className="mt-[3px] text-[11.5px] text-muted-3">
            akamai/agent · used for worktree pull requests
          </div>
        </div>
        <Toggle on={github} onClick={() => toggleIntegration("github")} />
      </div>
    </>
  );
}
