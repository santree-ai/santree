/** The Settings tab: app-wide defaults and per-repo overrides. */

import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentKind, ClaudeCommand } from "../../bindings";
import { RepoAvatar } from "../../components/chrome/RepoAvatar";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import {
  AgentIcon,
  AgentsIcon,
  BoltIcon,
  ContrastIcon,
  GitHubLogo,
  LinearLogo,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  RefreshIcon,
  SunIcon,
  TelescopeIcon,
} from "../../components/icons";
import { Badge, Segmented, Tabs, Toggle } from "../../components/primitives";
import {
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_COMMAND_KEY,
  INVESTIGATE_MODEL_KEY,
  useAgentAuth,
  useAgents,
  useClaudeCommands,
  useLinearConnect,
  useLinearOrgs,
  useLinearStatus,
  useSetRepoLinearOrg,
  useSetSetting,
  useSetting,
} from "../../lib/queries";
import { type Theme, useApp } from "../../state/AppContext";
import { useTerminals } from "../terminal/TerminalsContext";

const LINEAR_BRAND = "#5e6ad2";

type Scope = "app" | "repo";

/** Only Claude Code is wired up today; the rest are shown as work-in-progress. */
const agentAvailable = (kind: AgentKind) => kind === "Claude";

const ICON_SIZE = 15;
const APP_SECTIONS = [
  { key: "integrations", label: "Integrations", icon: <PlugIcon size={ICON_SIZE} /> },
  { key: "appearance", label: "Appearance", icon: <ContrastIcon size={ICON_SIZE} /> },
  { key: "agents", label: "Agents", icon: <AgentsIcon size={ICON_SIZE} /> },
  { key: "actions", label: "Actions", icon: <BoltIcon size={ICON_SIZE} /> },
] as const;
const REPO_SECTIONS = [
  { key: "linear", label: "Linear", icon: <LinearLogo size={ICON_SIZE} /> },
  { key: "actions", label: "Actions", icon: <BoltIcon size={ICON_SIZE} /> },
] as const;

