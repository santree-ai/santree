/**
 * The top bar's force-refresh: re-pull everything santree reads from Linear and
 * GitHub. Nothing polls those services in the background, so a ticket you just
 * filed (or a PR just opened) is invisible until the view happens to remount
 * past its stale window — this is the on-demand pull. Also bound to ⌘⇧R in
 * `useKeyboardShortcuts`.
 */
import { useRefreshExternal } from "../../lib/queries";
import { RefreshIcon } from "../icons";

export function RefreshButton() {
  const { refresh, fetching } = useRefreshExternal();
  return (
    <button
      type="button"
      onClick={refresh}
      // Never disabled while fetching: the spinner also reflects background
      // refetches this button didn't start (see `useRefreshExternal`), and those
      // must not swallow a click.
      aria-busy={fetching}
      title="Refresh Linear and GitHub data (⌘⇧R)"
      aria-label="Refresh Linear and GitHub data"
      className="flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded-md text-muted-3 hover:bg-hover hover:text-fg-2 focus-visible:ring-1 focus-visible:ring-[color:var(--accent)] focus-visible:outline-none"
    >
      <RefreshIcon size={12} className={fetching ? "animate-spin" : ""} />
    </button>
  );
}
