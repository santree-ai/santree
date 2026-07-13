/**
 * Resolve the app's theme preference to a concrete `"light" | "dark"`.
 *
 * `AppContext` writes `data-theme` on `<html>` for CSS, but components that hand
 * a theme to a third-party widget (e.g. the diff viewer, xterm) need the
 * resolved value in JS — and need to re-render when "auto" follows the OS.
 */
import { useEffect, useState } from "react";

import { useApp } from "../state/AppContext";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function useResolvedTheme(): "light" | "dark" {
  const { theme } = useApp();
  const [systemLight, setSystemLight] = useState(() => window.matchMedia(LIGHT_QUERY).matches);

  useEffect(() => {
    if (theme !== "auto") return;
    const mq = window.matchMedia(LIGHT_QUERY);
    // Re-read on re-entry: while the preference wasn't "auto" we weren't
    // listening, so the OS may have flipped since we last saw it.
    setSystemLight(mq.matches);
    const onChange = () => setSystemLight(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  if (theme === "auto") return systemLight ? "light" : "dark";
  return theme;
}
