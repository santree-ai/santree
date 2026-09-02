/**
 * The Triage workspace's right rail: what you consult *beside* the ticket, in
 * two panes — the attached project's files, and the sessions that have run on
 * its main checkout.
 *
 * It is the same {@link SidePanel} Trees and Reviews are built on, and it means
 * the same thing by it: reference beside the work. There is no Issue pane here
 * because the main area's "Linear" tab *is* the ticket; a copy in a narrower
 * column would be the same thing twice, which is the rule Reviews follows for
 * its pull request.
 *
 * **Everything in it hangs off the attached project.** An investigation is a
 * real CLI session on a checkout, and both panes are facts about a checkout, so
 * each leads with the attachment: which project and branch it is reading, and
 * the control that changes that. Runs happen on the project's *main* checkout
 * (the {@link BASE_TICKET} entry), never on a worktree — a ticket in triage is
 * being read, not worked, and a branch per ticket someone glanced at would
 * litter the disk. So Files lists the main checkout, and Session history is
 * the main checkout's history: every investigation of every ticket on that
 * project, not only this one's.
 *
 * The attachment used to be a pane of its own. It is not a thing to consult —
 * it is a fact about the other two — so it lives on their header line, and
 * only *nothing attached* takes a pane over: each says so and offers the one
 * action that fixes it.
 *
 * Collapsible + resizable (drag its left edge or ⌘L).
 */
import type { ReactNode } from "react";

import { RepoAvatar } from "../../components/chrome/RepoAvatar";
import { BranchIcon, ClockIcon, FilesIcon } from "../../components/icons";
import { Button, EmptyState } from "../../components/primitives";
import { SidePanel, type SidePanelTab } from "../../components/SidePanel";
import { useBaseWorktree, useRepos } from "../../lib/queries";
import { shortRepoName } from "../../lib/repoName";
// The base-checkout sentinel, from the registry's mirror rather than the Trees
// model: `BASE_ID` is a plain constant there, but importing the module drags
// the Trees context (and, in tests, its whole import graph) along, which is
// exactly why `registry.ts` keeps its own copy.
import { BASE_TICKET } from "../agents/registry";
import { AllFilesList } from "../trees/AllFilesList";
import { SessionHistory } from "../trees/SessionHistory";

export type TriageRailTab = "files" | "history";

export const DEFAULT_W = 400;
const MIN_W = 300;
const MAX_W = 720;

const TABS: SidePanelTab<TriageRailTab>[] = [
  { tab: "files", label: "Files", icon: <FilesIcon size={15} /> },
  { tab: "history", label: "Session history", icon: <ClockIcon size={15} /> },
];

