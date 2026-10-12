/** Settings → Terminal: the santree server card (docs/server.md, "UX").
 *
 *  The detached process that owns this Mac's terminals on a signed build. Shaped
 *  like the Daedalus status card: one state line with a glyph, the facts under
 *  it, and the controls that change the answer. Nothing here is optimistic about
 *  an ending: Restart, Stop and End now each show a pending state until the
 *  status event arrives, because painting "stopped" before the server says so
 *  would be a lie about terminals that are still running. */

import { useEffect, useRef, useState } from "react";

import type { DrainingServer, ServerState, ServerStatus } from "../../../bindings";
import { Button, ConfirmDialog, Spinner } from "../../../components/primitives";
import {
  useEndDrainingServer,
  useExportLogs,
  useRestartServer,
  useRevealLogs,
  useServerStatus,
  useStartServer,
  useStopServer,
} from "../../../lib/queries";
import { useLiveNow } from "../../../lib/relativeTime";
import {
  endDrainingConfirm,
  formatUptime,
  knownCount,
  restartConfirm,
  type ServerTone,
  serverStateView,
  sessionCountText,
  stopConfirm,
} from "../../../lib/serverStatus";
import { toast } from "../../../state/toast";
import { KvRow, ToneGlyph } from "../widgets";

const TONE_NAME: Record<ServerTone, string> = {
  ok: "Running",
  pending: "Working",
  warn: "Not running",
  error: "Failing",
};

/** How long a settled action waits for the status to move before the card stops
 *  claiming it is pending (an action that changed nothing sends no event). */
const SETTLE_MS = 10_000;

/** What an action is waiting to see change: which server runs, in what state, and
 *  which older ones remain. Not the session count — the status is re-pushed every
 *  time a session opens or ends, and that says nothing about the action. */
const positionOf = ({ state, draining }: ServerStatus) =>
  [
    state.kind,
    state.kind === "Running" ? state.revision : "",
    draining.map((d) => d.revision).join(","),
  ].join("|");

interface Pending {
  label: string;
  /** The server's position at the click. */
  from: string;
  /** The command has returned. */
  settled: boolean;
}

/** Holds an action "pending" from the click until the command has returned AND
 *  the server has moved since the click, or {@link SETTLE_MS} after it returned.
 *  A failed command clears it at once and rethrows, so the dialog shows the
 *  error. */
function usePendingAction(status: ServerStatus) {
  const position = positionOf(status);
  const positionRef = useRef(position);
  positionRef.current = position;
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    if (pending?.settled && position !== pending.from) setPending(null);
  }, [position, pending]);

  useEffect(() => {
    if (!pending?.settled) return;
    const t = setTimeout(() => setPending(null), SETTLE_MS);
    return () => clearTimeout(t);
  }, [pending]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setPending({ label, from: positionRef.current, settled: false });
    try {
      await action();
    } catch (e) {
      setPending(null);
      throw e;
    }
    setPending((p) => (p ? { ...p, settled: true } : p));
  };
  return { pendingLabel: pending?.label ?? null, run };
}

type Confirm = { kind: "restart" } | { kind: "stop" } | { kind: "end"; revision: number };

export function ServerCard() {
  const { data: status } = useServerStatus();
  // Unknown until the first answer; off is the one line in `ServerOff`.
  if (!status) return null;
  if (status.state.kind === "Off") return <ServerOff />;
  return <ServerControls status={status} />;
}

function ServerControls({ status }: { status: ServerStatus }) {
  const { state, draining } = status;
  const start = useStartServer();
  const restart = useRestartServer();
  const stop = useStopServer();
  const endDraining = useEndDrainingServer();
  const { pendingLabel, run } = usePendingAction(status);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const busy = pendingLabel !== null || start.isPending;

  const onConfirm = async () => {
    if (!confirm) return;
    if (confirm.kind === "restart") await run("Restarting…", () => restart.mutateAsync());
    else if (confirm.kind === "stop") await run("Stopping…", () => stop.mutateAsync());
    else await run(`Ending r${confirm.revision}…`, () => endDraining.mutateAsync(confirm.revision));
  };

  return (
    <section
      aria-label="santree server"
      className="mb-3.5 overflow-hidden rounded-xl border border-line-2 bg-raised"
    >
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-fg-bright">santree server</div>
          <p className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
            Owns this Mac's terminals, so a quit, a crash or an update never ends an agent.
          </p>
        </div>
        <div className="flex flex-none flex-wrap justify-end gap-2">
          {state.kind === "Running" ? (
            <>
              <Button disabled={busy} onClick={() => setConfirm({ kind: "restart" })}>
                Restart
              </Button>
              <Button disabled={busy} onClick={() => setConfirm({ kind: "stop" })}>
                Stop
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              disabled={busy || state.kind === "Starting" || state.kind === "Stopping"}
              onClick={() => start.mutate()}
            >
              {start.isPending && <Spinner size={10} color="var(--on-accent)" />}
              Start
            </Button>
          )}
          <LogButtons />
        </div>
      </div>

      <ServerStateBlock state={state} pendingLabel={pendingLabel} />

      {draining.length > 0 && (
        <DrainingServers
          draining={draining}
          busy={busy}
          onEnd={(revision) => setConfirm({ kind: "end", revision })}
        />
      )}

      <ServerConfirm
        confirm={confirm}
        state={state}
        draining={draining}
        onConfirm={onConfirm}
        onClose={() => setConfirm(null)}
      />
    </section>
  );
}

