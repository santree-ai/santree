/** The launch tray at the bottom of the Issues sidebar. */
import { useState } from "react";
import type { AgentKind } from "../../bindings";
import { ChevronDownIcon } from "../../components/icons";
import { Button, ChevronSelect } from "../../components/primitives";
import { agentAvailable } from "../../lib/format";
import {
  useAgents,
  useResolvedProviderSetting,
  WORK_AGENT_KEY,
  WORK_MODEL_KEY,
} from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { useIssues } from "./model";

const SELECT_CLASS =
  "w-full rounded-lg border border-line-2 bg-input py-2 pr-8 pl-2.5 font-mono text-[11px] text-fg-2";
const LABEL_CLASS = "mb-[5px] font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase";

export function LaunchPanel() {
  const { selectedEligible, clearSelection, launchAgent, setLaunchAgent, launch } = useIssues();
  const { activeRepo } = useApp();
  const { data: agents = [] } = useAgents();
  // The model is not a launch-time choice: every launch runs the model configured
  // for its agent in Settings → Actions → Work. It's resolved here through the same
  // hook the Trees launch seed uses, so what the tray shows is what will run.
  const { data: model } = useResolvedProviderSetting(
    activeRepo,
    WORK_MODEL_KEY,
    launchAgent,
    WORK_AGENT_KEY,
  );
  // The agent picker lives under a collapsed "Advanced" section — most launches use
  // the configured default, so it doesn't need to take up space every time.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const count = selectedEligible.length;

  // Nothing selected → no tray (the hint that used to live here was noise).
  if (count === 0) return null;

  // Only offer providers whose runtime adapter is registered.
  const availableAgents = agents.filter((a) => agentAvailable(a));
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

      {/* Collapsed by default: the header still surfaces what will run — the agent's
          configured model, read from Settings — so you know without expanding. */}
      <button
        type="button"
        onClick={() => setAdvancedOpen((o) => !o)}
        className="mb-[9px] flex w-full cursor-pointer items-center gap-1.5 text-left"
        aria-expanded={advancedOpen}
      >
        <ChevronDownIcon
          size={11}
          className={`text-muted-4 ${advancedOpen ? "transition-transform" : "-rotate-90 transition-transform"}`}
        />
        <span className="font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
          Advanced
        </span>
        <span
          className="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-3"
          title="Configured in Settings → Actions → Work"
        >
          {model || "default model"}
          <span className="text-muted-4"> (Settings)</span>
        </span>
      </button>

      {advancedOpen && (
        <div className="mb-[11px]">
          <div className={LABEL_CLASS}>Agent</div>
          <ChevronSelect
            value={launchAgent}
            onChange={(v) => setLaunchAgent(v as AgentKind)}
            className={SELECT_CLASS}
            aria-label="Agent"
          >
            {availableAgents.map((a) => (
              <option key={a.key} value={a.key} className="bg-input">
                {a.label}
              </option>
            ))}
          </ChevronSelect>
        </div>
      )}

      <Button variant="primary" size="lg" onClick={launch} className="w-full">
        <span className="text-[10px]">▶</span>
        <span>
          Launch {count} {count === 1 ? "agent" : "agents"}
        </span>
      </Button>
    </div>
  );
}
