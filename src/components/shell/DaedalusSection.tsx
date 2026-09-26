/**
 * The sidebar's Daedalus section: the projects that live on the user's home
 * server (docs/remote.md), a peer of TRIAGE and PROJECTS.
 *
 * The body is the project tree itself, over the Daedalus repos — the same rows,
 * folds and selection PROJECTS has, so a project does the same things wherever
 * it lives. The section is what says where that is, which is why no row carries
 * a mark of its own.
 *
 * States, none of them a toast (being away from home is normal):
 * - not set up, and no Daedalus project registered: not drawn at all — an
 *   integration you never configured has nothing to say in the rail;
 * - set up, nothing added yet: the header and one quiet line pointing at "+";
 * - out of reach (anything but `ApiReachable`): the section greys, as Triage
 *   does without a tracker, and one line says what to do, linked to Settings →
 *   Daedalus. The rows stay: they still open, since navigating is not running
 *   anything, but every action that would run on the server is disabled.
 *
 * Unknown is not "no": while the config read is in flight the section waits,
 * and while the status read is in flight it draws as reachable rather than
 * flashing grey at a server that is there.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { DaedalusReach } from "../../bindings";
import { useDaedalusConfig, useDaedalusStatus, useRepos } from "../../lib/queries";
import { DaedalusLogo } from "../icons";
import { DaedalusProjectsDialog } from "./DaedalusProjectsDialog";
import { ProjectTree } from "./ProjectTree";
import { SECTION_HEADER, SectionAddButton } from "./SectionHeader";

/** The tooltip on every action the section disables while out of reach. */
const OUT_OF_REACH = "Unavailable until santree can reach Daedalus";

/** What to do about a reach that isn't `ApiReachable`, in one line; `null` when
 *  there is nothing to do. */
function reachHint(reach: DaedalusReach): string | null {
  switch (reach.kind) {
    case "ApiReachable":
      return null;
    case "ApiUnreachable":
      return "Connect to your home network or VPN";
    case "Unauthorized":
      return "Daedalus refused the token";
    case "NotConfigured":
      return "Daedalus isn't connected";
  }
}

export function DaedalusSection() {
  const navigate = useNavigate();
  const { data: repos } = useRepos();
  const { data: config } = useDaedalusConfig();
  const { data: reach } = useDaedalusStatus();
  const [adding, setAdding] = useState(false);

  const hasProjects = repos?.some((repo) => repo.location === "Daedalus") ?? false;
  // `config` is `undefined` while its read is in flight and `null` once it says
  // nothing is saved: both keep an empty section off the rail.
  if (!hasProjects && !config) return null;

  const hint = reach ? reachHint(reach) : null;
  const dim = hint ? "opacity-60" : "";

  return (
    <div className="flex flex-none flex-col">
      <div className={`${SECTION_HEADER} ${dim}`}>
        <DaedalusLogo size={12} className="flex-none" />
        Daedalus
        <SectionAddButton label="Add from Daedalus" onClick={() => setAdding(true)} />
      </div>
      {/* Outside the dimming: it is the one thing in a greyed section still
          asking to be read, and a link at 60% is a link nobody sees. */}
      {hint && (
        <button
          type="button"
          onClick={() => navigate({ to: "/settings", search: { section: "daedalus" } })}
          aria-label={`${hint}. Open Settings, Daedalus`}
          title={reach?.kind === "ApiUnreachable" ? reach.reason : undefined}
          className="mx-2.5 mb-0.5 min-w-0 cursor-pointer truncate rounded px-1.5 py-(--density-compact) text-left text-[11px] text-muted-3 underline-offset-2 transition-colors hover:text-fg-2 hover:underline"
        >
          {hint}
        </button>
      )}
      <div className={dim}>
        <ProjectTree
          location="Daedalus"
          emptyLabel="No projects yet. Add one with +"
          actionsDisabled={hint ? OUT_OF_REACH : undefined}
        />
      </div>
      {adding && <DaedalusProjectsDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
