/**
 * The app's front door, in the two places the window has nothing to show.
 *
 * The sidebar already lists everything there is to open, so this pane's job is
 * not to duplicate it as a grid of cards. It says what to do next and the handful
 * of keys worth knowing on day one. Everything else is one click away in the rail
 * beside it.
 *
 * Without `workspace`: no worktree is picked. Register a repo, or start a ticket.
 * `/` redirects here (see `routes/index.tsx`): the workspace is the landing
 * route, so there is no separate home view to keep in step with this one.
 *
 * With `workspace`: one *is* picked and it has no tabs open — every one closed,
 * or none ever opened. The same surface, minus its own drag strip (the tab bar
 * above owns that one), offering the plainest thing that bar can open.
 *
 * It wears the app's own icon and settles in top to bottom (`.welcome-in`): this
 * is the first thing a new install shows, and it should look like the app that
 * was just installed, not like a placeholder for one.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";

import {
  BranchIcon,
  FolderPlusIcon,
  SantreeAppIcon,
  StarIcon,
  TerminalIcon,
} from "../../components/icons";
import { Spinner } from "../../components/primitives";
import { Kbd } from "../../components/ShortcutsOverlay";
import { AddProjectPrompt } from "../../components/shell/AddProjectPrompt";
import { useAddProject } from "../../components/shell/useAddProject";
import { REPO } from "../../lib/links";
import { useAppUi } from "../../state/AppContext";
import { StartTaskButton } from "./StartTaskButton";

/** The keys that pay for themselves on the first day. Deliberately short: a
 *  welcome screen that lists every binding teaches none of them — ⌘/ opens the
 *  full sheet, and it is the last row here. Inside a workspace the first row is
 *  the one that undoes the ✕ that got you here. */
const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "Find anything", keys: ["⌘", "K"] },
  { label: "Toggle the sidebar", keys: ["⌘", "B"] },
  { label: "Toggle the side panel", keys: ["⌘", "L"] },
  { label: "All keyboard shortcuts", keys: ["⌘", "/"] },
];
const WORKSPACE_SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "New tab", keys: ["⌘", "T"] },
  ...SHORTCUTS,
];

/** Both front-door actions wear the same shape — neither one is the primary. */
const ACTION =
  "flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-2 bg-raised px-4 text-[13px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-60";

const LINK =
  "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-4 transition-colors hover:text-fg-2";

/** One block of the surface, arriving `delay` ms after the one above it. */
function Enter({
  delay,
  className = "",
  children,
}: {
  delay: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`welcome-in ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

export function WelcomeSurface({ workspace }: { workspace?: { onOpenTerminal: () => void } }) {
  const flow = useAddProject();
  const { toggleShortcuts } = useAppUi();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto bg-app pb-8">
      {/* On the front door no tab bar mounts over this surface, so it carries its
          own drag strip — the window must stay grabbable along the top like every
          other view. In a workspace the tab bar above is already that strip, and a
          second one would just push the content down. */}
      {workspace === undefined && (
        <div data-tauri-drag-region className="h-[46px] w-full flex-none" />
      )}
      <div className="flex w-full max-w-[400px] flex-1 flex-col items-center justify-center gap-8 px-8">
        <div className="flex flex-col items-center gap-4">
          <Enter delay={0}>
            <SantreeAppIcon size={64} className="drop-shadow-[0_10px_24px_rgba(7,21,19,.28)]" />
          </Enter>
          <Enter delay={80} className="flex flex-col items-center gap-1.5">
            <h1 className="text-[20px] font-semibold tracking-[-.02em] text-fg-bright">santree</h1>
            <p className="max-w-[300px] text-center text-[13px] leading-[1.5] text-muted-3">
              {workspace
                ? "Nothing is open here. Start a terminal, or pick up an agent from Session history."
                : "Pick a worktree in the sidebar, or start one from a ticket."}
            </p>
          </Enter>
        </div>

        <Enter delay={160} className="flex flex-wrap items-center justify-center gap-2.5">
          {workspace ? (
            <button type="button" onClick={workspace.onOpenTerminal} className={ACTION}>
              <TerminalIcon size={15} />
              Open terminal
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={flow.addProject}
                disabled={flow.isPending}
                className={ACTION}
              >
                {flow.isPending ? <Spinner size={13} /> : <FolderPlusIcon size={15} />}
                Add project
              </button>
              <StartTaskButton
                trigger={(toggle, busy) => (
                  <button type="button" onClick={toggle} disabled={busy} className={ACTION}>
                    {busy ? <Spinner size={13} /> : <BranchIcon size={15} />}
                    Create worktree
                  </button>
                )}
              />
            </>
          )}
        </Enter>

        {workspace === undefined && <AddProjectPrompt flow={flow} className="w-full" />}

        <Enter delay={240} className="w-full">
          <dl className="flex w-full flex-col">
            {(workspace ? WORKSPACE_SHORTCUTS : SHORTCUTS).map(({ label, keys }) => (
              <div
                key={label}
                className="flex items-center gap-3 border-t border-hairline py-2 first:border-t-0"
              >
                <dt className="flex-1 text-[12.5px] text-muted-3">{label}</dt>
                <dd className="flex flex-none gap-1">
                  {keys.map((k) => (
                    <Kbd key={k} token={k} />
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </Enter>
      </div>

      {/* Two quiet links, not a call to action: the full shortcut sheet (a
          welcome screen shouldn't be the only place the keys are written) and
          the project's home. */}
      <Enter delay={320} className="flex flex-none items-center gap-1 pt-6">
        <button type="button" onClick={toggleShortcuts} className={LINK}>
          Keyboard shortcuts
        </button>
        <span aria-hidden className="text-muted-5">
          ·
        </span>
        <button
          type="button"
          onClick={() => openUrl(REPO)}
          title="santree on GitHub"
          className={LINK}
        >
          <StarIcon size={12} />
          Star on GitHub
        </button>
      </Enter>
    </div>
  );
}
