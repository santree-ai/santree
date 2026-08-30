/** The Agents sections: one settings item per harness, each with its own auth,
 * executable, version, and provider-specific behavior. The left nav is the
 * switch between them. Workflow models live under Actions. */

import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import type { AgentKind } from "../../../bindings";
import {
  CheckIcon,
  CliIcon,
  KeyIcon,
  PlayIcon,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { Badge, Button } from "../../../components/primitives";
import {
  CLAUDE_REMOTE_CONTROL_KEY,
  CLAUDE_START_WITH_CHROME_KEY,
  CLAUDE_STATUS_LINE_KEY,
  useAgentAuth,
  useAgents,
  useAgentVersionStatus,
  useBoolSetting,
  useClaudeGlobalCapture,
  useCodexAccount,
  useCodexHealth,
  useCodexLogout,
  useCodexRateLimits,
  useSetClaudeGlobalCapture,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { useApp } from "../../../state/AppContext";
import { alpha } from "../../../theme/colors";
import { agentProvider } from "../../terminal/agentProvider";
import { LoginTerminal } from "../LoginTerminal";
import { Block, Heading, KvRow, ToggleRow } from "../widgets";

export const ClaudeAgentSection = () => <ProviderSection kind="Claude" name="Claude Code" />;
export const CodexAgentSection = () => <ProviderSection kind="Codex" name="Codex" />;

/** One provider's whole configuration. `name` is the nav's label, used until the
 *  catalog answers so the title never flickers into place. */
function ProviderSection({ kind, name }: { kind: AgentKind; name: string }) {
  const { data: agents = [] } = useAgents();
  const def = agents.find((a) => a.key === kind);

  return (
    <>
      <Heading
        title={def?.label ?? name}
        subtitle="Connect and maintain this provider here. Which provider and model performs a job is configured separately under Workflow defaults."
      />
      <HarnessPanel kind={kind} />
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

  if (!settings) return null;
  const def = agents.find((a) => a.key === kind);
  const conf = settings.agents?.find((a) => a.key === kind);
  if (!def) return null;

  const provider = agentProvider(kind);
  if (provider.capabilities.settingsPanel === "codex") return <CodexPanel />;

  const savedExec = conf?.exec ?? "";
  const execValue = execDraft ?? savedExec;
  const commitExec = () => {
    if (execDraft !== null && execDraft !== savedExec) setAgentExec(kind, execDraft);
    setExecDraft(null);
  };

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
            Couldn't find {def.short} on your PATH. Set the path manually.
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

      {provider.capabilities.terminalSettings === "claude" && <ClaudeVersionBlock />}

      {provider.capabilities.terminalSettings === "claude" && <ClaudeTerminalBlock />}
    </div>
  );
}

function CodexPanel() {
  const { settings, setAgentExec } = useApp();
  const health = useCodexHealth();
  const account = useCodexAccount(health.data?.available === true);
  const limits = useCodexRateLimits(account.data?.connected === true);
  const logout = useCodexLogout();
  const configured = settings?.agents?.find((agent) => agent.key === "Codex");
  const [execDraft, setExecDraft] = useState<string | null>(null);
  if (!settings) return null;
  const savedExec = configured?.exec ?? "";
  const exec = execDraft ?? savedExec;
  const commitExec = () => {
    if (execDraft !== null && execDraft !== savedExec) setAgentExec("Codex", execDraft);
    setExecDraft(null);
  };
  const formatWindow = (
    window: { usedPercent: number | null; windowMinutes: number | null } | null,
  ) =>
    window
      ? `${Math.round(window.usedPercent ?? 0)}% used · ${window.windowMinutes ?? "?"} min window`
      : "Unavailable";

  return (
    <div className="flex flex-col gap-5">
      <Block
        title="Codex CLI"
        subtitle="Santree launches the real `codex` binary in a terminal. There is no santree-owned Codex service."
      >
        <div className="mb-3 flex items-center justify-between">
          <Badge
            color={
              health.data?.available ? "var(--color-status-green)" : "var(--color-status-amber)"
            }
          >
            {health.data?.available ? "Ready" : "Unavailable"}
          </Badge>
          <button
            type="button"
            onClick={() => health.refetch()}
            aria-label="Refresh Codex CLI status"
            className="cursor-pointer text-[11px] text-muted-2 hover:text-fg-2"
          >
            <RefreshIcon size={12} className={health.isFetching ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
          <KvRow label="Version" value={health.data?.version || "Not detected"} />
          <KvRow label="Executable" value={health.data?.executable || "Not found"} />
        </div>
        {health.data?.error && (
          <div className="mt-2 text-[11px] text-status-amber">{health.data.error}</div>
        )}
      </Block>

      <Block
        title="Authentication"
        subtitle="Codex owns and stores all credentials. Santree never receives tokens or API keys — it asks `codex login status`."
      >
        <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
          <KvRow label="Status" value={account.data?.connected ? "Signed in" : "Not signed in"} />
          <KvRow label="Method" value={account.data?.authType || "—"} />
        </div>
        {account.error && (
          <div className="mt-2 text-[11px] text-status-amber">{account.error.message}</div>
        )}
        {!account.data?.connected && (
          <div className="mt-2 text-[11px] leading-[1.55] text-muted-3">
            Sign in with <code className="font-mono text-fg-2">codex login</code> in a terminal. It
            opens a browser and finishes in the CLI; Santree watches for it and updates here.
          </div>
        )}
        {account.data?.connected && (
          <div className="mt-3 flex gap-2">
            <Button
              onClick={() => {
                if (window.confirm("Sign out of the shared Codex CLI account on this machine?"))
                  logout.mutate();
              }}
            >
              Sign out globally
            </Button>
          </div>
        )}
      </Block>

      <Block
        title="Rate limits"
        subtitle="From Codex's own record of its last turn — it does not update until you run Codex again."
      >
        <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
          <KvRow label="Plan" value={limits.data?.plan || "—"} />
          <KvRow label="Primary" value={formatWindow(limits.data?.primary ?? null)} />
          <KvRow label="Secondary" value={formatWindow(limits.data?.secondary ?? null)} />
        </div>
        {limits.error && (
          <div className="mt-2 text-[11px] text-status-amber">{limits.error.message}</div>
        )}
      </Block>

      <Block
        title="Codex executable path"
        subtitle="Leave empty to use the executable found on PATH."
      >
        <input
          type="text"
          value={exec}
          onChange={(event) => setExecDraft(event.target.value)}
          onBlur={commitExec}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          placeholder={health.data?.executable || "path to codex"}
          className="w-full rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px]"
        />
      </Block>
    </div>
  );
}

const CHROME_EXTENSION_URL = "https://code.claude.com/docs/en/chrome";

function ClaudeVersionBlock() {
  const versions = useAgentVersionStatus("Claude");
  const current = versions.data?.installed ?? "Not detected";
  const latest = versions.data?.latest ?? "Unavailable";

  return (
    <Block
      title="Version"
      subtitle="Santree only checks for updates. Install Claude Code updates through its own installer or package manager."
    >
      <div className="mb-3 flex items-center justify-between">
        {versions.data?.updateAvailable ? (
          <Badge color="var(--color-status-amber)">Update available</Badge>
        ) : versions.data?.installed && versions.data.latest ? (
          <Badge color="var(--color-status-green)">Up to date</Badge>
        ) : (
          <Badge color="var(--color-muted-2)">Unknown</Badge>
        )}
        <button
          type="button"
          onClick={() => versions.refetch()}
          aria-label="Refresh Claude Code versions"
          className="cursor-pointer text-[11px] text-muted-2 hover:text-fg-2"
        >
          <RefreshIcon size={12} className={versions.isFetching ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
        <KvRow label="Installed" value={current} />
        <KvRow label="Latest" value={latest} />
      </div>
    </Block>
  );
}

/** Claude-only launch/terminal behavior toggles: launch with `--chrome` (browser
 *  control), and show santree's inline context-usage bar. santree always injects
 *  its own status line into the sessions it launches (leaving the user's own
 *  `~/.claude/settings.json` untouched), so usage is always captured; the toggle
 *  only gates the status bar's own segment (see `SessionSegment`). */
function ClaudeTerminalBlock() {
  const remoteControl = useSetting("app", CLAUDE_REMOTE_CONTROL_KEY);
  const { value: startWithChrome } = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY);
  const { value: santreeStatusLine } = useBoolSetting("app", CLAUDE_STATUS_LINE_KEY);
  const capture = useClaudeGlobalCapture();
  const setCapture = useSetClaudeGlobalCapture();
  const { mutate: setSetting } = useSetSetting();
  const set = (key: string, next: boolean) =>
    setSetting({ scope: "app", key, value: next ? "true" : "false" });

  return (
    <Block title="Behavior">
      <div className="rounded-xl border border-line-3 bg-surface px-3.5 py-0.5">
        <ToggleRow
          label="Enable Remote Control"
          hint="Name Claude work and investigation sessions for Claude's Remote Control web. Turn this off if the installed Claude Code version does not support --remote-control."
          on={remoteControl.data !== "false"}
          onChange={(next) =>
            setSetting({
              scope: "app",
              key: CLAUDE_REMOTE_CONTROL_KEY,
              value: next ? null : "false",
            })
          }
        />
        <ToggleRow
          label="Start with Chrome"
          hint={
            <>
              Launch Claude with the <span className="font-mono">--chrome</span> flag so it can
              control your browser. Requires the{" "}
              <a
                href={CHROME_EXTENSION_URL}
                target="_blank"
                rel="noreferrer"
                // WKWebView ignores target="_blank" (see Markdown.tsx) — hand the URL to
                // the opener plugin instead, keeping the href for right-click-to-copy.
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl(CHROME_EXTENSION_URL);
                }}
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
          hint="Show the open workspace's live context-fill bar in the status bar, in sync with the terminal's own status line. Usage is always captured from santree's status line; this only toggles the in-app bar, so it reflects instantly on sessions that are already running."
          on={santreeStatusLine}
          onChange={(next) => set(CLAUDE_STATUS_LINE_KEY, next)}
        />
        <ToggleRow
          label="Capture usage from all Claude sessions"
          hint={
            <>
              Feed the usage meters from every Claude Code session on this Mac, not only the ones
              santree starts. santree wraps the status line in{" "}
              <span className="font-mono">
                {capture.data?.settingsPath ?? "~/.claude/settings.json"}
              </span>
              {capture.data?.originalCommand
                ? " so it records the usage windows and then runs your own status line unchanged"
                : " with its own status line"}
              . Reversible from here; a backup of the file is kept. If santree is removed while this
              is on, turn it off first or restore the backup, or Claude's status line will error.
            </>
          }
          on={capture.data?.enabled === true}
          disabled={capture.data === undefined || setCapture.isPending}
          onChange={(next) => setCapture.mutate(next)}
        />
      </div>
    </Block>
  );
}
