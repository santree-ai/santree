import type { AgentKind } from "../../bindings";

/**
 * A pane's address: the surface it hosts (`term_key`) and the provider running
 * in it.
 *
 * Neither half names a pane on its own. `terminal_sessions` is keyed by
 * `(repo, term_key, agent_kind)` — one surface holds one conversation per
 * provider — so a user can have a Claude and a Codex review of the same PR open
 * at once, and a map keyed by `term_key` alone would hand one pane's session,
 * title or provider mark to the other.
 *
 * **This is a local map key, never an identity that crosses IPC.** The two
 * halves reach the backend as two fields (`label` + `agentKind`, see
 * `TauriBackend.open`), because folding them into one string is exactly what
 * broke: a triage PTY opened under `AK-1::codex` matched no `term_key` on the
 * way back, so `hooks::session_states` reported a live agent as exited. The
 * separator is a character no `term_key` can contain, so the join is
 * unambiguous.
 */
export const paneAddress = (termKey: string, agentKind?: AgentKind | null): string =>
  agentKind ? `${termKey}\u0000${agentKind}` : termKey;
