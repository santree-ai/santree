/**
 * Trees-tab state model.
 *
 * Owns which worktree (task) is active, the right panel's state
 * (collapsed/width, like the Issues panel), and which file is open in the main
 * area. The worktree list is real (DB-backed git worktrees for the active repo),
 * grouped by project in the sidebar. An empty `activeId` means the all-agents
 * overview is showing instead of a single task. A non-null `selectedFile` swaps
 * the main content from the live terminal to that file's diff/contents.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentKind,
  SessionState,
  TabKind,
  TaskStatus,
  Worktree,
  WorktreePr,
  WorktreeTab,
} from "../../bindings";
import { primaryPr } from "../../components/PrChip";
import {
  useAddWorktreeTab,
  useBaseWorktree,
  useRemoveWorktreeTab,
  useRenameWorktreeTab,
  useTasks,
  useTriageDetail,
  useWorktreePrs,
  useWorktrees,
  useWorktreeTabs,
} from "../../lib/queries";
import { targetOwnsKey } from "../../lib/useKeyboardShortcuts";
import { usePersistedState } from "../../lib/usePersistedState";
import { useAgentRuns } from "../../state/AgentRuns";
import { type FixCiLaunch, type PendingLaunch, useApp, useAppUi } from "../../state/AppContext";
import { agentLabel } from "../../theme/colors";
import { useTerminals } from "../terminal/TerminalsContext";
import { useWorktreeDeletion } from "./useWorktreeDeletion";

export const NO_PROJECT = "No Project";

/** Sentinel id for the base-branch entry (repo root on main/master). Mirrors the
 *  Rust `worktree::BASE_ID`; the backend maps it to the repo root + default branch. */
export const BASE_ID = "__base__";

/** Synthesize the placeholder worktree shown while one is still being created
 *  (no branch/path/stats yet — `pending` drives the "Creating workspace…" UI).
 *  Exported for testing — see model.test.ts. */
export function pendingWorktree(p: PendingLaunch): Worktree {
  return {
    id: p.id,
    title: p.title,
    // Nothing is known about a worktree that doesn't exist yet — and a placeholder
    // is on screen for a second or two. Don't invent a status/activity for it.
    status: null,
    addLines: 0,
    delLines: 0,
    dirty: false,
    ahead: 0,
    behind: 0,
    unpushed: 0,
    remoteBehind: 0,
    pullConflict: false,
    agent: p.agent,
    activity: null,
    branch: "",
    path: "",
    project: p.project,
    // Known up front for a stacked launch, so `stackWorktrees` can indent the
    // placeholder immediately; empty for a root launch, same as before.
    baseBranch: p.baseBranch ?? "",
    setupRan: false,
    pending: true,
  };
}

/** Fill in a worktree's `status`/`activity` from live signals — the backend ships
 *  both as `null` rather than guessing (see the no-placeholder rule in CLAUDE.md).
 *  `status` comes from the linked Linear task's workflow state, and stays null when
 *  the task isn't in the current tasks fetch (e.g. it isn't assigned to the viewer)
 *  — the sidebar then renders no chip, rather than a confident lie. `activity` is
 *  derived from whether a live PTY session exists for the worktree's main terminal
 *  (`tree:<id>`), which is a real signal. Exported for testing — see model.test.ts. */
export function withLiveWorktreeStatus(
  w: Worktree,
  statusByTaskId: Map<string, TaskStatus>,
  liveTermRefIds: Set<string>,
): Worktree {
  return {
    ...w,
    status: statusByTaskId.get(w.id) ?? w.status,
    activity: liveTermRefIds.has(`tree:${w.id}`) ? "Running" : "Idle",
  };
}

/** The effective, display-ready Claude session state, reconciling the
 *  hook-recorded state with process liveness. Liveness is authoritative for
 *  running-vs-exited: a stored `active`/`waiting`/`idle` goes stale the instant
 *  the session dies without a `SessionEnd` (app restart, crash, kill), so a
 *  worktree with no live PTY reads as `exited` regardless of the last hook. A
 *  live session shows its hook state; `null` means nothing to show — the worktree
 *  never ran an agent, or a terminal is live but hasn't reported a state yet.
 *  Assumes `w` carries the live `activity` from {@link withLiveWorktreeStatus}. */
export function effectiveSessionState(w: Worktree, hook: SessionState | undefined): string | null {
  if (w.activity !== "Running") return hook ? "exited" : null;
  return hook?.state ?? null;
}

/** Merge real worktrees with in-flight launch placeholders and pending
 *  deletes: a launch keeps showing its "Creating workspace…" placeholder
 *  until the real worktree with the same id lands (then the placeholder is
 *  dropped), and a worktree mid-delete is hidden immediately rather than
 *  waiting for the filesystem watcher's refetch to catch up. Exported for
 *  testing — see model.test.ts. */
export function mergeWorktrees(
  realWorktrees: Worktree[],
  pendingLaunches: PendingLaunch[],
  pendingDeletes: Set<string>,
  withLiveStatus: (w: Worktree) => Worktree,
): Worktree[] {
  const realIds = new Set(realWorktrees.map((w) => w.id));
  const placeholders = pendingLaunches.filter((p) => !realIds.has(p.id)).map(pendingWorktree);
  const visible = realWorktrees.filter((w) => !pendingDeletes.has(w.id)).map(withLiveStatus);
  return [...placeholders, ...visible];
}

/** A cross-view launch (`treeLaunch`) is "dead" once neither a real worktree
 *  nor its pending placeholder exists for its id — e.g. `createWorktree`
 *  failed in the Issues model and the placeholder was dropped before a real
 *  worktree ever landed. A worktree that later reuses the same id (a manual
 *  retry via "Start a task", or the same ticket launched again much later)
 *  must not be mistaken for this stale request and auto-start an agent the
 *  user isn't asking for right now — see the #37 fix this backs. Exported for
 *  testing — see model.test.ts. */
export function isTreeLaunchDead(
  treeLaunch: string,
  worktrees: Worktree[],
  pendingLaunches: PendingLaunch[],
): boolean {
  const stillReferenced =
    worktrees.some((w) => w.id === treeLaunch) || pendingLaunches.some((p) => p.id === treeLaunch);
  return !stillReferenced;
}