export function SettingsView() {
  const { accent, activeRepo } = useApp();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();

  const [scope, setScope] = useState<Scope>("app");
  const [section, setSection] = useState<string>("integrations");

  const goBack = () => (canGoBack ? router.history.back() : navigate({ to: "/" }));
  const switchScope = (next: Scope) => {
    setScope(next);
    setSection(next === "app" ? "integrations" : "linear");
  };

  const sections = scope === "app" ? APP_SECTIONS : REPO_SECTIONS;

  const backCell = (
    <div className="flex items-center pl-1">
      <button
        type="button"
        onClick={goBack}
        className="flex cursor-pointer items-center gap-2 rounded-md py-1 pr-2.5 pl-1.5 text-muted-2 transition-colors hover:bg-hover hover:text-fg-2"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        <span className="text-[13px] font-semibold">Settings</span>
      </button>
    </div>
  );

  const scopeTabs = (
    <div className="flex h-full items-stretch gap-0.5">
      {(
        [
          { value: "app", label: "App defaults" },
          { value: "repo", label: activeRepo },
        ] as const
      ).map((tab) => {
        const active = scope === tab.value;
        const style: CSSProperties = active
          ? {
              color: "var(--color-fg-bright)",
              fontWeight: 500,
              boxShadow: `inset 0 -2px 0 ${accent}`,
            }
          : { color: "#7c7c85" };
        return (
          <button
            type="button"
            key={tab.value}
            onClick={() => switchScope(tab.value)}
            className="flex cursor-pointer items-center gap-1.5 px-3 text-[13px]"
            style={style}
          >
            {tab.value === "repo" && <RepoAvatar repo={activeRepo} size={15} />}
            {tab.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <ViewChrome
      leftCell={backCell}
      rightCell={scopeTabs}
      showRepoSelector={false}
      sidebar={
        <div className="p-2">
          {sections.map((s) => {
            const active = section === s.key;
            const style: CSSProperties = active
              ? {
                  background: `color-mix(in srgb, ${accent} 15%, transparent)`,
                  color: "var(--color-fg-bright)",
                  boxShadow: `inset 2px 0 0 ${accent}`,
                }
              : { background: "transparent", color: "var(--color-muted)" };
            return (
              <button
                type="button"
                key={s.key}
                onClick={() => setSection(s.key)}
                className="mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-[9px] text-left text-[12.5px] hover:bg-hover"
                style={style}
              >
                <span className="flex-none opacity-90">{s.icon}</span>
                {s.label}
              </button>
            );
          })}
        </div>
      }
    >
      <div className="flex-1 overflow-y-auto bg-app">
        <div className="max-w-[660px] px-[30px] pt-[26px] pb-11">
          {scope === "app" && section === "integrations" && <IntegrationsSection />}
          {scope === "app" && section === "appearance" && <AppearanceSection />}
          {scope === "app" && section === "agents" && <AgentsSection />}
          {scope === "app" && section === "actions" && <ActionsSection />}
          {scope === "repo" && section === "linear" && <RepoLinearSection repo={activeRepo} />}
          {scope === "repo" && section === "actions" && <ActionsSection repo={activeRepo} />}
        </div>
      </div>
    </ViewChrome>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <div className="mb-1 text-[17px] font-semibold text-fg-bright">{title}</div>
      <div className="mb-[22px] text-[12.5px] text-muted-3">{subtitle}</div>
    </>
  );
}

const linearBadge = (
  <div
    className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] text-white"
    style={{ background: LINEAR_BRAND }}
  >
    <LinearLogo size={19} />
  </div>
);

function IntegrationsSection() {
  const { settings, toggleIntegration } = useApp();
  const { data: orgs = [] } = useLinearOrgs();
  const connect = useLinearConnect();
  if (!settings) return null;
  const { triage, github } = settings.integrations;
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

        <div className="flex items-center gap-[13px] border-t border-line bg-surface px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-fg-3">Triage from Linear</div>
            <div className="mt-[3px] text-[11.5px] text-muted-3">
              Pull untriaged issues into the Triage queue for investigation.
            </div>
          </div>
          <Toggle on={triage} onClick={() => toggleIntegration("triage")} />
        </div>
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

function AppearanceSection() {
  const { theme, setTheme } = useApp();
  return (
    <>
      <Heading
        title="Appearance"
        subtitle="Choose a color theme. Auto follows your system setting."
      />
      <div className="rounded-xl border border-line-2 bg-raised p-4">
        <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">Theme</div>
        <div className="mb-[11px] text-[11.5px] text-muted-3">
          Switches the whole app between light and dark.
        </div>
        <Segmented<Theme>
          options={[
            { value: "dark", label: "Dark", icon: <MoonIcon size={13} /> },
            { value: "light", label: "Light", icon: <SunIcon size={13} /> },
            { value: "auto", label: "Auto", icon: <MonitorIcon size={13} /> },
          ]}
          value={theme}
          onChange={setTheme}
        />
      </div>
    </>
  );
}

function RepoLinearSection({ repo }: { repo: string }) {
  const { data: orgs = [] } = useLinearOrgs();
  const { data: status } = useLinearStatus(repo);
  const setOrg = useSetRepoLinearOrg();
  const connect = useLinearConnect();

  return (
    <>
      <Heading
        title={`Linear · ${repo}`}
        subtitle="Choose which connected organization supplies this repo's issues."
      />

      {orgs.length === 0 ? (
        <div className="flex items-center gap-[13px] rounded-xl border border-line-2 bg-raised p-4">
          {linearBadge}
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-fg-3">No Linear orgs connected</div>
            <div className="mt-[3px] text-[11.5px] text-muted-3">
              Connect one to pull this repo's assigned issues.
            </div>
          </div>
          <button
            type="button"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
            className="cursor-pointer rounded-md border-none px-3 py-1.5 text-[12px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
            style={{ background: LINEAR_BRAND }}
          >
            {connect.isPending ? "Connecting…" : "Connect"}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-line-2 bg-raised p-4">
          <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">Issues source</div>
          <div className="mb-3 text-[11.5px] text-muted-3">
            Issues in the graph for <span className="font-mono text-fg-3">{repo}</span> come from
            this org.
          </div>
          <div className="flex items-center gap-2">
            <select
              value={status?.orgSlug ?? ""}
              onChange={(e) => setOrg.mutate({ repo, slug: e.target.value })}
              className="flex-1 cursor-pointer appearance-none rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[12px] text-fg-3"
            >
              {orgs.map((org) => (
                <option key={org.slug} value={org.slug} className="bg-input">
                  {org.name} ({org.slug})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setOrg.mutate({ repo, slug: null })}
              className="cursor-pointer rounded-md border border-line-3 bg-input px-3 py-2 text-[11.5px] text-muted hover:border-line-strong hover:text-fg-2"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Shared classes for the settings `<select>` dropdowns. */
const SELECT_CLASS =
  "w-full cursor-pointer appearance-none rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[12px] text-fg-3";

/** The Actions section: a tab bar of agent-action configs (Triage Investigation
 * today; Work / Plan / Review later). Per-scope — app defaults or repo override. */
function ActionsSection({ repo }: { repo?: string }) {
  const [tab, setTab] = useState<"triage-investigation">("triage-investigation");
  return (
    <>
      <Heading
        title="Actions"
        subtitle="Configure how each agent action runs on a ticket — pick the agent, skill, and model. More actions (Work, Plan, Review) are coming."
      />
      <Tabs
        tabs={[
          {
            value: "triage-investigation",
            label: "Triage Investigation",
            icon: <TelescopeIcon size={14} />,
          },
        ]}
        value={tab}
        onChange={setTab}
        className="mb-5"
      />
      {tab === "triage-investigation" &&
        (repo ? <RepoInvestigateBody repo={repo} /> : <AppInvestigateBody />)}
    </>
  );
}

/** A labelled field inside a settings card, divided from the previous one. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-line py-3.5 first:border-t-0 first:pt-0">
      <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">{label}</div>
      {hint && <div className="mb-2.5 text-[11.5px] text-muted-3">{hint}</div>}
      {children}
    </div>
  );
}

/** `<option>`s for a Claude command picker, grouped by source. For the app
 * scope `repoCmds` is empty, so a single flat list is rendered. */
function CommandOptions({
  globalCmds,
  repoCmds,
}: {
  globalCmds: ClaudeCommand[];
  repoCmds: ClaudeCommand[];
}) {
  const opt = (c: ClaudeCommand, k: string) => (
    <option key={k} value={c.name} className="bg-input">
      /{c.name}
    </option>
  );
  if (repoCmds.length === 0) return <>{globalCmds.map((c) => opt(c, c.name))}</>;
  return (
    <>
      <optgroup label="Repo commands">{repoCmds.map((c) => opt(c, `repo:${c.name}`))}</optgroup>
      <optgroup label="Global commands">
        {globalCmds.map((c) => opt(c, `global:${c.name}`))}
      </optgroup>
    </>
  );
}

/** A `<select>` whose empty option inherits the app default, with a Reset. */
function OverrideSelect({
  value,
  onChange,
  defaultLabel,
  children,
}: {
  value: string;
  onChange: (v: string | null) => void;
  defaultLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value || null)}
        className={`flex-1 ${SELECT_CLASS}`}
      >
        <option value="">{defaultLabel}</option>
        {children}
      </select>
      <button
        type="button"
        onClick={() => onChange(null)}
        disabled={!value}
        className="cursor-pointer rounded-md border border-line-3 bg-input px-3 py-2 text-[11.5px] text-muted hover:border-line-strong hover:text-fg-2 disabled:cursor-default disabled:opacity-50"
      >
        Reset
      </button>
    </div>
  );
}

/** App-default Triage Investigation action: pick the agent, skill, and model. */
function AppInvestigateBody() {
  const { data: agents = [] } = useAgents();
  const { data: cmds } = useClaudeCommands(null);
  const agentQ = useSetting("app", INVESTIGATE_AGENT_KEY);
  const cmdQ = useSetting("app", INVESTIGATE_COMMAND_KEY);
  const modelQ = useSetting("app", INVESTIGATE_MODEL_KEY);
  const setSetting = useSetSetting();
  const set = (key: string, value: string | null) =>
    setSetting.mutate({ scope: "app", key, value });

  const agent = (agentQ.data as AgentKind | null) ?? "Claude";
  const agentDef = agents.find((a) => a.key === agent);
  const globalCmds = cmds?.global ?? [];
  const selected = globalCmds.find((c) => c.name === cmdQ.data);

  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-1">
      <Field label="Agent" hint="Only one agent runs an action. More harnesses are coming.">
        <select
          value={agent}
          onChange={(e) => set(INVESTIGATE_AGENT_KEY, e.target.value)}
          className={SELECT_CLASS}
        >
          {agents.map((a) => (
            <option
              key={a.key}
              value={a.key}
              disabled={!agentAvailable(a.key)}
              className="bg-input"
            >
              {a.label}
              {agentAvailable(a.key) ? "" : " — WIP"}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Skill"
        hint={
          <>
            From your global commands (<span className="font-mono">~/.claude/commands</span>).
          </>
        }
      >
        {globalCmds.length === 0 ? (
          <div className="rounded-lg border border-line-3 bg-input px-[11px] py-2.5 text-[11.5px] text-muted-3">
            No commands found in <span className="font-mono">~/.claude/commands</span>.
          </div>
        ) : (
          <select
            value={cmdQ.data ?? ""}
            onChange={(e) => set(INVESTIGATE_COMMAND_KEY, e.target.value || null)}
            className={SELECT_CLASS}
          >
            <option value="">None</option>
            <CommandOptions globalCmds={globalCmds} repoCmds={[]} />
          </select>
        )}
        {selected?.description && (
          <div className="mt-2 text-[11.5px] text-muted-3">{selected.description}</div>
        )}
      </Field>
      <Field label="Model" hint="Leave on the agent default to use the model set in Agents.">
        <select
          value={modelQ.data ?? ""}
          onChange={(e) => set(INVESTIGATE_MODEL_KEY, e.target.value || null)}
          className={SELECT_CLASS}
        >
          <option value="">Agent default</option>
          {agentDef?.models.map((m) => (
            <option key={m} value={m} className="bg-input">
              {m}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Per-repo Triage Investigation overrides — each field inherits the app value
 * unless set; the skill picker separates this repo's commands from the global. */
function RepoInvestigateBody({ repo }: { repo: string }) {
  const scope = `repo:${repo}`;
  const { data: agents = [] } = useAgents();
  const { data: cmds } = useClaudeCommands(repo);
  const setSetting = useSetSetting();
  const set = (key: string, value: string | null) => setSetting.mutate({ scope, key, value });

  const appAgent = (useSetting("app", INVESTIGATE_AGENT_KEY).data as AgentKind | null) ?? "Claude";
  const appCmd = useSetting("app", INVESTIGATE_COMMAND_KEY).data;
  const appModel = useSetting("app", INVESTIGATE_MODEL_KEY).data;
  const repoAgent = useSetting(scope, INVESTIGATE_AGENT_KEY).data as AgentKind | null;
  const repoCmd = useSetting(scope, INVESTIGATE_COMMAND_KEY).data;
  const repoModel = useSetting(scope, INVESTIGATE_MODEL_KEY).data;

  const effectiveAgent = repoAgent ?? appAgent;
  const agentDef = agents.find((a) => a.key === effectiveAgent);
  const appAgentShort = agents.find((a) => a.key === appAgent)?.short ?? appAgent;
  const globalCmds = cmds?.global ?? [];
  const repoCmds = cmds?.repo ?? [];

  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-1">
      <Field label="Agent" hint="Anything left on the default inherits the app setting.">
        <OverrideSelect
          value={repoAgent ?? ""}
          onChange={(v) => set(INVESTIGATE_AGENT_KEY, v)}
          defaultLabel={`Use app default (${appAgentShort})`}
        >
          {agents.map((a) => (
            <option
              key={a.key}
              value={a.key}
              disabled={!agentAvailable(a.key)}
              className="bg-input"
            >
              {a.label}
              {agentAvailable(a.key) ? "" : " — WIP"}
            </option>
          ))}
        </OverrideSelect>
      </Field>
      <Field label="Skill" hint="From this repo's commands or your global ones.">
        <OverrideSelect
          value={repoCmd ?? ""}
          onChange={(v) => set(INVESTIGATE_COMMAND_KEY, v)}
          defaultLabel={`Use app default${appCmd ? ` (/${appCmd})` : ""}`}
        >
          <CommandOptions globalCmds={globalCmds} repoCmds={repoCmds} />
        </OverrideSelect>
      </Field>
      <Field label="Model">
        <OverrideSelect
          value={repoModel ?? ""}
          onChange={(v) => set(INVESTIGATE_MODEL_KEY, v)}
          defaultLabel={`Use app default${appModel ? ` (${appModel})` : ""}`}
        >
          {agentDef?.models.map((m) => (
            <option key={m} value={m} className="bg-input">
              {m}
            </option>
          ))}
        </OverrideSelect>
      </Field>
    </div>
  );
}

/** The Agents section: one tab per harness, each with its own auth, executable,
 * and model. Mirrors the "Harnesses" screen — agent paths live here, while which
 * agent an action uses is configured under Actions. */
function AgentsSection() {
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
          dimmed: !agentAvailable(a.key),
          badge: agentAvailable(a.key) ? undefined : <Badge color="#8a8a93">WIP</Badge>,
        }))}
        value={tab}
        onChange={setTab}
        className="mb-6"
      />
      <HarnessPanel kind={tab} />
    </>
  );
}

/** Heading + body for one block inside a harness panel. */
function Block({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-line pt-5 first:border-t-0 first:pt-0">
      <div className="text-[13px] font-medium text-fg-2">{title}</div>
      {subtitle && <div className="mt-[3px] mb-3 text-[11.5px] text-muted-3">{subtitle}</div>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </div>
  );
}

/** A single key/value row in the subscription table. */
function KvRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex border-t border-line first:border-t-0">
      <div className="w-[110px] flex-none px-3 py-2 text-[11.5px] text-muted-3">{label}</div>
      <div className="break-all px-3 py-2 text-[11.5px] text-fg-3">{value}</div>
    </div>
  );
}

/** One harness's config: authentication/subscription + executable. */
function HarnessPanel({ kind }: { kind: AgentKind }) {
  const { settings, setAgentExec } = useApp();
  const { data: agents = [] } = useAgents();
  const authQ = useAgentAuth(kind);
  const auth = authQ.data;
  const [loginOpen, setLoginOpen] = useState(false);
  if (!settings) return null;
  const def = agents.find((a) => a.key === kind);
  const conf = settings.agents.find((a) => a.key === kind);
  if (!def) return null;

  if (!agentAvailable(kind)) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-line-2 bg-raised px-6 py-10 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-input text-muted-2">
          <AgentIcon kind={kind} size={22} />
        </div>
        <div className="text-[14px] font-semibold text-fg-2">{def.label} support is coming</div>
        <div className="max-w-[380px] text-[12px] text-muted-3">
          This harness is a work in progress. For now, Claude Code is the only configurable agent.
        </div>
        <Badge color="#8a8a93">WIP</Badge>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Block title="Authentication">
        <div className="grid grid-cols-2 gap-3">
          <div
            className="relative flex flex-col items-center justify-center gap-1.5 rounded-xl border bg-input py-5"
            style={{
              borderColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
              background: "color-mix(in srgb, var(--accent) 7%, transparent)",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-fg-2"
              aria-hidden
            >
              <path d="m4 17 6-5-6-5M12 19h8" />
            </svg>
            <span className="text-[12px] font-medium text-fg-2">CLI</span>
            <span className="absolute top-2.5 right-2.5" style={{ color: "var(--accent)" }}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
          </div>
          <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-line-3 py-5 opacity-55">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted-2"
              aria-hidden
            >
              <circle cx="7.5" cy="15.5" r="4.5" />
              <path d="m10.5 12.5 8-8M16 6l2 2M19 3l2 2" />
            </svg>
            <span className="text-[12px] font-medium text-muted-2">API key</span>
            <span className="mt-0.5">
              <Badge color="#8a8a93">WIP</Badge>
            </span>
          </div>
        </div>

        {auth && (
          <>
            <div className="mt-3.5 mb-2 flex items-center justify-between">
              <Badge color={auth.connected ? "#3fb950" : "var(--color-status-amber)"}>
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
              <button
                type="button"
                onClick={() => setLoginOpen(true)}
                className="mt-3 flex cursor-pointer items-center gap-2 rounded-md border border-line-3 bg-input px-3 py-1.5 text-[12px] font-medium text-fg-3 hover:border-line-strong"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M8 5v14l11-7z" />
                </svg>
                Run <span className="font-mono">{auth.loginCmd}</span>
              </button>
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
            value={conf?.exec ?? ""}
            onChange={(e) => setAgentExec(kind, e.target.value)}
            placeholder={auth?.detectedExec || `path to ${def.short}`}
            className="w-full flex-1 rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3 placeholder:text-muted-4"
          />
          {conf?.exec?.trim() && (
            <button
              type="button"
              onClick={() => setAgentExec(kind, "")}
              className="cursor-pointer whitespace-nowrap rounded-md border border-line-3 bg-input px-3 py-2 text-[11.5px] text-muted hover:border-line-strong hover:text-fg-2"
            >
              Use detected
            </button>
          )}
        </div>
        {!conf?.exec?.trim() && !auth?.detectedExec && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-status-amber">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
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
    </div>
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
  const { tabs, ensure, close, setEmbed } = useTerminals();
  const hostRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<string | null>(null);
  const seenRef = useRef(false);

  // Layout effect so the embed tears down synchronously with the DOM commit
  // (see InvestigatePane) and never lingers over other content.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const key = ensure({ title: command, source: "shell", refId, seed: command });
    keyRef.current = key;
    seenRef.current = false;
    const r = host.getBoundingClientRect();
    setEmbed({ host, key, rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
    return () => setEmbed(null);
  }, [refId, command, ensure, setEmbed]);

  // When the login process exits its tab is removed — auto-close the panel.
  useEffect(() => {
    const key = keyRef.current;
    if (!key) return;
    if (tabs.some((t) => t.key === key)) seenRef.current = true;
    else if (seenRef.current) {
      keyRef.current = null;
      onClose();
    }
  }, [tabs, onClose]);

  const closeNow = () => {
    const key = keyRef.current;
    if (key) close(key);
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
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="h-[280px] bg-panel">
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
