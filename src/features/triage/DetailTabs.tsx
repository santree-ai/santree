/** Discussion plus one durable tab per provider used on this ticket. */
import type { AgentKind } from "../../bindings";
import { AgentIcon, PlusIcon } from "../../components/icons";
import { Dropdown, MENU_ITEM, type TabItem, Tabs } from "../../components/primitives";
import { useAgentAuth, useCodexAccount, useCodexHealth } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { agentProvider } from "../terminal/agentProvider";
import type { DetailTab } from "./hooks";
import { INTERACTIVE_AGENTS } from "./providerSessions";

export function DetailTabs({
  tab,
  providers,
  onTab,
}: {
  tab: DetailTab;
  providers: AgentKind[];
  onTab: (t: DetailTab) => void;
}) {
  const { accent } = useApp();
  const claudeReady = !!useAgentAuth("Claude").data?.connected;
  const codexHealth = useCodexHealth();
  const codexAccount = useCodexAccount(codexHealth.data?.available === true);
  const codexReady = !!codexHealth.data?.available && !!codexAccount.data?.connected;
  const tabs: TabItem<DetailTab>[] = [
    { value: "discussion", label: "Discussion" },
    ...providers.map(
      (agent): TabItem<DetailTab> => ({
        value: agent,
        label: agentProvider(agent).label,
        icon: <AgentIcon kind={agent} size={12} />,
      }),
    ),
  ];
  const addable = INTERACTIVE_AGENTS.filter((agent) => !providers.includes(agent));
  return (
    <div className="flex flex-none items-stretch border-b border-hairline px-5">
      <Tabs
        className="min-w-0 flex-1"
        tabs={tabs}
        value={tab}
        onChange={onTab}
        variant="inset"
        accent={accent}
        tabClassName="py-2"
      />
      {addable.length > 0 && (
        <Dropdown
          align="right"
          menuClassName="w-40 overflow-hidden"
          trigger={(toggle) => (
            <button
              type="button"
              onClick={toggle}
              title="Investigate with another agent"
              aria-label="Investigate with another agent"
              className="flex w-8 cursor-pointer items-center justify-center text-muted-3 hover:text-fg-2"
            >
              <PlusIcon size={12} />
            </button>
          )}
        >
          {(close) =>
            addable.map((agent) => (
              <button
                key={agent}
                type="button"
                disabled={agent === "Codex" ? !codexReady : !claudeReady}
                title={
                  (agent === "Codex" ? codexReady : claudeReady)
                    ? undefined
                    : `Connect ${agentProvider(agent).label} in Settings first`
                }
                className={MENU_ITEM}
                onClick={() => {
                  onTab(agent);
                  close();
                }}
              >
                <AgentIcon kind={agent} size={13} />
                {agentProvider(agent).label}
              </button>
            ))
          }
        </Dropdown>
      )}
    </div>
  );
}
