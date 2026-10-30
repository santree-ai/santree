/** What every piece of one Conversation view shares: what it reads (a subagent
 *  is read with the same target and its own id) and where the session ran, so a
 *  path can be shown relative to it. */
import { createContext, type ReactNode, useContext } from "react";

import type { ConversationTarget } from "../../bindings";
import { formatDuration } from "../../lib/relativeTime";
import { compactPath } from "../trees/sessionDetail";

export interface ConversationScope {
  target: ConversationTarget;
  /** The session's working directory, as its record says. */
  cwd: string | null;
  /** A subagent's own conversation, read with this target and its id — still
   *  `running`, by its call's own record. Handed down rather than imported so a
   *  tool card need not import the journal that draws it. */
  renderSubagent?: (agentId: string, running: boolean) => ReactNode;
}

export const ConversationScopeContext = createContext<ConversationScope | null>(null);

export function useConversationScope(): ConversationScope | null {
  return useContext(ConversationScopeContext);
}

/** A path as the agent's own working directory would name it, or its last few
 *  segments when it lies outside. The whole path belongs in a `title`. */
export function displayPath(path: string, cwd: string | null): string {
  if (cwd && path.startsWith(`${cwd.replace(/\/+$/, "")}/`)) {
    return path.slice(cwd.replace(/\/+$/, "").length + 1);
  }
  return compactPath(path, 3);
}

/** A short duration: "450ms", "12s", "1m 12s". */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return formatDuration(ms / 1000);
}

/** The first non-blank line of a text, for a one-line preview. */
export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}
