/** Agent-action configs, one per left-nav entry under the "Actions" group:
 * Triage Investigation and Issues Work today (Plan / Review later). Per-scope —
 * app defaults or repo override. */

import { useEffect, useRef, useState } from "react";

import type { AgentKind } from "../../../bindings";
import { ChevronRightIcon } from "../../../components/icons";
import { ChevronSelect, Toggle } from "../../../components/primitives";
import { agentAvailable } from "../../../lib/format";
import {
  EFFORT_LEVELS,
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_COMMAND_KEY,
  INVESTIGATE_EFFORT_KEY,
  INVESTIGATE_MODEL_KEY,
  INVESTIGATE_REMOTE_CONTROL_KEY,
  PERMISSION_MODES,
  TRIAGE_GOOD_CITIZEN_KEY,
  TRIAGE_SNOOZED_KEY,
  useAgents,
  useBoolSetting,
  useClaudeCommandFile,
  useClaudeCommands,
  useClaudeModels,
  useResolvedSetting,
  useSetSetting,
  useSetting,
  useWriteClaudeCommand,
  WORK_AGENT_KEY,
  WORK_EFFORT_KEY,
  WORK_MODEL_KEY,
  WORK_PERMISSION_MODE_KEY,
  WORK_QUEUE_KEY,
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
  /** Claude's `--effort` for the run (low…max). */
  effortKey: string;
  /** Present only for actions that also run a Claude slash command (Investigate). */
  commandKey?: string;
  /** Present only for actions that pick a start mode (Claude's `--permission-mode`). */
  permissionModeKey?: string;
}

