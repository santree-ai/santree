/**
 * The santree server is the process that owns this Mac's terminals on a signed
 * build (docs/server.md). When it is down, new terminals have nowhere to open,
 * and the existing ones read as lost — so the window says so, once, with the one
 * thing that fixes it.
 *
 * Quiet by construction: nothing while the server is off (a mode with in-app
 * terminals) or running. It speaks for `Down` and `Failing` at once, and for a
 * start or a stop only once it has lasted (`useServerAttention`, the status-bar
 * dot's rule too, so the two never disagree). Starting is the user's call (the
 * supervisor stops restarting a server that keeps dying), and so is everything
 * after it: nothing here starts, resumes or retries by itself.
 */
import { useServerStatus, useStartServer } from "../../lib/queries";
import { serverStateView, TONE_DOT, useServerAttention } from "../../lib/serverStatus";
import { Button, Spinner } from "../primitives";

export function ServerBanner() {
  const { data } = useServerStatus();
  const start = useStartServer();
  const attention = useServerAttention(data?.state);

  if (!data || !attention) return null;
  const { state } = data;
  const view = serverStateView(state);

  if (state.kind === "Down" || state.kind === "Failing") {
    return (
      <div
        role="alert"
        className="flex flex-none items-center gap-3 border-b border-hairline bg-raised px-4 py-2"
      >
        <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${TONE_DOT[view.tone]}`} />
        <div className="min-w-0 flex-1 text-sm leading-[1.5] text-muted-2">
          <span className="font-medium text-fg-2">{view.sentence}</span> New terminals can't open,
          and the ones it held read as lost. {state.reason}
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={start.isPending}
          onClick={() => start.mutate()}
          aria-label="Start server"
        >
          {start.isPending && <Spinner size={10} color="var(--on-accent)" />}
          Start server
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-none items-center gap-2 border-b border-hairline bg-raised px-4 py-1.5 text-sm text-muted-3"
    >
      <Spinner size={11} />
      {view.sentence}
    </div>
  );
}
