/** Agent-action configs, one per left-nav entry under the "Actions" group:
 * Triage Investigation and Issues Work today (Plan / Review later). Per-scope —
 * app defaults or repo override. */

import type { AgentKind } from "../../../bindings";
import { ChevronSelect, Toggle } from "../../../components/primitives";
import { agentAvailable } from "../../../lib/format";
import {
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_COMMAND_KEY,
  INVESTIGATE_MODEL_KEY,
  TRIAGE_GOOD_CITIZEN_KEY,
  TRIAGE_SNOOZED_KEY,
  useAgents,
  useBoolSetting,
  useClaudeCommands,
  useSetSetting,
  useSetting,
  WORK_AGENT_KEY,
  WORK_MODEL_KEY,
} from "../../../lib/queries";
import { useApp } from "../../../state/AppContext";
import {
  CommandOptions,
  Field,
  Heading,
  OverrideSelect,
  SELECT_CLASS,
  ToggleRow,
} from "../widgets";

/** Describes one configurable agent action: which setting keys it stores and
 * whether it also picks a Skill/command. App vs repo scope is expressed by the
 * descriptor's keys plus the `inherits` flag the body passes down. */
interface ActionDescriptor {
  agentKey: string;
  modelKey: string;
  /** Present only for actions that also run a Claude slash command (Investigate). */
  commandKey?: string;
}

const INVESTIGATE: ActionDescriptor = {
  agentKey: INVESTIGATE_AGENT_KEY,
  modelKey: INVESTIGATE_MODEL_KEY,
  commandKey: INVESTIGATE_COMMAND_KEY,
};
const WORK: ActionDescriptor = { agentKey: WORK_AGENT_KEY, modelKey: WORK_MODEL_KEY };

/** The Triage Investigation action. Triage is global: the enable switch + queue
 * prefs live at the app level; a repo only overrides which agent/skill/model the
 * investigation runs. */
export function TriageActionSection({ repo }: { repo?: string }) {
  return (
    <>
      <Heading
        title="Triage"
        subtitle="How the Triage investigation runs — pick the agent, skill, and model."
      />
      {repo ? <ActionConfig descriptor={INVESTIGATE} repo={repo} /> : <AppTriagePanel />}
    </>
  );
}

/** The Work action body — the default agent + model the launch tray uses (app
 *  defaults or a per-repo override). Heading-less; rendered inside the merged
 *  "Work" settings section. */
export function WorkActionConfig({ repo }: { repo?: string }) {
  // Just the agent + model card. The old standalone "Work" intro card was
  // redundant with the section heading, so it's been dropped.
  return <ActionConfig descriptor={WORK} repo={repo} />;
}

/**
 * The app-level Triage panel: a master enable switch (locked until Linear is
 * connected), then — grayed out while disabled — the queue preferences and the
 * investigation action config.
 */
function AppTriagePanel() {
  const { settings, toggleIntegration } = useApp();
  const linear = !!settings?.integrations.linear;
  const enabled = !!settings?.integrations.triage;

  const goodCitizen = useBoolSetting("app", TRIAGE_GOOD_CITIZEN_KEY).value;
  const showSnoozed = useBoolSetting("app", TRIAGE_SNOOZED_KEY).value;
  const setSetting = useSetSetting();
  const setBool = (key: string, next: boolean) =>
    setSetting.mutate({ scope: "app", key, value: next ? "true" : null });

  return (
    <div className="space-y-3.5">
      <div className="flex items-center gap-[13px] rounded-xl border border-line-2 bg-raised p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg-bright">Enable Triage</div>
          <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
            {linear
              ? "Show the Triage tab and pull your Linear issues into it."
              : "Connect Linear first (Settings → Integrations) to enable triage."}
          </div>
        </div>
        <div className={linear ? "" : "pointer-events-none opacity-40"}>
          <Toggle on={enabled} onClick={() => toggleIntegration("triage")} />
        </div>
      </div>

      <div
        className={
          enabled ? "space-y-3.5" : "pointer-events-none space-y-3.5 opacity-45 select-none"
        }
        aria-disabled={!enabled}
      >
        <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
          <ToggleRow
            label="Be a good citizen"
            hint="When you're off triage duty or your own queue is empty, show the team's issues so you can pitch in — instead of an empty screen."
            on={goodCitizen}
            disabled={!enabled}
            onChange={(v) => setBool(TRIAGE_GOOD_CITIZEN_KEY, v)}
          />
          <ToggleRow
            label="Show snoozed issues"
            hint="Include snoozed issues in the queue (greyed, at the bottom). Off hides them until they wake."
            on={showSnoozed}
            disabled={!enabled}
            onChange={(v) => setBool(TRIAGE_SNOOZED_KEY, v)}
          />
        </div>

        <div>
          <div className="mb-2 px-1 font-mono text-[10px] tracking-[.07em] text-muted-4 uppercase">
            Investigation
          </div>
          <ActionConfig descriptor={INVESTIGATE} />
        </div>
      </div>
    </div>
  );
}

/**
 * The single body shared by all four action panels. Resolves the scope (`app`
 * or `repo:<repo>`), reads the effective agent (a repo override falls back to
 * the app value), and renders the agent / optional skill / model selects. The
 * `inherits` flag flips each select between a plain picker (app: hardcoded
 * "Agent default") and an {@link OverrideSelect} that inherits the app value.
 */
