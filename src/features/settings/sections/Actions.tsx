/** Agent-action configs, one per left-nav entry under the "Actions" group:
 * Triage Investigation and Issues Work today (Plan / Review later). Per-scope —
 * app defaults or repo override. */

import type { AgentKind } from "../../../bindings";
import { ChevronSelect, Toggle } from "../../../components/primitives";
import { agentAvailable } from "../../../lib/format";
import {
  EFFORT_LEVELS,
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_EFFORT_KEY,
  INVESTIGATE_MODEL_KEY,
  INVESTIGATE_REMOTE_CONTROL_KEY,
  PERMISSION_MODES,
  REVIEW_EFFORT_KEY,
  REVIEW_MODEL_KEY,
  TRIAGE_GOOD_CITIZEN_KEY,
  TRIAGE_SNOOZED_KEY,
  useAgents,
  useBoolSetting,
  useClaudeModels,
  useResolvedSetting,
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
import { Field, Heading, OverrideSelect, SELECT_CLASS, ToggleRow } from "../widgets";

/** Describes one configurable agent action: which setting keys it stores. App vs
 * repo scope is expressed by the descriptor's keys plus the `inherits` flag the
 * body passes down. */
interface ActionDescriptor {
  /** Absent for actions that are Claude-only by design (the AI review session).
   *  No agent picker is rendered then — offering one that the launch path ignores
   *  would be a control that lies. */
  agentKey?: string;
  modelKey: string;
  /** Claude's `--effort` for the run (low…max). */
  effortKey: string;
  /** Present only for actions that pick a start mode (Claude's `--permission-mode`). */
  permissionModeKey?: string;
}

const INVESTIGATE: ActionDescriptor = {
  agentKey: INVESTIGATE_AGENT_KEY,
  modelKey: INVESTIGATE_MODEL_KEY,
  effortKey: INVESTIGATE_EFFORT_KEY,
};
const WORK: ActionDescriptor = {
  agentKey: WORK_AGENT_KEY,
  modelKey: WORK_MODEL_KEY,
  effortKey: WORK_EFFORT_KEY,
  permissionModeKey: WORK_PERMISSION_MODE_KEY,
};
/** No `agentKey`: the review session launches Claude specifically, because its
 *  read-only guarantee rests on a Claude `--settings` deny-list we can't express
 *  for another harness. */
const REVIEW: ActionDescriptor = {
  modelKey: REVIEW_MODEL_KEY,
  effortKey: REVIEW_EFFORT_KEY,
};

/**
 * The Reviews tab's two AI surfaces: the interactive "Ask AI" session, and the
 * headless review brief.
 *
 * They're configured separately because they're different jobs. The session is a
 * conversation you steer, so it follows the same model/effort convention as every
 * other action. The brief is one shot at deciding where your attention goes, which
 * is worth a stronger model than the app's other headless helpers (commit
 * messages, PR bodies) get.
 */
export function ReviewActionSection({ repo }: { repo?: string }) {
  return (
    <>
      <Heading
        title="Reviews"
        subtitle="How the Reviews tab's AI sessions run. Ask AI reads and explains; AI review also writes drafts you can edit. Neither can comment or approve: nothing reaches GitHub until you add it to your own review. Edit their prompts in Settings → Prompts."
      />
      <ActionConfig descriptor={REVIEW} repo={repo} />
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
        subtitle="How the Triage investigation runs. Pick the agent and model, and edit its prompt in Settings → Prompts."
      />
      {repo ? (
        <div className="space-y-3.5">
          <ActionConfig descriptor={INVESTIGATE} repo={repo} />
          <RemoteControlCard forRepo={repo} />
        </div>
      ) : (
        <AppTriagePanel />
      )}
    </>
  );
}

/** Whether Investigate passes Claude's `--remote-control` flag (see
 *  {@link INVESTIGATE_REMOTE_CONTROL_KEY}). App defaults or a per-repo override,
 *  same scope convention as {@link WorkActionConfig}'s sibling cards. */
function RemoteControlCard({ forRepo, disabled }: { forRepo?: string; disabled?: boolean }) {
  const scope = forRepo ? `repo:${forRepo}` : "app";
  const appOn = useSetting("app", INVESTIGATE_REMOTE_CONTROL_KEY).data !== "false";
  const resolvedOn =
    useResolvedSetting(forRepo ?? "", INVESTIGATE_REMOTE_CONTROL_KEY).data !== "false";
  const on = forRepo ? resolvedOn : appOn;
  const { mutate: setSetting } = useSetSetting();
  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
      <ToggleRow
        label="Enable Remote Control"
        hint="Names the Investigate session for Claude's Remote Control web (--remote-control). Turn off if your claude build predates the flag and Investigate exits right away."
        on={on}
        disabled={disabled}
        onChange={(next) =>
          setSetting({ scope, key: INVESTIGATE_REMOTE_CONTROL_KEY, value: next ? null : "false" })
        }
      />
    </div>
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
      <ActionConfig descriptor={WORK} repo={repo} />
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
            <RemoteControlCard disabled={!enabled} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The single body shared by all four action panels. Resolves the scope (`app`
 * or `repo:<repo>`), reads the effective agent (a repo override falls back to
 * the app value), and renders the agent / optional skill / model selects. The
 * `inherits` flag flips each select between a plain concrete picker (app scope)
 * and one with a leading "inherit the app value" option (repo scope).
 *
 * `disabled` really disables every control (not just the wrapper's
 * `pointer-events-none`) — it's set by the app-scope Triage panel while triage is
 * off. Only the app scope ever disables an action, so the `inherits`
 * (`OverrideSelect`) branches below don't carry it.
 */
function ActionConfig({
  descriptor,
  repo,
  disabled,
}: {
  descriptor: ActionDescriptor;
  repo?: string;
  disabled?: boolean;
}) {
  const inherits = repo !== undefined;
  const scope = inherits ? `repo:${repo}` : "app";
  const { settings } = useApp();
  const { data: agents = [] } = useAgents();
  const setSetting = useSetSetting();
  const set = (key: string, value: string | null) => setSetting.mutate({ scope, key, value });

  // App defaults — the repo scope inherits these when its own value is unset.
  // Read the permission-mode key unconditionally (harmless sentinel when the
  // action has none) so hook order stays stable across renders.
  const permKey = descriptor.permissionModeKey ?? "__none_perm__";
  const hasPerm = descriptor.permissionModeKey !== undefined;
  // Same sentinel trick as `permKey`: an agent-less action still reads the key so
  // hook order stays stable, and falls back to Claude (the only agent it runs).
  const agentKey = descriptor.agentKey ?? "__none_agent__";
  const hasAgent = descriptor.agentKey !== undefined;
  const appAgent = (useSetting("app", agentKey).data as AgentKind | null) ?? "Claude";
  const appModel = useSetting("app", descriptor.modelKey).data;
  const appEffort = useSetting("app", descriptor.effortKey).data;
  const appPerm = useSetting("app", permKey).data;

  // This scope's stored values (null/undefined for both app + an unset repo).
  const scopeAgent = useSetting(scope, agentKey).data as AgentKind | null;
  const scopeModel = useSetting(scope, descriptor.modelKey).data;
  const scopeEffort = useSetting(scope, descriptor.effortKey).data;
  const scopePerm = useSetting(scope, permKey).data;

  const effectiveAgent = scopeAgent ?? appAgent;
  const agentDef = agents.find((a) => a.key === effectiveAgent);
  // Claude's list is live (from Claude Code's own picker cache), so it isn't stuck
  // on the agent catalog's static tiers; other (WIP) agents keep their catalog list.
  const claudeModels = useClaudeModels().data;
  const models =
    effectiveAgent === "Claude"
      ? (claudeModels ?? agentDef?.models ?? [])
      : (agentDef?.models ?? []);
  const appAgentShort = agents.find((a) => a.key === appAgent)?.short ?? appAgent;
  // The concrete model an unset app-scope picker falls back to: the effective
  // agent's own default (Settings → Agents), else the first current model. We no
  // longer expose an "Agent default" (defer) option — the app model is always a
  // concrete pick — so the picker must have a real value to show when nothing's
  // been chosen yet.
  const agentDefaultModel =
    settings?.agents?.find((a) => a.key === effectiveAgent)?.model || models[0] || "";

  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
      {hasAgent && (
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
            onChange={(v) => set(agentKey, v)}
            inherits={inherits}
            disabled={disabled}
            defaultLabel={`Use app default (${appAgentShort})`}
          />
        </Field>
      )}

      <Field
        label="Model"
        hint={
          inherits ? undefined : "The model this action runs with; it's the launch tray's default."
        }
      >
        <ModelSelect
          models={models}
          value={inherits ? (scopeModel ?? "") : (scopeModel ?? agentDefaultModel)}
          onChange={(v) => set(descriptor.modelKey, v)}
          inherits={inherits}
          disabled={disabled}
          defaultLabel={`Use app default${appModel ? ` (${appModel})` : ""}`}
        />
      </Field>

      {effectiveAgent === "Claude" && (
        <Field
          label="Effort"
          hint={
            inherits
              ? undefined
              : "How hard the agent thinks (Claude's --effort). Higher is more thorough but slower and pricier."
          }
        >
          <EffortSelect
            value={scopeEffort ?? ""}
            onChange={(v) => set(descriptor.effortKey, v)}
            inherits={inherits}
            disabled={disabled}
            defaultLabel={`Use app default${appEffort ? ` (${appEffort})` : ""}`}
          />
        </Field>
      )}

      {hasPerm && effectiveAgent === "Claude" && (
        <Field
          label="Start mode"
          hint={
            inherits
              ? undefined
              : "Claude's --permission-mode, applied when a worktree's agent starts and restarts. Default keeps Claude's normal mode."
          }
        >
          <PermissionModeSelect
            value={scopePerm ?? ""}
            onChange={(v) => set(permKey, v)}
            inherits={inherits}
            disabled={disabled}
            defaultLabel={`Use app default (${permModeLabel(appPerm) ?? "Default"})`}
          />
        </Field>
      )}
    </div>
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

/** The effort picker — a fixed low→max scale. "CLI default" leaves the flag off. */
function EffortSelect({
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
  const options = EFFORT_LEVELS.map((e) => (
    <option key={e} value={e} className="bg-input">
      {e}
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
      <option value="">CLI default</option>
      {options}
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