/** The right panel's panes. The ticket leads: a worktree exists *for* an issue,
 *  and its description is reference material you read beside the work — not one
 *  of the workspaces the main area swaps between. The PR and the AI work queue
 *  (the queue itself plus the AI's reading of the PR that fills it) sit next to
 *  it because they are the same reference material once the work is out for
 *  review. */
export type FileTab = "issue" | "pr" | "aiWork" | "files" | "changes" | "history";

/** What decides which panes a worktree has. Every one of them is a fact about the
 *  worktree, never about what happens to be on screen. */
export interface FileTabInputs {
  /** The repo's own checkout — a branch, not a ticket, and never a PR of ours. */
  isBase: boolean;
  hasPr: boolean;
  /** Whether this worktree's id names a real Linear ticket. False for one cut from
   *  a plain branch: santree keys worktrees by ticket id, but a branch-born one
   *  carries a branch slug there, and Linear has no issue by that name. Assumed
   *  true until Linear says otherwise — tickets usually exist, so showing the pane
   *  and dropping it beats a pane that pops in a round-trip late. */
  hasTicket: boolean;
}

/** Which panes the active worktree actually has: the Issue pane needs a ticket —
 *  which neither the base-branch entry nor a worktree cut from a plain branch has —
 *  and the PR and AI work panes need a pull request. Ordered as the strip renders
 *  them — the work's own material first (ticket, files, changes, sessions), then
 *  what happens to it once it is out for review, which is also the pair that comes
 *  and goes. The AI work queue sits directly after the PR because it is what you
 *  *do* about that PR.
 *
 *  The queue half of that pane is not really PR-specific, but its rows are keyed
 *  `(pr_repo, pr_number)` in SQLite, so `hasPr` gates the tab until a migration
 *  lifts that — at which point `aiWork` moves up beside `files`, one line, and
 *  {@link WorktreeAiWorkPane} already renders the PR-less case.
 *
 *  Paired with {@link resolveFileTab} in one file deliberately — split apart, the
 *  strip ends up hiding a pane the model still resolves to, and the user lands on
 *  a tab they can't see. Exported for testing — see model.test.ts. */
export function availableFileTabs(opts: FileTabInputs): FileTab[] {
  const tabs: FileTab[] = [];
  if (!opts.isBase && opts.hasTicket) tabs.push("issue");
  tabs.push("files", "changes", "history");
  if (opts.hasPr) tabs.push("pr", "aiWork");
  return tabs;
}

/** Resolve the remembered right-panel pane, falling back to Changes when it isn't
 *  one this worktree has. Exported for testing — see model.test.ts. */
export function resolveFileTab(remembered: FileTab, opts: FileTabInputs): FileTab {
  return availableFileTabs(opts).includes(remembered) ? remembered : "changes";
}

/** Which diff a picked file shows: the working tree against HEAD (`working`,
 *  the Changes/Untracked sections) or the branch against its base (`branch`,
 *  the Committed-on-branch section). */
export type FileScope = "working" | "branch";

/** How a committed file's diff is rendered.
 *
 *  - `pr` — GitHub's own patch, with the PR's comments anchored in it.
 *  - `local` — the branch against its base, computed here. No comments: the PR
 *    either doesn't exist or doesn't contain this file (its file list is capped,
 *    and a binary file has no patch).
 *  - `localAhead` — the file *is* in the PR, but the branch has commits GitHub
 *    hasn't seen. Showing GitHub's patch would silently display older code, and
 *    anchoring its comments onto the local diff would put them on the wrong
 *    lines, so the local diff is shown with the gap spelled out. */
export type PrDiffMode = "pr" | "local" | "localAhead";

/** Pick the diff for a committed file. Exported for testing — see model.test.ts. */
export function prDiffModeFor(opts: { inPr: boolean; unpushed: number }): PrDiffMode {
  if (!opts.inPr) return "local";
  return opts.unpushed > 0 ? "localAhead" : "pr";
}
/** The main-area tabs. "terminal" is always present (and can't be closed);
 *  "file"/"setup"/"checkLog" appear on demand; `tab:<id>` are the persisted extra
 *  tabs (Claude sessions / terminals) opened via the "+" tab (closable). */
export type MainTab = "terminal" | "file" | "setup" | "checkLog" | `tab:${string}`;

/** A CI check whose raw job log is open in the **main** area.
 *
 *  It goes there rather than in the right panel because the panel is a ~300px
 *  column and a job log is not a 300px object — the panel's expanded check row
 *  shows the metadata and hands off to this for the output itself. */
export interface OpenCheckLog {
  /** The Actions job id — what the log is fetched by. */
  jobId: number;
  /** The check's name, which titles the tab. */
  name: string;
  /** The run's page on GitHub, for the truncated-log fallback link. */
  url: string | null;
  /** "owner/name" the job belongs to. The PR's repo need not be the checkout's. */
  prRepo: string;
}

/** The main-tab id for a persisted extra tab. */
export const extraTab = (id: string): MainTab => `tab:${id}`;

/** Default title for a new extra tab, unique among the worktree's existing tab
 *  titles and derived from the selected provider: "Claude Code", "Codex 2", … /
 *  "Terminal 2", "Terminal 3", … (the primary Terminal tab is #1 implicitly).
 *  Exported for testing — see model.test.ts. */
export function defaultTabTitle(
  kind: TabKind,
  agentKind: AgentKind | null,
  existing: WorktreeTab[],
): string {
  const base =
    kind === "agent" ? agentLabel(agentKind ?? "Codex") : kind === "fixCi" ? "Fix CI" : "Terminal";
  const titles = new Set(existing.map((t) => t.title));
  let n = kind === "agent" || kind === "fixCi" ? 1 : 2;
  const candidate = () => (n === 1 ? base : `${base} ${n}`);
  while (titles.has(candidate())) n++;
  return candidate();
}

