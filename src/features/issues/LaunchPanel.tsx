/** The launch tray at the bottom of the Issues sidebar. */
import { useState } from "react";
import type { AgentKind } from "../../bindings";
import { ChevronDownIcon } from "../../components/icons";
import { Button, ChevronSelect } from "../../components/primitives";
import { agentAvailable } from "../../lib/format";
import { useAgents, useClaudeModels } from "../../lib/queries";
import { useIssues } from "./model";

const SELECT_CLASS =
  "w-full rounded-lg border border-line-2 bg-input py-2 pr-8 pl-2.5 font-mono text-[11px] text-fg-2";
const LABEL_CLASS = "mb-[5px] font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase";

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
  const claudeModels = useClaudeModels().data;
  // Agent + model live under a collapsed "Advanced" section — most launches use the
  // configured defaults, so they don't need to take up space every time.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const count = selectedEligible.length;

  // Nothing selected → no tray (the hint that used to live here was noise).
  if (count === 0) return null;

  // Only offer agents that are actually wired up (just Claude today).
  const availableAgents = agents.filter((a) => agentAvailable(a));
  // Claude's list is live (Claude Code's own picker cache); WIP agents use the catalog.
  const catalogModels = agents.find((a) => a.key === launchAgent)?.models ?? [];
  const models = launchAgent === "Claude" ? (claudeModels ?? catalogModels) : catalogModels;
  const chainedCount = selectedEligible.filter((t) => !t.ready).length;

  // Whether the current model is the configured default (no per-launch override).
  const isDefaultModel = launchModel === defaultModel;
  // Options: the live models, plus the configured default and any active override
  // that aren't already listed (so a stale/pinned value stays selectable).
  const withDefault =
    defaultModel && !models.includes(defaultModel) ? [defaultModel, ...models] : models;
  const modelOptions =
    launchModel && !withDefault.includes(launchModel) ? [launchModel, ...withDefault] : withDefault;

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

      {/* Collapsed by default: the header still surfaces the effective model (with a
          "(settings)" hint when it's the configured default) so you know what will
          run without expanding. */}
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
        <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-3">
          {launchModel}
          {isDefaultModel && <span className="text-muted-4"> (settings)</span>}
        </span>
      </button>

      {advancedOpen && (
        <div className="mb-[2px]">
          <div className={LABEL_CLASS}>Agent</div>
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

          <div className={LABEL_CLASS}>Model</div>
          {/* A plain dropdown over the current models (see `useClaudeModels`) — no
              free-text entry. The configured default is tagged "(settings)". */}
          <ChevronSelect
            value={launchModel}
            onChange={setLaunchModel}
            className={SELECT_CLASS}
            wrapperClassName="mb-[11px]"
            aria-label="Model"
          >
            {modelOptions.map((m) => (
              <option key={m} value={m} className="bg-input">
                {m}
                {m === defaultModel ? " (settings)" : ""}
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
