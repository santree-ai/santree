/**
 * The tab an adopted session gets when nothing on screen has asked for it.
 *
 * A pane normally comes up because a view mounted and called `ensure`, and a
 * session left running by the last page load (or by the last app run, now that
 * a server keeps them) is only found again if its view is visited. Until then
 * the agent registry has no live terminal for it, so the agent reads `detached`
 * and its prompts drop out of the attention count. Relaunch adopts everything
 * instead: every adopted session gets its tab at once, and the view that owns
 * it finds the tab already there when it opens (`ensure` is idempotent per
 * `(source, refId, provider)`).
 *
 * The identity has to be exactly the one the owning view would mint, or its
 * `ensure` would not find this tab and a second pane would attach to the same
 * session, so every field is derived from the same facts the launch sites use
 * and a session that cannot be named that precisely is left for its view.
 */
import type { AdoptedSession } from "../../bindings";
import { pathWithin } from "../../lib/repo";
import { type AgentOriginKind, parseTermKey } from "../agents/registry";
import type { TerminalSource, TerminalSpec } from "./orchestrator";
import { paneAddress } from "./paneAddress";
import type { SessionId } from "./types";

/** Adopted sessions by pane address (see `paneAddress`): the surface's
 *  `term_key` AND the provider in it, because that is what a pane coming up knows
 *  about itself, and one surface can have a pane per provider (a Claude and a
 *  Codex review of the same PR) — keyed by label alone, both would adopt the same
 *  session and the other would be stranded. */
export const adoptedMap = (sessions: AdoptedSession[]): Map<string, SessionId> =>
  new Map(sessions.map((s) => [paneAddress(s.label, s.agentKind), s.id]));

/** The source a `term_key` was launched under — the launch sites' own table
 *  (`WorktreeTerminal`, `TriageTerminal`/`InvestigatePane`, `ReviewTerminal`).
 *  A key outside it (a settings login, anything else) names no surface, so it
 *  gets no tab. */
export function sourceOfTermKey(termKey: string): TerminalSource | null {
  return SOURCE_OF_ORIGIN[parseTermKey(termKey).kind];
}

const SOURCE_OF_ORIGIN: Record<AgentOriginKind, TerminalSource | null> = {
  tree: "issue",
  "tree-tab": "issue",
  triage: "triage",
  "triage-tab": "triage",
  review: "review",
  "ai-review": "review",
  unknown: null,
};

interface RepoPath {
  name: string;
  path: string | null;
}

/** The registered project a working directory sits in: the deepest one whose
 *  path contains it, component-wise (a sibling sharing a prefix is not it). */
export function repoOfCwd(repos: readonly RepoPath[], cwd: string | null): string | null {
  if (!cwd) return null;
  let best: RepoPath | null = null;
  for (const r of repos) {
    if (!r.path || !pathWithin(r.path, cwd)) continue;
    if (!best || r.path.length > (best.path?.length ?? 0)) best = r;
  }
  return best?.name ?? null;
}

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** The spec to `ensure` for an adopted session, or null when it should wait for
 *  its own view. */
export function adoptedTabSpec(
  s: AdoptedSession,
  repos: readonly RepoPath[],
): (TerminalSpec & { refId: string }) | null {
  const source = sourceOfTermKey(s.label);
  if (!source) return null;
  const title = s.cwd ? baseName(s.cwd) : s.label;
  if (!s.agentKind) return { title, cwd: s.cwd ?? undefined, source, refId: s.label };
  // An agent's identity is all three fields or none (see `AgentTabIdentity`): a
  // tab filed under the wrong project is worse than one not filed at all.
  const repo = repoOfCwd(repos, s.cwd);
  if (!repo) return null;
  return {
    title,
    cwd: s.cwd ?? undefined,
    source,
    refId: s.label,
    agent: { kind: s.agentKind, repo, termKey: s.label },
  };
}
