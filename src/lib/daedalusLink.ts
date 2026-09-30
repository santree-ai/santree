/** What each state of the link to Daedalus says, and what to do about it — one
 *  wording for the sidebar, the add-project dialog and Settings (docs/remote.md).
 *  santree reaches Daedalus only through the Daedalus agent on this Mac, so
 *  every fix is on the agent or in Daedalus, never a field in santree. */

import type { DaedalusLink } from "../bindings";

export type LinkTone = "ok" | "pending" | "warn" | "error";

export interface LinkNotice {
  tone: LinkTone;
  /** The state, or what to do about it, in one line. */
  title: string;
  /** Why, when there is more to say. */
  detail: string | null;
}

export function linkNotice(link: DaedalusLink): LinkNotice {
  switch (link.kind) {
    case "Connected":
      return {
        tone: "ok",
        title: `Connected to ${link.hostname}`,
        detail: [
          `Session host ${link.version}`,
          link.agent && `Daedalus agent ${link.agent}`,
          `Projects in ${link.projectsRoot}`,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    case "Connecting":
      return { tone: "pending", title: "Connecting…", detail: null };
    case "AgentMissing":
      return {
        tone: "error",
        title: "Install the Daedalus agent on this Mac",
        detail: "santree reaches Daedalus through it.",
      };
    case "AgentOutdated":
      return {
        tone: "warn",
        title: "Update the Daedalus agent on this Mac",
        detail: "This version doesn't serve santree yet.",
      };
    case "SantreeOff":
      return {
        tone: "warn",
        title: "Turn on santree for this Mac in Daedalus › Settings › Machines",
        detail: null,
      };
    case "HostKeyChanged":
      return { tone: "error", title: "Daedalus's session host key changed", detail: link.reason };
    case "Unavailable":
      return { tone: "error", title: "Can't reach Daedalus", detail: link.reason };
    case "VersionMismatch":
      return {
        tone: "warn",
        title: "Daedalus speaks another protocol version",
        detail:
          link.theirs === null
            ? "Update santree or Daedalus so they match."
            : `It speaks protocol ${link.theirs}. Update santree or Daedalus so they match.`,
      };
  }
}

/** Whether santree can run anything on Daedalus right now. `undefined` (the
 *  first read in flight) counts as up, so nothing flashes grey at a link that
 *  is there. */
export function linkUp(link: DaedalusLink | undefined): boolean {
  return link === undefined || link.kind === "Connected" || link.kind === "Connecting";
}
