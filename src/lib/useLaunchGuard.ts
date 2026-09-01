import { useCallback, useMemo, useRef, useState } from "react";

export interface LaunchGuard {
  /** A launch taken by this guard is still in flight. Render the trigger busy off
   *  this — never off the ref, which changes without a render. */
  pending: boolean;
  /** Claim the guard for this click. `false` means one is already running. */
  take: () => boolean;
  /** Hand it back — on success *and* on failure, or the trigger stays stuck. */
  release: () => void;
}

/**
 * Guards a launch that is several awaits long — creating a worktree, rendering a
 * prompt, opening an agent tab.
 *
 * Every one of those effects is non-idempotent, and a second click before the
 * first resolves would run all of them again: two `git worktree add`s racing one
 * path, two agent tabs on one branch.
 *
 * Both a ref and a state, and it needs to be both. The ref is the one that
 * *guards*: it must read true within the click that took it, before any render,
 * which is exactly what state cannot do. The state is the one that *shows* — a
 * ref changing re-renders nothing, so for as long as this was a ref alone no
 * trigger could look busy and every one of these launches was several silent
 * seconds of a button that still said "Start".
 */
export function useLaunchGuard(): LaunchGuard {
  const running = useRef(false);
  const [pending, setPending] = useState(false);

  const take = useCallback(() => {
    if (running.current) return false;
    running.current = true;
    setPending(true);
    return true;
  }, []);

  const release = useCallback(() => {
    running.current = false;
    setPending(false);
  }, []);

  return useMemo(() => ({ pending, take, release }), [pending, take, release]);
}
