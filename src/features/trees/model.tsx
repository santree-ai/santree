/**
 * Trees-tab state model.
 *
 * Owns which worktree (task) is active, the file picker's right-panel state
 * (collapsed/width, like the Issues panel), and which file is open in the main
 * area. The worktree list is real (DB-backed git worktrees for the active repo),
 * grouped by project in the sidebar. An empty `activeId` means the all-agents
 * overview is showing instead of a single task. A non-null `selectedFile` swaps
 * the main content from the live terminal to that file's diff/contents.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { Worktree, WorktreePr } from "../../bindings";
import {
  queryKeys,
  TREES_RUN_SETUP_KEY,
  useBaseWorktree,
  useBoolSetting,
  useRemoveWorktree,
  useRemoveWorktrees,
  useWorktreePrs,
  useWorktrees,
} from "../../lib/queries";
import { inEditable } from "../../lib/useKeyboardShortcuts";
import { type PendingLaunch, useApp, useAppUi } from "../../state/AppContext";

export const NO_PROJECT = "No Project";

/** Sentinel id for the base-branch entry (repo root on main/master). Mirrors the
 *  Rust `worktree::BASE_ID`; the backend maps it to the repo root + default branch. */
export const BASE_ID = "__base__";

/** Synthesize the placeholder worktree shown while one is still being created
 *  (no branch/path/stats yet — `pending` drives the "Creating workspace…" UI). */
function pendingWorktree(p: PendingLaunch): Worktree {
  return {
    id: p.id,
    title: p.title,
    status: "InProgress",
    addLines: 0,
    delLines: 0,
    dirty: false,
    ahead: 0,
    behind: 0,
    unpushed: 0,
    agent: p.agent,
    activity: "Idle",
    branch: "",
    path: "",
    project: p.project,
    baseBranch: "",
    setupRan: false,
    pending: true,
  };
}
/** The file-picker sub-tabs (right panel). */
export type FileTab = "all" | "changes";
/** The main-area tabs. "issue" and "terminal" are always present (and can't be
 *  closed); "file"/"setup" appear on demand; `term:<n>` are extra terminals opened
 *  via the "+" tab (closable). */
export type MainTab = "issue" | "terminal" | "file" | "setup" | `term:${number}`;

/** The tab id for the nth extra terminal. */
export const termTab = (n: number): MainTab => `term:${n}`;

/** The project a worktree belongs to (its Linear project, or the catch-all). */
export const projectOf = (w: Worktree): string => w.project ?? NO_PROJECT;

interface TreesModel {
  repo: string;
  worktrees: Worktree[];
  /** Live PR status keyed by worktree id (from the worktree_prs stream). The
   *  single source for the sidebar cards, the bottom bar, and the commit box. */
  prsByWorktree: Map<string, WorktreePr[]>;
  /** True while the first worktrees fetch is in flight (no cached data yet) — so
   *  the view can show a loading state instead of the "no worktrees" empty state. */
  loading: boolean;
  /** The base-branch entry (repo root on main/master), or null when the repo has
   *  no local path. Selected via `setActive(BASE_ID)`; not part of `worktrees`. */
  baseWorktree: Worktree | null;
  /** Selected worktree id, "" for the all-agents overview, or BASE_ID for base. */
  activeId: string;
  active: Worktree | null;
  /** The file-picker right panel: collapsed flag + resizable width (like Issues). */
  rightCollapsed: boolean;
  rightWidth: number;
  fileTab: FileTab;
  /** The file shown in the (shared) main-area File tab, or null if none is open. */
  selectedFile: string | null;
  /** The worktree whose setup script is running in the Setup tab (meaningful only
   *  when it equals `activeId`), or null. */
  setupFor: string | null;
  /** True when the running setup is part of *starting* a task (setup → agent), as
   *  opposed to a manual "Re-run setup". Lets the pane withhold the not-yet-created
   *  terminal during the first setup without disturbing an existing one on re-run. */
  setupThenLaunch: boolean;
  /** Which main-area tab is showing. */
  activeTab: MainTab;
  /** Extra-terminal numbers for the active worktree (each → a `term:<n>` tab),
   *  in open order. The primary "terminal" tab is always present and not listed. */
  extraTerminals: number[];

