/**
 * Gate for the hidden Dev tab: it exists only for the app's developer, keyed on
 * the authenticated `gh` login. The nav chrome and shortcut map read the same
 * answer via `AppContext.devEnabled`; this hook adds `fetched` for DevView's
 * redirect (don't bounce off the tab before the status has actually loaded).
 */
import { DEV_GITHUB_LOGIN, useGithubStatus } from "../../lib/queries";

export function useDevEnabled(): { enabled: boolean; fetched: boolean } {
  const gh = useGithubStatus();
  return { enabled: gh.data?.account === DEV_GITHUB_LOGIN, fetched: gh.isFetched };
}
