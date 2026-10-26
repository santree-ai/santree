/** Each account's two headline windows — Claude's 5-hour and weekly, Codex's
 *  primary and secondary — for the places that meter accounts side by side
 *  (Settings → Agents' account rows, the status bar's account switcher).
 *  Claude's per-model windows stay in the Usage panel: these are a glance. */
import {
  useClaudeAccountUsage,
  useClaudeRateLimits,
  useCodexRateLimits,
} from "../../../lib/queries";
import { claudeWindows, codexWindows, type UsageWindow } from "./usageWindows";

export function useAccountWindows(
  kind: "Claude" | "Codex",
  enabled = true,
): (id: string | null) => UsageWindow[] {
  const fetched = useClaudeAccountUsage();
  const stored = useClaudeRateLimits();
  const codex = useCodexRateLimits(enabled && kind === "Codex");
  return (id) => {
    if (kind === "Codex") return codexWindows(codex.data?.find((a) => a.account === id)?.limits);
    // Anthropic's answer when it has one, the status line's otherwise — the
    // same precedence as the Usage panel's.
    const live = claudeWindows(fetched.data?.find((a) => a.account === id)?.fetch.windows);
    const windows =
      live.length > 0 ? live : claudeWindows(stored.data?.find((a) => a.account === id)?.windows);
    return windows.filter((w) => w.label === "5h" || w.label === "wk");
  };
}
