/**
 * The manual pull of everything santree reads from Linear and GitHub.
 *
 * Nothing polls those services, so a ticket filed a minute ago is invisible until
 * a view happens to remount past its stale window — this is the only on-demand
 * pull, and with the per-view chrome gone the bar is the only place left to put
 * it. Also bound to ⌘⇧R.
 */
import { useRefreshExternal } from "../../../lib/queries";
import { RefreshIcon } from "../../icons";
import { StatusButton } from "./StatusSegment";

/** Force-refetch the external data, spinning while anything is in flight. */
export function RefreshSegment() {
  const { refresh, fetching } = useRefreshExternal();
  return (
    <StatusButton
      onClick={refresh}
      // Never disabled while fetching: the spinner also reflects background
      // refetches this button didn't start, and those must not swallow a click.
      aria-busy={fetching}
      aria-label="Refresh Linear and GitHub data"
      title="Refresh Linear and GitHub data (⌘⇧R)"
    >
      <RefreshIcon size={11} className={fetching ? "animate-spin" : ""} />
    </StatusButton>
  );
}