function LogButtons() {
  const exportLogs = useExportLogs();
  const revealLogs = useRevealLogs();
  return (
    <>
      <Button
        disabled={revealLogs.isPending}
        title="Shows the log folder in your file manager"
        onClick={() => revealLogs.mutate()}
      >
        Open logs
      </Button>
      <Button
        disabled={exportLogs.isPending}
        title="Writes the app and server logs into one text file in your downloads folder"
        onClick={() =>
          exportLogs.mutate(undefined, {
            onSuccess: (r) => toast.success(r.path, { title: "Logs exported" }),
          })
        }
      >
        Export logs
      </Button>
    </>
  );
}

/** The state line (an action's own words while one is pending) and, for a
 *  running server, its facts. */
function ServerStateBlock({
  state,
  pendingLabel,
}: {
  state: ServerState;
  pendingLabel: string | null;
}) {
  const view = serverStateView(state);
  const tone: ServerTone = pendingLabel ? "pending" : view.tone;
  const reason = state.kind === "Down" || state.kind === "Failing" ? state.reason : null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={tone === "pending"}
      className="border-t border-line bg-surface px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <ToneGlyph tone={tone} name={TONE_NAME[tone]} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-fg-3">{pendingLabel ?? view.title}</div>
          {reason && !pendingLabel && (
            <div className="mt-0.5 text-[11.5px] leading-[1.5] break-words text-muted-3">
              {reason}
            </div>
          )}
        </div>
      </div>
      {state.kind === "Running" && (
        <div className="mt-3 overflow-hidden rounded-lg border border-line-3 bg-raised">
          <KvRow label="Revision" value={`r${state.revision}`} />
          <KvRow label="Version" value={state.version} />
          <Uptime startedAtMs={state.startedAtMs} />
          <KvRow label="PID" value={String(state.pid)} />
          <KvRow label="Live sessions" value={String(state.liveSessions)} />
        </div>
      )}
    </div>
  );
}

/** Its own component so the shared clock re-renders this row, not the card. */
function Uptime({ startedAtMs }: { startedAtMs: number | null }) {
  const now = useLiveNow();
  return (
    <KvRow label="Uptime" value={startedAtMs === null ? "—" : formatUptime(now - startedAtMs)} />
  );
}

function DrainingServers({
  draining,
  busy,
  onEnd,
}: {
  draining: DrainingServer[];
  busy: boolean;
  onEnd: (revision: number) => void;
}) {
  return (
    <section aria-label="Older servers" className="border-t border-line px-4 py-3">
      <div className="text-[11.5px] font-medium text-fg-3">Older servers still running</div>
      <p className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
        An update left these running because they still hold terminals. Each exits when its last one
        ends.
      </p>
      <ul className="mt-2 overflow-hidden rounded-lg border border-line-3 bg-raised">
        {draining.map((d) => (
          <li
            key={d.revision}
            className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11.5px] first:border-t-0"
          >
            <span className="min-w-0 flex-1 text-fg-3">
              r{d.revision} · {sessionCountText(d.sessions)} · exits when it ends
            </span>
            <Button
              size="sm"
              disabled={busy}
              aria-label={`End r${d.revision} now`}
              onClick={() => onEnd(d.revision)}
            >
              End now
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What each confirm says will end. */
function confirmCopy(confirm: Confirm, state: ServerState, draining: DrainingServer[]) {
  if (confirm.kind === "end") {
    const d = draining.find((s) => s.revision === confirm.revision);
    return {
      title: `End r${confirm.revision} now?`,
      message: endDrainingConfirm(confirm.revision, d?.sessions ?? { kind: "Unknown" }),
      label: "End now",
    };
  }
  // Restart and Stop only exist for a running server, whose count is a fact.
  const count = knownCount(state.kind === "Running" ? state.liveSessions : 0);
  return confirm.kind === "restart"
    ? { title: "Restart the santree server?", message: restartConfirm(count), label: "Restart" }
    : { title: "Stop the santree server?", message: stopConfirm(count), label: "Stop" };
}

function ServerConfirm({
  confirm,
  state,
  draining,
  onConfirm,
  onClose,
}: {
  confirm: Confirm | null;
  state: ServerState;
  draining: DrainingServer[];
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const copy = confirm && confirmCopy(confirm, state, draining);
  return (
    <ConfirmDialog
      open={confirm !== null}
      title={copy?.title ?? ""}
      message={copy?.message ?? ""}
      confirmLabel={copy?.label ?? "Confirm"}
      busyLabel="Working…"
      danger
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

/** In server mode Off (an unsigned, dev or Linux build without the opt-in) there is
 *  no server to control, so the card is one line saying why terminals end with
 *  the app. */
function ServerOff() {
  return (
    <p className="mb-3.5 text-[11.5px] leading-[1.5] text-muted-3">
      Terminals aren't persistent in this build: they run inside santree and end when it quits. A
      signed release keeps them in a separate server that outlives the app.
    </p>
  );
}
