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

import type { AgentKind, Settings, TabKind, TabPr } from "../bindings";
import { preloadRepoAvatars } from "../components/chrome/RepoAvatar";
import {
  useClaudeRateLimitsWatcher,
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

/** Slow-changing shared data — the part most `useApp()` consumers read. */
interface AppData {
  /** Currently selected repository (full name, e.g. `akamai/agent`). */
  activeRepo: string;
  setActiveRepo: (repo: string) => void;

  /** The theme accent, as a CSS value (`var(--accent)`) for inline styles.
   *  Deliberately NOT a hex: the accent inverts per theme (white on dark,
   *  near-black on light) and only the cascade knows which one is live. */
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

  /** Color theme preference; "auto" follows the OS setting. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

/** Volatile UI state — toggling these re-renders only their own consumers. */
interface AppUi {
  /** Global entity and navigation command palette (⌘K). */
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;

  /** A ticket the Issues graph should focus after cross-view navigation. */
  issueFocus: string | null;
  requestIssueFocus: (id: string) => void;
  consumeIssueFocus: () => void;

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

  /** The worktree the Trees view currently has open, with its repo — published by
   *  `TreesProvider` so the sidebar's project tree can mark the row the content
   *  area is showing (the tree is permanent; that provider is route-scoped, so it
   *  can't be read from there). Deliberately not cleared when Trees unmounts:
   *  "which workspace am I in" stays true while you glance at Reviews. */
  openWorktree: OpenWorktree | null;
  setOpenWorktree: (open: OpenWorktree | null) => void;

  /** The agent session the main area is actually showing — published by
   *  `TreesProvider` so the status bar's session meter can scope itself to the
   *  tab under the user's eyes instead of to whichever tab is first.
   *
   *  **Transient by design**, unlike {@link openWorktree} directly above: that
   *  one deliberately outlives a navigation, this one must not. "Which agent am
   *  I watching" stops being true the moment Trees is off screen or the tab on
   *  screen is a diff, so `TreesProvider` clears it on unmount and the meter
   *  goes with it. Don't "fix" it to match its neighbour. */
  focusedAgent: FocusedAgent | null;
  setFocusedAgent: (agent: FocusedAgent | null) => void;

  /** A worktree the Trees tab should just open (select) without starting an agent
   *  — set by the Issues "Open in Trees" action for an existing worktree, and by
   *  the sidebar's Linear/GitHub marks, which also say which pane to land on. */
  treeFocus: TreeFocus | null;
  requestTreeFocus: (id: string, focus?: Omit<TreeFocus, "id">) => void;
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

  /** Which tab the Triage workspace should land on, once the route already
   *  carries the ticket (`/triage?ticket=`). Only the tab: the ticket rides in
   *  the url so the sidebar's Triage row lights on arrival, for the same reason
   *  a pull request rides in Reviews' url. Set by `useOpenAgent` (and ⌘I) before
   *  navigating, consumed by the workspace for that ticket. */
  triageFocus: TriageFocus | null;
  requestTriageFocus: (ticket: string, agent?: AgentKind) => void;
  consumeTriageFocus: () => void;

  /** A "Fix CI with AI" launch handed off from Reviews to Trees: open a new
   *  Fix-CI Claude tab (`tabId`) on the PR's worktree (`worktreeId`), seeded to
   *  read the already-written `promptPath` (the failed log + guardrails). Set by
   *  the Reviews Checks tab before navigating to Trees, consumed once there. */
  fixCiLaunch: FixCiLaunch | null;
  requestFixCiLaunch: (launch: FixCiLaunch) => void;
  consumeFixCiLaunch: () => void;

  /** Tab ids whose launch died before it could ever start. Because the tab is
   *  opened at the click — before the command that produces its prompt has even
   *  been sent — a failure has to take it back down: left alone it is an agent tab
   *  holding a session on paths that will never arrive, i.e. a dead tab the user
   *  must close by hand. Trees consumes these (it owns the tab rows); requesting
   *  one also cancels a matching hand-off that hasn't been picked up yet. */
  abandonedLaunchTabs: string[];
  abandonLaunchTab: (tabId: string) => void;
  consumeAbandonedLaunchTab: (tabId: string) => void;

  /** Whether the left sidebar is collapsed (Conductor-style). */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Shared left-sidebar width (px) — constant across tabs, user-resizable. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
}

/** Which worktree, in which repo, the workspace view has open. */
export interface OpenWorktree {
  repo: string;
  id: string;
}

/** Which agent session the workspace view has *on screen*.
 *
 *  `termKey` is the logical terminal that owns the session (`tree:<id>`,
 *  `tree:<id>:tab:<uuid>`) — the same key `SessionState.termKey` carries, and the
 *  only thing this field is for: it is *compared*, never sent. Passing it to a
 *  command would make it an IPC-borne path/id and hand it the `safe_path`
 *  obligation, which nothing here is set up to meet. */
export interface FocusedAgent {
  repo: string;
  termKey: string;
  agentKind: AgentKind;
}

/** Which right-panel pane a cross-view focus should land on.
 *
 *  Spelled as a literal union rather than importing the Trees feature's `FileTab`:
 *  this is app-level state, and a state→feature import is the wrong direction.
 *  The strings match `FileTab`'s members, and the Trees model is where they're
 *  read back — `resolveFileTab` drops any pane the worktree doesn't have, so a
 *  request for the PR pane on a worktree with no PR degrades rather than
 *  stranding the user on an invisible tab. */
export type TreeFocusPane = "issue" | "pr";

/** A request for the Trees tab to open one worktree.
 *
 *  Every field past `id` is optional and `undefined` means **leave it alone**.
 *  That is the whole point: this used to be a blunt "reset this worktree's view"
 *  instruction — it forced the main area back to the first tab and the right
 *  panel to the ticket, whatever the caller actually wanted — so opening an
 *  agent landed you on tab one, and a click in the History pane threw away the
 *  pane you were reading. A request now moves only what it names. */
export interface TreeFocus {
  id: string;
  /** Right-panel pane to show; `undefined` leaves the panel where it is. */
  pane?: TreeFocusPane;
  /** Also open `pane`'s page — the pull request or the ticket at reading width
   *  — as the main-area tab, the way the pane's own expand control does. The
   *  sidebar's marks ask for this: a mark that says what the worktree is linked
   *  to should show that thing, not a column beside the work. */
  expand?: boolean;
  /** Main-area tab to show: a tab's id, `undefined` to keep the worktree's
   *  last-used tab, and `null` for a caller with no tab to name — a session
   *  minted before every agent lived in one, which selects the worktree and
   *  leaves its tab alone. */
  tab?: string | null;
  /** The request came from a click in the sidebar's own project tree, so that
   *  tree already shows the row and must not expand anything to reveal it. Every
   *  other caller — Issues, the graph, the palette, a session-history row — is
   *  selecting a row the tree may have folded away, and leaves this unset. */
  fromSidebar?: boolean;
}

/** Where the Triage workspace should land for one ticket: the provider's
 *  investigation tab, or the Linear tab when `agent` is null. */
export interface TriageFocus {
  ticket: string;
  agent: AgentKind | null;
}

/** A task whose worktree is mid-creation, enough to render a placeholder. */
export interface PendingLaunch {
  id: string;
  title: string;
  project: string | null;
  agent: AgentKind | null;
  /** The branch this launch will stack on, when it's a chained one — the same base
   *  `createWorktree` is given. Carried so the sidebar can nest the "Creating
   *  workspace…" placeholder under its parent straight away: the stack is already
   *  decided at launch, so waiting for the real worktree to land before indenting it
   *  makes a sub-task look like a root for the seconds the create takes. Absent for
   *  a root launch. */
  baseBranch?: string;
}

/** A Reviews→Trees review hand-off: which worktree + freshly-minted review tab to
 *  open, and the on-disk prompt file the tab's Claude session should read on
 *  launch.
 *
 *  Sent **twice** under one tab id, which is what makes the click feel instant:
 *  `preparing` the moment the button is pressed (identity only — enough for Trees
 *  to open and focus the tab), then `ready` with the paths once the render command
 *  has fetched the PR and written them. The pane holds its PTY across the gap, so
 *  the terminal still arrives last; only the *waiting* moved into the tab. */
export interface FixCiLaunch {
  worktreeId: string;
  tabId: string;
  /** `preparing`: the launch command is still running, so the paths below are
   *  absent and no session may spawn against them yet. `ready`: they landed. */
  phase: "preparing" | "ready";
  /** Absent while `preparing` — it is the thing being rendered. */
  promptPath?: string;
  /** Which review session this is. Persisted with the tab, so a resume after a
   * restart re-derives the same launch configuration instead of guessing. */
  kind: Extract<TabKind, "fixCi" | "aiReview">;
  /** The PR the session is scoped to — persisted alongside `kind` for the same
   * reason, and the only thing that names its MCP config file. */
  pr: TabPr;
  /** Review-worklist launches use the same guarded tab hand-off but also carry
   * the MCP authority that lets the agent complete items. */
  settingsPath?: string;
  mcpConfigPath?: string;
  title?: string;
  agentKind?: AgentKind;
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
 *  - `subBar`: the row under the top bar — the workspace tab strip and the right
 *    panel's own tab strip, which sit side by side and must share a baseline.
 *  - `statusBar`: the sidebar's footer row (settings/help), which ends the rail at
 *    the same height the window's status bar begins.
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
  const [activeRepo, setActiveRepo] = useState(() => localStorage.getItem(REPO_KEY) ?? "");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return stored >= SIDEBAR.min && stored <= SIDEBAR.max ? stored : SIDEBAR.default;
  });
  const [treeLaunch, setTreeLaunch] = useState<string | null>(null);
  const [issueFocus, setIssueFocus] = useState<string | null>(null);
  const [treeFocus, setTreeFocus] = useState<TreeFocus | null>(null);
  const [openWorktree, setOpenWorktree] = useState<OpenWorktree | null>(null);
  const [focusedAgent, setFocusedAgentState] = useState<FocusedAgent | null>(null);
  const [bgLaunches, setBgLaunches] = useState<string[]>([]);
  const [reviewFocus, setReviewFocus] = useState<string | null>(null);
  const [triageFocus, setTriageFocus] = useState<TriageFocus | null>(null);
  const [fixCiLaunch, setFixCiLaunch] = useState<FixCiLaunch | null>(null);
  const [abandonedLaunchTabs, setAbandonedLaunchTabs] = useState<string[]>([]);
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
  useClaudeRateLimitsWatcher();

  // The AI review writes its brief and drafts through santree's MCP server — a
  // separate process — so the only way the UI hears about them is this nudge. A
  // draft should appear in the diff while the user is reading it.
  useReviewAiWatcher();

  // Keep the Settings → Usage panel live: the watcher invalidates the usage query
  // when a transcript grows. Mounted app-wide so the listener is always attached;
  // the invalidation is a no-op until the panel actually observes the query.
  useUsageWatcher();

  // The active ViewChrome owns the live `--sidebar-width` variable so dragging it
  // does not invalidate styles across the entire app. Persist only the committed
  // value here so a resize survives a relaunch.
  useEffect(() => {
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
      accent: "var(--accent)",
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
      theme,
      setTheme: (next: Theme) => {
        localStorage.setItem(THEME_KEY, next);
        setThemeState(next);
      },
    }),
    [activeRepo, settings, applySettings, theme],
  );

  // Handlers are stabilized with `useCallback` (all use functional setState, so
  // none capture render values). This matters because the Issues and Trees models
  // capture these functions into their own context-value `useMemo` deps — if the
  // refs changed whenever volatile UI state did (help menu, sidebar drag), those
  // models would rebuild and re-render every consumer on every unrelated toggle.
  const toggleShortcuts = useCallback(() => setShortcutsOpen((o) => !o), []);
  const toggleCommandPalette = useCallback(() => setCommandPaletteOpen((o) => !o), []);
  const consumeIssueFocus = useCallback(() => setIssueFocus(null), []);
  const consumeTreeLaunch = useCallback(() => setTreeLaunch(null), []);
  const consumeTreeFocus = useCallback(() => setTreeFocus(null), []);
  // Defaults to the ticket, which is what "just open this worktree" has always
  // meant; a caller that means something more specific — this pane, this tab —
  // says so, and everything it doesn't name is left as the user had it.
  const requestTreeFocus = useCallback(
    (id: string, focus: Omit<TreeFocus, "id"> = { pane: "issue" }) =>
      setTreeFocus({ id, ...focus }),
    [],
  );
  const consumeReviewFocus = useCallback(() => setReviewFocus(null), []);
  const consumeTriageFocus = useCallback(() => setTriageFocus(null), []);
  const requestTriageFocus = useCallback(
    (ticket: string, agent?: AgentKind) => setTriageFocus({ ticket, agent: agent ?? null }),
    [],
  );
  const consumeFixCiLaunch = useCallback(() => setFixCiLaunch(null), []);
  // Both halves, because the failure can land on either side of the hand-off: the
  // request may still be sitting here unread (its worktree never appeared), or
  // Trees may already have turned it into a tab row.
  const abandonLaunchTab = useCallback((tabId: string) => {
    setFixCiLaunch((current) => (current?.tabId === tabId ? null : current));
    setAbandonedLaunchTabs((prev) => (prev.includes(tabId) ? prev : [...prev, tabId]));
  }, []);
  const consumeAbandonedLaunchTab = useCallback((tabId: string) => {
    setAbandonedLaunchTabs((prev) => prev.filter((id) => id !== tabId));
  }, []);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);
  // Republished by an effect that re-runs on every Trees state change, so an
  // unchanged focus must not mint a new object: this value is read from the
  // permanent status bar, and a fresh identity per keystroke in the terminal
  // would re-render it for nothing.
  const setFocusedAgent = useCallback((next: FocusedAgent | null) => {
    setFocusedAgentState((prev) => {
      const same =
        prev === next ||
        (prev !== null &&
          next !== null &&
          prev.repo === next.repo &&
          prev.termKey === next.termKey &&
          prev.agentKind === next.agentKind);
      return same ? prev : next;
    });
  }, []);
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
      commandPaletteOpen,
      setCommandPaletteOpen,
      toggleCommandPalette,
      issueFocus,
      requestIssueFocus: setIssueFocus,
      consumeIssueFocus,
      shortcutsOpen,
      setShortcutsOpen,
      toggleShortcuts,
      treeLaunch,
      requestTreeLaunch: setTreeLaunch,
      consumeTreeLaunch,
      openWorktree,
      setOpenWorktree,
      focusedAgent,
      setFocusedAgent,
      treeFocus,
      requestTreeFocus,
      consumeTreeFocus,
      bgLaunches,
      requestBackgroundLaunch,
      clearBackgroundLaunch,
      reviewFocus,
      requestReviewFocus: setReviewFocus,
      consumeReviewFocus,
      triageFocus,
      requestTriageFocus,
      consumeTriageFocus,
      fixCiLaunch,
      requestFixCiLaunch: setFixCiLaunch,
      consumeFixCiLaunch,
      abandonedLaunchTabs,
      abandonLaunchTab,
      consumeAbandonedLaunchTab,
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
      commandPaletteOpen,
      issueFocus,
      shortcutsOpen,
      treeLaunch,
      treeFocus,
      openWorktree,
      focusedAgent,
      setFocusedAgent,
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
      toggleCommandPalette,
      consumeIssueFocus,
      consumeTreeLaunch,
      consumeTreeFocus,
      requestTreeFocus,
      consumeReviewFocus,
      requestTriageFocus,
      consumeTriageFocus,
      consumeFixCiLaunch,
      abandonedLaunchTabs,
      abandonLaunchTab,
      consumeAbandonedLaunchTab,
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

export function useAppUiOptional(): AppUi | null {
  return useContext(AppUiContext);
}
