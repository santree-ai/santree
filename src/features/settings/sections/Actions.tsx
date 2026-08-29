/** Agent-action configs, one per left-nav entry under the "Actions" group:
 * Triage Investigation and Issues Work today (Plan / Review later). Per-scope —
 * app defaults or repo override. */

import { useEffect, useState } from "react";

import type { AgentKind, CodexModel } from "../../../bindings";
import { AgentIcon } from "../../../components/icons";
import { ChevronSelect, Tabs, Toggle } from "../../../components/primitives";
import { agentAvailable } from "../../../lib/format";
import {
  COMMIT_MESSAGE_AGENT_KEY,
  COMMIT_MESSAGE_MODEL_KEY,
  DEFAULT_HELPER_MODEL,
  EFFORT_LEVELS,
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_EFFORT_KEY,
  INVESTIGATE_MODEL_KEY,
  INVESTIGATE_PERMISSION_MODE_KEY,
  PERMISSION_MODES,
  PR_BODY_AGENT_KEY,
  PR_BODY_MODEL_KEY,
  providerSettingKey,
  REVIEW_AGENT_KEY,
  REVIEW_EFFORT_KEY,
  REVIEW_MODEL_KEY,
  REVIEW_PERMISSION_MODE_KEY,
  TRIAGE_GOOD_CITIZEN_KEY,
  TRIAGE_SNOOZED_KEY,
  useAgents,
  useBoolSetting,
  useClaudeModels,
  useCodexModels,
  useSetSetting,
  useSetting,
  WORK_AGENT_KEY,
  WORK_ASK_BASE_KEY,
  WORK_EFFORT_KEY,
  WORK_MODEL_KEY,
  WORK_PERMISSION_MODE_KEY,
  WORK_QUEUE_KEY,
} from "../../../lib/queries";
import { useApp } from "../../../state/AppContext";
import { agentProvider } from "../../terminal/agentProvider";
import { Field, Heading, OverrideSelect, SELECT_CLASS, ToggleRow } from "../widgets";
import { ViewedMarksCard } from "./ViewedMarks";

/** Describes one configurable workflow: its default provider and each provider's
 * independently persisted model, effort, and start-mode profile. */
interface ActionDescriptor {
  agentKey?: string;
  modelKey: string;
  /** Claude's `--effort` for the run (low…max). */
  effortKey: string;
  /** Present only for actions that pick a start mode (Claude's `--permission-mode`). */
  permissionModeKey?: string;
}

interface HeadlessProfile {
  agentKey: string;
  modelKey: string;
  label: string;
  hint: string;
}

const WORK_HELPERS: HeadlessProfile[] = [
  {
    agentKey: COMMIT_MESSAGE_AGENT_KEY,
    modelKey: COMMIT_MESSAGE_MODEL_KEY,
    label: "Commit message model",
    hint: "Writes a subject line from the staged diff in a one-shot print command.",
  },
  {
    agentKey: PR_BODY_AGENT_KEY,
    modelKey: PR_BODY_MODEL_KEY,
    label: "PR description model",
    hint: "Drafts the PR body from the diff, ticket, and optional session history.",
  },
];

const INVESTIGATE: ActionDescriptor = {
  agentKey: INVESTIGATE_AGENT_KEY,
  modelKey: INVESTIGATE_MODEL_KEY,
  effortKey: INVESTIGATE_EFFORT_KEY,
  permissionModeKey: INVESTIGATE_PERMISSION_MODE_KEY,
};
const WORK: ActionDescriptor = {
  agentKey: WORK_AGENT_KEY,
  modelKey: WORK_MODEL_KEY,
  effortKey: WORK_EFFORT_KEY,
  permissionModeKey: WORK_PERMISSION_MODE_KEY,
};
const REVIEW: ActionDescriptor = {
  agentKey: REVIEW_AGENT_KEY,
  modelKey: REVIEW_MODEL_KEY,
  effortKey: REVIEW_EFFORT_KEY,
  permissionModeKey: REVIEW_PERMISSION_MODE_KEY,
};

export function ReviewActionSection({ repo }: { repo?: string }) {
  return (
    <>
      <Heading
        title="Reviews"
        subtitle="Choose the default agent for new AI reviews and keep separate settings for every provider. Existing review sessions keep their original agent. Reviews write only local drafts until you add them to your own GitHub review."
      />
      <div className="space-y-3.5">
        <ActionConfig descriptor={REVIEW} repo={repo} />
        {!repo && <ViewedMarksCard />}
      </div>
    </>
  );
}

