/** Settings → Terminal: what is running behind the panes, and how to reach it.
 *
 *  Framed as recovery rather than administration, the way Orca frames its own:
 *  nothing here is part of a normal day. It exists for the terminal that has
 *  wedged, and for the state reattach made possible — a session still running
 *  with nothing attached to it, which no other surface shows.
 *
 *  On a signed build the sessions live in the detached santree server, which can
 *  be a different revision from the app after an update, so the card above the
 *  table controls it (`ServerCard`) and the table groups sessions by the server
 *  holding them. In a build without one they live in the app and end when it quits. */

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TerminalSession } from "../../../bindings";
import { commands } from "../../../bindings";
import { Button, ConfirmDialog, Dot } from "../../../components/primitives";
import {
  queryKeys,
  useAppVersion,
  useRepos,
  useServerStatus,
  useTerminalInventory,
} from "../../../lib/queries";
import { palette } from "../../../theme/colors";
import { Heading } from "../widgets";
import { ServerCard } from "./ServerCard";
import { ORPHAN_HINT, sessionName, TerminalSessionList } from "./TerminalSessions";

export function TerminalSection() {
  // Polls only while this section is on screen: TanStack runs `refetchInterval`
  // only while a query has observers, and navigating away unmounts this.
  const { data: inventory } = useTerminalInventory();
  const { data: serverStatus } = useServerStatus();
  const { data: version } = useAppVersion();
  const { data: repos = [] } = useRepos();
  const qc = useQueryClient();
  const [killing, setKilling] = useState<TerminalSession | null>(null);
  const [killAll, setKillAll] = useState(false);

  const rows = inventory?.sessions ?? [];
  const orphans = new Set(inventory?.orphans ?? []);
  const currentRevision =
    serverStatus?.state.kind === "Running" ? serverStatus.state.revision : null;
  const running = rows.filter((s) => s.alive).length;
  const detached = rows.filter((s) => s.alive && !s.attached).length;

  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.terminalInventory });
  const close = async (id: number) => {
    const result = await commands.terminalClose(id);
    if (result.status === "error") throw new Error(result.error);
    await refresh();
  };

  return (
    <>
      <Heading
        title="Terminal"
        subtitle="What is running behind your panes, and how to recover a terminal that has stopped responding."
      />

      <ServerCard />

      <div className="mb-3.5 rounded-xl border border-line-2 bg-raised px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 text-[13px] font-medium text-fg-2">
              Terminal sessions
              {version && (
                <span
                  className="font-mono text-[11px] font-normal text-muted-4"
                  title="This app's version. The server has its own revision, shown in the card above."
                >
                  santree {version}
                </span>
              )}
            </div>
            <p className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
              Sessions outlive the window: closing a pane leaves the work running. Which process
              holds them, and whether they outlive the app, depends on the server above.
            </p>
          </div>
          <div className="flex flex-none gap-2">
            <Button onClick={refresh} title="Refresh">
              Refresh
            </Button>
            <Button
              onClick={() => setKillAll(true)}
              disabled={rows.length === 0}
              title={rows.length === 0 ? "Nothing is running" : "End every session"}
            >
              Kill all
            </Button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[11.5px] text-muted-3">
          <Dot color={running > 0 ? palette.green : palette.muted} />
          {rows.length === 0
            ? "No sessions running"
            : `${running} running${detached > 0 ? ` · ${detached} detached` : ""}`}
        </div>

        {rows.length > 0 && (
          <TerminalSessionList
            sessions={rows}
            repos={repos}
            orphans={orphans}
            currentRevision={currentRevision}
            onKill={setKilling}
          />
        )}

        {orphans.size > 0 && (
          <p role="note" className="mt-2 text-[11.5px] leading-[1.5] text-muted-3">
            {orphans.size} session{orphans.size === 1 ? "" : "s"} marked "no tab": {ORPHAN_HINT}
          </p>
        )}
        {inventory && !inventory.complete && (
          <p role="note" className="mt-2 text-[11.5px] leading-[1.5] text-muted-3">
            This list may be missing sessions: a server that may hold more couldn't be asked.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={killing !== null}
        title="Kill this session?"
        // Orca's pattern: state the loss precisely, then bound it. A sentence
        // that only says what is destroyed reads as worse than it is.
        message={
          killing
            ? `Force-quits ${sessionName(killing)}. Anything unsaved in that terminal is lost. Its pane closes and can be reopened straight away.`
            : ""
        }
        confirmLabel="Kill session"
        busyLabel="Killing…"
        danger
        onConfirm={async () => {
          if (killing) await close(killing.id);
        }}
        onClose={() => setKilling(null)}
      />

      <ConfirmDialog
        open={killAll}
        title="Kill all terminal sessions?"
        message={`Force-quits ${rows.length} session${rows.length === 1 ? "" : "s"} across every worktree, including any agent still working. Anything unsaved in them is lost. New terminals can be opened straight away.`}
        confirmLabel="Kill all"
        busyLabel="Killing…"
        danger
        onConfirm={async () => {
          // Sequential on purpose: each close kills a process tree, and firing
          // them all at once puts every teardown on the blocking pool together
          // for no gain — this is a handful of sessions, not a fan-out.
          for (const s of rows) await close(s.id);
        }}
        onClose={() => setKillAll(false)}
      />
    </>
  );
}
