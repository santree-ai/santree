/**
 * App-global terminal session state. Lifting this out of the route keeps shells
 * alive across tab switches (switching away must never kill a running process)
 * and lets the nav tab show a live count. The sessions are rendered once, in a
 * persistent layer (see `TerminalLayer`), regardless of the active route.
 */
import { createContext, type ReactNode, useContext } from "react";

import { type TerminalTabs, useTerminalTabs } from "./orchestrator";

const TerminalsContext = createContext<TerminalTabs | null>(null);

export function TerminalsProvider({ children }: { children: ReactNode }) {
  const value = useTerminalTabs();
  return <TerminalsContext.Provider value={value}>{children}</TerminalsContext.Provider>;
}

export function useTerminals(): TerminalTabs {
  const ctx = useContext(TerminalsContext);
  if (!ctx) throw new Error("useTerminals must be used within <TerminalsProvider>");
  return ctx;
}
