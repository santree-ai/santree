import type { AgentKind, TriageSession } from "../../bindings";

export const INTERACTIVE_AGENTS: readonly AgentKind[] = ["Codex", "Claude"];

/** PTYs need a provider-qualified identity even though durable storage keys the
 * same logical surface by a separate provider column. */
export const triageTerminalRef = (refId: string, agent: AgentKind) =>
  `${refId}::${agent.toLowerCase()}`;

export function providersByRef(sessions: TriageSession[]): Map<string, Set<AgentKind>> {
  const result = new Map<string, Set<AgentKind>>();
  for (const session of sessions) {
    const providers = result.get(session.refId) ?? new Set<AgentKind>();
    providers.add(session.agentKind);
    result.set(session.refId, providers);
  }
  return result;
}

export function orderedProviders(providers: Iterable<AgentKind>): AgentKind[] {
  const available = new Set(providers);
  return INTERACTIVE_AGENTS.filter((agent) => available.has(agent));
}
