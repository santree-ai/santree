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
import type { ServerStatus, TerminalSession } from "../../../bindings";
import { commands } from "../../../bindings";
import { Button, ConfirmDialog, Dot } from "../../../components/primitives";
import {
  queryKeys,
  useAppVersion,
  useServerStatus,
  useTerminalInventory,
} from "../../../lib/queries";
import { palette } from "../../../theme/colors";
import { Heading } from "../widgets";
import { ServerCard } from "./ServerCard";

/** What a session's dot and status word say. Three states, because "running"
 *  and "running but unwatched" are genuinely different things to the user, and
 *  only one of them is a reason to come here. */
function statusOf(s: TerminalSession): { label: string; color: string; hint: string } {
  if (!s.alive) {
    return {
      label: "Exited",
      color: palette.muted,
      hint: "The process ended. The session is still holding a pty until it is closed.",
    };
  }
  if (!s.attached) {
    return {
      label: "Detached",
      color: palette.amber,
      hint: "Running, with no pane receiving its output. Reopening its worktree attaches to it.",
    };
  }
  return {
    label: "Running",
    color: palette.green,
    hint: "A pane is attached and receiving output.",
  };
}

/** The worktree or surface a session belongs to, from its `term_key`.
 *
 *  Shown instead of the raw session id for the same reason Orca shows a
 *  workspace: the id is how the backend refers to it, but the worktree is how
 *  the user knows which of their terminals this is. */
function surfaceOf(session: TerminalSession): string {
  const label = session.label;
  if (!label) return session.cwd?.split("/").slice(-2).join("/") ?? "unknown";
  const tab = label.match(/^tree:(.+):tab:(.+)$/);
  if (tab) return `${tab[1]} · tab ${tab[2]}`;
  const tree = label.match(/^tree:(.+)$/);
  if (tree) return tree[1];
  return label;
}

const ORPHAN_HINT =
  "running, but no tab will ever show them (a tab closed while its server was unreachable, or a worktree deleted under it). Kill them to free the process.";

/** Sessions grouped by the server holding them, newest revision first; sessions
 *  in the app itself (no revision) come last. */
function groupByServer(
  rows: TerminalSession[],
  status: ServerStatus | undefined,
): { key: string; label: string; sessions: TerminalSession[] }[] {
  const current = status?.state.kind === "Running" ? status.state.revision : null;
  const by = new Map<number | null, TerminalSession[]>();
  for (const s of rows) {
    const k = s.serverRevision ?? null;
    by.set(k, [...(by.get(k) ?? []), s]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b - a))
    .map(([rev, sessions]) => ({
      key: String(rev),
      label:
        rev === null
          ? "In this app"
          : `Server r${rev}${rev === current ? " · current" : " · older, draining"}`,
      sessions,
    }));
}

export function TerminalSection() {
  // Polls only while this section is on screen: TanStack runs `refetchInterval`
  // only while a query has observers, and navigating away unmounts this.
  const { data: inventory } = useTerminalInventory();
  const { data: serverStatus } = useServerStatus();
  const { data: version } = useAppVersion();
  const qc = useQueryClient();
  const [killing, setKilling] = useState<TerminalSession | null>(null);
  const [killAll, setKillAll] = useState(false);

  const rows = inventory?.sessions ?? [];
  const orphans = new Set(inventory?.orphans ?? []);
  const groups = groupByServer(rows, serverStatus);
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
          <div className="mt-3 overflow-hidden rounded-lg border border-line">
            <div className="flex border-b border-line bg-panel px-3 py-1.5 text-[10.5px] font-medium tracking-wide text-muted-4 uppercase">
              <div className="min-w-0 flex-1">Session</div>
              <div className="w-[70px] flex-none text-right">PID</div>
              <div className="w-[80px] flex-none text-right">Size</div>
              <div className="w-[86px] flex-none pl-3">Status</div>
              <div className="w-[28px] flex-none" />
            </div>
            {groups.map((g) => (
              <div key={g.key}>
                <div className="border-t border-line bg-panel px-3 py-1 text-[10.5px] text-muted-3 first:border-t-0">
                  {g.label}
                </div>
                {g.sessions.map((s) => {
                  const status = statusOf(s);
                  return (
                    <div
                      key={s.id}
                      className="group flex items-center border-t border-line px-3 py-2 text-[11.5px]"
                    >
                      <div
                        className="flex min-w-0 flex-1 items-center gap-2 truncate text-fg-3"
                        title={s.cwd ?? s.label}
                      >
                        <span className="truncate">{surfaceOf(s)}</span>
                        {orphans.has(s.id) && (
                          <span
                            className="flex-none rounded-sm bg-panel px-1 text-[10px] text-status-amber"
                            title={ORPHAN_HINT}
                          >
                            no tab
                          </span>
                        )}
                      </div>
                      <div className="w-[70px] flex-none text-right font-mono text-muted-4">
                        {s.pid ?? "—"}
                      </div>
                      <div className="w-[80px] flex-none text-right font-mono text-muted-4">
                        {s.cols}×{s.rows}
                      </div>
                      <div
                        className="flex w-[86px] flex-none items-center gap-1.5 pl-3 text-muted-3"
                        title={status.hint}
                      >
                        <Dot color={status.color} />
                        {status.label}
                      </div>
                      <button
                        type="button"
                        onClick={() => setKilling(s)}
                        title={`Kill ${surfaceOf(s)}`}
                        aria-label={`Kill session ${surfaceOf(s)}`}
                        className="w-[28px] flex-none cursor-pointer text-muted-4 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-status-red"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
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
            ? `Force-quits ${surfaceOf(killing)}. Anything unsaved in that terminal is lost. Its pane closes and can be reopened straight away.`
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
