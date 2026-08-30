import { useRef } from "react";

/**
 * Guards a launch that is several awaits long — creating a worktree, rendering a
 * prompt, opening an agent tab.
 *
 * Every one of those effects is non-idempotent, and a second click before the
 * first resolves would run all of them again: two `git worktree add`s racing one
 * path, two agent tabs on one branch. The guard is a ref rather than state
 * because it must be true *within* the click that took it, before any render.
 *
 * `release()` on the failure path only — a launch that succeeded has navigated
 * away or replaced its own trigger.
 */
export function useLaunchGuard() {
  const running = useRef(false);
  return {
    take: () => {
      if (running.current) return false;
      running.current = true;
      return true;
    },
    release: () => {
      running.current = false;
    },
  };
}
