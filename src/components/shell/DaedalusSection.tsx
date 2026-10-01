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
 * - no Daedalus project registered and no live link: not drawn at all — an
 *   integration this Mac doesn't use has nothing to say in the rail;
 * - linked, nothing added yet: the header and one quiet line pointing at "+";
 * - the link down (no agent, santree off, out of reach…): the section greys,
 *   as Triage does without a tracker, and one line says what to do, linked to
 *   Settings → Daedalus. The rows stay: they still open, since navigating is
 *   not running anything.
 *
 * Its rows' git actions (create, split and delete a worktree) are disabled with
 * the reason while the link is down (`gitOff`); with it up they run on the box.
 *
 * Unknown is not "no": while the status read is in flight the section draws as
 * linked rather than flashing grey at a server that is there.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { gitOff, linkNotice, linkUp } from "../../lib/daedalusLink";
import { useDaedalusStatus, useRepos } from "../../lib/queries";
import { usePersistedState } from "../../lib/usePersistedState";
import { ChevronDownIcon, ChevronRightIcon, DaedalusLogo } from "../icons";
import { DaedalusProjectsDialog } from "./DaedalusProjectsDialog";
import { ProjectTree } from "./ProjectTree";
import { SECTION_HEADER, SectionAddButton } from "./SectionHeader";

export function DaedalusSection() {
  const navigate = useNavigate();
  const { data: repos } = useRepos();
  const { data: link } = useDaedalusStatus();
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = usePersistedState("santree.shell.daedalus.collapsed", false);
  const Chevron = collapsed ? ChevronRightIcon : ChevronDownIcon;

  const hasProjects = repos?.some((repo) => repo.location === "Daedalus") ?? false;
  if (!hasProjects && link?.kind !== "Connected") return null;

  const notice = link && !linkUp(link) ? linkNotice(link) : null;
  const dim = notice ? "opacity-60" : "";

  return (
    <div className="flex flex-none flex-col">
      <div className={SECTION_HEADER}>
        <button
          type="button"
          aria-label={`${collapsed ? "Expand" : "Collapse"} Daedalus`}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className={`-ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left uppercase transition-colors hover:text-fg-2 ${dim}`}
        >
          <Chevron size={10} className="flex-none" />
          <DaedalusLogo size={12} className="flex-none" />
          Daedalus
        </button>
        <SectionAddButton label="Add from Daedalus" onClick={() => setAdding(true)} />
      </div>
      <div hidden={collapsed}>
        {/* Outside the dimming: it is the one thing in a greyed section still
          asking to be read, and a link at 60% is a link nobody sees. */}
        {notice && (
          <button
            type="button"
            onClick={() => navigate({ to: "/settings", search: { section: "daedalus" } })}
            aria-label={`${notice.title}. Open Settings, Daedalus`}
            title={notice.detail ?? undefined}
            className="mx-2.5 mb-0.5 min-w-0 cursor-pointer truncate rounded px-1.5 py-(--density-compact) text-left text-[11px] text-muted-3 underline-offset-2 transition-colors hover:text-fg-2 hover:underline"
          >
            {notice.title}
          </button>
        )}
        <div className={dim}>
          <ProjectTree
            location="Daedalus"
            emptyLabel="No projects yet. Add one with +"
            actionsDisabled={gitOff(true, link)}
          />
        </div>
      </div>
      {adding && <DaedalusProjectsDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