/** Resolve the active worktree's remembered main tab, falling back to the
 *  terminal when the remembered tab is no longer available: the File tab needs
 *  an open file, the Setup tab needs setup still running for THIS worktree
 *  (`setupFor` is a single slot — another worktree's setup can supersede it),
 *  and a `tab:<id>` tab needs that persisted extra tab to still exist.
 *  Exported for testing — see model.test.ts. */
export function resolveActiveTab(
  remembered: MainTab | undefined,
  opts: {
    selectedFile: string | null;
    setupFor: string | null;
    activeId: string;
    extraTabIds: string[];
    checkLog: OpenCheckLog | null;
  },
): MainTab {
  const { selectedFile, setupFor, activeId, extraTabIds, checkLog } = opts;
  const tabId =
    typeof remembered === "string" && remembered.startsWith("tab:") ? remembered.slice(4) : null;
  const tabAvailable =
    remembered === "terminal" ||
    (remembered === "file" && selectedFile !== null) ||
    (remembered === "setup" && setupFor === activeId) ||
    (remembered === "checkLog" && checkLog !== null) ||
    (tabId !== null && extraTabIds.includes(tabId));
  return remembered && tabAvailable ? remembered : "terminal";
}

/** Which agent session the main area is showing, as the `{termKey, agentKind}`
 *  the status bar's session meter joins on — `null` whenever what's on screen is
 *  not an agent.
 *
 *  The distinction the meter needs and the worktree alone can't make: a workspace
 *  can have several agent tabs *and* a plain shell tab, and the main area is just
 *  as often showing a diff, the setup log or a check's job log. The base entry's
 *  "terminal" is a shell at the repo root, not an agent; an extra `terminal` tab
 *  is a shell too; and a worktree with no agent launched yet has no session to
 *  point at. Each of those is `null` rather than the nearest available numbers.
 *  Exported for testing — see model.test.ts. */
export function focusedAgentFor(opts: {
  activeTab: MainTab;
  activeId: string;
  extraTabs: WorktreeTab[];
  worktreeAgent: AgentKind | null;
}): { termKey: string; agentKind: AgentKind } | null {
  const { activeTab, activeId, extraTabs, worktreeAgent } = opts;
  if (!activeId) return null;
  if (activeTab === "terminal") {
    if (activeId === BASE_ID || !worktreeAgent) return null;
    return { termKey: `tree:${activeId}`, agentKind: worktreeAgent };
  }
  if (!activeTab.startsWith("tab:")) return null;
  const tab = extraTabs.find((t) => t.id === activeTab.slice(4));
  if (!tab || tab.kind === "terminal" || !tab.agentKind) return null;
  return { termKey: `tree:${activeId}:tab:${tab.id}`, agentKind: tab.agentKind };
}

/** Whether the main terminal must be withheld while the *work prompt* is still
 *  being written. The PTY applies a seed only at session creation, so mounting in
 *  this window spawns a bare shell and the agent launch is silently lost — no
 *  session row is ever minted, which later strands the Resume button in a
 *  shell↔"session ended" loop. (During setup the terminal is withheld by the setup
 *  gate instead; the rest of the seed inputs are gated inside `useAgentTab`.)
 *  Exported for testing — see model.test.ts. */
export function shouldHoldTerminal(opts: {
  launching: boolean;
  initialSetup: boolean;
  promptFetched: boolean;
}): boolean {
  const { launching, initialSetup, promptFetched } = opts;
  return launching && !initialSetup && !promptFetched;
}

/** Which main tab "begin a task" opens: the Setup tab when the script runs first
 *  (the agent launches once it finishes), otherwise straight to the terminal — per
 *  the "run setup on new worktrees" preference. Exported for testing — see
 *  model.test.ts. */
export function startTabFor(runSetupPref: boolean): Extract<MainTab, "setup" | "terminal"> {
  return runSetupPref ? "setup" : "terminal";
}

/** The worktrees whose setup script has just finished — each lands on its own
 *  terminal tab. Tracked per worktree rather than as one "was setting up" flag,
 *  which conflates them: switching away mid-setup would drop the *new* worktree
 *  onto its terminal (spawning a shell it never asked for) while the one that
 *  actually finished never gets switched. Exported for testing — see model.test.ts. */
export function finishedSetups(prev: Set<string>, now: Set<string>): string[] {
  return [...prev].filter((id) => !now.has(id));
}

interface TreesModel {
  repo: string;
  worktrees: Worktree[];
  /** Live PR status keyed by worktree id (from the worktree_prs stream). The
   *  single source for the sidebar cards, the bottom bar, and the commit box. */
  prsByWorktree: Map<string, WorktreePr[]>;
  /** The active worktree's primary PR — the open one, else the most recent —
   *  picked with {@link primaryPr}, the same rule the sidebar's PR mark uses, so
   *  the panel and the row can never disagree about which PR is *the* one. */
  activePr: WorktreePr | null;
  /** True while the first worktrees fetch is in flight (no cached data yet) — so
   *  the view can show a loading state instead of the "no worktrees" empty state. */
  loading: boolean;
  /** True while the base checkout is loading independently of the worktree list. */
  baseLoading: boolean;
  /** The base-branch entry (repo root on main/master), or null when the repo has
   *  no local path. Selected via `setActive(BASE_ID)`; not part of `worktrees`. */
  baseWorktree: Worktree | null;
  /** Selected worktree id, "" for the all-agents overview, or BASE_ID for base. */
  activeId: string;
  active: Worktree | null;
  /** The right panel: collapsed flag + resizable width (like Issues). */
  rightCollapsed: boolean;
  rightWidth: number;
  fileTab: FileTab;
  /** Whether the active worktree's id names a real Linear ticket — the Issue pane's
   *  gate. See {@link FileTabInputs.hasTicket} for what "no" means and why the
   *  answer is optimistic while Linear is still being asked. */
  hasTicket: boolean;
  /** The file shown in the (shared) main-area File tab, or null if none is open. */
  selectedFile: string | null;
  /** Which diff `selectedFile` shows (see {@link FileScope}). */
  selectedFileScope: FileScope;
  /** The active worktree, when its setup script is running right now — else null.
   *  The runs themselves are owned by `AgentRuns` at the app shell (they outlive
   *  this route); this is just the slice the tab bar and tab resolution need. */
  setupFor: string | null;
  /** Which main-area tab is showing. */
  activeTab: MainTab;
  /** The check whose raw job log is open in the main area, or null. */
  openCheckLog: OpenCheckLog | null;
  /** Persisted extra tabs (Claude sessions / terminals) for the active worktree,
   *  in open order. The primary "terminal" tab is always present and not listed. */
  extraTabs: WorktreeTab[];

