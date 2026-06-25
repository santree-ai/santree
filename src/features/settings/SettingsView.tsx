/** The Settings tab: app-wide defaults and per-repo overrides. */

import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useState } from "react";

import { ViewChrome } from "../../components/chrome/ViewChrome";
import { AgentIcon, GitHubLogo, LinearLogo } from "../../components/icons";
import { Badge, Segmented, Toggle } from "../../components/primitives";
import {
  useAgents,
  useLinearConnect,
  useLinearOrgs,
  useLinearStatus,
  useSetRepoLinearOrg,
} from "../../lib/queries";
import { useApp } from "../../state/AppContext";

const LINEAR_BRAND = "#5e6ad2";

type Scope = "app" | "repo";

const APP_SECTIONS = [
  { key: "integrations", label: "Integrations" },
  { key: "agents", label: "Agents" },
] as const;
const REPO_SECTIONS = [{ key: "linear", label: "Linear" }] as const;

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
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={goBack}
        aria-label="Back"
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-line-3 text-muted-2 transition-colors hover:border-line-strong hover:text-fg-2"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <span className="text-[13px] font-semibold text-fg-2">Settings</span>
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
          ? { color: "#ededf2", fontWeight: 500, boxShadow: `inset 0 -2px 0 ${accent}` }
          : { color: "#7c7c85" };
        return (
          <button
            type="button"
            key={tab.value}
            onClick={() => switchScope(tab.value)}
            className="cursor-pointer px-3 text-[13px]"
            style={style}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <ViewChrome
      sidebarWidth={230}
      leftCell={backCell}
      rightCell={scopeTabs}
      sidebar={
        <div className="flex w-[230px] flex-none flex-col border-r border-line bg-panel">
          <div className="p-2">
            {sections.map((s) => {
              const active = section === s.key;
              const style: CSSProperties = active
                ? {
                    background: `color-mix(in srgb, ${accent} 15%, transparent)`,
                    color: "#ededf2",
                    boxShadow: `inset 2px 0 0 ${accent}`,
                  }
                : { background: "transparent", color: "#9b9ba3" };
              return (
                <button
                  type="button"
                  key={s.key}
                  onClick={() => setSection(s.key)}
                  className="mb-0.5 w-full cursor-pointer rounded-md px-3 py-[9px] text-left text-[12.5px] hover:bg-[#15161a]"
                  style={style}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
      }
    >
      <div className="flex-1 overflow-y-auto bg-app">
        <div className="max-w-[660px] px-[30px] pt-[26px] pb-11">
          {scope === "app" && section === "integrations" && <IntegrationsSection />}
          {scope === "app" && section === "agents" && <AgentsSection />}
          {scope === "repo" && section === "linear" && <RepoLinearSection repo={activeRepo} />}
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

      <div className="mb-3.5 overflow-hidden rounded-xl border border-line-2 bg-[#101114]">
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

      <div className="flex items-center gap-[13px] rounded-xl border border-line-2 bg-[#101114] p-4">
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
        <div className="flex items-center gap-[13px] rounded-xl border border-line-2 bg-[#101114] p-4">
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
        <div className="rounded-xl border border-line-2 bg-[#101114] p-4">
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

function AgentsSection() {
  const { settings, setDefaultAgent, setAgentExec, setAgentModel } = useApp();
  const { data: agents = [] } = useAgents();
  if (!settings) return null;

  return (
    <>
      <Heading
        title="Agents"
        subtitle="Pick a default agent and per-provider model. Override the agent and model per task when launching — handy for spreading load across subscriptions."
      />

      <div className="mb-[18px] rounded-xl border border-line-2 bg-[#101114] p-4">
        <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">Default agent</div>
        <div className="mb-[11px] text-[11.5px] text-muted-3">Pre-selected in the launch tray.</div>
        <Segmented
          options={agents.map((a) => ({
            value: a.key,
            label: a.short,
            icon: <AgentIcon kind={a.key} size={13} />,
          }))}
          value={settings.defaultAgent}
          onChange={setDefaultAgent}
        />
      </div>

      {agents.map((def) => {
        const conf = settings.agents.find((a) => a.key === def.key);
        const isDefault = settings.defaultAgent === def.key;
        return (
          <div key={def.key} className="mb-3 rounded-xl border border-line-2 bg-[#101114] p-4">
            <div className="mb-3.5 flex items-center gap-2.5">
              <AgentIcon kind={def.key} size={16} className="text-fg-2" />
              <span className="text-[13.5px] font-semibold text-fg-bright">{def.label}</span>
              <span
                className="rounded-[5px] px-[7px] py-0.5 font-mono text-[9px] tracking-[.04em] uppercase"
                style={
                  isDefault
                    ? {
                        color: "var(--accent)",
                        border: "1px solid color-mix(in srgb, var(--accent) 27%, transparent)",
                        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                      }
                    : { color: "#6b6b73", border: "1px solid #2a2a31", background: "transparent" }
                }
              >
                default
              </span>
            </div>
            <div className="flex flex-wrap gap-3.5">
              <div className="min-w-[220px] flex-1">
                <div className="mb-1.5 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
                  Executable path
                </div>
                <input
                  type="text"
                  value={conf?.exec ?? ""}
                  onChange={(e) => setAgentExec(def.key, e.target.value)}
                  className="w-full rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3"
                />
              </div>
              <div className="w-[200px]">
                <div className="mb-1.5 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
                  Default model
                </div>
                <select
                  value={conf?.model ?? ""}
                  onChange={(e) => setAgentModel(def.key, e.target.value)}
                  className="w-full cursor-pointer appearance-none rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3"
                >
                  {def.models.map((m) => (
                    <option key={m} value={m} className="bg-input">
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
