/**
 * What the window shows before a worktree is picked — the app's front door.
 *
 * The sidebar already lists everything there is to open, so this pane's job is
 * not to duplicate it as a grid of cards. It says what to do when the sidebar is
 * empty (register a repo), what to do when it isn't (start a ticket), and the
 * handful of keys worth knowing on day one. Everything else about a workspace is
 * one click away in the rail beside it.
 *
 * `/` redirects here (see `routes/index.tsx`): the workspace is the landing
 * route, so there is no separate home view to keep in step with this one.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

import { BranchIcon, FolderPlusIcon, StarIcon, TreeIcon } from "../../components/icons";
import { Spinner } from "../../components/primitives";
import { Kbd } from "../../components/ShortcutsOverlay";
import { AddProjectPrompt } from "../../components/shell/AddProjectPrompt";
import { useAddProject } from "../../components/shell/useAddProject";
import { REPO } from "../../lib/links";
import { useAppUi } from "../../state/AppContext";
import { StartTaskButton } from "./StartTaskButton";

/** The keys that pay for themselves on the first day. Deliberately short: a
 *  welcome screen that lists every binding teaches none of them — ⌘/ opens the
 *  full sheet, and it is the last row here. */
const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "Find anything", keys: ["⌘", "K"] },
  { label: "Toggle the sidebar", keys: ["⌘", "B"] },
  { label: "Toggle the side panel", keys: ["⌘", "L"] },
  { label: "All keyboard shortcuts", keys: ["⌘", "/"] },
];

/** Both front-door actions wear the same shape — neither one is the primary. */
const ACTION =
  "flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-2 bg-raised px-4 text-[13px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-60";

export function WelcomeSurface() {
  const flow = useAddProject();
  const { toggleShortcuts } = useAppUi();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto pb-10">
      {/* No tab bar mounts over this surface, so it carries its own drag strip —
          the window must stay grabbable along the top like every other view. */}
      <div data-tauri-drag-region className="h-[46px] w-full flex-none" />
      <div className="flex w-full max-w-[420px] flex-1 flex-col items-center justify-center gap-7 px-8">
        <div className="flex flex-col items-center gap-3">
          <span className="flex h-14 w-14 items-center justify-center rounded-[16px] border border-line-2 bg-raised text-accent">
            <TreeIcon size={26} />
          </span>
          <h1 className="text-[22px] font-semibold tracking-[-.02em] text-fg-bright">santree</h1>
          <p className="text-center text-[13px] text-muted-3">
            Select a workspace from the sidebar to begin.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2.5">
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
        </div>

        <AddProjectPrompt flow={flow} className="w-full" />

        <dl className="flex w-full flex-col gap-2">
          {SHORTCUTS.map(({ label, keys }) => (
            <div key={label} className="flex items-center gap-3">
              <dt className="flex-1 text-[12.5px] text-muted-3">{label}</dt>
              <dd className="flex flex-none gap-1">
                {keys.map((k) => (
                  <Kbd key={k} token={k} />
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex flex-none items-center gap-2 pt-8">
        {/* The keyboard route to the full sheet, next to the list that trails
            off — a welcome screen shouldn't be the only place they're written. */}
        <button
          type="button"
          onClick={toggleShortcuts}
          className="flex h-8 cursor-pointer items-center rounded-full px-3 text-[12px] text-muted-4 transition-colors hover:text-fg-2"
        >
          Shortcuts
        </button>
        <button
          type="button"
          onClick={() => openUrl(REPO)}
          title="santree on GitHub"
          className="flex h-8 cursor-pointer items-center gap-2 rounded-full border border-[color:var(--color-status-amber)]/40 px-4 text-[12.5px] font-medium text-status-amber transition-colors hover:bg-[color:var(--color-status-amber)]/10"
        >
          <StarIcon size={13} />
          Star on GitHub
        </button>
      </div>
    </div>
  );
}