  setActive: (id: string) => void;
  toggleRightPanel: () => void;
  setRightWidth: (w: number) => void;
  setFileTab: (tab: FileTab) => void;
  /** Open a file in the shared File tab (and focus it), or close it with null.
   *  `scope` picks the diff; it defaults to the working tree. */
  selectFile: (path: string | null, scope?: FileScope) => void;
  /** Switch which main-area tab is showing (the tab must be present). */
  setActiveTab: (tab: MainTab) => void;
  /** Close the File tab (back to the terminal). */
  closeFileTab: () => void;
  /** Open a check's raw job log in the main area (the "View full details" action
   *  on an expanded check), replacing whichever log was open. */
  showCheckLog: (log: OpenCheckLog) => void;
  /** Close the check-log tab (back to the terminal). */
  closeCheckLog: () => void;
  /** Open (and persist) a new Claude or terminal tab for the active worktree
   *  and focus it. */
  addTab: (kind: TabKind, agentKind?: AgentKind) => void;
  /** Close a persisted extra tab (the caller tears down its PTY session). A
   *  Claude tab's stored session is forgotten with it. */
  closeTab: (id: string) => void;
  /** Rename a persisted extra tab (blank titles are ignored). */
  renameTab: (id: string, title: string) => void;

  /** Begin a task: open the worktree and hand the run to `AgentRuns` (setup first,
   *  then the agent — or straight to the agent, per the preference). */
  startAgent: (id: string) => void;
  /** Open the Setup tab and run the script (the manual "Run setup" action). */
  runSetup: (id: string) => void;

  /** The on-disk CI-fix prompt file for a Fix-CI tab (from the Reviews "Fix CI
   *  with AI" hand-off), read once by that tab's fresh-launch seed. Undefined once
   *  a session exists on disk (a resume needs no prompt). */
  fixCiLaunchFor: (tabId: string) => FixCiLaunch | undefined;

  /** The worktree the create-PR dialog is open for, or null when closed. */
  prDialogFor: string | null;
  openPrDialog: (id: string) => void;
  closePrDialog: () => void;

  /** The worktree to surface the "create a PR?" suggestion bar for (set after a
   *  commit+push), or null. Cleared on dismiss, when the PR dialog opens, or once a
   *  PR exists / the banner's own checks no longer hold. */
  prSuggestFor: string | null;
  suggestPr: (id: string) => void;
  dismissPrSuggestion: () => void;

  /** Worktrees ticked for bulk actions (e.g. delete all merged). */
  selectedWorktrees: Set<string>;
  toggleWorktreeSelected: (id: string) => void;
  setWorktreeSelection: (ids: string[]) => void;
  clearWorktreeSelection: () => void;

  /** Delete a worktree — optimistic + background (rolls back + toasts on failure). */
  deleteWorktree: (id: string) => void;
  /** Delete all selected worktrees (optimistic + background), then clear selection. */
  deleteSelected: () => void;
}

/** localStorage keys for the view state above. Namespaced like the AppContext
 *  ones (`santree-*`) so everything the app persists is greppable from one place. */
const ACTIVE_ID_KEY = "santree-trees-active-id";
const RIGHT_COLLAPSED_KEY = "santree-trees-right-collapsed";
const RIGHT_WIDTH_KEY = "santree-trees-right-width";
// Bumped when the tab set changed (`all` → `files`, plus `history`); a stale
// value would otherwise select a tab that no longer exists.
// Bumped whenever a pane is *removed or renamed*: a remembered value from an
// older set is then resolved by a rule that no longer describes the strip.
// Purely adding one (the AI review pane) needs no bump — every value the old set
// could hold is still a pane, and still resolves to itself.
// v5: `aiReview` and `queue` merged into `aiWork`, so both old values now name
// nothing and would silently drop the reader onto Changes.
const FILE_TAB_KEY = "santree-trees-file-tab-v5";
const FILE_SCOPE_BY_WT_KEY = "santree-trees-file-scope-by-wt";
const TAB_BY_WT_KEY = "santree-trees-tab-by-worktree";
const FILE_BY_WT_KEY = "santree-trees-file-by-worktree";

const TreesContext = createContext<TreesModel | null>(null);

