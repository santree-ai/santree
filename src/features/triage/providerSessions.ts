import type { AgentKind, TriageSession } from "../../bindings";

export const INTERACTIVE_AGENTS: readonly AgentKind[] = ["Codex", "Claude"];

/**
 * The surface key for a ticket's investigation: the PTY's label, the tab's
 * `refId` and `terminal_sessions.term_key`, all the same string.
 *
 * The provider is deliberately not in it. A surface holds one session *per
 * provider*, and the durable row keys that with its own column — so the provider
 * travels beside this key (the tab's `agent.kind`, the PTY's `agentKind`), never
 * appended to it. Folding it in is what made a live investigation read as exited:
 * `AK-1::codex` matched no `term_key` when the liveness join asked.
 */
export const triageTermKey = (ticketId: string) => `triage:${ticketId}`;

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
