/** The Integrations section: connect a task tracker (Linear) and choose how
 *  santree authenticates GitHub (PRs + Reviews). Today only the `gh` CLI method
 *  is live; the GitHub App (OAuth) and Personal Access Token methods are shown as
 *  work-in-progress, mirroring the WIP harnesses on the Agents screen. */

import { useState } from "react";
import {
  CliIcon,
  GitHubLogo,
  GlobeIcon,
  KeyIcon,
  LinearLogo,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { Badge, Button, ChevronSelect, Tabs } from "../../../components/primitives";
import {
  LINEAR_SCOPE_KEY,
  type LinearScope,
  parseLinearScope,
  useGithubApiBudget,
  useGithubStatus,
  useLinearApiBudget,
  useLinearConnect,
  useLinearOrgs,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { useApp } from "../../../state/AppContext";
import { LINEAR_BRAND } from "../../../theme/colors";
import { ApiBudgetMeters } from "../ApiBudget";
import { BinaryPathField } from "../BinaryPathField";
import { Heading, KvRow } from "../widgets";

/** Linear's real app-icon treatment — the official monochrome logomark, white on
 *  a near-black tile (theme-independent, like the GitHub mark beside it). */
export const linearBadge = (
  <div
    className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] text-white"
    style={{ background: "#101113" }}
  >
    <LinearLogo size={19} />
  </div>
);

export function IntegrationsSection() {
  const { settings } = useApp();
  const { data: orgs = [] } = useLinearOrgs();
  const connect = useLinearConnect();
  const scope: LinearScope = parseLinearScope(useSetting("app", LINEAR_SCOPE_KEY).data);
  const { mutate: setSetting } = useSetSetting();
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
                ? `${orgs.length} ${orgs.length === 1 ? "org" : "orgs"} connected, chosen per repo`
                : "Connect to sync your assigned issues"}
            </div>
          </div>
          {/* Brand-colored primary — the Linear purple with white text is the one
              deliberate exception to the accent fill (a "connect to Linear" cue). */}
          <Button
            variant="primary"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
            style={{ background: LINEAR_BRAND, color: "#ffffff" }}
          >
            {connect.isPending ? "Connecting…" : connected ? "Add org" : "Connect"}
          </Button>
        </div>

        {/* What the NEXT connect asks for. Deliberately not derived from the
            connected orgs: the grant is fixed at authorize time, so this is a
            request, and changing it only matters on the trip through Linear. */}
        <div className="flex items-center gap-4 border-t border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">
              Permissions to request
            </div>
            <div className="text-[11.5px] text-muted-3">
              Read-only workspaces still show issues, triage and comments. santree just can't change
              anything. Choose write access intentionally; reconnect any workspace that was granted
              read-only.
            </div>
          </div>
          <ChevronSelect
            value={scope}
            onChange={(value) => setSetting({ scope: "app", key: LINEAR_SCOPE_KEY, value })}
            className="w-[148px] rounded-lg border border-line-3 bg-input py-2 pr-8 pl-[11px] text-[12px] text-fg-3"
            wrapperClassName="flex-none"
          >
            <option value="read" className="bg-input">
              Read-only
            </option>
            <option value="read_write" className="bg-input">
              Read &amp; write
            </option>
          </ChevronSelect>
        </div>

        {connected && (
          <div className="border-t border-line bg-surface px-4 py-2">
            {orgs.map((org) => (
              <div key={org.slug} className="flex items-center gap-2 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: LINEAR_BRAND }} />
                <span className="text-[12px] text-fg-3">{org.name}</span>
                <span className="font-mono text-[10.5px] text-muted-4">{org.slug}</span>
                {!org.canWrite && <Badge>read-only</Badge>}
              </div>
            ))}
          </div>
        )}

        {connected && <LinearBudget />}
      </div>

      <LocalGitHubCard />
    </>
  );
}

/** Each connected workspace's remaining Linear budget.
 *
 *  One block per org because the limits are per user per OAuth app, so two
 *  workspaces genuinely have two budgets. The "as of" line is not decoration:
 *  Linear reports the budget only in the headers of a call that already spent
 *  some of it, so this is the last reading santree took, not a live meter. */
