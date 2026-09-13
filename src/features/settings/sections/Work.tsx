/** Settings → Work: everything about starting and running a task — the launch
 *  agent/model, Linear tracking, and how agent worktrees are set up and committed.
 *  Merges what used to be the separate "Issues" and "Trees" sections. */

import {
  TRACKER_READ_ONLY_HINT,
  useBoolSetting,
  useJiraSites,
  useLinearOrgs,
  useResolvedBoolSetting,
  useSetSetting,
  WORK_DEFAULT_REPO_KEY,
  WORK_MOVE_IN_PROGRESS_KEY,
} from "../../../lib/queries";
import { Heading, ToggleRow } from "../widgets";
import { DefaultProjectField, WorkActionConfig } from "./Actions";
import { WorktreeSettings } from "./Trees";

/** Toggle that moves the ticket to its started state when a worktree is created,
 *  so the tracker reflects what's actually being worked on. App defaults or a
 *  per-repo override, same scope convention as {@link WorkActionConfig}. */
function TrackingCard({ forRepo }: { forRepo?: string }) {
  const scope = forRepo ? `repo:${forRepo}` : "app";
  const appValue = useBoolSetting("app", WORK_MOVE_IN_PROGRESS_KEY).value;
  const resolvedValue = useResolvedBoolSetting(forRepo ?? "", WORK_MOVE_IN_PROGRESS_KEY).value;
  const value = forRepo ? resolvedValue : appValue;
  const { mutate: setSetting } = useSetSetting();
  // Scoped to every connection rather than a repo: this row also renders
  // app-wide, where there is no repo to resolve a tracker from. Read-only only
  // when nothing connected, in either tracker, can be written to.
  const { data: orgs = [] } = useLinearOrgs();
  const { data: sites = [] } = useJiraSites();
  const writable = [...orgs, ...sites].map((c) => c.canWrite);
  const readOnly = writable.length > 0 && writable.every((w) => !w);
  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
      <ToggleRow
        label="Move issue to In Progress when a worktree starts"
        hint={
          readOnly
            ? TRACKER_READ_ONLY_HINT
            : "Move the ticket to its “in progress” status so Linear or Jira reflects what you're actually working on. Needs write access to the tracker."
        }
        on={value && !readOnly}
        disabled={readOnly}
        onChange={(next) =>
          setSetting({
            scope,
            key: WORK_MOVE_IN_PROGRESS_KEY,
            value: next ? "true" : "false",
          })
        }
      />
    </div>
  );
}

export function WorkSection({ repo, forRepo }: { repo: string; forRepo: boolean }) {
  const scopeRepo = forRepo ? repo : undefined;
  return (
    <>
      <Heading
        title="Work"
        subtitle="Configure each provider, choose which one runs work and drafts commit or PR text, and control how worktrees behave."
      />
      {/* A single space-y so every card is evenly spaced. WorktreeSettings returns
          a fragment of cards, which flatten in here as siblings — so the gap is
          uniform across all of them (App scope shows the defaults; repo the override). */}
      <div className="space-y-5">
        {/* App-wide, like Triage's: which project a ticket starts in is not a
            question one project can answer for the others. */}
        {!forRepo && (
          <DefaultProjectField
            settingKey={WORK_DEFAULT_REPO_KEY}
            hint="Where a ticket that more than one of your projects carries is started and queued. Unset, the first such start asks and offers to remember the answer here. A ticket only one project carries never asks."
          />
        )}
        <WorkActionConfig repo={scopeRepo} />
        <TrackingCard forRepo={scopeRepo} />
        <WorktreeSettings repo={repo} forRepo={scopeRepo} />
      </div>
    </>
  );
}
