/**
 * What a tab's content knows about the split group it is drawn in. Provided by
 * `SplitWorkspace` around each tab's content; `null` outside a split workspace
 * (the Settings login terminal, a test), where nothing needs it.
 */
import { createContext, useContext } from "react";

export interface SplitPane {
  /** The tab is its group's active one, so it is on screen. */
  visible: boolean;
  /** …and its group is the focused one: the keyboard's, ⌘F's. */
  focused: boolean;
  /** Make this tab's group the focused one — for content that receives the
   *  user's press somewhere its group can't see (a terminal, drawn by the
   *  terminal layer rather than inside its host). */
  activate: () => void;
}

export const SplitPaneContext = createContext<SplitPane | null>(null);

export function useSplitPane(): SplitPane | null {
  return useContext(SplitPaneContext);
}