function ActionConfig({ descriptor, repo }: { descriptor: ActionDescriptor; repo?: string }) {
  const inherits = repo !== undefined;
  const scope = inherits ? `repo:${repo}` : "app";
  const { data: agents = [] } = useAgents();
  const { data: cmds } = useClaudeCommands(repo ?? null);
  const setSetting = useSetSetting();
  const set = (key: string, value: string | null) => setSetting.mutate({ scope, key, value });

  // App defaults — the repo scope inherits these when its own value is unset.
  // Read the command keys unconditionally (with a harmless sentinel when the
  // action has no command) so hook order stays stable across renders.
  const cmdKey = descriptor.commandKey ?? "__none__";
  const hasCmd = descriptor.commandKey !== undefined;
  const appAgent = (useSetting("app", descriptor.agentKey).data as AgentKind | null) ?? "Claude";
  const appCmd = useSetting("app", cmdKey).data;
  const appModel = useSetting("app", descriptor.modelKey).data;

  // This scope's stored values (null/undefined for both app + an unset repo).
  const scopeAgent = useSetting(scope, descriptor.agentKey).data as AgentKind | null;
  const scopeCmd = useSetting(scope, cmdKey).data;
  const scopeModel = useSetting(scope, descriptor.modelKey).data;

  const effectiveAgent = scopeAgent ?? appAgent;
  const agentDef = agents.find((a) => a.key === effectiveAgent);
  const appAgentShort = agents.find((a) => a.key === appAgent)?.short ?? appAgent;
  const globalCmds = cmds?.global ?? [];
  const repoCmds = cmds?.repo ?? [];
  const selectedCmd = globalCmds.find((c) => c.name === scopeCmd);

  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
      <Field
        label="Agent"
        hint={
          inherits
            ? "Anything left on the default inherits the app setting."
            : "Only one agent runs an action. More harnesses are coming."
        }
      >
        <AgentSelect
          agents={agents}
          value={inherits ? (scopeAgent ?? "") : effectiveAgent}
          onChange={(v) => set(descriptor.agentKey, v)}
          inherits={inherits}
          defaultLabel={`Use app default (${appAgentShort})`}
        />
      </Field>

      {hasCmd && (
        <Field
          label="Skill"
          hint={
            inherits ? (
              "From this repo's commands or your global ones."
            ) : (
              <>
                From your global commands (<span className="font-mono">~/.claude/commands</span>).
              </>
            )
          }
        >
          {inherits ? (
            <OverrideSelect
              value={scopeCmd ?? ""}
              onChange={(v) => set(cmdKey, v)}
              defaultLabel={`Use app default${appCmd ? ` (/${appCmd})` : ""}`}
            >
              <CommandOptions globalCmds={globalCmds} repoCmds={repoCmds} />
            </OverrideSelect>
          ) : globalCmds.length === 0 ? (
            <div className="rounded-lg border border-line-3 bg-input px-[11px] py-2.5 text-[11.5px] text-muted-3">
              No commands found in <span className="font-mono">~/.claude/commands</span>.
            </div>
          ) : (
            <ChevronSelect
              value={scopeCmd ?? ""}
              onChange={(v) => set(cmdKey, v || null)}
              className={SELECT_CLASS}
            >
              <option value="">None</option>
              <CommandOptions globalCmds={globalCmds} repoCmds={[]} />
            </ChevronSelect>
          )}
          {!inherits && selectedCmd?.description && (
            <div className="mt-2 text-[11.5px] text-muted-3">{selectedCmd.description}</div>
          )}
        </Field>
      )}

      <Field
        label="Model"
        hint={
          inherits
            ? undefined
            : hasCmd
              ? "Leave on the agent default to use the model set in Agents."
              : "The default in the launch tray; switch it per launch any time."
        }
      >
        <ModelSelect
          models={agentDef?.models ?? []}
          value={scopeModel ?? ""}
          onChange={(v) => set(descriptor.modelKey, v)}
          inherits={inherits}
          defaultLabel={`Use app default${appModel ? ` (${appModel})` : ""}`}
        />
      </Field>
    </div>
  );
}

/** The agent picker — identical options in every action. When `inherits`, it's
 * an {@link OverrideSelect} that falls back to the app default; otherwise a
 * plain select bound to the effective value. */
function AgentSelect({
  agents,
  value,
  onChange,
  inherits,
  defaultLabel,
}: {
  agents: { key: AgentKind; label: string }[];
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
  defaultLabel: string;
}) {
  const options = agents.map((a) => (
    <option key={a.key} value={a.key} disabled={!agentAvailable(a.key)} className="bg-input">
      {a.label}
      {agentAvailable(a.key) ? "" : " — WIP"}
    </option>
  ));
  if (inherits) {
    return (
      <OverrideSelect value={value} onChange={onChange} defaultLabel={defaultLabel}>
        {options}
      </OverrideSelect>
    );
  }
  return (
    <ChevronSelect value={value} onChange={onChange} className={SELECT_CLASS}>
      {options}
    </ChevronSelect>
  );
}

/** The model picker — the effective agent's models. When `inherits`, an
 * {@link OverrideSelect}; otherwise a plain select with an "Agent default". */
function ModelSelect({
  models,
  value,
  onChange,
  inherits,
  defaultLabel,
}: {
  models: string[];
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
  defaultLabel: string;
}) {
  const options = models.map((m) => (
    <option key={m} value={m} className="bg-input">
      {m}
    </option>
  ));
  if (inherits) {
    return (
      <OverrideSelect value={value} onChange={onChange} defaultLabel={defaultLabel}>
        {options}
      </OverrideSelect>
    );
  }
  return (
    <ChevronSelect value={value} onChange={(v) => onChange(v || null)} className={SELECT_CLASS}>
      <option value="">Agent default</option>
      {options}
    </ChevronSelect>
  );
}
