/**
 * "Relaunch adopts everything": the two things that keep this page holding every
 * session the Mac is running, mounted once at the root beside the layer.
 *
 *  1. **A tab for every adopted session.** Sessions come back from the backend
 *     whether or not a view will ever be opened for them; without a tab the agent
 *     registry sees no live terminal, so the agent reads `detached` and its prompts
 *     leave the attention count. A tab is `ensure`d for each one whose surface can
 *     be named (`adoptedTabs`), except those the backend reports as orphans (a tab
 *     row that is gone). Nothing is ever closed here: a session whose surface is
 *     gone just waits, and Settings is where a human ends it.
 *  2. **Adopting again when the server comes up late.** The page-load adoption waits
 *     a bounded time for the server and takes whatever it has; a server that
 *     starts later (a slow signature check, a Start click after it was down) would
 *     otherwise never be adopted.
 *
 * Neither starts, resumes or retries anything: they only attach to processes that
 * are already running.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ServerState } from "../../bindings";
import { fetchTerminalInventory, useRepos, useServerStatus } from "../../lib/queries";
import { adoptedTabSpec } from "./adoptedTabs";
import { useAdoptAgain, useAdoptedSessions, useTerminals } from "./TerminalsContext";

export function TerminalAdoption() {
  useReadoptWhenServerRuns();
  useEnsureAdoptedTabs();
  return null;
}

/**
 * Adopt again when the status moves INTO `Running` — the one change that means
 * "there may be sessions to adopt that weren't there when this page loaded".
 *
 * The status is re-pushed whenever the server's session count changes, so this
 * compares kinds, not events: a `Running` that follows a `Running` is the count
 * moving, and adopting on it would re-ask the backend on every shell anyone
 * opens. The first status seen is the page's starting point, not a change — the
 * page-load adoption already waited for the server it names.
 */
function useReadoptWhenServerRuns() {
  const adoptAgain = useAdoptAgain();
  const { data } = useServerStatus();
  const kind = data?.state.kind;
  const last = useRef<ServerState["kind"]>(undefined);
  useEffect(() => {
    if (!kind) return;
    const moved = last.current !== undefined && last.current !== "Running" && kind === "Running";
    last.current = kind;
    if (moved) void adoptAgain();
  }, [kind, adoptAgain]);
}

function useEnsureAdoptedTabs() {
  const qc = useQueryClient();
  const { ensure } = useTerminals();
  const { panes, ready } = useAdoptedSessions();
  const { data: repos } = useRepos();
  // Sessions already handled. A ref, not state: it only stops a re-render from
  // asking the backend twice, and a StrictMode re-run must find it filled.
  const handled = useRef(new Set<number>());

  useEffect(() => {
    // `repos` itself, not "the read settled": a failed read settles with no data,
    // and an agent is named by the project its cwd sits in, so with no list every
    // agent would read as belonging to none and be skipped for good.
    if (!ready || repos === undefined) return;
    const fresh = panes.filter((p) => !handled.current.has(p.id));
    if (fresh.length === 0) return;
    for (const p of fresh) handled.current.add(p.id);
    void (async () => {
      // The orphans are the backend's call (it can see which tab rows exist);
      // when it can't be asked, every session is treated as wanted — a running
      // agent shown is better than a running agent nobody can see.
      const orphans = await fetchTerminalInventory(qc)
        .then((inv) => new Set(inv.orphans))
        .catch(() => new Set<number>());
      for (const p of fresh) {
        if (orphans.has(p.id)) continue;
        const spec = adoptedTabSpec(p, repos);
        if (spec) ensure(spec);
      }
    })();
  }, [panes, ready, repos, qc, ensure]);
}
