/**
 * Trees-tab state model.
 *
 * Owns which worktree/terminal is active, whether the terminal or diff view is
 * showing, the broadcast (all-agents) scope, and any messages the user has typed
 * into a terminal (appended on top of the backend's seed transcript).
 */
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

import { useWorktrees } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { agentSlug } from "../../theme/colors";

/** A user/agent line typed into a terminal at runtime. */
export interface LogLine {
  text: string;
  color: string;
}

interface TreesModel {
  activeId: string;
  treeView: "terminal" | "diff";
  scopeAll: boolean;
  /** Per-worktree appended lines (keyed by worktree id). */
  termLog: Record<string, LogLine[]>;

  setActive: (id: string) => void;
  setTreeView: (view: "terminal" | "diff") => void;
  setScopeAll: () => void;
  /** Send a message to one worktree's agent (echo + ack). */
  sendTo: (id: string, message: string) => void;
  /** Send one message to every running/awaiting agent. */
  broadcast: (message: string) => void;
}

const TreesContext = createContext<TreesModel | null>(null);

const USER_COLOR = "#dbe6f2";

export function TreesProvider({ children }: { children: ReactNode }) {
  const { accent } = useApp();
  const { data: worktrees = [] } = useWorktrees();

  const [activeId, setActiveId] = useState("AK-165");
  const [treeView, setTreeView] = useState<"terminal" | "diff">("terminal");
  const [scopeAll, setScopeAllState] = useState(false);
  const [termLog, setTermLog] = useState<Record<string, LogLine[]>>({});

  const value = useMemo<TreesModel>(() => {
    const slugFor = (id: string) => {
      const wt = worktrees.find((w) => w.id === id);
      return wt ? agentSlug(wt.agent) : "claude";
    };
    const append = (log: Record<string, LogLine[]>, id: string, lines: LogLine[]) => ({
      ...log,
      [id]: [...(log[id] ?? []), ...lines],
    });

    return {
      activeId,
      treeView,
      scopeAll,
      termLog,
      setActive: (id) => {
        setActiveId(id);
        setScopeAllState(false);
      },
      setTreeView,
      setScopeAll: () => setScopeAllState(true),
      sendTo: (id, message) => {
        const msg = message.trim();
        if (!msg) return;
        setTermLog((log) =>
          append(log, id, [
            { text: `› ${msg}`, color: USER_COLOR },
            { text: `${slugFor(id)}: got it — folding that into the current run…`, color: accent },
          ]),
        );
      },
      broadcast: (message) => {
        const msg = message.trim();
        if (!msg) return;
        const targets = worktrees.filter(
          (w) => w.activity === "Running" || w.activity === "Awaiting",
        );
        setTermLog((log) => {
          let next = log;
          for (const w of targets) {
            next = append(next, w.id, [
              { text: `› [broadcast] ${msg}`, color: USER_COLOR },
              { text: `${slugFor(w.id)}: ack`, color: accent },
            ]);
          }
          return next;
        });
      },
    };
  }, [activeId, treeView, scopeAll, termLog, worktrees, accent]);

  return <TreesContext.Provider value={value}>{children}</TreesContext.Provider>;
}

export function useTrees(): TreesModel {
  const ctx = useContext(TreesContext);
  if (!ctx) throw new Error("useTrees must be used within <TreesProvider>");
  return ctx;
}
