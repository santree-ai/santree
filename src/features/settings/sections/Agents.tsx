/** The Agents section: one tab per harness, each with its own auth, executable,
 * and model. Mirrors the "Harnesses" screen — agent paths live here, while which
 * agent an action uses is configured under Actions. */

import { useEffect, useState } from "react";

import type { AgentKind } from "../../../bindings";
import {
  AgentIcon,
  CheckIcon,
  CliIcon,
  CloseIcon,
  KeyIcon,
  PlayIcon,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { Badge, Button, Tabs } from "../../../components/primitives";
import { agentAvailable } from "../../../lib/format";
import {
  CLAUDE_START_WITH_CHROME_KEY,
  CLAUDE_STATUS_LINE_KEY,
  useAgentAuth,
  useAgents,
  useBoolSetting,
  useSetSetting,
} from "../../../lib/queries";
import { useApp } from "../../../state/AppContext";
import { alpha } from "../../../theme/colors";
import { useEmbeddedTerminal } from "../../terminal/useEmbeddedTerminal";
import { Block, Heading, KvRow, ToggleRow } from "../widgets";

export function AgentsSection() {
  const { data: agents = [] } = useAgents();
  const [tab, setTab] = useState<AgentKind>("Claude");

  return (
    <>
      <Heading
        title="Agents"
        subtitle="Each agent harness has its own authentication, executable, and model. Choose which one an action uses under Actions."
      />
      <Tabs
        tabs={agents.map((a) => ({
          value: a.key,
          label: a.label,
          icon: <AgentIcon kind={a.key} size={14} />,
          dimmed: !agentAvailable(a),
          badge: agentAvailable(a) ? undefined : <Badge color="var(--color-muted-2)">WIP</Badge>,
        }))}
        value={tab}
        onChange={setTab}
        className="mb-6"
      />
      <HarnessPanel kind={tab} />
    </>
  );
}

/** One harness's config: authentication/subscription + executable. */
function HarnessPanel({ kind }: { kind: AgentKind }) {
  const { settings, setAgentExec } = useApp();
  const { data: agents = [] } = useAgents();
  const authQ = useAgentAuth(kind);
  const auth = authQ.data;
  const [loginOpen, setLoginOpen] = useState(false);
  // Local draft for the executable path: null means "showing the saved value
  // as-is". Committing on every keystroke would fire a full-settings-blob
  // write per character (see SetupScriptField in Trees.tsx for the same
  // pattern applied to the setup-script textarea); instead we buffer edits
  // locally and only call setAgentExec on blur/Enter.
  const [execDraft, setExecDraft] = useState<string | null>(null);
  // Reset the draft when switching harness tabs so we don't carry one agent's
  // in-progress edit over to another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on kind change.
  useEffect(() => setExecDraft(null), [kind]);

  if (!settings) return null;
  const def = agents.find((a) => a.key === kind);
  const conf = settings.agents?.find((a) => a.key === kind);
  if (!def) return null;

  const savedExec = conf?.exec ?? "";
  const execValue = execDraft ?? savedExec;
  const commitExec = () => {
    if (execDraft !== null && execDraft !== savedExec) setAgentExec(kind, execDraft);
    setExecDraft(null);
  };

  if (!agentAvailable(def)) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-line-2 bg-raised px-6 py-10 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-input text-muted-2">
          <AgentIcon kind={kind} size={22} />
        </div>
        <div className="text-[14px] font-semibold text-fg-2">{def.label} support is coming</div>
        <div className="max-w-[380px] text-[12px] text-muted-3">
          This harness is a work in progress. For now, Claude Code is the only configurable agent.
        </div>
        <Badge color="var(--color-muted-2)">WIP</Badge>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Block title="Authentication">
        <div className="grid grid-cols-2 gap-3">
          <div
            className="relative flex flex-col items-center justify-center gap-1.5 rounded-xl border bg-input py-5"
            style={{ borderColor: alpha(45), background: alpha(7) }}
          >
            <CliIcon size={20} className="text-fg-2" />
            <span className="text-[12px] font-medium text-fg-2">CLI</span>
            <span className="absolute top-2.5 right-2.5" style={{ color: "var(--accent)" }}>
              <CheckIcon size={14} />
            </span>
          </div>
          <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-line-3 py-5 opacity-55">
            <KeyIcon size={20} className="text-muted-2" />
            <span className="text-[12px] font-medium text-muted-2">API key</span>
            <span className="mt-0.5">
              <Badge color="var(--color-muted-2)">WIP</Badge>
            </span>
          </div>
        </div>

        {auth && (
          <>
            <div className="mt-3.5 mb-2 flex items-center justify-between">
              <Badge
                color={auth.connected ? "var(--color-status-green)" : "var(--color-status-amber)"}
              >
                {auth.connected ? "Connected" : "Not connected"}
              </Badge>
              <button
                type="button"
                onClick={() => authQ.refetch()}
                className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted-2 transition-colors hover:text-fg-2"
              >
                <RefreshIcon size={12} className={authQ.isFetching ? "animate-spin" : ""} />
                Refresh
              </button>
            </div>
            <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
              <KvRow label="Provider" value={auth.provider} />
              <KvRow label="Plan" value={auth.plan} />
              <KvRow label="Org" value={auth.org} />
              <KvRow label="Account" value={auth.account} />
            </div>
            {!loginOpen && (
              <Button onClick={() => setLoginOpen(true)} className="mt-3">
                <PlayIcon size={11} />
                Run <span className="font-mono">{auth.loginCmd}</span>
              </Button>
            )}
            {loginOpen && (
              <LoginTerminal
                refId={`login:${kind}`}
                command={auth.loginCmd}
                onClose={() => setLoginOpen(false)}
              />
            )}
          </>
        )}
      </Block>

      <Block
        title={`${def.label} executable path`}
        subtitle="Override the detected executable with a custom one. Leave empty to use the one found on your PATH (recommended)."
      >
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={execValue}
            onChange={(e) => setExecDraft(e.target.value)}
            onBlur={commitExec}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder={auth?.detectedExec || `path to ${def.short}`}
            className="w-full flex-1 rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3 placeholder:text-muted-4"
          />
          {execValue.trim() && (
            <Button
              onClick={() => {
                setExecDraft(null);
                setAgentExec(kind, "");
              }}
              className="whitespace-nowrap"
            >
              Use detected
            </Button>
          )}
        </div>
        {!execValue.trim() && !auth?.detectedExec && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-status-amber">
            <WarningIcon size={12} />
            Couldn't find {def.short} on your PATH — set the path manually.
          </div>
        )}
      </Block>

      {auth && (
        <Block title={`${def.label} settings`}>
          <div className="flex items-center justify-between rounded-lg border border-line-3 bg-surface px-3 py-2.5">
            <span className="font-mono text-[11.5px] text-muted-2">{auth.settingsPath}</span>
          </div>
        </Block>
      )}

      {kind === "Claude" && <ClaudeTerminalBlock />}
    </div>
  );
}