  setActive: (id: string) => void;
  showAllAgents: () => void;
  toggleRightPanel: () => void;
  setRightWidth: (w: number) => void;
  setFileTab: (tab: FileTab) => void;
  /** Open a file in the shared File tab (and focus it), or close it with null. */
  selectFile: (path: string | null) => void;
  /** Switch which main-area tab is showing (the tab must be present). */
  setActiveTab: (tab: MainTab) => void;
  /** Close the File tab (back to the terminal). */
  closeFileTab: () => void;
  /** Open a new extra terminal for the active worktree and focus it. */
  addTerminal: () => void;
  /** Close an extra terminal tab (the caller tears down its PTY session). */
  closeTerminal: (n: number) => void;

  /** Begin a task: open the worktree and either run setup first (in the Setup tab,
   *  then launch the agent) or launch the agent straight away — per the "run setup
   *  on new worktrees" preference. */
  startAgent: (id: string) => void;
  /** Open the Setup tab and run the script (the manual "Run setup" action). */
  runSetup: (id: string) => void;
  /** Called when the setup script finishes: closes the Setup tab and, for the
   *  launch flow, continues to the agent. */
  completeSetup: () => void;

  /** Worktree ids whose terminal should launch the agent on first open — set
   *  when a task is started, cleared once its terminal has consumed it. */
  launchAgents: Set<string>;
  /** Per-launch model overrides from the Issues tray, keyed by worktree id (empty
   *  ⇒ fall back to the configured Work model). Read once by the fresh-launch seed. */
  launchModels: Record<string, string>;
  requestAgentLaunch: (id: string) => void;
  clearAgentLaunch: (id: string) => void;

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

const TreesContext = createContext<TreesModel | null>(null);

export function TreesProvider({ children }: { children: ReactNode }) {
  const { activeRepo } = useApp();
  const {
    treeLaunch,
    consumeTreeLaunch,
    treeFocus,
    consumeTreeFocus,
    pendingLaunches,
    removePendingLaunch,
    pendingDeletes,
    addPendingDeletes,
    removePendingDelete,
  } = useAppUi();
  const { data: realWorktrees = [], isLoading: worktreesLoading } = useWorktrees(activeRepo);
  const { data: baseWorktree = null } = useBaseWorktree(activeRepo);
  const { data: worktreePrs = [] } = useWorktreePrs(activeRepo);
  const runSetupPref = useBoolSetting("app", TREES_RUN_SETUP_KEY).value;
  const qc = useQueryClient();
  // Owned here (a stable provider) so optimistic delete's rollback still fires
  // after the deleted worktree's pane/bottom-bar unmounts.
  const { mutate: removeOne } = useRemoveWorktree(activeRepo);
  const { mutate: removeMany } = useRemoveWorktrees(activeRepo);

  // Show "Creating workspace…" placeholders for in-flight launches; hide worktrees
  // being deleted. Both held as state (not query-cache patches) so the refetch this
  // tab's mount — or the filesystem watcher mid-delete — triggers can't wipe them.
  const worktrees = useMemo(() => {
    const realIds = new Set(realWorktrees.map((w) => w.id));
    const placeholders = pendingLaunches.filter((p) => !realIds.has(p.id)).map(pendingWorktree);
    const visible = realWorktrees.filter((w) => !pendingDeletes.has(w.id));
    return [...placeholders, ...visible];
  }, [realWorktrees, pendingLaunches, pendingDeletes]);

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

  const [activeId, setActiveId] = useState("");
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightWidth, setRightWidth] = useState(320);
  const [fileTab, setFileTab] = useState<FileTab>("changes");
  const [launchAgents, setLaunchAgents] = useState<Set<string>>(new Set());
  // Per-launch model chosen in the Issues tray, keyed by worktree id. A transient
  // hand-off: captured from the pending launch when a launch is consumed, read once
  // by the fresh-launch seed, then cleared with the agent-launch flag. Empty ⇒ the
  // Trees fallback (the configured Work model). Never persisted — the created
  // session carries `--model` itself, so a resume needs nothing stored.
  const [launchModels, setLaunchModels] = useState<Record<string, string>>({});
  // The worktree whose setup script is running in the Setup tab, and whether to
  // launch the agent once it finishes (true when setup is part of starting a task).
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [setupThenLaunch, setSetupThenLaunch] = useState(false);
  // Per-worktree main tab + open file, so switching worktrees restores whichever
  // tab/file each one was last on instead of snapping every one back to its Issue
  // tab. A worktree with no entry defaults to Issue (Terminal for the base entry,
  // which has no ticket); the launch flow switches to setup/terminal as it starts.
  const [activeTabByWt, setActiveTabByWt] = useState<Record<string, MainTab>>({});
  const [selectedFileByWt, setSelectedFileByWt] = useState<Record<string, string | null>>({});
  const setTabFor = useCallback(
    (id: string, tab: MainTab) => setActiveTabByWt((m) => ({ ...m, [id]: tab })),
    [],
  );
  const setFileFor = useCallback(
    (id: string, file: string | null) => setSelectedFileByWt((m) => ({ ...m, [id]: file })),
    [],
  );
  const [prDialogFor, setPrDialogFor] = useState<string | null>(null);
  const [prSuggestFor, setPrSuggestFor] = useState<string | null>(null);
  const [selectedWorktrees, setSelectedWorktrees] = useState<Set<string>>(new Set());
  // Extra terminals per worktree id (the "+" tab). Keyed by worktree so each one
  // keeps its own terminals across switches; the next number is max+1 (the primary
  // "Terminal" tab is #1 implicitly, so extras start at 2).
  const [extraTermsByWt, setExtraTermsByWt] = useState<Record<string, number[]>>({});

