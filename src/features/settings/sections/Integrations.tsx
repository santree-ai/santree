/** The Integrations section: connect a task tracker (Linear) and choose how
 *  santree authenticates GitHub (PRs + Reviews). Today only the `gh` CLI method
 *  is live; the GitHub App (OAuth) and Personal Access Token methods are shown as
 *  work-in-progress, mirroring the WIP harnesses on the Agents screen. */

import type { ReactNode } from "react";
import {
  CliIcon,
  GlobeIcon,
  KeyIcon,
  LinearLogo,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { Badge, Button } from "../../../components/primitives";
import {
  SYNC_VIEWED_KEY,
  useGithubStatus,
  useLinearConnect,
  useLinearOrgs,
  useSetSyncViewed,
  useSetting,
} from "../../../lib/queries";
import { useApp } from "../../../state/AppContext";
import { alpha, LINEAR_BRAND } from "../../../theme/colors";
import { Heading, KvRow, ToggleRow } from "../widgets";

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

      <LocalGitHubCard />
      <ViewedMarksCard />
    </>
  );
}

/** Where the Reviews tab keeps its per-file "Viewed" marks.
 *
 *  Off (the default) they live in this machine's database, keyed to each file's blob
 *  SHA. On, they *are* GitHub's marks — the same checkbox as the github.com Files
 *  tab, so a half-finished review follows you to another machine or the browser.
 *  Syncing needs the gh CLI signed in, and the backend falls back to the local store
 *  without it, so the toggle reads OFF and locks rather than claiming a sync that
 *  isn't happening. */
function ViewedMarksCard() {
  const { data: gh } = useGithubStatus();
  const { data } = useSetting("app", SYNC_VIEWED_KEY);
  const { mutate: setSyncViewed } = useSetSyncViewed();
  const authenticated = !!gh?.authenticated;

  return (
    <>
      <div className="mt-5 mb-2.5 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-fg-bright">Reviews</span>
        <span className="text-[11.5px] text-muted-3">
          How the Reviews tab remembers which files you've looked at.
        </span>
      </div>
      <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
        <ToggleRow
          label={`Sync "Viewed" files with GitHub`}
          hint={
            authenticated
              ? "Marking a file viewed here marks it on github.com too, and marks made there show up here. Off, marks stay on this machine."
              : "Sign in with the gh CLI to sync marks with GitHub. Until then they stay on this machine."
          }
          on={authenticated && data === "true"}
          disabled={!authenticated}
          onChange={setSyncViewed}
        />
      </div>
    </>
  );
}

/** How santree authenticates GitHub, Conductor-style: a radio group of methods.
 *  Only the `gh` CLI method is live today — it borrows the CLI's own session and
 *  powers PR creation + the Reviews dashboard. The GitHub App (OAuth) and
 *  Personal Access Token methods are shown as work-in-progress and can't be
 *  selected yet, matching the WIP harnesses on the Agents screen. */
function LocalGitHubCard() {
  const { data: gh, refetch, isFetching } = useGithubStatus();

  const badge = !gh ? null : !gh.installed ? (
    <Badge color="var(--color-status-amber)">not found</Badge>
  ) : gh.authenticated ? (
    <Badge color="var(--color-status-green)">connected</Badge>
  ) : (
    <Badge color="var(--color-status-amber)">signed out</Badge>
  );

  return (
    <>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-fg-bright">Local GitHub</span>
        <span className="text-[11.5px] text-muted-3">
          Choose how santree authenticates GitHub operations on your machine.
        </span>
      </div>

      <div className="flex flex-col gap-4">
        {/* gh CLI auth — the one live method, so it's always the selected radio. */}
        <MethodCard
          icon={<CliIcon size={16} className="text-fg-2" />}
          title="gh CLI auth"
          selected
          trailing={
            <div className="flex items-center gap-3">
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
          }
        >
          {gh && !gh.installed && (
            <div className="flex items-start gap-2 text-[11.5px]">
              <WarningIcon size={13} className="mt-px flex-none text-status-amber" />
              <div className="text-muted-3">
                <span className="font-medium text-status-amber">
                  GitHub CLI not found on your PATH.
                </span>{" "}
                Install it (<span className="font-mono text-fg-3">brew install gh</span>) and run{" "}
                <span className="font-mono text-fg-3">gh auth login</span> — without it,
                pull-request creation and the Reviews tab stay empty.
              </div>
            </div>
          )}

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
        </MethodCard>

        {/* GitHub App (OAuth) — WIP: sign in from within santree, no gh CLI. */}
        <MethodCard
          icon={<GlobeIcon size={16} className="text-muted-2" />}
          title="GitHub App (OAuth)"
          wip
        />

        {/* Personal Access Token — WIP: paste a token santree stores in the keychain. */}
        <MethodCard
          icon={<KeyIcon size={16} className="text-muted-2" />}
          title="Personal Access Token"
          wip
        />
      </div>
    </>
  );
}

/** One row in the Local GitHub method picker: a radio, an icon, a title, an
 *  optional trailing slot, and expanded detail below when live. WIP methods are
 *  dimmed, get a WIP badge, and can't be selected. */
function MethodCard({
  icon,
  title,
  selected = false,
  wip = false,
  trailing,
  children,
}: {
  icon: ReactNode;
  title: string;
  selected?: boolean;
  wip?: boolean;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className="rounded-xl border bg-raised px-4 py-3.5"
      style={
        selected
          ? { borderColor: alpha(45), background: alpha(7) }
          : { borderColor: "var(--color-line-2)" }
      }
    >
      <div className="flex items-center gap-3">
        <Radio checked={selected} dimmed={wip} />
        <span className={wip ? "opacity-55" : undefined}>{icon}</span>
        <span
          className={`flex-1 text-[13px] font-semibold ${wip ? "text-muted-2" : "text-fg-bright"}`}
        >
          {title}
        </span>
        {wip ? <Badge color="var(--color-muted-2)">WIP</Badge> : trailing}
      </div>
      {/* Only the selected method expands its detail; the rest collapse to a row. */}
      {selected && children && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** A read-only radio dot — the picker is single-choice and locked to gh CLI. */
function Radio({ checked, dimmed }: { checked: boolean; dimmed?: boolean }) {
  return (
    <span
      className="flex h-[15px] w-[15px] flex-none items-center justify-center rounded-full border"
      style={{
        borderColor: checked ? "var(--accent)" : "var(--color-line-strong)",
        opacity: dimmed ? 0.6 : 1,
      }}
    >
      {checked && (
        <span className="h-[7px] w-[7px] rounded-full" style={{ background: "var(--accent)" }} />
      )}
    </span>
  );
}
