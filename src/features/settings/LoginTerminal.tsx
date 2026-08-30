/** The in-place login terminal shared by every settings pane that can hand a
 *  sign-in back to the vendor's own CLI (Agents → Claude Code, Integrations →
 *  GitHub).
 *
 *  It is a plain terminal: santree seeds the one human-initiated command and
 *  then only relays keystrokes. Nothing reads the session's output, and no
 *  credential passes through the app — the CLI stores its own (see
 *  COMPLIANCE.md).
 *
 *  Callers own `refId`, which namespaces the session; keep the values distinct
 *  (`login:Claude`, `login:github`, …) or two panes would share one PTY. */

import { CloseIcon } from "../../components/icons";
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";

export function LoginTerminal({
  refId,
  command,
  onClose,
  className = "mt-3",
}: {
  /** Session namespace — unique per login surface. */
  refId: string;
  /** The command seeded into the shell, shown verbatim in the header. */
  command: string;
  /** Fired when the process exits, or when the ✕ tears it down. */
  onClose: () => void;
  /** Layout only — the caller's spacing around the panel. */
  className?: string;
}) {
  // The persistent TerminalLayer overlays the host div below.
  const { hostRef, close } = useEmbeddedTerminal({
    spec: { title: command, source: "shell", refId, seed: command },
    onExited: onClose,
  });

  const closeNow = () => {
    close();
    onClose();
  };

  return (
    <div className={`overflow-hidden rounded-lg border border-line-3 ${className}`}>
      <div className="flex items-center justify-between bg-input px-3 py-2">
        <span className="text-[11.5px] text-muted-2">
          Running <span className="font-mono text-fg-3">{command}</span>
        </span>
        <button
          type="button"
          onClick={closeNow}
          aria-label="Close"
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-3 hover:bg-hover hover:text-fg-2"
        >
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="h-[280px] bg-panel">
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
