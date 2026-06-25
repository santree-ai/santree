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
import { useSettings } from "../lib/queries";
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

  /** The help menu popup is anchored in the shell but toggled from sidebars. */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const { data: seed } = useSettings();

  const [activeRepo, setActiveRepo] = useState("akamai/agent");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Adopt the backend seed once, and align the default agent's model.
  useEffect(() => {
    if (seed && !settings) setSettings(seed);
  }, [seed, settings]);

  // The accent is a fixed theme color, set once on the root.
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", DEFAULT_ACCENT);
  }, []);

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
      helpOpen,
      setHelpOpen,
    };
  }, [activeRepo, settings, helpOpen]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}