function LinearBudget() {
  const { data: budgets = [], isFetching } = useLinearApiBudget();
  if (budgets.length === 0) return null;

  return (
    <div className="border-t border-line px-4 py-3.5">
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-fg-3">API budget</span>
        <span className="text-[11.5px] text-muted-3">
          Per workspace, per hour. Throttling stops on whichever pool runs out first.
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {budgets.map((budget) => (
          <div key={budget.slug}>
            {budgets.length > 1 && (
              <div className="mb-1.5 text-[11.5px] text-muted-2">{budget.name}</div>
            )}
            <ApiBudgetMeters
              windows={budget.windows}
              caption={
                isFetching
                  ? "Reading…"
                  : `As reported by Linear on santree's last call, ${new Date(
                      budget.observedAtMs ?? 0,
                    ).toLocaleTimeString()}. Linear only reports this in a response, so there is nothing to poll.`
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** How santree authenticates GitHub: one card, one tab strip, one panel — the
 *  same shape as the Agents screen, where the harnesses are also a set of
 *  alternatives of which only some are live. Only the `gh` CLI method works
 *  today; it borrows the CLI's own session and powers PR creation + Reviews. */
type GhMethod = "cli" | "app" | "pat";

function LocalGitHubCard() {
  const { data: gh, refetch, isFetching } = useGithubStatus();
  const [method, setMethod] = useState<GhMethod>("cli");

  const badge = !gh ? null : !gh.installed ? (
    <Badge color="var(--color-status-amber)">not found</Badge>
  ) : gh.authenticated ? (
    <Badge color="var(--color-status-green)">connected</Badge>
  ) : (
    <Badge color="var(--color-status-amber)">signed out</Badge>
  );

  const wipBadge = <Badge color="var(--color-muted-2)">WIP</Badge>;

  return (
    <>
      <div className="mb-2.5 flex items-center gap-2">
        <GitHubLogo size={15} className="text-fg-2" />
        <span className="text-[13px] font-semibold text-fg-bright">Local GitHub</span>
        <span className="text-[11.5px] text-muted-3">
          Choose how santree authenticates GitHub operations on your machine.
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
        <div className="flex items-center gap-3 px-4 pt-2.5">
          <Tabs<GhMethod>
            tabs={[
              { value: "cli", label: "gh CLI auth", icon: <CliIcon size={14} /> },
              {
                value: "app",
                label: "GitHub App",
                icon: <GlobeIcon size={14} />,
                dimmed: true,
                badge: wipBadge,
              },
              {
                value: "pat",
                label: "Access token",
                icon: <KeyIcon size={14} />,
                dimmed: true,
                badge: wipBadge,
              },
            ]}
            value={method}
            onChange={setMethod}
            className="min-w-0 flex-1"
          />
        </div>

        {method === "cli" ? (
          <div className="flex flex-col gap-3.5 px-4 py-4">
            <div className="flex items-center gap-3">
              <span className="flex-1 text-[12.5px] text-muted-3">
                santree runs the `gh` CLI as you. No separate sign-in.
              </span>
              {badge}
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
              <div className="flex items-start gap-2 text-[11.5px]">
                <WarningIcon size={13} className="mt-px flex-none text-status-amber" />
                <div className="text-muted-3">
                  <span className="font-medium text-status-amber">
                    GitHub CLI not found on your PATH.
                  </span>{" "}
                  Install it (<span className="font-mono text-fg-3">brew install gh</span>) and run{" "}
                  <span className="font-mono text-fg-3">gh auth login</span>. Without it,
                  pull-request creation and the Reviews tab stay empty. Already installed? Point
                  santree at it below.
                </div>
              </div>
            )}

            {/* Offered in both states: not-found is when you need it most, but a
                second install (or the wrong one on PATH) is a real case too. */}
            <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
              <BinaryPathField name="gh" hint="only needed if santree can't find it itself" />
            </div>

            {gh?.authenticated && <GithubBudget />}

            {gh?.installed && (
              <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
                {gh.authenticated && <KvRow label="Account" value={gh.account} />}
                {gh.authenticated && gh.name && <KvRow label="Name" value={gh.name} />}
                {gh.authenticated && <KvRow label="Host" value={gh.host} />}
                <KvRow label="CLI path" value={gh.detectedExec} />
                {gh.version && <KvRow label="Version" value={gh.version} />}
                {!gh.authenticated && (
                  <div className="flex items-start gap-2 border-t border-line px-3 py-2.5 text-[11.5px]">
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
        ) : (
          <div className="px-4 py-6 text-center text-[12px] text-muted-3">
            {method === "app"
              ? "Sign in to GitHub from inside santree, without the gh CLI."
              : "Paste a personal access token; santree keeps it in the OS keychain."}
            <div className="mt-1 text-[11.5px] text-muted-4">Not built yet.</div>
          </div>
        )}
      </div>
    </>
  );
}

/** What is left of the GitHub budget the `gh` session spends.
 *
 *  The budget belongs to the token, not to santree — anything else signed in as
 *  the same `gh` account draws on the same pools, which is why the number has to
 *  come from GitHub's `/rate_limit` rather than from a local tally. That
 *  endpoint is free, so refreshing it never moves what it reports. */
function GithubBudget() {
  const { data: budget } = useGithubApiBudget();
  if (!budget) return null;
  return (
    <ApiBudgetMeters
      windows={budget.windows}
      caption="GitHub's own /rate_limit for this gh session. Shared with everything else signed in as the same account."
    />
  );
}
