/** The launch tray at the bottom of the Issues sidebar. */
import type { AgentKind } from "../../bindings";
import { ChevronSelect, ComboBox } from "../../components/primitives";
import { agentAvailable } from "../../lib/format";
import { useAgents } from "../../lib/queries";
import { useIssues } from "./model";

const SELECT_CLASS =
  "w-full rounded-lg border border-line-2 bg-input py-2 pr-8 pl-2.5 font-mono text-[11px] text-fg-2";

export function LaunchPanel() {
  const {
    selectedEligible,
    clearSelection,
    launchAgent,
    launchModel,
    defaultModel,
    setLaunchAgent,
    setLaunchModel,
    launch,
  } = useIssues();
  const { data: agents = [] } = useAgents();

  const count = selectedEligible.length;

  // Nothing selected → no tray (the hint that used to live here was noise).
  if (count === 0) return null;

  // Only offer agents that are actually wired up (just Claude today).
  const availableAgents = agents.filter((a) => agentAvailable(a));
  const models = agents.find((a) => a.key === launchAgent)?.models ?? [];
  const chainedCount = selectedEligible.filter((t) => !t.ready).length;

  return (
    <div className="flex-none border-t border-line bg-well px-[13px] pt-3 pb-3.5">
      <div className="mb-[9px] flex items-center justify-between">
        <span className="text-[11.5px] text-muted">
          <span className="font-semibold text-fg">{count}</span> selected
        </span>
        <button
          type="button"
          onClick={clearSelection}
          className="cursor-pointer text-[11px] text-muted-3 hover:text-muted"
        >
          clear
        </button>
      </div>

      {chainedCount > 0 && (
        <div className="mb-[9px] font-mono text-[10px]" style={{ color: "var(--accent)" }}>
          ⛓ {chainedCount} will stack on a running worktree
        </div>
      )}

      <div className="mb-[5px] font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
        Agent
      </div>
      <ChevronSelect
        value={launchAgent}
        onChange={(v) => setLaunchAgent(v as AgentKind)}
        className={SELECT_CLASS}
        wrapperClassName="mb-[9px]"
        aria-label="Agent"
      >
        {availableAgents.map((a) => (
          <option key={a.key} value={a.key} className="bg-input">
            {a.label}
          </option>
        ))}
      </ChevronSelect>

      <div className="mb-[5px] font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
        Model
      </div>
      {/* Editable: the suggestions are the known models, but you can type any alias
          or id the CLI accepts (`opus`, `claude-fable-5`, …) — so it's never stuck
          behind a stale list. Empty falls back to the configured default. */}
      <ComboBox
        value={launchModel}
        onChange={setLaunchModel}
        options={models}
        placeholder={defaultModel}
        className={SELECT_CLASS}
        wrapperClassName="mb-[11px]"
        aria-label="Model"
      />

      <button
        type="button"
        onClick={launch}
        className="flex w-full items-center justify-center gap-2 rounded-[9px] px-3 py-2.5 text-[13px] font-semibold transition-[filter,transform] hover:brightness-105 active:translate-y-px"
        style={{
          background: "var(--color-fg-bright)",
          color: "var(--color-app)",
          boxShadow: "0 6px 18px -10px rgba(0,0,0,.55)",
        }}
      >
        <span className="text-[10px]">▶</span>
        <span>
          Launch {count} {count === 1 ? "agent" : "agents"}
        </span>
      </button>
    </div>
  );
}
