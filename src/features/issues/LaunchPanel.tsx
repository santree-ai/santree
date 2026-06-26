/** The launch tray at the bottom of the Issues sidebar. */
import { AgentIcon } from "../../components/icons";
import { Segmented } from "../../components/primitives";
import { useAgents } from "../../lib/queries";
import { useIssues } from "./model";

export function LaunchPanel() {
  const {
    selectedEligible,
    clearSelection,
    launchAgent,
    launchModel,
    setLaunchAgent,
    setLaunchModel,
    launch,
  } = useIssues();
  const { data: agents = [] } = useAgents();

  const count = selectedEligible.length;

  if (count === 0) {
    return (
      <div className="flex-none border-t border-line bg-well px-[13px] pt-3 pb-3.5">
        <p className="text-[11.5px] leading-[1.55] text-muted-3">
          Select ready tasks to queue agents. Launch in parallel — each opens its own terminal
          session.
        </p>
      </div>
    );
  }

  const chainedCount = selectedEligible.filter((t) => !t.ready).length;
  const models = agents.find((a) => a.key === launchAgent)?.models ?? [];

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
      <Segmented
        className="mb-[9px]"
        options={agents.map((a) => ({
          value: a.key,
          label: a.short,
          icon: <AgentIcon kind={a.key} size={12} />,
        }))}
        value={launchAgent}
        onChange={setLaunchAgent}
      />

      <div className="mb-[5px] font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
        Model
      </div>
      <select
        value={launchModel}
        onChange={(e) => setLaunchModel(e.target.value)}
        className="mb-[11px] w-full cursor-pointer appearance-none rounded-lg border border-line-2 bg-input px-2.5 py-2 font-mono text-[11px] text-fg-2"
      >
        {models.map((m) => (
          <option key={m} value={m} className="bg-input">
            {m}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={launch}
        className="flex w-full items-center justify-center gap-2 rounded-[9px] border px-3 py-2.5 text-[13px] font-semibold text-[#06231a] transition-[filter,transform] hover:brightness-110 active:translate-y-px"
        style={{
          background: "var(--accent)",
          borderColor: "var(--accent)",
          boxShadow: "0 8px 22px -10px color-mix(in srgb, var(--accent) 67%, transparent)",
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
