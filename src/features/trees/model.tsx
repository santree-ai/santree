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
 *  derived from whether any of the worktree's panes has a live PTY session, which
 *  is a real signal. Exported for testing — see model.test.ts. */
export function withLiveWorktreeStatus(
  w: Worktree,
  statusByTaskId: Map<string, TaskStatus>,
  liveTermRefIds: Set<string>,
): Worktree {
  return {
    ...w,
    status: statusByTaskId.get(w.id) ?? w.status,
    activity: hasLivePane(liveTermRefIds, w.id) ? "Running" : "Idle",
  };
}

/** Whether any pane belonging to this worktree is live. Every one of its agents
 *  and shells is a tab (`tree:<id>:tab:<tab id>`), so this is a prefix test — but
 *  a `startsWith` alone would let `tree:AK-1` claim `tree:AK-12`'s panes, so the
 *  separator is part of it. The bare `tree:<id>` key is matched too: it is what
 *  every session minted before tabs became the only surface still carries.
 *  Exported for testing — see model.test.ts. */
export function hasLivePane(liveTermRefIds: Set<string>, worktreeId: string): boolean {
  const key = `tree:${worktreeId}`;
  if (liveTermRefIds.has(key)) return true;
  const prefix = `${key}:`;
  for (const refId of liveTermRefIds) if (refId.startsWith(prefix)) return true;
  return false;
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
 *  {@link AiWorkPane} already renders the PR-less case.
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
/** The main-area tabs. `tab:<id>` are the persisted tabs — every agent and every
 *  shell the worktree has open, the one a started task runs in included, each a
 *  `worktree_tabs` row so the set survives a restart. "prView"/"issueView" are
 *  the worktree's pull request and its ticket at reading width — the right
 *  panel's PR and Issue panes expanded into the main area, remembered per
 *  worktree but never a row: they need no process, and they only exist while the
 *  worktree has the thing they show. "file"/"setup"/"checkLog" are the transient
 *  views that appear with the thing they show. All of them close, and closing
 *  the last one leaves the workspace showing nothing. */
export type MainTab = "file" | "setup" | "checkLog" | "prView" | "issueView" | `tab:${string}`;

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

/** The main-area tabs a worktree has open, in strip order — the list the tab bar
 *  renders and {@link resolveActiveTab} picks from.
 *
 *  There is no privileged tab. A worktree's agents and shells are all persisted
 *  rows, so what is open is whatever `worktree_tabs` says, and a workspace whose
 *  rows are all closed has nothing open at all — which is what puts the empty
 *  surface on screen. The two reference views sit right after the rows: they are
 *  opened deliberately and stay, so the transient three — which come and go —
 *  trail them rather than shifting them about. Those appear with whatever they
 *  show: a picked file, a setup run belonging to THIS worktree (`setupFor` is a
 *  single slot — another worktree's run can supersede it), and a check's job log.
 *  Exported for testing — see model.test.ts. */
export function openMainTabs(opts: {
  tabIds: string[];
  /** Already gated on the worktree having a PR / a ticket to show — a view that
   *  is "open" for a PR that has since gone is not open. */
  hasPrView: boolean;
  hasIssueView: boolean;
  hasFile: boolean;
  hasSetup: boolean;
  hasCheckLog: boolean;
}): MainTab[] {
  const tabs: MainTab[] = opts.tabIds.map(extraTab);
  if (opts.hasPrView) tabs.push("prView");
  if (opts.hasIssueView) tabs.push("issueView");
  if (opts.hasFile) tabs.push("file");
  if (opts.hasSetup) tabs.push("setup");
  if (opts.hasCheckLog) tabs.push("checkLog");
  return tabs;
}

/** `map` without `key` — the same object when the key was never there, so a
 *  state setter can return it and skip the render. */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Which open tab is showing: the remembered one while it is still open, else the
 *  first — and `null` once nothing is open, which is what puts the empty surface
 *  on screen. Closing a tab therefore needs no fallback of its own: dropping it
 *  from `open` is what moves the selection, so there is one rule for "what am I
 *  looking at" instead of one per close button.
 *  Exported for testing — see model.test.ts. */
export function resolveActiveTab(remembered: MainTab | undefined, open: MainTab[]): MainTab | null {
  return remembered !== undefined && open.includes(remembered) ? remembered : (open[0] ?? null);
}

/** Which of a worktree's tabs may name it in Claude's Remote Control web, or null
 *  when none can.
 *
 *  The name is the worktree id, so only one session can hold it — two panes under
 *  one name collide, which is why an extra agent tab never claimed it while the
 *  work terminal existed. Now that every agent is a tab, the claim goes to the
 *  worktree's first Claude tab: that is the one a started task minted (it is
 *  created before any other) and, once it is closed, whichever Claude tab is now
 *  oldest. It has to be tab-shaped rather than launch-shaped because
 *  `--remote-control` rides on *every* launch, resume included — scoping it to the
 *  fresh launch would drop the name the first time the tab was reopened. Only
 *  Claude has the capability at all, so a Codex tab standing first must not
 *  consume the claim. Exported for testing — see model.test.ts. */
export function remoteControlTab(tabs: WorktreeTab[]): string | null {
  return tabs.find((t) => t.kind === "agent" && t.agentKind === "Claude")?.id ?? null;
}

/** Which agent session the main area is showing, as the `{termKey, agentKind}`
 *  the status bar's session meter joins on — `null` whenever what's on screen is
 *  not an agent.
 *
 *  The distinction the meter needs and the worktree alone can't make: a workspace
 *  can have several agent tabs *and* a plain shell tab, and the main area is just
 *  as often showing a diff, the setup log, a check's job log or nothing at all. A
 *  `terminal` tab is a shell, not an agent, and is `null` here rather than the
 *  nearest available numbers.
 *  Exported for testing — see model.test.ts. */
export function focusedAgentFor(opts: {
  activeTab: MainTab | null;
  activeId: string;
  tabs: WorktreeTab[];
}): { termKey: string; agentKind: AgentKind } | null {
  const { activeTab, activeId, tabs } = opts;
  if (!activeId || activeTab === null || !activeTab.startsWith("tab:")) return null;
  const tab = tabs.find((t) => t.id === activeTab.slice(4));
  if (!tab || tab.kind === "terminal" || !tab.agentKind) return null;
  return { termKey: `tree:${activeId}:tab:${tab.id}`, agentKind: tab.agentKind };
}

/** Whether a started task's terminal must be withheld while the *work prompt* is
 *  still being written. The PTY applies a seed only at session creation, so
 *  mounting in this window spawns a bare shell and the agent launch is silently
 *  lost — no session row is ever minted, and the tab is left running a shell the
 *  ticket knows nothing about. (During setup the terminal is withheld by the setup
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
 *  (the agent launches into `tabId` once it finishes), otherwise straight to the
 *  tab the agent is starting in — per the "run setup on new worktrees"
 *  preference. Exported for testing — see model.test.ts. */
export function startTabFor(runSetupPref: boolean, tabId: string): MainTab {
  return runSetupPref ? "setup" : extraTab(tabId);
}

/** The worktrees whose setup script has just finished — each lands on the tab its
 *  agent is starting in. Tracked per worktree rather than as one "was setting up"
 *  flag, which conflates them: switching away mid-setup would drop the *new*
 *  worktree onto a tab it never asked for while the one that actually finished
 *  never gets switched. Exported for testing — see model.test.ts. */
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
  /** Which main-area tab is showing, or null when the workspace has none open. */
  activeTab: MainTab | null;
  /** The check whose raw job log is open in the main area, or null. */
  openCheckLog: OpenCheckLog | null;
  /** Whether the worktree's pull request, and its ticket, are open as main-area
   *  tabs ("GitHub PR", "Linear"). Already gated: false when there is no PR or no
   *  ticket to show, whatever was remembered. */
  prViewOpen: boolean;
  issueViewOpen: boolean;
  /** The active worktree's persisted tabs, in open order — every agent and every
   *  shell it has open, the one a started task runs in included. This is the
   *  whole set: there is no tab outside it. */
  tabs: WorktreeTab[];

  setActive: (id: string) => void;
  toggleRightPanel: () => void;
  setRightWidth: (w: number) => void;
  setFileTab: (tab: FileTab) => void;
  /** Open a file in the shared File tab (and focus it), or close it with null.
   *  `scope` picks the diff; it defaults to the working tree. */
  selectFile: (path: string | null, scope?: FileScope) => void;
  /** Switch which main-area tab is showing (the tab must be present). */
  setActiveTab: (tab: MainTab) => void;
  /** Close the File tab (the selection falls to whatever is still open). */
  closeFileTab: () => void;
  /** Open a check's raw job log in the main area (the "View full details" action
   *  on an expanded check), replacing whichever log was open. */
  showCheckLog: (log: OpenCheckLog) => void;
  /** Close the check-log tab (the selection falls to whatever is still open). */
  closeCheckLog: () => void;
  /** Open the PR / the ticket as a main-area tab and show it — the right panel's
   *  "Open in a tab". Close drops the tab; the selection falls to whatever is
   *  still open. Remembered per worktree, across reloads. */
  openPrView: () => void;
  closePrView: () => void;
  openIssueView: () => void;
  closeIssueView: () => void;
  /** Open (and persist) a new agent or terminal tab for the active worktree and
   *  focus it. Returns the new tab's id. */
  addTab: (kind: TabKind, agentKind?: AgentKind) => string | null;
  /** Close a tab and delete its row (the caller tears down its PTY session). An
   *  agent tab's stored session is forgotten with it — the conversation itself
   *  survives on disk, and Session history is how it comes back. */
  closeTab: (id: string) => void;
  /** Rename a tab (blank titles are ignored). */
  renameTab: (id: string, title: string) => void;

  /** Begin a task: mint its tab, open the worktree and hand the run to
   *  `AgentRuns` (setup first, then the agent — or straight to the agent, per the
   *  preference). `agent` names the provider for a worktree that was created a
   *  moment ago and isn't in the worktrees read yet. */
  startAgent: (id: string, opts?: { agent?: AgentKind | null }) => void;
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

  /** A tab someone asked to be taken to that no longer has a row — an agent
   *  whose process exited, since a dead process closes its tab. Its conversation
   *  is still on disk, so `useReopenClosedTab` resumes it into a fresh tab
   *  instead of leaving the click to do nothing. */
  reopenTab: { worktreeId: string; tabId: string } | null;
  consumeReopenTab: () => void;

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
const PR_VIEW_BY_WT_KEY = "santree-trees-pr-view-by-worktree";
const ISSUE_VIEW_BY_WT_KEY = "santree-trees-issue-view-by-worktree";

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
  const { beginRun, runSetup, isSettingUp, runSetupOnStart, setVisibleWorktree, launchAgents } =
    useAgentRuns();
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
  // live PTY session exists for any of the worktree's panes. A worktree whose task
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
  // Session-scoped, unlike the rest: it has to survive a route change and a
  // webview reload (terminals adopt across a reload, so the pane must come back
  // to its host) but a cold launch belongs on the welcome surface, not on
  // whichever worktree was open when the app last quit. The per-worktree maps
  // below stay local — they are "what this worktree was showing", restored on an
  // explicit click rather than on a navigation.
  const [activeId, setActiveId] = usePersistedState(ACTIVE_ID_KEY, "", "session");
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
  // Persisted like the file, unlike the check log: a PR page and a ticket page
  // are addressed by the worktree alone, so what reopens after a reload is
  // exactly what was open — and a remembered "prView" in `activeTabByWt` would
  // otherwise land on nothing.
  const [prViewByWt, setPrViewByWt] = usePersistedState<Record<string, true>>(
    PR_VIEW_BY_WT_KEY,
    {},
  );
  const [issueViewByWt, setIssueViewByWt] = usePersistedState<Record<string, true>>(
    ISSUE_VIEW_BY_WT_KEY,
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

  // Read at call time rather than captured, so `startAgent` keeps a stable
  // identity: the effects that depend on it would otherwise re-run on every
  // worktrees or tabs refetch.
  // A closed tab someone asked to be taken to. Held rather than acted on here:
  // reopening it means resuming its conversation into a *new* tab, which needs
  // the worktree to be active first — see `useReopenClosedTab`.
  const [reopenTab, setReopenTab] = useState<{ worktreeId: string; tabId: string } | null>(null);
  const consumeReopenTab = useCallback(() => setReopenTab(null), []);

  const worktreesRef = useRef(worktrees);
  worktreesRef.current = worktrees;
  const tabsByWtRef = useRef(tabsByWt);
  tabsByWtRef.current = tabsByWt;

  // Begin a task: mint the tab the agent will run in, open it, and hand the run to
  // AgentRuns. The row is written before the run begins because the launch names
  // the tab — a start that only set a flag on the worktree could be consumed by
  // whichever agent tab happened to mount first, and the *work prompt* would open
  // someone else's conversation. `focus` (default true) makes the worktree active;
  // a launch that shouldn't steal the view passes false.
  const startAgent = useCallback(
    (id: string, opts?: { focus?: boolean; agent?: AgentKind | null }) => {
      const tabId = crypto.randomUUID();
      // The worktree's configured provider. A start that follows a create races the
      // worktrees read, so the caller passes the provider it just created the
      // worktree with rather than letting the lookup miss and fall back — that
      // fallback would run Claude in a tab the user asked Codex for. "Claude" is
      // the same last resort `useAgentTab` applies to a worktree with no provider
      // recorded at all.
      const agent = opts?.agent ?? worktreesRef.current.find((w) => w.id === id)?.agent ?? "Claude";
      addTabRow({
        id: tabId,
        worktreeId: id,
        kind: "agent",
        agentKind: agent,
        title: defaultTabTitle("agent", agent, tabsByWtRef.current.get(id) ?? []),
        pr: null,
      });
      if (opts?.focus ?? true) select(id);
      setFileFor(id, null);
      setTabFor(id, startTabFor(runSetupOnStart, tabId));
      beginRun(id, tabId);
    },
    [runSetupOnStart, beginRun, select, setFileFor, setTabFor, addTabRow],
  );

  // The Setup tab is temporary: when a worktree's script finishes, *that* worktree
  // lands on the tab its agent is starting in — even if the user has since
  // switched to another one. The runs are owned by AgentRuns; this just follows
  // them in the UI. A manual re-run launches nothing, so it names no tab and this
  // leaves the selection alone.
  const settingUpActive = isSettingUp(activeId);
  const settingUpIds = useMemo(
    () => new Set([BASE_ID, ...worktrees.map((w) => w.id)].filter((id) => isSettingUp(id))),
    [worktrees, isSettingUp],
  );
  const wasSettingUp = useRef(settingUpIds);
  useEffect(() => {
    for (const id of finishedSetups(wasSettingUp.current, settingUpIds)) {
      const tabId = launchAgents.get(id);
      if (tabId) setTabFor(id, extraTab(tabId));
    }
    wasSettingUp.current = settingUpIds;
  }, [settingUpIds, setTabFor, launchAgents]);

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
    // Nothing to pre-arm while the worktree is still being created: it has no
    // tabs yet, so nothing can mount and spawn a bare shell ahead of setup. The
    // run begins — and mints its tab — once the real worktree exists.
    if (wt.pending) return;
    startAgent(treeLaunch, { agent: wt.agent });
    consumeTreeLaunch();
    focusedLaunchRef.current = null;
  }, [treeLaunch, worktrees, pendingLaunches, consumeTreeLaunch, startAgent, select]);

  // Consume a cross-view "open" request (from the Issues graph/"Open in Trees"):
  // select the existing worktree and open the ticket beside it — no agent start,
  // the work is already there. Clearing the open file (like `setActive`) avoids
  // landing on a stale File tab that renders nothing.
  useEffect(() => {
    if (!treeFocus) return;
    // The base checkout is selectable but deliberately absent from `worktrees`,
    // so it has to clear the existence gate on its own — otherwise picking it in
    // the sidebar switches repo and then lands on whatever was open before.
    const { id, pane, tab, expand } = treeFocus;
    if (id !== BASE_ID && !worktrees.some((w) => w.id === id)) return;
    select(id);
    setFileFor(id, null);
    // Only move what the caller named. A string is a tab id; `null` is a caller
    // that has no tab to name (a session minted before every agent lived in one),
    // and `undefined` keeps whatever the worktree had open — which is what the old
    // unconditional reset made impossible: every agent, every history row and
    // every palette jump landed on tab one.
    //
    // A tab whose process has exited is deleted outright (`useTabSessions`), so a
    // sidebar row for an exited agent names a tab that no longer exists. Falling
    // back to whatever else was open is what made clicking one look like a dead
    // click — the agent is right there in the rail and nothing happens. The
    // conversation is still on disk, so hand it to the reopen path instead:
    // resuming it is what "open this agent" has always meant for a session with
    // no live PTY (see `bucketOf`'s `detached`).
    if (tab) {
      if ((tabsByWtRef.current.get(id) ?? []).some((t) => t.id === tab)) {
        setTabFor(id, extraTab(tab));
      } else {
        setReopenTab({ worktreeId: id, tabId: tab });
      }
    }
    // Same contract for the panel: a caller that names a pane gets it, and
    // `resolveFileTab` degrades a PR pane on a worktree without one. The
    // sidebar's Linear and GitHub marks name theirs *expanded* — the page as a
    // main tab, remembered per worktree exactly as the pane's own expand control
    // remembers it (and dropped the same way when the worktree loses the thing
    // it shows). Keyed by `id`, not `activeId`: the select above hasn't rendered.
    if (pane !== undefined) {
      setFileTab(pane);
      if (expand) {
        const openView = pane === "pr" ? setPrViewByWt : setIssueViewByWt;
        openView((current) => ({ ...current, [id]: true }));
        setTabFor(id, pane === "pr" ? "prView" : "issueView");
      }
    }
    consumeTreeFocus();
  }, [
    treeFocus,
    worktrees,
    consumeTreeFocus,
    select,
    setFileFor,
    setTabFor,
    setFileTab,
    setPrViewByWt,
    setIssueViewByWt,
  ]);

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
    const tabs = tabsByWt.get(activeId) ?? [];
    const selectedFile = selectedFileByWt[activeId] ?? null;
    const selectedFileScope: FileScope = fileScopeByWt[activeId] ?? "working";
    // The Setup tab only exists while THIS worktree's script is running.
    const setupFor = settingUpActive ? activeId : null;
    const openCheckLog = checkLogByWt[activeId] ?? null;
    const activePr = primaryPr(prsByWorktree.get(activeId) ?? []) ?? null;
    const paneInputs: FileTabInputs = {
      isBase: activeId === BASE_ID,
      hasPr: activePr !== null,
      hasTicket,
    };
    // The expanded views follow their panes: a PR page for a worktree whose PR
    // is gone, or a ticket page on the base checkout, is not open however it was
    // remembered — the one rule that decides which panes exist decides this too.
    const panes = availableFileTabs(paneInputs);
    const prViewOpen = !!prViewByWt[activeId] && panes.includes("pr");
    const issueViewOpen = !!issueViewByWt[activeId] && panes.includes("issue");
    // One list of what is open, and the remembered selection resolved against it
    // — see openMainTabs/resolveActiveTab for why each tab comes and goes, and
    // why the answer can be "nothing".
    const openTabs = openMainTabs({
      tabIds: tabs.map((t) => t.id),
      hasPrView: prViewOpen,
      hasIssueView: issueViewOpen,
      hasFile: selectedFile !== null,
      hasSetup: setupFor !== null,
      hasCheckLog: openCheckLog !== null,
    });
    const activeTab = resolveActiveTab(activeTabByWt[activeId], openTabs);
    return {
      repo: activeRepo,
      reopenTab,
      consumeReopenTab,
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
      fileTab: resolveFileTab(fileTab, paneInputs),
      hasTicket,
      selectedFile,
      selectedFileScope,
      setupFor,
      activeTab,
      openCheckLog,
      prViewOpen,
      issueViewOpen,
      tabs,
      // Switching worktrees just changes which one is active — each remembers its
      // own tab/file (see activeTabByWt/selectedFileByWt), so returning to a worktree
      // restores whatever it was last showing instead of snapping back to its first
      // tab.
      setActive: select,
      toggleRightPanel: () => setRightCollapsed((c) => !c),
      setRightWidth,
      setFileTab,
      // Picking a file opens (or reuses) the shared File tab and focuses it;
      // expand the picker if it was collapsed so it stays usable alongside.
      selectFile: (path, scope = "working") => {
        setFileFor(activeId, path);
        setFileScopeFor(activeId, scope);
        if (path) {
          setTabFor(activeId, "file");
          setRightCollapsed(false);
        }
      },
      setActiveTab: (tab) => setTabFor(activeId, tab),
      // No fallback to pick here: with no file the File tab leaves `openMainTabs`,
      // and `resolveActiveTab` moves the selection to whatever is still open.
      closeFileTab: () => setFileFor(activeId, null),
      showCheckLog: (log) => {
        setCheckLogByWt((current) => ({ ...current, [activeId]: log }));
        setTabFor(activeId, "checkLog");
      },
      closeCheckLog: () => setCheckLogByWt((current) => omit(current, activeId)),
      openPrView: () => {
        setPrViewByWt((current) => ({ ...current, [activeId]: true }));
        setTabFor(activeId, "prView");
      },
      closePrView: () => setPrViewByWt((current) => omit(current, activeId)),
      openIssueView: () => {
        setIssueViewByWt((current) => ({ ...current, [activeId]: true }));
        setTabFor(activeId, "issueView");
      },
      closeIssueView: () => setIssueViewByWt((current) => omit(current, activeId)),
      // The id is minted here (not by the backend) so the optimistic cache patch
      // is the exact row the DB will hold and the tab can be focused immediately.
      addTab: (kind, agentKind) => {
        if (!activeId) return null;
        const id = crypto.randomUUID();
        const resolvedAgent = kind === "terminal" ? null : (agentKind ?? "Codex");
        addTabRow({
          id,
          worktreeId: activeId,
          kind,
          agentKind: resolvedAgent,
          title: defaultTabTitle(kind, resolvedAgent, tabs),
          // The "+" menu opens agent and terminal tabs only; a PR belongs to the
          // review kinds, which arrive through the hand-off above.
          pr: null,
        });
        setTabFor(activeId, extraTab(id));
        return id;
      },
      closeTab: (id) => {
        removeTabRow(id);
        setFixCiLaunchByTab((current) => omit(current, id));
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
    prViewByWt,
    issueViewByWt,
    setPrViewByWt,
    setIssueViewByWt,
    reopenTab,
    consumeReopenTab,
  ]);

  // Tell the app shell which agent the main area is showing, so the status bar's
  // session meter can scope itself to it. Derived from the resolved value rather
  // than the raw state so the tab it names is the one actually rendered (a
  // remembered tab that is no longer available falls back to the terminal).
  useEffect(() => {
    const focus = focusedAgentFor({
      activeTab: value.activeTab,
      activeId: value.activeId,
      tabs: value.tabs,
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