/** Claude-only launch/terminal behavior toggles: launch with `--chrome` (browser
 *  control), and show santree's inline context-usage bar. santree always injects
 *  its own status line into the sessions it launches (leaving the user's own
 *  `~/.claude/settings.json` untouched), so usage is always captured; the toggle
 *  only gates the in-app bar. */
function ClaudeTerminalBlock() {
  const { value: startWithChrome } = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY);
  const { value: santreeStatusLine } = useBoolSetting("app", CLAUDE_STATUS_LINE_KEY);
  const { mutate: setSetting } = useSetSetting();
  const set = (key: string, next: boolean) =>
    setSetting({ scope: "app", key, value: next ? "true" : "false" });

  return (
    <Block title="Behavior">
      <div className="rounded-xl border border-line-3 bg-surface px-3.5 py-0.5">
        <ToggleRow
          label="Start with Chrome"
          hint={
            <>
              Launch Claude with the <span className="font-mono">--chrome</span> flag so it can
              control your browser. Requires the{" "}
              <a
                href="https://code.claude.com/docs/en/chrome"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-line-strong underline-offset-2 hover:text-fg-2"
              >
                Claude Code Chrome extension
              </a>
              .
            </>
          }
          on={startWithChrome}
          onChange={(next) => set(CLAUDE_START_WITH_CHROME_KEY, next)}
        />
        <ToggleRow
          label="Show inline context usage"
          hint="Display each Claude session's live context-fill bar inside santree, in sync with the terminal's status line. Usage is always captured from santree's own status line; this only toggles the in-app bar, so it reflects instantly on sessions that are already running."
          on={santreeStatusLine}
          onChange={(next) => set(CLAUDE_STATUS_LINE_KEY, next)}
        />
      </div>
    </Block>
  );
}

/** A small embedded terminal that runs an agent's login command in place — the
 * persistent TerminalLayer overlays the host div below the auth table. */
function LoginTerminal({
  refId,
  command,
  onClose,
}: {
  refId: string;
  command: string;
  onClose: () => void;
}) {
  const { hostRef, close } = useEmbeddedTerminal({
    spec: { title: command, source: "shell", refId, seed: command },
    onExited: onClose,
  });

  const closeNow = () => {
    close();
    onClose();
  };

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-line-3">
      <div className="flex items-center justify-between bg-input px-3 py-2">
        <span className="text-[11.5px] text-muted-2">
          Running <span className="font-mono text-fg-3">{command}</span>
        </span>
        <button
          type="button"
          onClick={closeNow}
          aria-label="Close"
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-3 hover:bg-hover hover:text-fg-2"
        >
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="h-[280px] bg-panel">
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