  // Begin a task: open it, then either run setup first (in the Setup tab, then
  // launch the agent on finish) or launch the agent straight away, per the pref.
  const startAgent = useCallback(
    (id: string) => {
      setActiveId(id);
      setFileFor(id, null);
      if (runSetupPref) {
        setSetupFor(id);
        setSetupThenLaunch(true);
        setTabFor(id, "setup");
      } else {
        setLaunchAgents((s) => new Set(s).add(id));
        setTabFor(id, "terminal");
      }
    },
    [runSetupPref, setFileFor, setTabFor],
  );

  // Clear the selection if the active worktree vanished (e.g. it was deleted).
  // The base entry isn't in `worktrees`, so it's never cleared here.
  useEffect(() => {
    if (activeId === BASE_ID) return;
    if (activeId && !worktrees.some((w) => w.id === activeId)) setActiveId("");
  }, [worktrees, activeId]);

  // Consume a cross-view launch request (from the Issues "launch" action). Land
  // on the task as soon as its optimistic placeholder appears so its "Creating
  // workspace…" state is visible; only begin the agent once the *real* worktree
  // exists (the placeholder has no branch/path yet).
  useEffect(() => {
    if (!treeLaunch) return;
    const wt = worktrees.find((w) => w.id === treeLaunch);
    if (!wt) return;
    setActiveId(treeLaunch);
    // Capture the tray's model now, while the pending launch is still around (it's
    // dropped once the real worktree lands, before the seed is built). Idempotent.
    const model = pendingLaunches.find((p) => p.id === treeLaunch)?.model;
    if (model)
      setLaunchModels((m) => (m[treeLaunch] === model ? m : { ...m, [treeLaunch]: model }));
    if (wt.pending) {
      // Pre-arm the main tab *before* the real worktree's pane can mount, so the
      // terminal never spawns a bare shell ahead of setup: with setup, switch to
      // the Setup tab now (terminal stays unmounted until setup finishes); without
      // setup, mark the launch so the terminal mounts already carrying the seed.
      if (runSetupPref) setTabFor(treeLaunch, "setup");
      else {
        setLaunchAgents((s) => (s.has(treeLaunch) ? s : new Set(s).add(treeLaunch)));
        setTabFor(treeLaunch, "terminal");
      }
      return;
    }
    startAgent(treeLaunch);
    consumeTreeLaunch();
  }, [
    treeLaunch,
    worktrees,
    pendingLaunches,
    runSetupPref,
    consumeTreeLaunch,
    startAgent,
    setTabFor,
  ]);

