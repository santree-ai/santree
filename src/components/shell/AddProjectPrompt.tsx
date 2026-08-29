/**
 * What "add a project" still has to say after the folder picker closes.
 *
 * Two things can follow a pick: it failed, or it landed and santree doesn't know
 * which Linear workspace it belongs to (asked only when several are connected
 * and the repo's own CLI config didn't answer it — see {@link useAddProject}).
 *
 * Shared, because {@link useAddProject} holds that state per call site: the
 * sidebar's "+" and the welcome surface's button each run their own flow, so
 * whichever one was used has to be able to finish the conversation itself.
 */
import type { AddProjectFlow } from "./useAddProject";

export function AddProjectPrompt({
  flow,
  className,
}: {
  flow: AddProjectFlow;
  className?: string;
}) {
  const { error, pendingRepo, orgs, chooseOrg } = flow;
  if (!error && !pendingRepo) return null;

  return (
    <div className={className}>
      {error && <p className="pb-1 text-[11px] text-[var(--color-status-red)]">{error}</p>}
      {pendingRepo && (
        <div className="rounded-md border border-line bg-surface p-2">
          <p className="pb-1 text-[11px] text-muted-4">Linear workspace for {pendingRepo}</p>
          {orgs.map((org) => (
            <button
              key={org.slug}
              type="button"
              onClick={() => chooseOrg(org.slug)}
              className="flex h-6 w-full cursor-pointer items-center rounded px-1.5 text-[12px] text-fg-2 transition-colors hover:bg-hover"
            >
              {org.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