const INVESTIGATE: ActionDescriptor = {
  agentKey: INVESTIGATE_AGENT_KEY,
  modelKey: INVESTIGATE_MODEL_KEY,
  effortKey: INVESTIGATE_EFFORT_KEY,
  commandKey: INVESTIGATE_COMMAND_KEY,
};
const WORK: ActionDescriptor = {
  agentKey: WORK_AGENT_KEY,
  modelKey: WORK_MODEL_KEY,
  effortKey: WORK_EFFORT_KEY,
  permissionModeKey: WORK_PERMISSION_MODE_KEY,
};

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
function RemoteControlCard({ forRepo }: { forRepo?: string }) {
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
  const setSetting = useSetSetting();
  return (
    <div className="space-y-3.5">
      <ActionConfig descriptor={WORK} repo={repo} />
      {/* The queue is a global workflow choice (not a per-repo agent/model
          override), so it only appears on the app-defaults scope. */}
      {!repo && (
        <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
          <ToggleRow
            label="Queue work before launching"
            hint="On: add several tickets to a queue and launch them together (the launch tray). Off: each issue's panel shows a single “Run” button that starts it right away — ⌘-click runs it in the background without leaving your current view."
            on={queue}
            onChange={(v) =>
              setSetting.mutate({ scope: "app", key: WORK_QUEUE_KEY, value: v ? "true" : null })
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

      <div
        className={
          enabled ? "space-y-3.5" : "pointer-events-none space-y-3.5 opacity-45 select-none"
        }
        aria-disabled={!enabled}
      >
        <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
          <ToggleRow
            label="Be a good citizen"
            hint="Show the whole team's issues — not just the ones assigned to you — so you can pitch in on anyone's tickets, on triage duty or not. Also the Mine/All toggle in the Triage header."
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
            <ActionConfig descriptor={INVESTIGATE} />
            <RemoteControlCard />
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
 */
function ActionConfig({ descriptor, repo }: { descriptor: ActionDescriptor; repo?: string }) {
  const inherits = repo !== undefined;
  const scope = inherits ? `repo:${repo}` : "app";
  const { settings } = useApp();
  const { data: agents = [] } = useAgents();
  const { data: cmds } = useClaudeCommands(repo ?? null);
  const setSetting = useSetSetting();
  const set = (key: string, value: string | null) => setSetting.mutate({ scope, key, value });

  // App defaults — the repo scope inherits these when its own value is unset.
  // Read the command keys unconditionally (with a harmless sentinel when the
  // action has no command) so hook order stays stable across renders.
  const cmdKey = descriptor.commandKey ?? "__none__";
  const hasCmd = descriptor.commandKey !== undefined;
  // Read the permission-mode key unconditionally too (harmless sentinel when the
  // action has none) so hook order stays stable across renders.
  const permKey = descriptor.permissionModeKey ?? "__none_perm__";
  const hasPerm = descriptor.permissionModeKey !== undefined;
  const appAgent = (useSetting("app", descriptor.agentKey).data as AgentKind | null) ?? "Claude";
  const appCmd = useSetting("app", cmdKey).data;
  const appModel = useSetting("app", descriptor.modelKey).data;
  const appEffort = useSetting("app", descriptor.effortKey).data;
  const appPerm = useSetting("app", permKey).data;

  // This scope's stored values (null/undefined for both app + an unset repo).
  const scopeAgent = useSetting(scope, descriptor.agentKey).data as AgentKind | null;
  const scopeCmd = useSetting(scope, cmdKey).data;
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
  const globalCmds = cmds?.global ?? [];
  const repoCmds = cmds?.repo ?? [];
  const selectedCmd = globalCmds.find((c) => c.name === scopeCmd);
  // The command this scope actually runs: its own pick, or (repo scope) the
  // inherited app default. Drives the inline skill editor below.
  const effectiveCmd = (inherits ? (scopeCmd ?? appCmd) : scopeCmd) || undefined;

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
          {/* Edit the selected skill's real file, right under its picker. Keyed
                so switching skill/scope reseeds a fresh draft (and flushes the old
                one on unmount). */}
          {effectiveCmd && (
            <SkillEditor
              key={`${scope}:${effectiveCmd}`}
              repo={repo ?? null}
              name={effectiveCmd}
              fromRepoScope={inherits}
            />
          )}
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
              : "Which permission mode a worktree's agent starts (and restarts) in — Claude's --permission-mode. Default keeps Claude's normal mode."
          }
        >
          <PermissionModeSelect
            value={scopePerm ?? ""}
            onChange={(v) => set(permKey, v)}
            inherits={inherits}
            defaultLabel={`Use app default (${permModeLabel(appPerm) ?? "Default"})`}
          />
        </Field>
      )}
    </div>
  );
}

/** Debounce constant for the skill editor's autosave. */
const SKILL_SAVE_DEBOUNCE_MS = 600;

/**
 * Collapsible inline editor for the selected Investigate skill, sitting right
 * under its picker. Edits the *real* command `.md` file in place (the global one,
 * or the repo's own copy, resolved on the backend repo-over-global). It's a plain
 * Claude command file, not a jinja template, so there's no preview. Autosaves a
 * beat after typing stops and flushes on unmount, so switching skill/scope never
 * drops the last edit (same pattern as the commit-message draft).
 */
function SkillEditor({
  repo,
  name,
  fromRepoScope,
}: {
  repo: string | null;
  name: string;
  fromRepoScope: boolean;
}) {
  const { data, isLoading } = useClaudeCommandFile(repo, name);
  const { mutate: save, isPending } = useWriteClaudeCommand(repo, name);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  // Adopt the loaded file once; if the user typed before it resolved, their input
  // wins (never stomp active typing with the loaded value).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || data === undefined) return;
    seeded.current = true;
    if (text === "") setText(data.content);
  }, [data, text]);

  // Autosave a beat after typing stops (no-op once it matches the file — our write
  // updates the cached content, so `data.content` catches up after a save).
  useEffect(() => {
    if (!seeded.current || !data || text === data.content) return;
    const timer = setTimeout(
      () => save({ source: data.source, content: text }),
      SKILL_SAVE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [text, data, save]);

  // Flush any unsaved edit synchronously on teardown (this component is keyed, so
  // switching skill/scope unmounts it before the debounce timer fires). Refs so
  // this doesn't re-fire per keystroke.
  const textRef = useRef(text);
  textRef.current = text;
  const dataRef = useRef(data);
  dataRef.current = data;
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      const d = dataRef.current;
      if (d && textRef.current !== d.content) {
        saveRef.current({ source: d.source, content: textRef.current });
      }
    },
    [],
  );

  const dirty = !!data && text !== data.content;
  const status = isPending ? "Saving…" : dirty ? "Unsaved" : data ? "Saved" : "";

  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-[12px] text-muted-2 hover:text-fg-2"
      >
        <ChevronRightIcon
          size={12}
          className={`flex-none transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="flex-none">Edit skill file</span>
        {open && data && (
          <span
            className="min-w-0 flex-1 truncate text-left font-mono text-[10.5px] text-muted-4"
            title={data.path}
          >
            {data.path}
          </span>
        )}
        {open && (
          <span className={`text-[10.5px] text-muted-4 ${data ? "flex-none" : "ml-auto"}`}>
            {status}
          </span>
        )}
      </button>

      {open &&
        (isLoading ? (
          <div className="mt-2 text-[11.5px] text-muted-3">
            Loading <span className="font-mono">/{name}</span>…
          </div>
        ) : !data ? (
          <div className="mt-2 text-[11.5px] text-muted-3">
            Couldn't load <span className="font-mono">/{name}</span>.
          </div>
        ) : (
          <>
            {fromRepoScope && data.source === "global" && (
              <div className="mt-2 text-[11px] leading-[1.5] text-muted-3">
                This is a global command — edits apply to every repo.
              </div>
            )}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              aria-label={`Edit the /${name} skill`}
              // Disable ligatures/contextual alternates: the mono font otherwise
              // renders `---`/`###`/`` `` ``/`**` as combined glyphs, so the text
              // looks shifted and the caret doesn't line up with the characters.
              style={{ fontVariantLigatures: "none", fontFeatureSettings: '"liga" 0, "calt" 0' }}
              className="mt-2 h-72 w-full resize-y rounded-lg border border-line-3 bg-input px-3 py-2.5 font-mono text-[12px] leading-[1.55] text-fg-2 outline-none focus:border-line-strong"
            />
          </>
        ))}
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
  defaultLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
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
  defaultLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
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
  defaultLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  agents: { key: AgentKind; label: string; available: boolean }[];
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
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
  defaultLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  models: string[];
  value: string;
  onChange: (v: string | null) => void;
  inherits: boolean;
  defaultLabel: string;
  "aria-labelledby"?: string;
}) {
  const options = value && !models.includes(value) ? [value, ...models] : models;
  return (
    <ChevronSelect
      value={value}
      onChange={(v) => onChange(v || null)}
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