export function TriageSidePanel({
  repo,
  attached,
  defaultRepo,
  onPickProject,
  onDetach,
  tab,
  onTabChange,
  collapsed,
  onToggle,
  width,
  onWidth,
}: {
  /** The project the ticket runs on, or `null` when nothing is attached. */
  repo: string | null;
  /** `repo` is this ticket's own pick rather than the triage default. */
  attached: boolean;
  /** The default the ticket falls to without a pick of its own. */
  defaultRepo: string | null;
  /** Open the project picker; the gate persists whatever is picked. */
  onPickProject: () => void;
  /** Drop the ticket's own pick, back onto the default (or onto nothing). */
  onDetach: () => void;
  tab: TriageRailTab;
  onTabChange: (tab: TriageRailTab) => void;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
  onWidth: (w: number) => void;
}) {
  const { data: repos = [] } = useRepos();
  const project = repo ? (repos.find((r) => r.name === repo) ?? null) : null;
  // The main checkout's branch, for the "which project" line and the history
  // pane's "where it ran". Off without a project.
  const { data: base } = useBaseWorktree(repo ?? "");
  const branch = base?.branch ?? null;

  /** A checkout pane under the line that says which project it is reading.
   *  Written once: the line is about the attachment, not about any one pane,
   *  and two copies would be two chances for one to stop saying it. */
  const onProject = (name: string, pane: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectLine
        repo={name}
        branch={branch}
        attached={attached}
        defaultRepo={defaultRepo}
        onChange={onPickProject}
        onDetach={onDetach}
      />
      <div className="flex min-h-0 flex-1 flex-col">{pane}</div>
    </div>
  );

  const panes: Record<TriageRailTab, ReactNode> = {
    // No `onOpen`: this view's main area is the ticket and its investigations,
    // and it has no file viewer to land a click in. Read-only rows say that up
    // front; a dead button says it once per click.
    files: project ? (
      onProject(
        project.name,
        <AllFilesList repo={project.name} worktreeId={BASE_TICKET} selectedPath={null} />,
      )
    ) : (
      <NoProject what="Browsing the project's files" onAttach={onPickProject} />
    ),
    // The main checkout's sessions, which is where investigations run — so this
    // is the checkout's history, every ticket's, not only this one's. No
    // `onResume`: an investigation tab's own resume pane already does that job.
    history: project ? (
      onProject(
        project.name,
        <SessionHistory repo={project.name} worktreeId={BASE_TICKET} branch={branch} />,
      )
    ) : (
      <NoProject
        what="Listing the sessions that ran on the main checkout"
        onAttach={onPickProject}
      />
    ),
  };

  return (
    <SidePanel
      tabs={TABS}
      active={tab}
      onSelect={onTabChange}
      collapsed={collapsed}
      onToggle={onToggle}
      width={width}
      onWidth={onWidth}
      cssVar="--triage-right"
      min={MIN_W}
      max={MAX_W}
      resetTo={DEFAULT_W}
      ariaLabel="Ticket panel"
    >
      {/* A total map, for the reason the other two hosts give: a new rail tab
          is a compile error here instead of landing in whichever arm was last. */}
      {panes[tab]}
    </SidePanel>
  );
}

/** One line of why, shared by both empty states so the rail never explains the
 *  attachment two ways. */
const WHY =
  "Investigations, terminals and these panes run on the project's main checkout. No worktree is created.";

/** What a checkout pane renders until there is a project to read. The same
 *  words in both, because it is the same missing fact, and the one action that
 *  fixes it. */
function NoProject({ what, onAttach }: { what: string; onAttach: () => void }) {
  return (
    <EmptyState
      icon={<BranchIcon size={16} className="text-muted-4" />}
      title="No project attached"
      subtitle={
        <>
          {what} needs a project. {WHY}
          <span className="mt-3 flex justify-center">
            <Button size="sm" onClick={onAttach}>
              <BranchIcon size={11} />
              Attach a project
            </Button>
          </span>
        </>
      }
    />
  );
}

/**
 * The line above a checkout pane: which project (and branch) it is reading, on
 * what footing, and the controls that change it. "Change" opens the picker;
 * "Use default" is offered only for a ticket's own pick, when there is a
 * default to fall back to — on the default already, it would offer to do what
 * is the case.
 */
function ProjectLine({
  repo,
  branch,
  attached,
  defaultRepo,
  onChange,
  onDetach,
}: {
  repo: string;
  branch: string | null;
  attached: boolean;
  defaultRepo: string | null;
  onChange: () => void;
  onDetach: () => void;
}) {
  return (
    <div className="flex h-9 flex-none items-center gap-2 border-b border-hairline bg-raised px-3 text-[11px] text-muted-3">
      <RepoAvatar repo={repo} size={14} bordered={false} />
      <span className="min-w-0 truncate" title={repo}>
        <span className="text-fg-3">{shortRepoName(repo)}</span>
        {branch && (
          <>
            {" · "}
            <span className="font-mono text-[10.5px]">{branch}</span>
          </>
        )}
      </span>
      {!attached && (
        <span
          className="flex-none rounded border border-hairline px-1 text-[9px] tracking-[.06em] text-muted-4 uppercase"
          title="The triage default; this ticket has no project of its own"
        >
          default
        </span>
      )}
      <span className="ml-auto flex flex-none items-center gap-1">
        {attached && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onDetach}
            title={
              defaultRepo
                ? `Drop this ticket's own pick and follow the triage default (${shortRepoName(defaultRepo)})`
                : "Drop this ticket's own pick; nothing will be attached"
            }
          >
            {defaultRepo ? "Use default" : "Detach"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onChange}
          title="Run this ticket on another project"
        >
          Change
        </Button>
      </span>
    </div>
  );
}