  // Consume a cross-view "open" request (from the Issues graph/"Open in Trees"):
  // select the existing worktree and land on its Issue tab — no agent start, the
  // work is already there. Resetting the tab/file/setup state (like `setActive`)
  // avoids opening into a stale tab that renders nothing.
  useEffect(() => {
    if (!treeFocus) return;
    if (!worktrees.some((w) => w.id === treeFocus)) return;
    setActiveId(treeFocus);
    setFileFor(treeFocus, null);
    setSetupFor(null);
    setTabFor(treeFocus, "issue");
    consumeTreeFocus();
  }, [treeFocus, worktrees, consumeTreeFocus, setFileFor, setTabFor]);

  // ⌘L toggles the file-picker panel (mirrors the Issues tab). Owned here rather
  // than in a separate consumer component so there's no shallow useTrees() caller.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (inEditable(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyL") {
        e.preventDefault();
        setRightCollapsed((c) => !c);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<TreesModel>(() => {
    const active =
      activeId === BASE_ID ? baseWorktree : (worktrees.find((w) => w.id === activeId) ?? null);
    const extraTerminals = extraTermsByWt[activeId] ?? [];
    const selectedFile = selectedFileByWt[activeId] ?? null;
    // Resolve the active worktree's remembered tab. Unlike Triage (two always-present
    // tabs), Trees' File/Setup/extra-terminal tabs are conditional: the File tab needs
    // an open file, the Setup tab needs setup still running for THIS worktree (setupFor
    // is a single slot — another worktree's setup can supersede it), and a `term:<n>`
    // tab needs that terminal to still exist. If the remembered tab is no longer
    // available, fall back to a safe default instead of rendering a blank pane.
    const isBaseActive = activeId === BASE_ID;
    const fallbackTab: MainTab = isBaseActive ? "terminal" : "issue";
    const remembered = activeTabByWt[activeId];
    const termN =
      typeof remembered === "string" && remembered.startsWith("term:")
        ? Number(remembered.slice(5))
        : null;
    const tabAvailable =
      remembered === "terminal" ||
      (remembered === "issue" && !isBaseActive) ||
      (remembered === "file" && selectedFile !== null) ||
      (remembered === "setup" && setupFor === activeId) ||
      (termN !== null && extraTerminals.includes(termN));
    const activeTab: MainTab = remembered && tabAvailable ? remembered : fallbackTab;
    return {
      repo: activeRepo,
      worktrees,
      prsByWorktree,
      loading: worktreesLoading,
      baseWorktree,
      activeId,
      active,
      rightCollapsed,
      rightWidth,
      fileTab,
      selectedFile,
      setupFor,
      setupThenLaunch,
      activeTab,
      extraTerminals,
      // Switching worktrees just changes which one is active — each remembers its
      // own tab/file (see activeTabByWt/selectedFileByWt), so returning to a worktree
      // restores whatever it was last showing instead of snapping back to the Issue
      // tab. A never-visited worktree falls back to its default (Issue, or Terminal
      // for the base entry which has no ticket).
      setActive: (id) => setActiveId(id),
      showAllAgents: () => setActiveId(""),
      toggleRightPanel: () => setRightCollapsed((c) => !c),
      setRightWidth,
      setFileTab,
      // Picking a file opens (or reuses) the shared File tab and focuses it;
      // expand the picker if it was collapsed so it stays usable alongside.
      selectFile: (path) => {
        setFileFor(activeId, path);
        setTabFor(activeId, path ? "file" : "terminal");
        if (path) setRightCollapsed(false);
      },
      setActiveTab: (tab) => setTabFor(activeId, tab),
      closeFileTab: () => {
        setFileFor(activeId, null);
        if (activeTab === "file") setTabFor(activeId, "terminal");
      },
      addTerminal: () => {
        if (!activeId) return;
        const list = extraTermsByWt[activeId] ?? [];
        const next = (list.length ? Math.max(...list) : 1) + 1;
        setExtraTermsByWt((m) => ({ ...m, [activeId]: [...(m[activeId] ?? []), next] }));
        setTabFor(activeId, termTab(next));
      },
      closeTerminal: (n) => {
        setExtraTermsByWt((m) => ({
          ...m,
          [activeId]: (m[activeId] ?? []).filter((x) => x !== n),
        }));
        // If the closed terminal was showing, fall back to the primary terminal.
        if (activeTab === termTab(n)) setTabFor(activeId, "terminal");
      },
      startAgent,
      // A manual re-run opens the Setup tab alongside whatever's already open
      // (e.g. a File tab) — it doesn't replace it.
      runSetup: (id) => {
        setSetupFor(id);
        setSetupThenLaunch(false);
        setTabFor(id, "setup");
      },
      // The Setup tab is temporary: it closes when the script finishes. The launch
      // flow then continues to the agent.
      completeSetup: () => {
        qc.invalidateQueries({ queryKey: queryKeys.worktrees(activeRepo) });
        if (setupThenLaunch && setupFor) {
          setLaunchAgents((s) => new Set(s).add(setupFor));
        }
        if (setupFor) setTabFor(setupFor, "terminal");
        setSetupFor(null);
        setSetupThenLaunch(false);
      },
      launchAgents,
      launchModels,
      requestAgentLaunch: (id) => setLaunchAgents((s) => new Set(s).add(id)),
      clearAgentLaunch: (id) => {
        setLaunchAgents((s) => {
          if (!s.has(id)) return s;
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        // The seed has been consumed — drop the one-shot model override too.
        setLaunchModels((m) => {
          if (!(id in m)) return m;
          const { [id]: _, ...rest } = m;
          return rest;
        });
      },
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
      // Hide instantly via pendingDeletes (clobber-proof), delete in the
      // background; on failure drop from pendingDeletes so it reappears (the
      // mutation also raises an error toast). The auto-clear effect removes it
      // once the real list confirms it's gone.
      deleteWorktree: (id) => {
        addPendingDeletes([id]);
        removeOne(id, { onError: () => removePendingDelete(id) });
      },
      deleteSelected: () => {
        if (selectedWorktrees.size === 0) return;
        const ids = [...selectedWorktrees];
        addPendingDeletes(ids);
        removeMany(ids, { onError: () => ids.forEach(removePendingDelete) });
        setSelectedWorktrees(new Set());
      },
    };
  }, [
    worktrees,
    prsByWorktree,
    worktreesLoading,
    baseWorktree,
    activeId,
    extraTermsByWt,
    rightCollapsed,
    rightWidth,
    fileTab,
    selectedFileByWt,
    setupFor,
    setupThenLaunch,
    activeTabByWt,
    setTabFor,
    setFileFor,
    startAgent,
    launchAgents,
    launchModels,
    activeRepo,
    qc,
    prDialogFor,
    prSuggestFor,
    selectedWorktrees,
    removeOne,
    removeMany,
    addPendingDeletes,
    removePendingDelete,
  ]);

  return <TreesContext.Provider value={value}>{children}</TreesContext.Provider>;
}

export function useTrees(): TreesModel {
  const ctx = useContext(TreesContext);
  if (!ctx) throw new Error("useTrees must be used within <TreesProvider>");
  return ctx;
}
