/**
 * True once `condition` has held, without a break, for `ms`. Any render where it
 * is false resets the wait.
 *
 * For a signal that is only worth a word when it lasts: a server start that is
 * ordinarily over in a moment, a terminal that ordinarily answers at once.
 */
import { useEffect, useState } from "react";

export function useHeldFor(condition: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!condition) return;
    const t = setTimeout(() => setHeld(true), ms);
    return () => {
      clearTimeout(t);
      setHeld(false);
    };
  }, [condition, ms]);
  // `held` is reset by the cleanup a render late; the condition is not.
  return condition && held;
}
