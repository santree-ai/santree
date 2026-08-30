/**
 * The launch-line surface, in one import for the four places that open an agent
 * terminal.
 *
 * {@link AgentLaunchConfig} is typed, provider-neutral data — a model name, an
 * effort, a permission mode, a path — and each provider's `AgentLaunchSpec`
 * (see `agentProvider.ts`) is the only thing that knows how its CLI spells
 * them. Call sites pass what the user configured; they do not build flags,
 * quote values, or remember which of them a given CLI must not receive.
 *
 * {@link resumeInvocation} is the same knowledge pointed the other way: the
 * command a human would type to continue a session in their own terminal, built
 * from the identical provider record the seed uses, so the copied line and the
 * launched one cannot drift.
 */
export {
  type AgentLaunchConfig,
  type AgentLaunchSpec,
  agentSessionSeed,
  resumeInvocation,
  shellQuote,
} from "./agentProvider";
