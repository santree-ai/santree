/** Settings → Integrations → Daedalus: the home server that Daedalus projects
 *  live and run on (docs/remote.md).
 *
 *  Nothing to configure: santree reaches Daedalus through the Daedalus agent on
 *  this Mac, which the box already knows and approves. The pane is one status
 *  card — how the link is, what to do when it isn't, and a way to try again
 *  now. Not reaching it is normal, so every state is a line here, never a
 *  toast. */

import { type ReactNode, useState } from "react";

import type {
  DaedalusLink,
  DaedalusMachineSettings,
  DaedalusSettingAnswer,
  DaedalusSettingKey,
} from "../../../bindings";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  DaedalusLogo,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { copyText } from "../../../components/menuRows";
import { Button, Toggle } from "../../../components/primitives";
import { TurnOnSantree } from "../../../components/TurnOnSantree";
import { type LinkTone, linkNotice, SANTREE_OFF } from "../../../lib/daedalusLink";
import {
  useDaedalusHealth,
  useDaedalusMachine,
  useDaedalusStatus,
  useSetDaedalusSetting,
} from "../../../lib/queries";
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
      <ThisMacCard />
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
  const santreeOff = !checking && link?.kind === "SantreeOff";

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
            <div className="text-[12.5px] font-medium text-fg-3">
              {/* The action is the button below; the title names the state. */}
              {santreeOff ? SANTREE_OFF : notice.title}
            </div>
            {notice.detail && link?.kind !== "Connected" && (
              <div className="mt-0.5 text-[11.5px] leading-[1.5] break-words text-muted-3">
                {notice.detail}
              </div>
            )}
            {santreeOff && <TurnOnSantree className="mt-2" />}
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

/** The three settings this Mac may ask the box for, in the order the menu bar
 *  shows them. */
const MACHINE_SETTINGS: { key: DaedalusSettingKey; label: string; hint: string }[] = [
  {
    key: "AwakeHold",
    label: "Keep awake",
    hint: "This Mac doesn't go to sleep, so Daedalus can always reach it.",
  },
  {
    key: "ClaudeRemoteControl",
    label: "Claude Remote Control",
    hint: "Daedalus's admins can steer Claude Code on this Mac through Remote Control.",
  },
  {
    key: "Santree",
    label: "santree on the box",
    hint: "santree on this Mac can open terminals and run commands on the box. Turning it on asks an admin to confirm in the browser.",
  },
];

function keptValue(s: DaedalusMachineSettings, key: DaedalusSettingKey): boolean {
  switch (key) {
    case "AwakeHold":
      return s.awakeHold;
    case "ClaudeRemoteControl":
      return s.claudeRemoteControl;
    case "Santree":
      return s.santree;
  }
}

/** "This Mac": the settings the box keeps for this machine, asked for through
 *  the Daedalus agent here. The box decides them, so a switch shows the value
 *  on its way until the box carries it, and why when it doesn't. */
function ThisMacCard() {
  const machine = useDaedalusMachine();
  const data = machine.data;
  // No agent: the status card above already says to install it.
  if (!data || data.kind === "AgentMissing") return null;
  return (
    <section
      aria-label="This Mac"
      className="mt-4 overflow-hidden rounded-xl border border-line-2 bg-raised"
    >
      <div className="px-4 pt-3.5 pb-1">
        <div className="text-[13px] font-semibold text-fg-bright">This Mac</div>
        <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
          Daedalus keeps these for this Mac. A change is asked of the box, which applies it within
          seconds. The menu bar and Daedalus › Settings › Machines show the same settings.
        </div>
      </div>
      {data.kind === "AgentOutdated" && (
        <Notice tone="warn" text="Update the Daedalus agent to change this Mac's settings here." />
      )}
      {data.kind === "Unavailable" && (
        <Notice tone="error" text={`Can't read this Mac's settings: ${data.reason}`} />
      )}
      {data.kind === "Ready" && <MachineSwitches settings={data.settings} />}
    </section>
  );
}

function Notice({ tone, text }: { tone: "warn" | "error"; text: string }) {
  return (
    <div className="flex items-start gap-2.5 px-4 py-3">
      <ToneGlyph tone={tone} />
      <div className="min-w-0 flex-1 text-[12px] break-words text-fg-3">{text}</div>
    </div>
  );
}

