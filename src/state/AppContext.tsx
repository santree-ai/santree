/**
 * Global client state — the cross-cutting bits that several tabs share.
 *
 * Split into two contexts on purpose:
 *  - {@link useApp} — slow-changing *data* (active repo, settings, theme). Most
 *    consumers only need this, so they shouldn't re-render on a UI toggle.
 *  - {@link useAppUi} — volatile UI state (help/shortcuts popovers, the sidebar
 *    collapse/width, the cross-view tree-launch hand-off). Toggling these only
 *    re-renders the few components that actually read them.
 *
 * Settings come from the backend (`useSettings`) and are edited through the
 * optimistic `useSaveSettings` write (the query cache is the source of truth).
 * Per-tab ephemeral state (selection, sessions, terminal logs, …) lives in the
 * relevant feature, not here.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { AgentKind, Settings } from "../bindings";
import { preloadRepoAvatars } from "../components/chrome/RepoAvatar";
import {
  DEV_GITHUB_LOGIN,
  useGithubStatus,
  useRepos,
  useReviewAiWatcher,
  useSaveSettings,
  useSessionStates,
  useSessionStateWatcher,
  useSessionUsageWatcher,
  useSettings,
  useUsageWatcher,
  useWorktreeWatcher,
} from "../lib/queries";
import { DEFAULT_ACCENT } from "../theme/colors";

/** Slow-changing shared data — the part most `useApp()` consumers read. */
interface AppData {
  /** Currently selected repository (full name, e.g. `akamai/agent`). */
  activeRepo: string;
  setActiveRepo: (repo: string) => void;

  /** The fixed theme accent (exposed for inline styles). */
  accent: string;

  /** Live settings (null until the backend seed loads). Edits persist via
   *  `setAgentExec` / `toggleIntegration`, which write through the optimistic
   *  settings cache. */
  settings: Settings | null;
  setAgentExec: (agent: AgentKind, exec: string) => void;
  setAgentModel: (agent: AgentKind, model: string) => void;
  toggleIntegration: (key: "linear" | "triage") => void;

  /** Triage is available only when Linear is connected and triage is enabled. */
  triageEnabled: boolean;

  /** The hidden Dev (dogfooding) tab — only for the app developer's GitHub
   *  login (see features/dev; deleted with it). */
  devEnabled: boolean;

  /** Color theme preference; "auto" follows the OS setting. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

/** Volatile UI state — toggling these re-renders only their own consumers. */
interface AppUi {
  /** The searchable keyboard-shortcuts overlay (⌘/ or the help menu). */
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  toggleShortcuts: () => void;

  /** A worktree the Trees tab should open and launch the agent in — set by the
   *  Issues "launch" action before navigating to Trees, consumed once there. */
  treeLaunch: string | null;
  requestTreeLaunch: (id: string) => void;
  consumeTreeLaunch: () => void;

  /** Tasks whose worktree is being created right now. The Trees tab merges these
   *  in as `pending` placeholders ("Creating workspace…") so there's immediate
   *  feedback while git runs — held as state (not a query-cache patch, which the
   *  Trees-mount refetch would clobber). Dropped once the real worktree lands. */
  pendingLaunches: PendingLaunch[];
  addPendingLaunches: (items: PendingLaunch[]) => void;
  removePendingLaunch: (id: string) => void;

  /** Worktree ids being deleted right now. The Trees tab filters these out so a
   *  delete is instant and stays gone — held as state (not a query-cache patch,
   *  which a mid-delete refetch from the filesystem watcher would clobber, briefly
   *  re-adding the worktree with garbage stats). Dropped once it's gone (success)
   *  or the delete fails (so it reappears). */
  pendingDeletes: Set<string>;
  addPendingDeletes: (ids: string[]) => void;
  removePendingDelete: (id: string) => void;