export function TreesProvider({ children }: { children: ReactNode }) {
  const { activeRepo } = useApp();
  const {
    treeLaunch,
    consumeTreeLaunch,
    treeFocus,
    consumeTreeFocus,
    fixCiLaunch,
    consumeFixCiLaunch,
    pendingLaunches,
    removePendingLaunch,
    pendingDeletes,
    removePendingDelete,
    setOpenWorktree,
    setFocusedAgent,
  } = useAppUi();
  // Setup runs and queued launches are owned by the app shell, not this route — a
  // run must survive navigating away from Trees (see AgentRuns).
  const { beginRun, runSetup, isSettingUp, runSetupOnStart, setVisibleWorktree } = useAgentRuns();
  const { data: realWorktrees = [], isLoading: worktreesLoading } = useWorktrees(activeRepo);
  const { data: baseWorktree = null, isLoading: baseWorktreeLoading } = useBaseWorktree(activeRepo);
  const { data: worktreePrs = [] } = useWorktreePrs(activeRepo);
  // Owned here (a stable provider) so optimistic delete's rollback still fires
  // after the deleted worktree's pane unmounts. Shared with the sidebar row's
  // right-click delete — see useWorktreeDeletion.
  const { deleteWorktree, deleteWorktrees } = useWorktreeDeletion(activeRepo);

  // The backend ships `status`/`activity` as null rather than guessing — fill them
  // from real signals here: `status` joins the linked Linear task's workflow state
  // (the tasks query already fetches it for Issues), `activity` reflects whether a
  // live PTY session exists for the worktree's main terminal. A worktree whose task
  // isn't in the current fetch (unassigned to the viewer) keeps a null status and
  // renders no chip.
  const { data: tasks = [] } = useTasks(activeRepo);
  const statusByTaskId = useMemo(() => new Map(tasks.map((t) => [t.id, t.status])), [tasks]);
  const { tabs: terminalTabs } = useTerminals();
  const liveTermRefIds = useMemo(
    () =>
      new Set(
        terminalTabs
          .filter((t) => t.source === "issue" && t.refId !== undefined)
          .map((t) => t.refId as string),
      ),
    [terminalTabs],
  );
  const withLiveStatus = useCallback(
    (w: Worktree): Worktree => withLiveWorktreeStatus(w, statusByTaskId, liveTermRefIds),
    [statusByTaskId, liveTermRefIds],
  );

  // Show "Creating workspace…" placeholders for in-flight launches; hide worktrees
  // being deleted. Both held as state (not query-cache patches) so the refetch this
  // tab's mount — or the filesystem watcher mid-delete — triggers can't wipe them.
  const worktrees = useMemo(
    () => mergeWorktrees(realWorktrees, pendingLaunches, pendingDeletes, withLiveStatus),
    [realWorktrees, pendingLaunches, pendingDeletes, withLiveStatus],
  );

  // Live PR status keyed by worktree id (worktree.id == its issue id).
  const prsByWorktree = useMemo(() => {
    const map = new Map<string, WorktreePr[]>();
    for (const p of worktreePrs) {
      const list = map.get(p.issueId) ?? [];
      list.push(p);
      map.set(p.issueId, list);
    }
    return map;
  }, [worktreePrs]);

  // Once a real worktree lands for a pending launch, drop the placeholder.
  useEffect(() => {
    for (const w of realWorktrees) {
      if (pendingLaunches.some((p) => p.id === w.id)) removePendingLaunch(w.id);
    }
  }, [realWorktrees, pendingLaunches, removePendingLaunch]);

  // Once a deleted worktree is actually gone from the real list, drop it from the
  // pending-delete set (a failed delete leaves it present → it stays/returns).
  useEffect(() => {
    if (pendingDeletes.size === 0) return;
    const realIds = new Set(realWorktrees.map((w) => w.id));
    for (const id of pendingDeletes) {
      if (!realIds.has(id)) removePendingDelete(id);
    }
  }, [realWorktrees, pendingDeletes, removePendingDelete]);

  // Persisted, not plain `useState`: this provider is route-scoped, so leaving
  // Trees for another tab unmounts it — and every one of these resetting is what
  // made coming back land on the all-agents overview instead of the worktree,
  // tab and file the user left open. See usePersistedState.
  const [activeId, setActiveId] = usePersistedState(ACTIVE_ID_KEY, "");
  // Tell the app shell which workspace is open, so the sidebar can mark its row.
  // This provider is route-scoped and the tree is permanent, so the selection has
  // to travel through AppUi rather than being read from here.
  useEffect(() => {
    setOpenWorktree(activeId ? { repo: activeRepo, id: activeId } : null);
  }, [activeId, activeRepo, setOpenWorktree]);

  // Does the active worktree's id name a real ticket? Only Linear can say: absence
  // from `tasks` above proves nothing (that fetch is the viewer's own issues), so
  // this asks the same query the Issue pane reads — one round-trip that also warms
  // the pane. `null` is Linear's definitive "no such issue"; `undefined` is "still
  // asking", and tickets usually exist, so the pane shows until told otherwise.
  // Skipped for the base entry, which has no ticket by construction.
  const { data: activeTicket } = useTriageDetail(
    activeRepo,
    activeId === BASE_ID ? null : activeId,
  );
  const hasTicket = activeTicket !== null;

  const [rightCollapsed, setRightCollapsed] = usePersistedState(RIGHT_COLLAPSED_KEY, false);
  const [rightWidth, setRightWidth] = usePersistedState(RIGHT_WIDTH_KEY, 320);
  // Opens on the ticket: a workspace is entered to work on an issue, and the
  // description is what you read first. (Bumped key — the pane list changed.)
  const [fileTab, setFileTab] = usePersistedState<FileTab>(FILE_TAB_KEY, "issue");
  // Capability-bearing settings/MCP paths live only in this in-memory hand-off.
  // Browser storage is user-editable and must never choose files loaded by an agent.
  const [fixCiLaunchByTab, setFixCiLaunchByTab] = useState<Record<string, FixCiLaunch>>({});
  // Deliberately NOT persisted, unlike the tab it opens under: a job log is
  // transient, and a `jobId` remembered from last week would reopen a stale log
  // for a PR that has since moved on. `activeTabByWt` can still remember
  // "checkLog" — with no log in the slot, `resolveActiveTab` falls back to the
  // terminal, exactly as it does for a "setup" tab whose run has ended.
  const [checkLogByWt, setCheckLogByWt] = useState<Record<string, OpenCheckLog>>({});
  // Per-worktree main tab + open file, so switching worktrees restores whichever
  // tab/file each one was last on instead of snapping every one back to the
  // terminal. A worktree with no entry defaults to the terminal; the launch flow
  // switches to setup as it starts.
  const [activeTabByWt, setActiveTabByWt] = usePersistedState<Record<string, MainTab>>(
    TAB_BY_WT_KEY,
    {},
  );
  const [selectedFileByWt, setSelectedFileByWt] = usePersistedState<Record<string, string | null>>(
    FILE_BY_WT_KEY,
    {},
  );
  // The setters below come from `usePersistedState`, which returns `useState`'s
  // own setter — stable for the component's life, so listing it changes nothing
  // at runtime. Biome only knows that guarantee for a literal `useState` call.
  const setTabFor = useCallback(
    (id: string, tab: MainTab) => setActiveTabByWt((m) => ({ ...m, [id]: tab })),
    [setActiveTabByWt],
  );
  const setFileFor = useCallback(
    (id: string, file: string | null) => setSelectedFileByWt((m) => ({ ...m, [id]: file })),
    [setSelectedFileByWt],
  );
  const [fileScopeByWt, setFileScopeByWt] = usePersistedState<Record<string, FileScope>>(
    FILE_SCOPE_BY_WT_KEY,
    {},
  );
  const setFileScopeFor = useCallback(
    (id: string, scope: FileScope) => setFileScopeByWt((m) => ({ ...m, [id]: scope })),
    [setFileScopeByWt],
  );
  const [prDialogFor, setPrDialogFor] = useState<string | null>(null);
  const [prSuggestFor, setPrSuggestFor] = useState<string | null>(null);
  const [selectedWorktrees, setSelectedWorktrees] = useState<Set<string>>(new Set());
  // Persisted extra tabs (the "+" tab: Claude sessions / terminals), DB-backed so
  // they survive app restarts. Grouped by worktree id; mutations are optimistic
  // (the tab appears/renames/closes instantly, the row lands in the background).
  const { data: allExtraTabs = [] } = useWorktreeTabs(activeRepo);
  const tabsByWt = useMemo(() => {
    const map = new Map<string, WorktreeTab[]>();
    for (const t of allExtraTabs) {
      const list = map.get(t.worktreeId) ?? [];
      list.push(t);
      map.set(t.worktreeId, list);
    }
    return map;
  }, [allExtraTabs]);
  const { mutate: addTabRow } = useAddWorktreeTab(activeRepo);
  const { mutate: renameTabRow } = useRenameWorktreeTab(activeRepo);
  const { mutate: removeTabRow } = useRemoveWorktreeTab(activeRepo);

  // The ONLY way `activeId` is written. It also publishes the selection to
  // `AgentRuns`, in the same batch — the off-screen launcher skips the worktree
  // Trees is showing, because that worktree's visible pane already hosts its
  // terminal and two hosts for one session would fight over the xterm overlay.
  // Splitting these two writes would open a window where both mount.
  const select = useCallback(
    (id: string) => {
      setActiveId(id);
      setVisibleWorktree(id || null);
    },
    [setActiveId, setVisibleWorktree],
  );

  // `select` is what normally keeps `activeId` and AgentRuns' visible worktree in
  // step, but a selection restored from storage lands in state without passing
  // through it — publish it once on mount, or the off-screen launcher never learns
  // Trees is already showing that worktree and mounts a second host for its
  // session, two of which fight over the xterm overlay.
  const restoredId = useRef(activeId);
  useEffect(() => {
    setVisibleWorktree(restoredId.current || null);
    // Trees no longer has a worktree on screen — release it, so a launch queued for
    // it (a task the user started and then navigated away from) is picked up by the
    // off-screen launcher and actually runs.
    return () => setVisibleWorktree(null);
  }, [setVisibleWorktree]);

  // Begin a task: open it and hand the run to AgentRuns. `focus` (default true)
  // makes the worktree active; a launch that shouldn't steal the view passes false.
  const startAgent = useCallback(
    (id: string, opts?: { focus?: boolean }) => {
      if (opts?.focus ?? true) select(id);
      setFileFor(id, null);
      setTabFor(id, startTabFor(runSetupOnStart));
      beginRun(id);
    },
    [runSetupOnStart, beginRun, select, setFileFor, setTabFor],
  );

  // The Setup tab is temporary: when a worktree's script finishes, *that* worktree
  // lands on its terminal (where the agent is starting, if the run was part of a
  // task start) — even if the user has since switched to another one. The runs are
  // owned by AgentRuns; this just follows them in the UI.
  const settingUpActive = isSettingUp(activeId);
  const settingUpIds = useMemo(
    () => new Set([BASE_ID, ...worktrees.map((w) => w.id)].filter((id) => isSettingUp(id))),
    [worktrees, isSettingUp],
  );
  const wasSettingUp = useRef(settingUpIds);
  useEffect(() => {
    for (const id of finishedSetups(wasSettingUp.current, settingUpIds)) setTabFor(id, "terminal");
    wasSettingUp.current = settingUpIds;
  }, [settingUpIds, setTabFor]);

  // Clear the selection if the active worktree vanished (e.g. it was deleted).
  // The base entry isn't in `worktrees`, so it's never cleared here.
  useEffect(() => {
    if (activeId === BASE_ID) return;
    // "Not in the list" only means "gone" once there *is* a list. Without this,
    // a restored selection is cleared on mount — the list is still empty then —
    // which is the all-agents overview again, just one tick later.
    if (worktreesLoading) return;
    if (activeId && !worktrees.some((w) => w.id === activeId)) select("");
  }, [worktrees, activeId, select, worktreesLoading]);

  // Tracks which treeLaunch id has already been focused (setActiveId called for
  // it), so a worktrees refetch while the real worktree hasn't landed yet
  // doesn't re-run setActiveId on every render and yank the user back to this
  // tab if they've since navigated elsewhere (finding #37). Reset once the
  // launch is consumed (agent started, or the launch died) so a later launch
  // for the same id — e.g. relaunching the same ticket after deleting its
  // worktree — is still focused fresh.
  const focusedLaunchRef = useRef<string | null>(null);

  // Consume a cross-view launch request (from the Issues "launch" action). Land
  // on the task as soon as its optimistic placeholder appears so its "Creating
  // workspace…" state is visible; only begin the agent once the *real* worktree
  // exists (the placeholder has no branch/path yet).
  useEffect(() => {
    if (!treeLaunch) return;
    if (isTreeLaunchDead(treeLaunch, worktrees, pendingLaunches)) {
      // createWorktree failed (or the pending launch was otherwise dropped)
      // before a real worktree could land for this id — the launch is dead.
      // Clear it so a worktree that appears later for the same id (e.g. a
      // manual retry via "Start a task") isn't mistaken for this stale
      // request and doesn't unexpectedly auto-start an agent (finding #37).
      consumeTreeLaunch();
      focusedLaunchRef.current = null;
      return;
    }
    const wt = worktrees.find((w) => w.id === treeLaunch);
    if (!wt) return;
    if (focusedLaunchRef.current !== treeLaunch) {
      focusedLaunchRef.current = treeLaunch;
      select(treeLaunch);
    }
    if (wt.pending) {
      // Pre-arm the main tab *before* the real worktree's pane can mount, so the
      // terminal never spawns a bare shell ahead of setup. The run itself only
      // begins once the real worktree exists (it has no path yet).
      setTabFor(treeLaunch, startTabFor(runSetupOnStart));
      return;
    }
    startAgent(treeLaunch);
    consumeTreeLaunch();
    focusedLaunchRef.current = null;
  }, [
    treeLaunch,
    worktrees,
    pendingLaunches,
    runSetupOnStart,
    consumeTreeLaunch,
    startAgent,
    select,
    setTabFor,
  ]);

  // Consume a cross-view "open" request (from the Issues graph/"Open in Trees"):
  // select the existing worktree and open the ticket beside it — no agent start,
  // the work is already there. Clearing the open file (like `setActive`) avoids
  // landing on a stale File tab that renders nothing.
  useEffect(() => {
    if (!treeFocus) return;
    // The base checkout is selectable but deliberately absent from `worktrees`,
    // so it has to clear the existence gate on its own — otherwise picking it in
    // the sidebar switches repo and then lands on whatever was open before.
    const { id, pane, tab } = treeFocus;
    if (id !== BASE_ID && !worktrees.some((w) => w.id === id)) return;
    select(id);
    setFileFor(id, null);
    // Only move what the caller named. `tab === null` means the main work
    // terminal (a `tree` agent lives there); a string is an extra tab's id;
    // `undefined` keeps whatever the worktree had open, which is what the old
    // unconditional reset to "terminal" made impossible — every agent, every
    // history row and every palette jump landed on tab one. `resolveActiveTab`
    // still has the last word, so naming a tab that has since been closed falls
    // back to the terminal rather than stranding the user on nothing.
    if (tab !== undefined) setTabFor(id, tab === null ? "terminal" : extraTab(tab));
    // Same contract for the panel: the sidebar's Linear and GitHub marks each
    // name their own pane, and `resolveFileTab` degrades a PR pane on a worktree
    // without one.
    if (pane !== undefined) setFileTab(pane);
    consumeTreeFocus();
  }, [treeFocus, worktrees, consumeTreeFocus, select, setFileFor, setTabFor, setFileTab]);

  // Consume a "Fix CI with AI" hand-off from Reviews: once the PR's worktree has
  // landed, open its freshly-minted Fix-CI tab (persist the row, stash the prompt
  // path for the pane's seed, focus it). The tab's pane launches Claude with the
  // no-git settings + the failed log; the create/prompt-write already ran in
  // Reviews before navigating here.
  useEffect(() => {
    if (!fixCiLaunch) return;
    const { worktreeId, tabId } = fixCiLaunch;
    if (!worktrees.some((w) => w.id === worktreeId)) return; // wait for the worktree
    setFixCiLaunchByTab((m) => ({ ...m, [tabId]: fixCiLaunch }));
    // Idempotent: only persist the row the first time (the effect can re-run
    // before the tabs query refetches the new row).
    if (!(tabsByWt.get(worktreeId) ?? []).some((t) => t.id === tabId)) {
      addTabRow({
        id: tabId,
        worktreeId,
        kind: fixCiLaunch.kind,
        agentKind: fixCiLaunch.agentKind ?? "Codex",
        title: fixCiLaunch.title ?? "Fix CI",
        // Persisted so the tab re-derives its deny list and its review tools when
        // it reopens — the hand-off carrying them dies with the app.
        pr: fixCiLaunch.pr,
      });
    }
    select(worktreeId);
    setFileFor(worktreeId, null);
    setTabFor(worktreeId, extraTab(tabId));
    consumeFixCiLaunch();
  }, [
    fixCiLaunch,
    worktrees,
    tabsByWt,
    addTabRow,
    consumeFixCiLaunch,
    select,
    setFileFor,
    setTabFor,
  ]);

  // ⌘L toggles the right panel (mirrors the Issues tab). Owned here rather
  // than in a separate consumer component so there's no shallow useTrees() caller.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (targetOwnsKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyL") {
        e.preventDefault();
        setRightCollapsed((c) => !c);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRightCollapsed]);

  const value = useMemo<TreesModel>(() => {
    const active =
      activeId === BASE_ID ? baseWorktree : (worktrees.find((w) => w.id === activeId) ?? null);
    const extraTabs = tabsByWt.get(activeId) ?? [];
    const selectedFile = selectedFileByWt[activeId] ?? null;
    const selectedFileScope: FileScope = fileScopeByWt[activeId] ?? "working";
    // Resolve the active worktree's remembered tab (falls back to a safe
    // default — Issue, or Terminal for the base entry — when it's no longer
    // available; see resolveActiveTab's doc comment for why each tab can
    // become unavailable).
    // The Setup tab only exists while THIS worktree's script is running.
    const setupFor = settingUpActive ? activeId : null;
    const openCheckLog = checkLogByWt[activeId] ?? null;
    const activeTab = resolveActiveTab(activeTabByWt[activeId], {
      selectedFile,
      setupFor,
      activeId,
      extraTabIds: extraTabs.map((t) => t.id),
      checkLog: openCheckLog,
    });
    const activePr = primaryPr(prsByWorktree.get(activeId) ?? []) ?? null;
    return {
      repo: activeRepo,
      worktrees,
      prsByWorktree,
      activePr,
      loading: worktreesLoading,
      baseLoading: baseWorktreeLoading,
      baseWorktree,
      activeId,
      active,
      rightCollapsed,
      rightWidth,
      fileTab: resolveFileTab(fileTab, {
        isBase: activeId === BASE_ID,
        hasPr: activePr !== null,
        hasTicket,
      }),
      hasTicket,
      selectedFile,
      selectedFileScope,
      setupFor,
      activeTab,
      openCheckLog,
      extraTabs,
      // Switching worktrees just changes which one is active — each remembers its
      // own tab/file (see activeTabByWt/selectedFileByWt), so returning to a worktree
      // restores whatever it was last showing instead of snapping back to the
      // terminal, which is where a never-visited one starts.
      setActive: select,
      toggleRightPanel: () => setRightCollapsed((c) => !c),
      setRightWidth,
      setFileTab,
      // Picking a file opens (or reuses) the shared File tab and focuses it;
      // expand the picker if it was collapsed so it stays usable alongside.
      selectFile: (path, scope = "working") => {
        setFileFor(activeId, path);
        setFileScopeFor(activeId, scope);
        setTabFor(activeId, path ? "file" : "terminal");
        if (path) setRightCollapsed(false);
      },
      setActiveTab: (tab) => setTabFor(activeId, tab),
      closeFileTab: () => {
        setFileFor(activeId, null);
        if (activeTab === "file") setTabFor(activeId, "terminal");
      },
      showCheckLog: (log) => {
        setCheckLogByWt((current) => ({ ...current, [activeId]: log }));
        setTabFor(activeId, "checkLog");
      },
      closeCheckLog: () => {
        setCheckLogByWt((current) => {
          if (!(activeId in current)) return current;
          const next = { ...current };
          delete next[activeId];
          return next;
        });
        if (activeTab === "checkLog") setTabFor(activeId, "terminal");
      },
      // The id is minted here (not by the backend) so the optimistic cache patch
      // is the exact row the DB will hold and the tab can be focused immediately.
      addTab: (kind, agentKind) => {
        if (!activeId) return;
        const id = crypto.randomUUID();
        const resolvedAgent = kind === "terminal" ? null : (agentKind ?? "Codex");
        addTabRow({
          id,
          worktreeId: activeId,
          kind,
          agentKind: resolvedAgent,
          title: defaultTabTitle(kind, resolvedAgent, extraTabs),
          // The "+" menu opens agent and terminal tabs only; a PR belongs to the
          // review kinds, which arrive through the hand-off above.
          pr: null,
        });
        setTabFor(activeId, extraTab(id));
      },
      closeTab: (id) => {
        removeTabRow(id);
        setFixCiLaunchByTab((current) => {
          if (!(id in current)) return current;
          const next = { ...current };
          delete next[id];
          return next;
        });
        // If the closed tab was showing, fall back to the primary terminal.
        if (activeTab === extraTab(id)) setTabFor(activeId, "terminal");
      },
      renameTab: (id, title) => {
        const trimmed = title.trim();
        if (trimmed) renameTabRow({ id, title: trimmed });
      },
      startAgent,
      // A manual re-run opens the Setup tab alongside whatever's already open
      // (e.g. a File tab) — it doesn't replace it.
      runSetup: (id) => {
        runSetup(id);
        setTabFor(id, "setup");
      },
      // The on-disk CI-fix prompt file for a Fix-CI tab (from the Reviews hand-off),
      // read once by that tab's fresh-launch seed. Undefined after a restart — the
      // session then resumes instead of re-seeding.
      fixCiLaunchFor: (tabId: string) => fixCiLaunchByTab[tabId],
      prDialogFor,
      // Opening the dialog supersedes the suggestion bar for that worktree.
      openPrDialog: (id) => {
        setPrSuggestFor((cur) => (cur === id ? null : cur));
        setPrDialogFor(id);
      },
      closePrDialog: () => setPrDialogFor(null),
      prSuggestFor,
      suggestPr: (id) => setPrSuggestFor(id),
      dismissPrSuggestion: () => setPrSuggestFor(null),
      selectedWorktrees,
      toggleWorktreeSelected: (id) =>
        setSelectedWorktrees((s) => {
          const next = new Set(s);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      setWorktreeSelection: (ids) => setSelectedWorktrees(new Set(ids)),
      clearWorktreeSelection: () => setSelectedWorktrees(new Set()),
      // Both go through the shared deletion flow (hide → delete → tear down the
      // worktree's terminals on success); see useWorktreeDeletion.
      deleteWorktree,
      deleteSelected: () => {
        if (selectedWorktrees.size === 0) return;
        deleteWorktrees([...selectedWorktrees]);
        setSelectedWorktrees(new Set());
      },
    };
  }, [
    worktrees,
    prsByWorktree,
    worktreesLoading,
    baseWorktreeLoading,
    baseWorktree,
    activeId,
    tabsByWt,
    addTabRow,
    renameTabRow,
    removeTabRow,
    rightCollapsed,
    rightWidth,
    fileTab,
    hasTicket,
    setFileTab,
    setRightCollapsed,
    setRightWidth,
    selectedFileByWt,
    fileScopeByWt,
    setFileScopeFor,
    settingUpActive,
    activeTabByWt,
    setTabFor,
    setFileFor,
    select,
    startAgent,
    runSetup,
    fixCiLaunchByTab,
    activeRepo,
    prDialogFor,
    prSuggestFor,
    selectedWorktrees,
    deleteWorktree,
    deleteWorktrees,
    checkLogByWt,
  ]);

  // Tell the app shell which agent the main area is showing, so the status bar's
  // session meter can scope itself to it. Derived from the resolved value rather
  // than the raw state so the tab it names is the one actually rendered (a
  // remembered tab that is no longer available falls back to the terminal).
  useEffect(() => {
    const focus = focusedAgentFor({
      activeTab: value.activeTab,
      activeId: value.activeId,
      extraTabs: value.extraTabs,
      worktreeAgent: value.active?.agent ?? null,
    });
    setFocusedAgent(focus && activeRepo ? { repo: activeRepo, ...focus } : null);
  }, [value, activeRepo, setFocusedAgent]);

  // Its own effect so the clear happens on *unmount only* — folding it into the
  // publish above would clear and re-set on every Trees state change. Leaving
  // Trees means no agent is on screen, and the meter must go with it.
  useEffect(() => () => setFocusedAgent(null), [setFocusedAgent]);

  return <TreesContext.Provider value={value}>{children}</TreesContext.Provider>;
}

export function useTrees(): TreesModel {
  const ctx = useContext(TreesContext);
  if (!ctx) throw new Error("useTrees must be used within <TreesProvider>");
  return ctx;
}
