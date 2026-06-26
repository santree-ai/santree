/**
 * Global client state — the cross-cutting bits that several tabs share:
 * the active repo and the live settings.
 *
 * Settings are *seeded* from the backend (`useSettings`) and then owned here so
 * the UI can edit them locally (integrations toggles, default agent, models).
 * Per-tab ephemeral state (selection, sessions, terminal logs, …) lives in the
 * relevant feature, not here.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import type { AgentKind, Settings } from "../bindings";
import { useRepos, useSettings } from "../lib/queries";
import { DEFAULT_ACCENT } from "../theme/colors";

interface AppState {
  /** Currently selected repository (full name, e.g. `akamai/agent`). */
  activeRepo: string;
  setActiveRepo: (repo: string) => void;

  /** The fixed theme accent (exposed for inline styles). */
  accent: string;

  /** Live settings (null until the backend seed loads). */
  settings: Settings | null;
  updateSettings: (patch: Partial<Settings>) => void;
  setDefaultAgent: (agent: AgentKind) => void;
  setAgentExec: (agent: AgentKind, exec: string) => void;
  setAgentModel: (agent: AgentKind, model: string) => void;
  toggleIntegration: (key: "linear" | "triage" | "github") => void;

  /** Triage is available only when Linear is connected and triage is enabled. */
  triageEnabled: boolean;

  /** Color theme preference; "auto" follows the OS setting. */
  theme: Theme;
  setTheme: (theme: Theme) => void;

  /** The help menu popup is anchored in the shell but toggled from sidebars. */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;

  /** The searchable keyboard-shortcuts overlay (⌘/ or the help menu). */
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  toggleShortcuts: () => void;

  /** Whether the left sidebar is collapsed (Conductor-style). */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Shared left-sidebar width (px) — constant across tabs, user-resizable. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
}

/** Color theme preference. */
export type Theme = "dark" | "light" | "auto";

const THEME_KEY = "santree-theme";

/** Bounds for the resizable sidebar; dragging below MIN triggers collapse. */
export const SIDEBAR = { default: 264, min: 200, max: 460, collapseAt: 170 } as const;

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const { data: seed } = useSettings();
  const { data: repos } = useRepos();

  const [activeRepo, setActiveRepo] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR.default);
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme | null) ?? "dark",
  );

  // Adopt the backend seed once, and align the default agent's model.
  useEffect(() => {
    if (seed && !settings) setSettings(seed);
  }, [seed, settings]);

  // Default to (and stay on) a repo that actually exists.
  useEffect(() => {
    if (repos?.length && !repos.some((r) => r.name === activeRepo)) {
      setActiveRepo(repos[0].name);
    }
  }, [repos, activeRepo]);

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

  const value = useMemo<AppState>(() => {
    const updateSettings = (patch: Partial<Settings>) =>
      setSettings((s) => (s ? { ...s, ...patch } : s));

    return {
      activeRepo,
      setActiveRepo,
      accent: DEFAULT_ACCENT,
      settings,
      updateSettings,
      setDefaultAgent: (agent) => updateSettings({ defaultAgent: agent }),
      setAgentExec: (agent, exec) =>
        setSettings((s) =>
          s ? { ...s, agents: s.agents.map((a) => (a.key === agent ? { ...a, exec } : a)) } : s,
        ),
      setAgentModel: (agent, model) =>
        setSettings((s) =>
          s ? { ...s, agents: s.agents.map((a) => (a.key === agent ? { ...a, model } : a)) } : s,
        ),
      toggleIntegration: (key) =>
        setSettings((s) => {
          if (!s) return s;
          // Triage depends on Linear: it can only be enabled while Linear is on.
          if (key === "triage" && !s.integrations.linear) return s;
          return {
            ...s,
            integrations: { ...s.integrations, [key]: !s.integrations[key] },
          };
        }),
      triageEnabled: !!settings?.integrations.linear && !!settings?.integrations.triage,
      theme,
      setTheme: (next: Theme) => {
        localStorage.setItem(THEME_KEY, next);
        setThemeState(next);
      },
      helpOpen,
      setHelpOpen,
      shortcutsOpen,
      setShortcutsOpen,
      toggleShortcuts: () => setShortcutsOpen((o) => !o),
      sidebarCollapsed,
      toggleSidebar: () => setSidebarCollapsed((c) => !c),
      setSidebarCollapsed,
      sidebarWidth,
      setSidebarWidth,
    };
  }, [activeRepo, settings, helpOpen, shortcutsOpen, sidebarCollapsed, sidebarWidth, theme]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}

/**
 * Like `useApp`, but returns `null` instead of throwing when no provider is
 * mounted. For non-critical chrome (e.g. global keyboard shortcuts in the route
 * root) that must never crash the tree during a transient render.
 */
export function useAppOptional(): AppState | null {
  return useContext(AppContext);
}