function MachineSwitches({ settings }: { settings: DaedalusMachineSettings }) {
  const set = useSetDaedalusSetting();
  // What the agent answered the last ask of each setting — shown until the
  // settings say more (pending, failed) or the next ask.
  const [answers, setAnswers] = useState<
    Partial<Record<DaedalusSettingKey, DaedalusSettingAnswer>>
  >({});
  const ask = (key: DaedalusSettingKey, value: boolean) => {
    setAnswers((a) => ({ ...a, [key]: undefined }));
    set.mutate(
      { key, value },
      { onSuccess: (answer) => setAnswers((a) => ({ ...a, [key]: answer })) },
    );
  };
  const readOnly = !settings.mayChange
    ? `Only ${settings.operator ?? "the user who installed the Daedalus agent"} can change these on this Mac.`
    : !settings.linked
      ? "Changes need the box, and the Daedalus agent isn't connected to it right now."
      : null;

  return (
    <div className="px-4 pb-1">
      {MACHINE_SETTINGS.map(({ key, label, hint }) => (
        <MachineSwitch
          key={key}
          settingKey={key}
          label={label}
          hint={hint}
          settings={settings}
          answer={answers[key]}
          onAsk={(value) => ask(key, value)}
        />
      ))}
      {readOnly && (
        <div className="border-t border-line py-3 text-[11.5px] leading-[1.5] text-muted-3">
          {readOnly}
        </div>
      )}
      {settings.fingerprint && (
        <div className="flex items-center gap-2 border-t border-line py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-fg-3">This Mac's key</div>
            <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
              Daedalus asks for its first characters when you turn santree on.
            </div>
          </div>
          <span className="font-mono text-[11.5px] text-fg-3" title={settings.fingerprint}>
            {settings.fingerprintShort ?? settings.fingerprint}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Copy this Mac's key"
            onClick={() => copyText(settings.fingerprint ?? "", "This Mac's key")}
          >
            <CopyIcon size={12} />
          </Button>
        </div>
      )}
    </div>
  );
}

function MachineSwitch({
  settingKey: key,
  label,
  hint,
  settings,
  answer,
  onAsk,
}: {
  settingKey: DaedalusSettingKey;
  label: string;
  hint: string;
  settings: DaedalusMachineSettings;
  answer: DaedalusSettingAnswer | undefined;
  onAsk: (value: boolean) => void;
}) {
  const kept = keptValue(settings, key);
  const pending = settings.pending.find((p) => p.key === key);
  const failed = settings.failed.find((f) => f.key === key);
  // On its way to the box, the switch shows where it is going; waiting on the
  // browser, it stays off until an admin has confirmed it.
  const on = pending?.via === "Box" ? pending.want : kept;
  const next = !on;
  // Only santree ON goes through the browser, and so needs no link.
  const needsLink = !(key === "Santree" && next);
  const disabled = !settings.mayChange || (needsLink && !settings.linked);

  let status: ReactNode = <span className="text-muted-3">{hint}</span>;
  if (pending?.via === "Box") {
    status = (
      <span className="flex items-center gap-1.5 text-muted-3">
        <RefreshIcon size={11} className="animate-spin" />
        Sending to Daedalus…
      </span>
    );
  } else if (pending?.via === "Browser") {
    status = (
      <span className="text-muted-3">
        Waiting for your OK in the browser.{" "}
        <button
          type="button"
          onClick={() => onAsk(true)}
          disabled={!settings.mayChange}
          className="cursor-pointer underline-offset-2 hover:underline disabled:cursor-default"
          style={{ color: "var(--accent-text)" }}
        >
          Open again
        </button>
        {settings.fingerprintShort && ` · This Mac's key starts ${settings.fingerprintShort}`}
      </span>
    );
  } else if (failed) {
    status = <span className="text-status-amber">Not changed: {failed.why}</span>;
  } else if (answer?.kind === "Refused") {
    status = <span className="text-status-amber">Not changed: {answer.reason}</span>;
  } else if (answer?.kind === "AgentOutdated") {
    status = (
      <span className="text-status-amber">Update the Daedalus agent to change this here.</span>
    );
  }

  const labelId = `machine-setting-${key}`;
  return (
    <div className="flex items-center gap-[13px] border-t border-line py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div id={labelId} className="text-[12.5px] font-medium text-fg-3">
          {label}
        </div>
        <div aria-live="polite" className="mt-[3px] text-[11.5px] leading-[1.5] break-words">
          {status}
        </div>
      </div>
      <Toggle on={on} onClick={() => onAsk(next)} disabled={disabled} ariaLabelledBy={labelId} />
    </div>
  );
}
