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

/** The tooltip on every action that would change a Daedalus project, or run
 *  something in it, while santree can't reach the box. */
export const OUT_OF_REACH = "Unavailable until santree can reach Daedalus";

/** The same, while it can: santree works a Daedalus project's git and runs its
 *  terminals and setup scripts on the box, but no agents there yet. */
export const DAEDALUS_AGENTS_SOON = "Coming soon for Daedalus projects";

/** Why santree offers no way to change a project's git right now — the link
 *  being down, for a Daedalus project; `undefined` otherwise. */
export function gitOff(remote: boolean, link: DaedalusLink | undefined): string | undefined {
  if (!remote) return undefined;
  return linkUp(link) ? undefined : OUT_OF_REACH;
}

/** Why santree offers no terminal or setup script in a project right now:
 *  they run on the box, so a Daedalus project's are off only while the link
 *  is down. `undefined` for a project on this Mac. */
export function runOff(remote: boolean, link: DaedalusLink | undefined): string | undefined {
  return gitOff(remote, link);
}

/** Why santree offers no agent in a project right now — agents don't run on
 *  Daedalus yet. `undefined` for a project on this Mac. */
export function agentOff(remote: boolean, link: DaedalusLink | undefined): string | undefined {
  if (!remote) return undefined;
  return linkUp(link) ? DAEDALUS_AGENTS_SOON : OUT_OF_REACH;
}

/** Whether `cwd` lies inside one of the Daedalus projects in `repos` — the
 *  frontend's copy of the backend's `repo::on_daedalus`, for the one decision
 *  a pane makes before any byte arrives: whether its bytes are the box's, and
 *  so untrusted (OSC 52 off). Component-wise, like `Path::starts_with`. */
export function onDaedalus(
  repos: readonly { location: string; path: string | null }[] | undefined,
  cwd: string | undefined,
): boolean {
  if (!cwd || !repos) return false;
  return repos.some(
    (r) =>
      r.location === "Daedalus" &&
      r.path !== null &&
      (cwd === r.path || cwd.startsWith(r.path.endsWith("/") ? r.path : `${r.path}/`)),
  );
}
