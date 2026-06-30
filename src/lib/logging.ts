/**
 * Mirror the browser `console` into `tauri-plugin-log`, so frontend logs land in
 * the same on-disk file as the Rust backend (see `src-tauri/src/lib.rs`
 * `log_plugin`). Each forwarded line is tagged `[webview]` with a timestamp by the
 * plugin, so a user can attach one file when reporting an issue.
 *
 * We keep the original `console` behaviour (devtools still print) and only *also*
 * forward. It's a no-op outside Tauri (e.g. plain `vite` in a browser), where the
 * plugin's invoke isn't available.
 */
import { debug, error, info, warn } from "@tauri-apps/plugin-log";

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

/** `console.log` has no log-level equivalent, so it maps to info. */
const FORWARD: Record<ConsoleLevel, (message: string) => Promise<void>> = {
  log: info,
  info,
  warn,
  error,
  debug,
};

/** Render a console argument as a readable string (Errors keep their stack). */
function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Patch `console.*` to also forward to the log file. Call once, as early as
 * possible (before app code runs). Safe to call when not running under Tauri.
 */
export function forwardConsoleToLog(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;

  for (const level of Object.keys(FORWARD) as ConsoleLevel[]) {
    const original = console[level].bind(console);
    const forward = FORWARD[level];
    console[level] = (...args: unknown[]) => {
      original(...args);
      // Fire-and-forget; never let a logging failure surface to the app (and
      // never route it back through the patched console — that would recurse).
      forward(args.map(stringifyArg).join(" ")).catch(() => {});
    };
  }
}