/** The Triage Investigation action. Triage is global: the enable switch + queue
 * prefs live at the app level; a repo only overrides which agent/skill/model the
 * investigation runs. */
export function TriageActionSection({ repo }: { repo?: string }) {
  return (
    <>
      <Heading
        title="Triage"
        subtitle="Choose the default agent for new investigations and keep separate settings for every provider. Existing investigation sessions keep their original agent."
      />
      {repo ? (
        <div className="space-y-3.5">
          <ActionConfig descriptor={INVESTIGATE} repo={repo} />
        </div>
      ) : (
        <AppTriagePanel />
      )}
    </>
  );
}

/** The Work action body — the default agent + model the launch tray uses (app
 *  defaults or a per-repo override). Heading-less; rendered inside the merged
 *  "Work" settings section. */
export function WorkActionConfig({ repo }: { repo?: string }) {
  const queue = useBoolSetting("app", WORK_QUEUE_KEY).value;
  // Unset means ask (see WORK_ASK_BASE_KEY) — read the raw value, not useBoolSetting.
  const { data: askBase } = useSetting("app", WORK_ASK_BASE_KEY);
  const setSetting = useSetSetting();
  return (
    <div className="space-y-3.5">
      <ActionConfig
        descriptor={WORK}
        repo={repo}
        showDefaultAgent={false}
        headlessProfiles={WORK_HELPERS}
      />
      {/* Both are global workflow choices (not per-repo agent/model overrides),
          so they only appear on the app-defaults scope. */}
      {!repo && (
        <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
          <ToggleRow
            label="Queue work before launching"
            hint="On: add several tickets to a queue and launch them together (the launch tray). Off: each issue's panel shows a single “Run” button that starts it right away. ⌘-click runs it in the background without leaving your current view."
            on={queue}
            onChange={(v) =>
              setSetting.mutate({ scope: "app", key: WORK_QUEUE_KEY, value: v ? "true" : null })
            }
          />
          <ToggleRow
            label="Ask which branch to start from"
            hint="When a ticket's blocker is already in a worktree, ask whether to branch off that work (stacked) or off the repo's default branch. Off: it stacks on the blocker without asking."
            on={askBase !== "false"}
            onChange={(v) =>
              setSetting.mutate({
                scope: "app",
                key: WORK_ASK_BASE_KEY,
                value: v ? null : "false",
              })
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * The app-level Triage panel: a master enable switch (locked until Linear is
 * connected), then — grayed out while disabled — the queue preferences and the
 * investigation action config.
 */
function AppTriagePanel() {
  const { settings, toggleIntegration } = useApp();
  const linear = !!settings?.integrations?.linear;
  const enabled = !!settings?.integrations?.triage;

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

      {/* Grayed out while triage is off. `pointer-events-none` only stops the
          mouse — every control below also takes the real `disabled` attribute, or
          a keyboard user could tab straight into it and change a setting the UI
          says is off. */}
      <div
        className={
          enabled ? "space-y-3.5" : "pointer-events-none space-y-3.5 opacity-45 select-none"
        }
        aria-disabled={!enabled}
      >
        <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
          <ToggleRow
            label="Be a good citizen"
            hint="Show the whole team's issues, not only the ones assigned to you. Same switch as the Mine/All toggle in the Triage header."
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
          <div className="space-y-3.5">
            <ActionConfig descriptor={INVESTIGATE} disabled={!enabled} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionConfig({
  descriptor,
  repo,
  disabled,
  showDefaultAgent = true,
  headlessProfiles = [],
}: {
  descriptor: ActionDescriptor;
  repo?: string;
  disabled?: boolean;
  showDefaultAgent?: boolean;
  headlessProfiles?: HeadlessProfile[];
}) {
  const inherits = repo !== undefined;
  const scope = inherits ? `repo:${repo}` : "app";
  const { settings } = useApp();
  const { data: agents = [] } = useAgents();
  const setSetting = useSetSetting();
  const set = (key: string, value: string | null) => setSetting.mutate({ scope, key, value });
  const permKey = descriptor.permissionModeKey ?? "__none_perm__";
  const hasPerm = descriptor.permissionModeKey !== undefined;
  const agentKey = descriptor.agentKey ?? "__none_agent__";
  const hasAgent = descriptor.agentKey !== undefined;
  const appAgent =
    (useSetting("app", agentKey).data as AgentKind | null) ??
    (hasAgent ? (settings?.defaultAgent ?? "Claude") : "Claude");
  const scopeAgent = useSetting(scope, agentKey).data as AgentKind | null;
  const effectiveAgent = scopeAgent ?? appAgent;
  const availableAgents = agents.filter(
    (agent) => (agent.key === "Claude" || agent.key === "Codex") && agentAvailable(agent),
  );
  const [tab, setTab] = useState<AgentKind>(effectiveAgent);
  useEffect(() => setTab(effectiveAgent), [effectiveAgent]);
  const provider = agentProvider(tab);
  const agentDef = agents.find((agent) => agent.key === tab);
  const claudeModels = useClaudeModels().data;
  const codexModels = useCodexModels(tab === "Codex").data;
  const models =
    provider.capabilities.modelSource === "claude"
      ? (claudeModels ?? agentDef?.models ?? [])
      : provider.capabilities.modelSource === "codex"
        ? (codexModels?.map((model) => model.id) ?? agentDef?.models ?? [])
        : (agentDef?.models ?? []);
  const appAgentShort = agents.find((agent) => agent.key === appAgent)?.short ?? appAgent;
  // `codex debug models` publishes no default flag, only its own priority order,
  // so the head of the list is the closest honest answer — never a synthesized
  // "isDefault".
  const agentDefaultModel =
    settings?.agents?.find((agent) => agent.key === tab)?.model || models[0] || "";

  const modelProfileKey = providerSettingKey(descriptor.modelKey, tab);
  const effortProfileKey = providerSettingKey(descriptor.effortKey, tab);
  const permProfileKey = providerSettingKey(permKey, tab);
  const appModelProfile = useSetting("app", modelProfileKey).data;
  const appEffortProfile = useSetting("app", effortProfileKey).data;
  const appPermProfile = useSetting("app", permProfileKey).data;
  const scopeModelProfile = useSetting(scope, modelProfileKey).data;
  const scopeEffortProfile = useSetting(scope, effortProfileKey).data;
  const scopePermProfile = useSetting(scope, permProfileKey).data;
  const legacyAppModel = useSetting("app", descriptor.modelKey).data;
  const legacyAppEffort = useSetting("app", descriptor.effortKey).data;
  const legacyAppPerm = useSetting("app", permKey).data;

  const compatibleLegacyModel =
    appAgent === tab && legacyAppModel && models.includes(legacyAppModel) ? legacyAppModel : null;
  const appModel = appModelProfile ?? compatibleLegacyModel ?? agentDefaultModel;
  const appEffort = appEffortProfile ?? (appAgent === tab ? legacyAppEffort : null);
  const appPerm = appPermProfile ?? (appAgent === tab ? legacyAppPerm : null);
  const modelValue = inherits ? (scopeModelProfile ?? "") : (scopeModelProfile ?? appModel);
  const effortValue = inherits
    ? (scopeEffortProfile ?? "")
    : (scopeEffortProfile ?? appEffort ?? "");
  const permValue = inherits ? (scopePermProfile ?? "") : (scopePermProfile ?? appPerm ?? "");
  const effectiveModel = modelValue || appModel;
  const codexModel =
    tab === "Codex" ? codexModels?.find((model) => model.id === effectiveModel) : null;
  const effortOptions = effortOptionsFor(tab, codexModel);
  const effortDefault =
    tab === "Codex" && codexModel?.defaultReasoningEffort
      ? `CLI default (${codexModel.defaultReasoningEffort})`
      : "CLI default";

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
        {hasAgent && showDefaultAgent && (
          <div className="px-4 pt-0.5">
            <Field
              label="Default agent"
              hint={
                inherits
                  ? "New sessions inherit the app default unless this repo overrides it."
                  : "The provider used for new sessions. Existing sessions keep their provider."
              }
            >
              <AgentSelect
                agents={availableAgents}
                value={inherits ? (scopeAgent ?? "") : effectiveAgent}
                onChange={(value) => {
                  set(agentKey, value);
                  setTab(value ? (value as AgentKind) : appAgent);
                }}
                inherits={inherits}
                disabled={disabled}
                defaultLabel={`Use app default (${appAgentShort})`}
              />
            </Field>
          </div>
        )}
        <Tabs
          tabs={availableAgents.map((agent) => ({
            value: agent.key,
            label: agent.label,
            icon: <AgentIcon kind={agent.key} size={13} />,
          }))}
          value={tab}
          onChange={setTab}
          className={showDefaultAgent ? "border-y border-line px-4" : "border-b border-line px-4"}
        />
        <div className="px-4 py-0.5">
          <Field
            label={headlessProfiles.length > 0 ? "Work model" : "Model"}
            hint={inherits ? undefined : `Saved for ${agentDef?.label ?? tab}.`}
          >
            <ModelSelect
              models={models}
              value={modelValue}
              onChange={(value) => set(modelProfileKey, value)}
              inherits={inherits}
              disabled={disabled}
              defaultLabel={`Use app default${appModel ? ` (${appModel})` : ""}`}
            />
          </Field>
          {provider.capabilities.effort && (
            <Field
              label={headlessProfiles.length > 0 ? "Work effort" : "Effort"}
              hint={
                inherits
                  ? undefined
                  : "How hard the agent thinks. Higher is more thorough but slower and pricier."
              }
            >
              <EffortSelect
                value={effortValue}
                onChange={(value) => set(effortProfileKey, value)}
                options={effortOptions}
                inherits={inherits}
                disabled={disabled}
                defaultLabel={`Use app default${appEffort ? ` (${appEffort})` : ""}`}
                cliDefaultLabel={effortDefault}
              />
            </Field>
          )}
          {hasPerm && provider.capabilities.permissionMode && (
            <Field
              label={headlessProfiles.length > 0 ? "Work start mode" : "Start mode"}
              hint={inherits ? undefined : "Applied whenever this provider starts or resumes."}
            >
              <PermissionModeSelect
                value={permValue}
                onChange={(value) => set(permProfileKey, value)}
                inherits={inherits}
                disabled={disabled}
                defaultLabel={`Use app default (${permModeLabel(appPerm) ?? "Default"})`}
              />
            </Field>
          )}
          {headlessProfiles.map((profile) => (
            <HeadlessProfileField
              key={profile.modelKey}
              profile={profile}
              tab={tab}
              repo={repo}
              models={models}
              defaultModel={tab === "Claude" ? DEFAULT_HELPER_MODEL : agentDefaultModel}
              fallbackAgent={appAgent}
              scopeFallbackAgent={effectiveAgent}
              disabled={disabled}
            />
          ))}
        </div>
      </div>
      {headlessProfiles.length > 0 && (
        <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
          <div className="pt-2.5 pb-3">
            <div className="text-[13px] font-semibold text-fg-bright">Agent assignments</div>
            <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
              Choose which configured provider performs each job.
            </div>
          </div>
          <AgentAssignmentField
            label="Work agent"
            hint="Starts new interactive work sessions. Existing sessions keep their provider."
            settingKey={agentKey}
            repo={repo}
            fallbackAgent={settings?.defaultAgent ?? "Claude"}
            agents={availableAgents}
            disabled={disabled}
          />
          <AgentAssignmentField
            label="Commit message agent"
            hint="Generates commit-message drafts independently of the interactive session."
            settingKey={COMMIT_MESSAGE_AGENT_KEY}
            repo={repo}
            fallbackAgent={appAgent}
            scopeFallbackAgent={effectiveAgent}
            agents={availableAgents}
            disabled={disabled}
          />
          <AgentAssignmentField
            label="PR description agent"
            hint="Generates PR-description drafts independently of the interactive session."
            settingKey={PR_BODY_AGENT_KEY}
            repo={repo}
            fallbackAgent={appAgent}
            scopeFallbackAgent={effectiveAgent}
            agents={availableAgents}
            disabled={disabled}
          />
        </div>
      )}
    </>
  );
}

function modelMatchesProvider(model: string, agent: AgentKind): boolean {
  const claudeModel =
    model.startsWith("claude-") || model === "opus" || model === "sonnet" || model === "haiku";
  return agent === "Claude" ? claudeModel : agent === "Codex" ? !claudeModel : true;
}

function HeadlessProfileField({
  profile,
  tab,
  repo,
  models,
  defaultModel,
  fallbackAgent,
  scopeFallbackAgent,
  disabled,
}: {
  profile: HeadlessProfile;
  tab: AgentKind;
  repo?: string;
  models: string[];
  defaultModel: string;
  fallbackAgent: AgentKind;
  scopeFallbackAgent: AgentKind;
  disabled?: boolean;
}) {
  const inherits = repo !== undefined;
  const scope = inherits ? `repo:${repo}` : "app";
  const appSelectedRaw = useSetting("app", profile.agentKey).data as AgentKind | null;
  const scopeSelectedRaw = useSetting(scope, profile.agentKey).data as AgentKind | null;
  const appSelected = appSelectedRaw ?? fallbackAgent;
  const scopeSelected = scopeSelectedRaw ?? appSelectedRaw ?? scopeFallbackAgent;
  const profileKey = providerSettingKey(profile.modelKey, tab);
  const appProfile = useSetting("app", profileKey).data;
  const scopeProfile = useSetting(scope, profileKey).data;
  const legacyApp = useSetting("app", profile.modelKey).data;
  const legacyScope = useSetting(scope, profile.modelKey).data;
  const compatibleAppLegacy =
    appSelected === tab && legacyApp && modelMatchesProvider(legacyApp, tab) ? legacyApp : null;
  const compatibleScopeLegacy =
    scopeSelected === tab && legacyScope && modelMatchesProvider(legacyScope, tab)
      ? legacyScope
      : null;
  const appModel = appProfile ?? compatibleAppLegacy ?? defaultModel;
  const value = inherits
    ? (scopeProfile ?? compatibleScopeLegacy ?? "")
    : (scopeProfile ?? compatibleScopeLegacy ?? appModel);
  const { mutate: setSetting } = useSetSetting();

  return (
    <Field label={profile.label} hint={inherits ? undefined : profile.hint}>
      <ModelSelect
        models={models}
        value={value}
        onChange={(next) =>
          setSetting({
            scope,
            key: profileKey,
            value: next,
          })
        }
        inherits={inherits}
        disabled={disabled}
        defaultLabel={`Use app default${appModel ? ` (${appModel})` : ""}`}
      />
    </Field>
  );
}

function AgentAssignmentField({
  label,
  hint,
  settingKey,
  repo,
  fallbackAgent,
  scopeFallbackAgent = fallbackAgent,
  agents,
  disabled,
}: {
  label: string;
  hint: string;
  settingKey: string;
  repo?: string;
  fallbackAgent: AgentKind;
  scopeFallbackAgent?: AgentKind;
  agents: { key: AgentKind; label: string; short: string; available: boolean }[];
  disabled?: boolean;
}) {
  const inherits = repo !== undefined;
  const scope = inherits ? `repo:${repo}` : "app";
  const appRaw = useSetting("app", settingKey).data as AgentKind | null;
  const scopeRaw = useSetting(scope, settingKey).data as AgentKind | null;
  const appAgent = appRaw ?? fallbackAgent;
  const inheritedAgent = appRaw ?? scopeFallbackAgent;
  const value = inherits ? (scopeRaw ?? "") : (scopeRaw ?? appAgent);
  const short = agents.find((agent) => agent.key === inheritedAgent)?.short ?? inheritedAgent;
  const { mutate: setSetting } = useSetSetting();

  return (
    <Field label={label} hint={inherits ? undefined : hint}>
      <AgentSelect
        agents={agents}
        value={value}
        onChange={(next) => setSetting({ scope, key: settingKey, value: next })}
        inherits={inherits}
        disabled={disabled}
        defaultLabel={`Use inherited default (${short})`}
      />
    </Field>
  );
}

/** Friendly label for a stored `--permission-mode` value (e.g. `acceptEdits` →
 *  "Accept edits"); `null`/unset returns `undefined` (the "Default" case). */
function permModeLabel(value: string | null | undefined): string | undefined {
  return PERMISSION_MODES.find((m) => m.value === value)?.label;
}

/** The start-mode picker — Claude's `--permission-mode`. The empty option
 *  ("Default") leaves the flag off, i.e. Claude's own normal mode. */
function PermissionModeSelect({
  value,
  onChange,
  inherits,
  disabled,
  defaultLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
  disabled?: boolean;
  defaultLabel: string;
  "aria-labelledby"?: string;
}) {
  const options = PERMISSION_MODES.map((m) => (
    <option key={m.value} value={m.value} className="bg-input">
      {m.label}
    </option>
  ));
  if (inherits) {
    return (
      <OverrideSelect
        value={value}
        onChange={onChange}
        defaultLabel={defaultLabel}
        aria-labelledby={ariaLabelledBy}
      >
        {options}
      </OverrideSelect>
    );
  }
  return (
    <ChevronSelect
      value={value}
      onChange={(v) => onChange(v || null)}
      disabled={disabled}
      className={SELECT_CLASS}
      aria-labelledby={ariaLabelledBy}
    >
      <option value="">Default</option>
      {options}
    </ChevronSelect>
  );
}

interface EffortOption {
  value: string;
  description?: string;
}

export function effortOptionsFor(agent: AgentKind, model?: CodexModel | null): EffortOption[] {
  if (agent === "Codex") {
    return (model?.supportedReasoningEfforts ?? []).map(({ effort, description }) => ({
      value: effort,
      description,
    }));
  }
  return EFFORT_LEVELS.map((value) => ({ value }));
}

/** The effort picker uses the selected model's live Codex capabilities. Leaving
 * it on "CLI default" omits the override entirely. */
function EffortSelect({
  value,
  onChange,
  options,
  inherits,
  disabled,
  defaultLabel,
  cliDefaultLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string;
  onChange: (v: string | null) => void;
  options: EffortOption[];
  inherits: boolean;
  disabled?: boolean;
  defaultLabel: string;
  cliDefaultLabel: string;
  "aria-labelledby"?: string;
}) {
  const optionNodes = options.map(({ value: effort, description }) => (
    <option key={effort} value={effort} title={description} className="bg-input">
      {effort}
    </option>
  ));
  if (inherits) {
    return (
      <OverrideSelect
        value={value}
        onChange={onChange}
        defaultLabel={defaultLabel}
        aria-labelledby={ariaLabelledBy}
      >
        {optionNodes}
      </OverrideSelect>
    );
  }
  return (
    <ChevronSelect
      value={value}
      onChange={(v) => onChange(v || null)}
      disabled={disabled}
      className={SELECT_CLASS}
      aria-labelledby={ariaLabelledBy}
    >
      <option value="">{cliDefaultLabel}</option>
      {optionNodes}
    </ChevronSelect>
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
  disabled,
  defaultLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  agents: { key: AgentKind; label: string; available: boolean }[];
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
  disabled?: boolean;
  defaultLabel: string;
  "aria-labelledby"?: string;
}) {
  const options = agents.map((a) => (
    <option key={a.key} value={a.key} disabled={!agentAvailable(a)} className="bg-input">
      {a.label}
      {agentAvailable(a) ? "" : " — WIP"}
    </option>
  ));
  if (inherits) {
    return (
      <OverrideSelect
        value={value}
        onChange={onChange}
        defaultLabel={defaultLabel}
        aria-labelledby={ariaLabelledBy}
      >
        {options}
      </OverrideSelect>
    );
  }
  return (
    <ChevronSelect
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={SELECT_CLASS}
      aria-labelledby={ariaLabelledBy}
    >
      {options}
    </ChevronSelect>
  );
}

/** The model picker — a plain dropdown over the current models (`useClaudeModels`);
 *  no free-text entry. The app scope is always a concrete model (no "Agent default"
 *  defer option); only the repo scope keeps a first "inherit the app value" option.
 *  A saved value that's no longer in the live list (an older pin) is kept as an
 *  option so it isn't dropped. */
function ModelSelect({
  models,
  value,
  onChange,
  inherits,
  disabled,
  defaultLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  models: string[];
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
  disabled?: boolean;
  defaultLabel: string;
  "aria-labelledby"?: string;
}) {
  const options = value && !models.includes(value) ? [value, ...models] : models;
  return (
    <ChevronSelect
      value={value}
      onChange={(v) => onChange(v || null)}
      disabled={disabled}
      className={SELECT_CLASS}
      aria-labelledby={ariaLabelledBy}
    >
      {inherits && <option value="">{defaultLabel}</option>}
      {options.map((m) => (
        <option key={m} value={m} className="bg-input">
          {m}
        </option>
      ))}
    </ChevronSelect>
  );
}
