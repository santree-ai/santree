/**
 * The embedded terminal host both Reviews sessions render into.
 *
 * `attach` is load-bearing, not a convenience. There is one inline terminal slot
 * app-wide, claimed by whichever host mounted last, and these panes stay *mounted*
 * while hidden (their PTY and checkout must survive a tab switch). Two mounted
 * hosts would mean the hidden one holding the slot and the visible one showing
 * nothing, so only the visible pane attaches. Releasing the claim doesn't touch the
 * session — the layer just stops pointing at this host.
 */
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";

export function ReviewTerminal({
  termKey,
  title,
  cwd,
  seed,
  attach,
  onExited,
}: {
  termKey: string;
  title: string;
  cwd?: string;
  seed?: string;
  attach: boolean;
  onExited: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title, cwd, source: "review", refId: termKey, seed },
    attach,
    onExited,
  });
  return <div ref={hostRef} className="h-full w-full" />;
}
