/**
 * **Which agent owns this pane** — the one arbiter for that question, and the
 * sibling of `lib/attention.ts`, which owns the other one (*what is it doing*).
 *
 * The two questions have separate answers and separate modules on purpose. A
 * pane's provider is an identity: it decides which mark is drawn, which CLI a
 * resume launches, and whether the pane counts as an agent at all. Its state is
 * a claim about work in progress. Letting one answer the other is how a pane
 * that merely *exists* starts reading as a pane that is *busy* — so nothing
 * here returns, accepts, or can be widened into a status. See the type note
 * below, which makes that structural rather than a promise.
 *
 * ## The precedence, and why each tier beats the next
 *
 *  1. **The session row** (`session_state.agent_kind`) — what the provider's own
 *     hook reported from inside the agent's lifecycle. Decisive wherever it
 *     exists: the row carries a provider-minted session id, and an identity
 *     taken from anywhere else would not match the id sitting beside it.
 *  2. **The process table** (`agent_procs.rs`) — what `ps` sees in the pane's
 *     foreground *right now*. It beats santree's launch record because it is
 *     observation where the record is memory: it is the only signal that
 *     survives the user quitting one CLI and starting another in the same pane,
 *     and the only one that can see an agent santree never launched at all.
 *  3. **santree's own launch record** (a tab's `AgentTabIdentity`) — what
 *     santree put in the pane. Last, but never removable: `ps` can fail, and a
 *     CLI behind an interpreter is not recognisable by `argv[0]`, so tier 2
 *     supplements this rather than replacing it.
 *
 * A missing signal is **no information, never "no agent"** — which is why every
 * field is optional and `null` and `undefined` are read the same way. Only when
 * all three say nothing is the answer `null`, and that means "no agent is known
 * to be here", not "this is a plain shell".
 *
 * ## The call sites this exists to keep in sync
 *
 * The rule predates the function, and the two below had already drifted apart
 * under it — the status bar consulted tier 3 alone, so a pane the process table
 * named but santree had not launched appeared in the tree and went uncounted in
 * the bar. Anything that needs a pane's provider calls this; nothing writes a
 * second `??` chain:
 *
 *  - `features/agents/registry.ts` — `buildAgentEntries`, in both passes (the
 *    session-row pass and the pane pass). Feeds the sidebar tree, the palette
 *    and every `AgentEntry.agentKind` consumer.
 *  - `components/shell/status/AgentsSegment.tsx` — `countLive`, the status
 *    bar's "N agents".
 */
import type { AgentKind } from "../bindings";

/**
 * What the arbiter can answer: a provider, or nothing observed.
 *
 * `AgentKind` and only `AgentKind`. It is the identity vocabulary and carries
 * no state, which is the point — the same discipline as `TitleActivity` in
 * `features/terminal/agentTitle.ts`, where the status tier is typed so it can
 * only ever assert activity and never identity. This is that constraint pointed
 * the other way, and `paneAgentOwner.test.ts` pins it at compile time.
 */
export type PaneAgentOwner = AgentKind | null;

/**
 * The three signals, in no particular order here — {@link resolvePaneAgentOwner}
 * holds the order. Each is optional because a caller supplies whichever it
 * actually has, and because absence is not an answer.
 *
 * Every field is a {@link PaneAgentOwner}: there is no field an `AgentState`
 * could be passed in, so there is no state for the resolver to leak back out.
 */
export type PaneAgentOwnerSignals = {
  /** 1. The provider named on the pane's `session_state` row. */
  sessionAgent?: PaneAgentOwner;
  /** 2. The provider the host process table sees in the pane's foreground. */
  detectedAgent?: PaneAgentOwner;
  /** 3. The provider santree recorded launching into the pane. */
  launchAgent?: PaneAgentOwner;
};

/**
 * The single authoritative resolver for "which agent owns this pane", shared by
 * the registry fold and the status bar's live count so they cannot drift apart.
 * See this module's docblock for the precedence and the full call-site list.
 */
export function resolvePaneAgentOwner(signals: PaneAgentOwnerSignals): PaneAgentOwner {
  return signals.sessionAgent ?? signals.detectedAgent ?? signals.launchAgent ?? null;
}
