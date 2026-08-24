import {
  SYNC_VIEWED_KEY,
  useGithubStatus,
  useSetSyncViewed,
  useSetting,
} from "../../../lib/queries";
import { ToggleRow } from "../widgets";

/** Reviews-owned behavior: where per-file Viewed marks are stored. */
export function ViewedMarksCard() {
  const { data: gh } = useGithubStatus();
  const { data } = useSetting("app", SYNC_VIEWED_KEY);
  const { mutate: setSyncViewed } = useSetSyncViewed();
  const authenticated = !!gh?.authenticated;

  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
      <ToggleRow
        label={'Sync "Viewed" files with GitHub'}
        hint={
          authenticated
            ? "Marking a file viewed here marks it on github.com too, and marks made there show up here. Off, marks stay on this machine."
            : "Sign in with the gh CLI to sync marks with GitHub. Until then they stay on this machine."
        }
        on={authenticated && data === "true"}
        disabled={!authenticated}
        onChange={setSyncViewed}
      />
    </div>
  );
}
