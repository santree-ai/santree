/** Where a link clicked in a terminal opens: in a Web tab of the surface that
 *  terminal belongs to — beside the agent that printed it, in the tab already on
 *  that site if there is one — or, with ⇧ held, in the default browser. */
import { openUrl } from "@tauri-apps/plugin-opener";

import { commands } from "../../bindings";
import { parseTermKey } from "../agents/registry";
import { hostOfSurface } from "./hosts";

/** Asked once: whether this Mac runs Web tabs at all (macOS 14+). */
let supported: Promise<boolean> | null = null;

/** The Web-tab surface a terminal is on, by its key (`tree:<worktree>…`,
 *  `triage:<ticket>…`, `ai-review:<pr>`, `review:<pr>`). */
export function surfaceOf(termKey: string | null | undefined): string | null {
  const origin = parseTermKey(termKey);
  switch (origin.kind) {
    case "tree":
    case "tree-tab":
      return origin.ticket;
    case "triage":
    case "triage-tab":
      return origin.ticket ? `triage:${origin.ticket}` : null;
    case "review":
      return origin.pr ? `review:${origin.pr}` : null;
    case "ai-review":
      return origin.pr ? `ai-review:${origin.pr}` : null;
    default:
      return null;
  }
}

/** Open `url`, clicked in the terminal keyed `termKey`. */
export async function openTerminalLink(
  termKey: string | null | undefined,
  url: string,
  e: MouseEvent,
) {
  const surface = surfaceOf(termKey);
  const host = surface ? hostOfSurface(surface) : undefined;
  supported ??= commands.browserSupported();
  if (e.shiftKey || !host || !isWebPage(url) || !(await supported)) {
    void openUrl(url);
    return;
  }
  host.open(url);
}

function isWebPage(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