  /** A worktree the Trees tab should just open (select) without starting an agent
   *  — set by the Issues "Open in Trees" action for an existing worktree. */
  treeFocus: string | null;
  requestTreeFocus: (id: string) => void;
  consumeTreeFocus: () => void;

  /** Worktrees the Trees tab should launch an agent in *in the background* —
   *  set by the Issues "Run in background" (⌘-click) action. Trees mounts each
   *  off-screen to spawn its PTY and seed the agent without stealing focus or
   *  switching the active worktree, then drops it here once launched (the live
   *  session persists in the TerminalLayer and re-attaches on a later open). */
  bgLaunches: string[];
  requestBackgroundLaunch: (id: string) => void;
  clearBackgroundLaunch: (id: string) => void;

  /** A PR the Reviews tab should select — set (as the PR's url) by a PR pill
   *  elsewhere in the app before navigating to Reviews, consumed once there. */
  reviewFocus: string | null;
  requestReviewFocus: (url: string) => void;
  consumeReviewFocus: () => void;

  /** A ticket the Triage tab should select — set (as the ticket id) by the Agents
   *  panel before navigating to Triage, consumed once there. Mirrors
   *  {@link treeFocus}. */
  triageFocus: string | null;
  requestTriageFocus: (id: string) => void;
  consumeTriageFocus: () => void;

  /** A "Fix CI with AI" launch handed off from Reviews to Trees: open a new
   *  Fix-CI Claude tab (`tabId`) on the PR's worktree (`worktreeId`), seeded to
   *  read the already-written `promptPath` (the failed log + guardrails). Set by
   *  the Reviews Checks tab before navigating to Trees, consumed once there. */
  fixCiLaunch: FixCiLaunch | null;
  requestFixCiLaunch: (launch: FixCiLaunch) => void;
  consumeFixCiLaunch: () => void;

  /** Whether the left sidebar is collapsed (Conductor-style). */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Shared left-sidebar width (px) — constant across tabs, user-resizable. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
}

/** A task whose worktree is mid-creation, enough to render a placeholder. */
export interface PendingLaunch {
  id: string;
  title: string;
  project: string | null;
  agent: AgentKind | null;
  /** The per-launch model chosen in the Issues tray (empty ⇒ the settings default).
   *  A transient hand-off to the Trees fresh-launch seed — not persisted; once the
   *  session is created with `--model`, resuming carries it, so there's nothing to
   *  store. */
  model?: string;
  /** The branch this launch will stack on, when it's a chained one — the same base
   *  `createWorktree` is given. Carried so the sidebar can nest the "Creating
   *  workspace…" placeholder under its parent straight away: the stack is already
   *  decided at launch, so waiting for the real worktree to land before indenting it
   *  makes a sub-task look like a root for the seconds the create takes. Absent for
   *  a root launch. */
  baseBranch?: string;
}

/** A Reviews→Trees "Fix CI with AI" hand-off: which worktree + freshly-minted
 *  Fix-CI tab to open, and the on-disk prompt file (failed log + guardrails) the
 *  tab's Claude session should read on launch. */
export interface FixCiLaunch {
  worktreeId: string;
  tabId: string;
  promptPath: string;
}

/** Color theme preference. */
export type Theme = "dark" | "light" | "auto";

const THEME_KEY = "santree-theme";
const REPO_KEY = "santree-active-repo";
const SIDEBAR_COLLAPSED_KEY = "santree-sidebar-collapsed";
const SIDEBAR_WIDTH_KEY = "santree-sidebar-width";

/** Bounds for the resizable sidebar; dragging below MIN triggers collapse. */
export const SIDEBAR = { default: 264, min: 200, max: 460, collapseAt: 170 } as const;

/**
 * Shared chrome bar heights (Tailwind height classes) so the sidebar column's
 * horizontal dividers line up with the content column's across the app:
 *  - `subBar`: the row under the top bar — repo selector (sidebar) ↔ tab bar (content).
 *  - `statusBar`: the bottom bar — sidebar footer ↔ work-panel bottom bar.
 * Both columns share the viewport's top/bottom edges, so equal heights ⇒ aligned dividers.
 */
export const CHROME = { subBar: "h-9", statusBar: "h-9" } as const;

const AppDataContext = createContext<AppData | null>(null);
const AppUiContext = createContext<AppUi | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  // The settings query cache is the single source of truth — `useSaveSettings`
  // patches it optimistically (with rollback), so there's no separate local
  // mirror to keep in sync (which could drift if a save failed and rolled back).
  const { data: settings = null } = useSettings();
  const { data: repos } = useRepos();
  const { mutate: saveSettings } = useSaveSettings();
  // The hidden Dev tab's gate, derived once here (like triageEnabled) so the
  // nav chrome and the shortcut map agree. A plain boolean dep below, so status
  // refetches don't rebuild the memo unless the answer actually changes.
  const { data: github } = useGithubStatus();
  const devEnabled = github?.account === DEV_GITHUB_LOGIN;

