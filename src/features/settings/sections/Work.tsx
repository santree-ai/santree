/** Settings → Work: everything about starting and running a task — the launch
 *  agent/model, Linear tracking, and how agent worktrees are set up and committed.
 *  Merges what used to be the separate "Issues" and "Trees" sections. */

import { useBoolSetting, useSetSetting, WORK_MOVE_IN_PROGRESS_KEY } from "../../../lib/queries";
import { Heading, ToggleRow } from "../widgets";
import { WorkActionConfig } from "./Actions";
import { WorktreeSettings } from "./Trees";

/** Toggle (app-scoped) that moves the Linear issue to its started state when a
 *  worktree is created, so Linear reflects what's actually being worked on. */
function TrackingCard() {
  const { value } = useBoolSetting("app", WORK_MOVE_IN_PROGRESS_KEY);
  const { mutate: setSetting } = useSetSetting();
  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
      <ToggleRow
        label="Move issue to In Progress when a worktree starts"
        hint="Update the Linear issue to its “started” status so Linear reflects what you're actually working on. Needs Linear connected with write access."
        on={value}
        onChange={(next) =>
          setSetting({
            scope: "app",
            key: WORK_MOVE_IN_PROGRESS_KEY,
            value: next ? "true" : "false",
          })
        }
      />
    </div>
  );
}

export function WorkSection({ repo, forRepo }: { repo: string; forRepo: boolean }) {
  return (
    <>
      <Heading
        title="Work"
        subtitle="The agent that runs a task, Linear tracking, and how worktrees are set up and committed."
      />
      {/* A single space-y so every card is evenly spaced. WorktreeSettings returns
          a fragment of cards, which flatten in here as siblings — so the gap is
          uniform across all of them (App scope shows the defaults; repo the override). */}
      <div className="space-y-5">
        <WorkActionConfig repo={forRepo ? repo : undefined} />
        <TrackingCard />
        <WorktreeSettings repo={repo} />
      </div>
    </>
  );
}
