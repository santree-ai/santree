/** Settings → Integrations → Daedalus: the home server that Daedalus projects
 *  live and run on (docs/remote.md).
 *
 *  App-scoped: santree talks to one Daedalus. The URL and API token are what the
 *  user types; the ssh connection info below them is what Daedalus reports and is
 *  read-only here. Not reaching it is normal (away from home, no VPN), so the
 *  pane shows that as a state with a hint, never as an error. */

import { useEffect, useId, useState } from "react";

import type { DaedalusConfig, DaedalusHealth, DaedalusReach, DaemonReach } from "../../../bindings";
import {
  CheckIcon,
  CloseIcon,
  DaedalusLogo,
  MinusIcon,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { Badge, Button, Toggle } from "../../../components/primitives";
import {
  useDaedalusConfig,
  useDaedalusConnect,
  useDaedalusDaemonStatus,
  useDaedalusDisconnect,
  useDaedalusHealth,
  useDaedalusSetIdentityFile,
  useDaedalusStatus,
} from "../../../lib/queries";
import { formatRelativeTime, isoMs, useLiveNow } from "../../../lib/relativeTime";
import { Heading, KvRow } from "../widgets";

const INPUT_CLASS =
  "w-full rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3 placeholder:text-muted-4";

/** Daedalus's app-icon treatment — its mark already is the brand tile, so it
 *  stands at the tile size the Linear and Jira cards use. */
const daedalusTile = <DaedalusLogo size={34} className="flex-none" />;

export function DaedalusSection() {
  const { data: config } = useDaedalusConfig();
  const configured = config != null;

  return (
    <>
      <Heading
        title="Daedalus"
        subtitle="Connect Daedalus to add the projects it keeps. A Daedalus project's shells, agents and git run on Daedalus, and santree draws them here."
      />

      <ConnectionCard config={config ?? null} />

      {configured && <ServerInfoCard config={config} />}
      {configured && <IdentityFileCard config={config} />}
      <VpnCard />
    </>
  );
}

// ── Health check ─────────────────────────────────────────────────────────────
// The card's one status surface: each stage of reaching Daedalus, in order, so
// "ssh works but santree-remote isn't there" reads as exactly that. The API row
// follows the live reach and the santree-remote row the live link once the check
// has found it installed; ssh has no live source, so it is the check's answer.

type Tone = "ok" | "warn" | "error" | "skipped" | "pending";

interface CheckRow {
  label: string;
  tone: Tone;
  detail: string;
}

const CHECKING: Omit<CheckRow, "label"> = { tone: "pending", detail: "Checking…" };

function apiRow(reach: DaedalusReach | undefined): CheckRow {
  const label = "Daedalus API";
  switch (reach?.kind) {
    case undefined:
      return { label, ...CHECKING };
    case "ApiReachable":
      return { label, tone: "ok", detail: "Reachable" };
    case "ApiUnreachable":
      return { label, tone: "error", detail: reach.reason };
    case "Unauthorized":
      return {
        label,
        tone: "error",
        detail: "Daedalus refused the token. Paste a new one below.",
      };
    case "NotConfigured":
      return { label, tone: "skipped", detail: "Not configured." };
  }
}

function sshRow(health: DaedalusHealth | undefined, checking: boolean): CheckRow {
  const label = "SSH access";
  const ssh = health?.ssh;
  if (!ssh || checking) return { label, ...CHECKING };
  switch (ssh.kind) {
    case "Ok":
      return { label, tone: "ok", detail: ssh.target };
    case "Failed":
      return { label, tone: "error", detail: `${ssh.reason}. Tried ${ssh.target}.` };
    case "Skipped":
      return { label, tone: "skipped", detail: ssh.reason };
  }
}

const NOT_INSTALLED: Omit<CheckRow, "label"> = {
  tone: "error",
  detail: "Not installed on Daedalus yet.",
};

const mismatch = (theirs: number | null): Omit<CheckRow, "label"> => ({
  tone: "warn",
  detail:
    theirs === null
      ? "Speaks another protocol version than this santree. Update one of them."
      : `Speaks protocol ${theirs}, which this santree doesn't. Update one of them.`,
});

function daemonRow(
  health: DaedalusHealth | undefined,
  checking: boolean,
  live: DaemonReach | undefined,
): CheckRow {
  const label = "santree-remote on Daedalus";
  const daemon = health?.daemon;
  if (!daemon || checking) return { label, ...CHECKING };
  switch (daemon.kind) {
    case "Skipped":
      return { label, tone: "skipped", detail: daemon.reason };
    case "NotInstalled":
      return { label, ...NOT_INSTALLED };
  }
  // Installed: from here the live link is the fresher answer.
  switch (live?.kind) {
    case "Connected":
      return { label, tone: "ok", detail: `Connected · santree-remote ${live.version}` };
    case "Connecting":
      return { label, tone: "pending", detail: "Connecting…" };
    case "Unreachable":
      return live.reason.includes("not found on the server")
        ? { label, ...NOT_INSTALLED }
        : { label, tone: "error", detail: `Not running. ${live.reason}` };
    case "VersionMismatch":
      return { label, ...mismatch(live.theirs) };
  }
  switch (daemon.kind) {
    case "Connected":
      return { label, tone: "ok", detail: `Connected · santree-remote ${daemon.version}` };
    case "NotRunning":
      return { label, tone: "error", detail: `Not running. ${daemon.reason}` };
    case "VersionMismatch":
      return { label, ...mismatch(daemon.theirs) };
  }
}

const TONE: Record<Tone, { className: string; name: string }> = {
  ok: { className: "text-status-green", name: "OK" },
  warn: { className: "text-status-amber", name: "Warning" },
  error: { className: "text-status-red", name: "Failed" },
  skipped: { className: "text-muted-4", name: "Skipped" },
  pending: { className: "text-muted-4", name: "Checking" },
};

function ToneGlyph({ tone }: { tone: Tone }) {
  const { className, name } = TONE[tone];
  const glyph = {
    ok: <CheckIcon size={12} />,
    warn: <WarningIcon size={12} />,
    error: <CloseIcon size={12} />,
    skipped: <MinusIcon size={12} />,
    pending: <RefreshIcon size={12} className="animate-spin" />,
  }[tone];
  return (
    <span role="img" aria-label={name} className={`mt-[2px] flex-none ${className}`}>
      {glyph}
    </span>
  );
}

function HealthCheck() {
  const status = useDaedalusStatus();
  const health = useDaedalusHealth();
  const daemon = useDaedalusDaemonStatus();
  const now = useLiveNow();
  const checking = health.isFetching;
  const checkedMs = isoMs(health.data?.checkedAt);
  const rows = [
    apiRow(status.data),
    sshRow(health.data, checking),
    daemonRow(health.data, checking, daemon.data),
  ];

  return (
    <section aria-label="Health check" className="border-t border-line px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-fg-3">Health check</span>
        {checkedMs !== null && !checking && (
          <span className="text-[11px] text-muted-4">
            Checked {formatRelativeTime(checkedMs, now)}
          </span>
        )}
        <Button
          onClick={() => {
            void status.refetch();
            void health.refetch();
          }}
          disabled={checking}
          className="ml-auto"
        >
          <RefreshIcon size={12} className={checking ? "animate-spin" : ""} />
          Run check
        </Button>
      </div>
      <ul
        className="overflow-hidden rounded-lg border border-line-3 bg-surface"
        aria-live="polite"
        aria-busy={checking}
      >
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-start gap-2.5 border-line-3 px-3 py-2 not-first:border-t"
          >
            <ToneGlyph tone={row.tone} />
            <span className="w-[176px] flex-none text-[11.5px] font-medium text-fg-3">
              {row.label}
            </span>
            <span className="min-w-0 flex-1 text-[11.5px] leading-[1.5] break-words text-muted-3">
              {row.detail}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** URL + token, the health check, and Connect / Disconnect. */
function ConnectionCard({ config }: { config: DaedalusConfig | null }) {
  const connect = useDaedalusConnect();
  const disconnect = useDaedalusDisconnect();
  const [url, setUrl] = useState(config?.url ?? "");
  const [token, setToken] = useState("");
  const urlId = useId();
  const tokenId = useId();

  // Follow the saved URL when it arrives or changes elsewhere (a disconnect),
  // without clobbering what the user is typing over it.
  const savedUrl = config?.url ?? "";
  useEffect(() => setUrl(savedUrl), [savedUrl]);

  const hasToken = config?.hasToken ?? false;
  const canConnect =
    url.trim().length > 0 && (token.trim().length > 0 || hasToken) && !connect.isPending;
  const submit = () => {
    if (!canConnect) return;
    connect.mutate({ url: url.trim(), token }, { onSuccess: () => setToken("") });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
      <div className="flex items-center gap-[13px] p-4">
        {daedalusTile}
        <div className="min-w-0 flex-1">
          <span className="text-[13.5px] font-semibold text-fg-bright">Daedalus</span>
          <div className="mt-[3px] truncate text-[11.5px] leading-[1.5] text-muted-3">
            {config ? (
              <span className="font-mono">{config.url}</span>
            ) : (
              "Not configured. Add your Daedalus URL and API token."
            )}
          </div>
        </div>
      </div>

      {config && <HealthCheck />}

      <form
        className="flex flex-col gap-3 border-t border-line bg-surface px-4 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div>
          <label htmlFor={urlId} className="mb-1 block text-[11px] font-medium text-muted-2">
            Daedalus URL
          </label>
          <input
            id={urlId}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://daedalus.home.example"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor={tokenId} className="mb-1 block text-[11px] font-medium text-muted-2">
            API token
          </label>
          <input
            id={tokenId}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              hasToken ? "Saved in the keychain. Paste a new one to replace it." : "Paste it here"
            }
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <div className="mt-1 text-[10.5px] text-muted-4">
            Kept in the OS keychain, never in santree's database.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={!canConnect}>
            {connect.isPending ? "Connecting…" : config ? "Save and retry" : "Connect"}
          </Button>
          {config && (
            <Button
              variant="ghost"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              className="ml-auto"
            >
              Disconnect
            </Button>
          )}
        </div>
        {config && (
          <div className="text-[10.5px] text-muted-4">
            Disconnecting forgets the URL and token. Projects you added from Daedalus stay.
          </div>
        )}
      </form>
    </div>
  );
}

/** What Daedalus last reported about reaching it over ssh. Read-only: the
 *  server is the source of truth, and santree offers no way to change it. */
function ServerInfoCard({ config }: { config: DaedalusConfig }) {
  const now = useLiveNow();
  const fetchedMs = isoMs(config.fetchedAt);
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-line-2 bg-raised">
      <div className="flex items-baseline gap-2 px-4 pt-3.5 pb-2.5">
        <span className="text-[12.5px] font-medium text-fg-3">Connection</span>
        <span className="text-[11.5px] text-muted-3">
          {fetchedMs === null
            ? "Read the first time Daedalus answers."
            : `As Daedalus reported it ${formatRelativeTime(fetchedMs, now)}.`}
        </span>
      </div>
      {fetchedMs !== null && (
        <div className="mx-4 mb-3.5 overflow-hidden rounded-lg border border-line-3 bg-surface">
          <KvRow label="SSH user" value={config.sshUser ?? "—"} />
          <KvRow label="SSH host" value={config.sshHost ?? "—"} />
          <KvRow label="SSH port" value={config.sshPort?.toString() ?? "—"} />
          <KvRow label="Projects root" value={config.projectsRoot ?? "—"} />
        </div>
      )}
    </div>
  );
}

/** The optional ssh identity file. */
function IdentityFileCard({ config }: { config: DaedalusConfig }) {
  const setIdentity = useDaedalusSetIdentityFile();
  const saved = config.identityFile ?? "";
  const [path, setPath] = useState(saved);
  useEffect(() => setPath(saved), [saved]);
  const id = useId();
  const dirty = path.trim() !== saved;

  return (
    <form
      className="mt-3 rounded-xl border border-line-2 bg-raised px-4 py-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) setIdentity.mutate(path.trim() || null);
      }}
    >
      <label htmlFor={id} className="mb-[3px] block text-[12.5px] font-medium text-fg-3">
        Identity file
      </label>
      <div className="mb-2.5 text-[11.5px] text-muted-3">
        Optional. The ssh key santree uses for Daedalus, inside your home folder. Without one, ssh
        uses your agent and its usual keys.
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/.ssh/id_ed25519, as a full path"
          autoComplete="off"
          spellCheck={false}
          className={`min-w-0 flex-1 ${INPUT_CLASS}`}
        />
        <Button type="submit" disabled={!dirty || setIdentity.isPending}>
          Save
        </Button>
        <Button
          variant="ghost"
          onClick={() => setIdentity.mutate(null)}
          disabled={!saved || setIdentity.isPending}
        >
          Clear
        </Button>
      </div>
    </form>
  );
}

/** santree's own tunnel — planned, not built. The row exists so the plan is
 *  visible and the requirement it stands in for is written down. */
function VpnCard() {
  const labelId = useId();
  return (
    <div className="mt-3 flex items-center gap-[13px] rounded-xl border border-line-2 bg-raised px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span id={labelId} className="text-[12.5px] font-medium text-fg-3">
            Connect through santree's own VPN
          </span>
          <Badge color="var(--color-muted-2)">WIP</Badge>
        </div>
        <div className="mt-[3px] flex items-start gap-1.5 text-[11.5px] leading-[1.5] text-muted-3">
          <WarningIcon size={12} className="mt-[3px] flex-none text-muted-4" />
          <span>
            Planned. Until then santree reaches Daedalus only from your home network or through your
            system VPN.
          </span>
        </div>
      </div>
      <Toggle on={false} onClick={() => {}} disabled ariaLabelledBy={labelId} />
    </div>
  );
}
