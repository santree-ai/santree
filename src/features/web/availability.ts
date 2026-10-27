/** Whether a Web tab can open — asked by every strip's "+" menu. */
import { useBrowserSupported } from "../../lib/queries";

/** Why a Web tab can't open in a project, if it can't: this Mac's WebKit is too
 *  old, or the project is on Daedalus, whose pages must be browsed from the box —
 *  which santree can't do yet. Opening one from this Mac instead would quietly
 *  put `localhost` on the wrong machine. */
export function useWebOff(remote: boolean): string | undefined {
  const supported = useBrowserSupported().data;
  if (remote) return "Web tabs can't browse from Daedalus yet";
  if (supported === false) return "Web tabs need macOS 14 or later";
  return undefined;
}