  const [activeRepo, setActiveRepo] = useState(() => localStorage.getItem(REPO_KEY) ?? "");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return stored >= SIDEBAR.min && stored <= SIDEBAR.max ? stored : SIDEBAR.default;
  });
  const [treeLaunch, setTreeLaunch] = useState<string | null>(null);
  const [treeFocus, setTreeFocus] = useState<string | null>(null);
  const [bgLaunches, setBgLaunches] = useState<string[]>([]);
  const [reviewFocus, setReviewFocus] = useState<string | null>(null);
  const [triageFocus, setTriageFocus] = useState<string | null>(null);
  const [fixCiLaunch, setFixCiLaunch] = useState<FixCiLaunch | null>(null);
  const [pendingLaunches, setPendingLaunches] = useState<PendingLaunch[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme | null) ?? "dark",
  );

  // Default to (and stay on) a repo that actually exists. When the list empties (the
  // last repo was removed) the active repo must be *cleared*, not left pointing at a
  // repo the backend no longer knows — every `enabled: !!repo` query would keep
  // firing against it.
  useEffect(() => {
    if (!repos) return; // still loading — don't clear a valid repo
    if (repos.some((r) => r.name === activeRepo)) return;
    setActiveRepo(repos[0]?.name ?? "");
  }, [repos, activeRepo]);

  // Warm the GitHub avatar cache for every repo up front, so pickers/dropdowns
  // render their icons instantly instead of flashing a loading state on open.
  useEffect(() => {
    if (repos?.length) preloadRepoAvatars(repos);
  }, [repos]);

  // Persist the active repo (and sidebar layout) across launches, same as theme.
  // Keyed on the state itself rather than wrapping the exposed setters, since
  // `activeRepo` and `sidebarCollapsed` are also written from other call sites
  // above (the repo-validation fallback) and below (`toggleSidebar`).
  //
  // Clearing the repo must *remove* the key, not leave the last name behind: the
  // initial state seeds straight from localStorage, so a stale name would fire
  // every `enabled: !!repo` query against a repo the backend no longer knows on
  // the next launch — before the validation effect above can clear it.
  useEffect(() => {
    if (activeRepo) localStorage.setItem(REPO_KEY, activeRepo);
    else localStorage.removeItem(REPO_KEY);
  }, [activeRepo]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Watch the active repo's worktrees app-wide (not just on the Trees tab) so
  // on-disk changes invalidate the cache even while another view is showing —
  // returning to Trees then renders fresh data, not a stale snapshot.
  useWorktreeWatcher(activeRepo);

  // Keep live Claude session state flowing into the cache app-wide + in realtime:
  // the watchers push updates, and <SessionStatePoller/> keeps the query observed.
  // The Trees sidebar and the all-agents overview both render it.
  useSessionStateWatcher();
  useSessionUsageWatcher();

  // The AI review writes its brief and drafts through santree's MCP server — a
  // separate process — so the only way the UI hears about them is this nudge. A
  // draft should appear in the diff while the user is reading it.
  useReviewAiWatcher();

  // Keep the Settings → Usage panel live: the watcher invalidates the usage query
  // when a transcript grows. Mounted app-wide so the listener is always attached;
  // the invalidation is a no-op until the panel actually observes the query.
  useUsageWatcher();

  // The accent is a fixed theme color, set once on the root.
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", DEFAULT_ACCENT);
  }, []);

  // Mirror the committed width into the `--sidebar-width` CSS variable. During a
  // drag the resizer writes this variable directly (no React render); this keeps
  // it in sync on the initial value and the pointer-up commit. Also persist it,
  // same as theme, so a resize survives a relaunch.
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  // Resolve the theme to a concrete `data-theme` on <html>. "auto" tracks the OS
  // preference live via matchMedia.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = theme === "auto" ? (mq.matches ? "light" : "dark") : theme;
      document.documentElement.setAttribute("data-theme", resolved);
    };
    apply();
    if (theme !== "auto") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // Apply a settings edit: persist the whole blob via the optimistic write, which
  // patches the `["settings"]` cache immediately (with rollback on failure) — so
  // the UI updates at once and there's no local copy to drift. A no-op update
  // (e.g. a disallowed toggle) is dropped before the write.
  const applySettings = useCallback(
    (updater: (s: Settings) => Settings) => {
      if (!settings) return;
      const next = updater(settings);
      if (next === settings) return;
      saveSettings(next);
    },
    [settings, saveSettings],
  );

  const dataValue = useMemo<AppData>(
    () => ({
      activeRepo,
      setActiveRepo,
      accent: DEFAULT_ACCENT,
      settings,
      setAgentExec: (agent, exec) =>
        applySettings((s) => ({
          ...s,
          agents: (s.agents ?? []).map((a) => (a.key === agent ? { ...a, exec } : a)),
        })),
      setAgentModel: (agent, model) =>
        applySettings((s) => ({
          ...s,
          agents: (s.agents ?? []).map((a) => (a.key === agent ? { ...a, model } : a)),
        })),
      toggleIntegration: (key) =>
        applySettings((s) => {
          // `s.integrations` is only optional in the generated type because
          // `Settings` round-trips through `#[serde(default)]` for backward
          // compat on old stored blobs — the live value here is always fully
          // populated (from `get_settings`), so a fallback is just for TS.
          const integrations = s.integrations ?? { linear: false, triage: false };
          // Triage depends on Linear: it can only be enabled while Linear is on.
          if (key === "triage" && !integrations.linear) return s;
          return { ...s, integrations: { ...integrations, [key]: !integrations[key] } };
        }),
      triageEnabled: !!settings?.integrations?.linear && !!settings?.integrations?.triage,
      devEnabled,
      theme,
      setTheme: (next: Theme) => {
        localStorage.setItem(THEME_KEY, next);
        setThemeState(next);
      },
    }),
    [activeRepo, settings, applySettings, theme, devEnabled],
  );

  // Handlers are stabilized with `useCallback` (all use functional setState, so
  // none capture render values). This matters because the Issues and Trees models
  // capture these functions into their own context-value `useMemo` deps — if the
  // refs changed whenever volatile UI state did (help menu, sidebar drag), those
  // models would rebuild and re-render every consumer on every unrelated toggle.
  const toggleShortcuts = useCallback(() => setShortcutsOpen((o) => !o), []);
  const consumeTreeLaunch = useCallback(() => setTreeLaunch(null), []);
  const consumeTreeFocus = useCallback(() => setTreeFocus(null), []);
  const consumeReviewFocus = useCallback(() => setReviewFocus(null), []);
  const consumeTriageFocus = useCallback(() => setTriageFocus(null), []);
  const consumeFixCiLaunch = useCallback(() => setFixCiLaunch(null), []);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);
  const addPendingLaunches = useCallback((items: PendingLaunch[]) => {
    setPendingLaunches((prev) => [
      ...prev,
      ...items.filter((i) => !prev.some((p) => p.id === i.id)),
    ]);
  }, []);
  const removePendingLaunch = useCallback((id: string) => {
    setPendingLaunches((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const requestBackgroundLaunch = useCallback((id: string) => {
    setBgLaunches((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  const clearBackgroundLaunch = useCallback((id: string) => {
    setBgLaunches((prev) => prev.filter((x) => x !== id));
  }, []);
  const addPendingDeletes = useCallback((ids: string[]) => {
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);
  const removePendingDelete = useCallback((id: string) => {
    setPendingDeletes((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const uiValue = useMemo<AppUi>(
    () => ({
      shortcutsOpen,
      setShortcutsOpen,
      toggleShortcuts,
      treeLaunch,
      requestTreeLaunch: setTreeLaunch,
      consumeTreeLaunch,
      treeFocus,
      requestTreeFocus: setTreeFocus,
      consumeTreeFocus,
      bgLaunches,
      requestBackgroundLaunch,
      clearBackgroundLaunch,
      reviewFocus,
      requestReviewFocus: setReviewFocus,
      consumeReviewFocus,
      triageFocus,
      requestTriageFocus: setTriageFocus,
      consumeTriageFocus,
      fixCiLaunch,
      requestFixCiLaunch: setFixCiLaunch,
      consumeFixCiLaunch,
      pendingLaunches,
      addPendingLaunches,
      removePendingLaunch,
      pendingDeletes,
      addPendingDeletes,
      removePendingDelete,
      sidebarCollapsed,
      toggleSidebar,
      setSidebarCollapsed,
      sidebarWidth,
      setSidebarWidth,
    }),
    [
      shortcutsOpen,
      treeLaunch,
      treeFocus,
      bgLaunches,
      requestBackgroundLaunch,
      clearBackgroundLaunch,
      reviewFocus,
      triageFocus,
      fixCiLaunch,
      pendingLaunches,
      pendingDeletes,
      sidebarCollapsed,
      sidebarWidth,
      toggleShortcuts,
      consumeTreeLaunch,
      consumeTreeFocus,
      consumeReviewFocus,
      consumeTriageFocus,
      consumeFixCiLaunch,
      toggleSidebar,
      addPendingLaunches,
      removePendingLaunch,
      addPendingDeletes,
      removePendingDelete,
    ],
  );

  return (
    <AppDataContext.Provider value={dataValue}>
      <AppUiContext.Provider value={uiValue}>
        <SessionStatePoller />
        {children}
      </AppUiContext.Provider>
    </AppDataContext.Provider>
  );
}

/** Keeps the session-state query observed app-wide so its poll runs even on views
 *  that don't read it (returning to Trees then shows current state, not a stale
 *  snapshot). A leaf that renders nothing: subscribing from `AppProvider` itself
 *  re-rendered the whole provider — and every consumer under it — on every tick. */
function SessionStatePoller() {
  useSessionStates();
  return null;
}

export function useApp(): AppData {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}

/** Volatile UI state (popovers, sidebar, tree-launch). Separate from {@link useApp}
 *  so toggling it doesn't re-render data-only consumers. */
export function useAppUi(): AppUi {
  const ctx = useContext(AppUiContext);
  if (!ctx) throw new Error("useAppUi must be used within <AppProvider>");
  return ctx;
}

/**
 * Like {@link useApp} / {@link useAppUi}, but return `null` instead of throwing
 * when no provider is mounted. For non-critical chrome (e.g. global keyboard
 * shortcuts in the route root) that must never crash during a transient render.
 */
export function useAppOptional(): AppData | null {
  return useContext(AppDataContext);
}

export function useAppUiOptional(): AppUi | null {
  return useContext(AppUiContext);
}
