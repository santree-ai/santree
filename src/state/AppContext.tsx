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
import { useRepos, useSaveSettings, useSettings, useWorktreeWatcher } from "../lib/queries";
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
  toggleIntegration: (key: "linear" | "triage" | "github") => void;

  /** Triage is available only when Linear is connected and triage is enabled. */
  triageEnabled: boolean;

  /** Color theme preference; "auto" follows the OS setting. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

/** Volatile UI state — toggling these re-renders only their own consumers. */
interface AppUi {
  /** The help menu popup is anchored in the shell but toggled from sidebars. */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;

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

  /** A PR the Reviews tab should select — set (as the PR's url) by a PR pill
   *  elsewhere in the app before navigating to Reviews, consumed once there. */
  reviewFocus: string | null;
  requestReviewFocus: (url: string) => void;
  consumeReviewFocus: () => void;

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
  agent: AgentKind;
}

/** Color theme preference. */
export type Theme = "dark" | "light" | "auto";

const THEME_KEY = "santree-theme";

/** Bounds for the resizable sidebar; dragging below MIN triggers collapse. */
export const SIDEBAR = { default: 264, min: 200, max: 460, collapseAt: 170 } as const;

const AppDataContext = createContext<AppData | null>(null);
const AppUiContext = createContext<AppUi | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  // The settings query cache is the single source of truth — `useSaveSettings`
  // patches it optimistically (with rollback), so there's no separate local
  // mirror to keep in sync (which could drift if a save failed and rolled back).
  const { data: settings = null } = useSettings();
  const { data: repos } = useRepos();
  const { mutate: saveSettings } = useSaveSettings();

  const [activeRepo, setActiveRepo] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR.default);
  const [treeLaunch, setTreeLaunch] = useState<string | null>(null);
  const [treeFocus, setTreeFocus] = useState<string | null>(null);
  const [reviewFocus, setReviewFocus] = useState<string | null>(null);
  const [pendingLaunches, setPendingLaunches] = useState<PendingLaunch[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme | null) ?? "dark",
  );

  // Default to (and stay on) a repo that actually exists.
  useEffect(() => {
    if (repos?.length && !repos.some((r) => r.name === activeRepo)) {
      setActiveRepo(repos[0].name);
    }
  }, [repos, activeRepo]);

  // Watch the active repo's worktrees app-wide (not just on the Trees tab) so
  // on-disk changes invalidate the cache even while another view is showing —
  // returning to Trees then renders fresh data, not a stale snapshot.
  useWorktreeWatcher(activeRepo);

  // The accent is a fixed theme color, set once on the root.
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", DEFAULT_ACCENT);
  }, []);

  // Mirror the committed width into the `--sidebar-width` CSS variable. During a
  // drag the resizer writes this variable directly (no React render); this keeps
  // it in sync on the initial value and the pointer-up commit.
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
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
          agents: s.agents.map((a) => (a.key === agent ? { ...a, exec } : a)),
        })),
      toggleIntegration: (key) =>
        applySettings((s) => {
          // Triage depends on Linear: it can only be enabled while Linear is on.
          if (key === "triage" && !s.integrations.linear) return s;
          return { ...s, integrations: { ...s.integrations, [key]: !s.integrations[key] } };
        }),
      triageEnabled: !!settings?.integrations.linear && !!settings?.integrations.triage,
      theme,
      setTheme: (next: Theme) => {
        localStorage.setItem(THEME_KEY, next);
        setThemeState(next);
      },
    }),
    [activeRepo, settings, applySettings, theme],
  );

  const uiValue = useMemo<AppUi>(
    () => ({
      helpOpen,
      setHelpOpen,
      shortcutsOpen,
      setShortcutsOpen,
      toggleShortcuts: () => setShortcutsOpen((o) => !o),
      treeLaunch,
      requestTreeLaunch: setTreeLaunch,
      consumeTreeLaunch: () => setTreeLaunch(null),
      treeFocus,
      requestTreeFocus: setTreeFocus,
      consumeTreeFocus: () => setTreeFocus(null),
      reviewFocus,
      requestReviewFocus: setReviewFocus,
      consumeReviewFocus: () => setReviewFocus(null),
      pendingLaunches,
      addPendingLaunches: (items) =>
        setPendingLaunches((prev) => [
          ...prev,
          ...items.filter((i) => !prev.some((p) => p.id === i.id)),
        ]),
      removePendingLaunch: (id) => setPendingLaunches((prev) => prev.filter((p) => p.id !== id)),
      pendingDeletes,
      addPendingDeletes: (ids) =>
        setPendingDeletes((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.add(id);
          return next;
        }),
      removePendingDelete: (id) =>
        setPendingDeletes((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      sidebarCollapsed,
      toggleSidebar: () => setSidebarCollapsed((c) => !c),
      setSidebarCollapsed,
      sidebarWidth,
      setSidebarWidth,
    }),
    [
      helpOpen,
      shortcutsOpen,
      treeLaunch,
      treeFocus,
      reviewFocus,
      pendingLaunches,
      pendingDeletes,
      sidebarCollapsed,
      sidebarWidth,
    ],
  );

  return (
    <AppDataContext.Provider value={dataValue}>
      <AppUiContext.Provider value={uiValue}>{children}</AppUiContext.Provider>
    </AppDataContext.Provider>
  );
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
