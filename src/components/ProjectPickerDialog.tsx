/**
 * "Which project?" — the modal an action asks through when it needs a project
 * and nothing has settled one: a triage ticket with no project to run on, a
 * ticket that more than one project could start.
 *
 * A list of the registered projects the way the sidebar draws them, avatar and
 * short name with the path beneath, because picking one is recognising a mark,
 * not reading a path — the whole registry, or just the projects the asker
 * names. Clicking a row picks it; so does Enter on the focused one, and the
 * arrows walk the list. The project the ticket already runs on — its own pick,
 * or the default — starts focused and marked, so Enter alone keeps things as
 * they are.
 *
 * One switch beside the list: make the pick the default — for triage or for
 * work, whichever asked, in the asker's own words. Off by default, the way the
 * worktree gate's setup toggle is: an answer to "this ticket needs a project"
 * is not yet a decision about every other ticket.
 *
 * Chrome matches {@link CreateWorktreeDialog} — the same portal, scrim and card
 * — rather than importing it: that dialog is a form with its own state, and
 * this is a picker.
 */
import { type KeyboardEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useRepos } from "../lib/queries";
import { shortRepoName } from "../lib/repoName";
import { accentActiveStyle } from "../theme/colors";
import { RepoAvatar } from "./chrome/RepoAvatar";
import { BranchIcon } from "./icons";
import { Button, Toggle, useModalA11y } from "./primitives";

/** The toggle's accessible name lives in the row's own text, so the switch and
 *  the words that explain it are one control to a screen reader. */
const DEFAULT_LABEL_ID = "project-picker-default-label";
const TITLE_ID = "project-picker-title";

export function ProjectPickerDialog({
  title,
  action,
  explain,
  current,
  repos: only,
  defaultToggle,
  onPick,
  onCancel,
}: {
  title: string;
  /** Named in the sentence, so it reads: "Investigating with Codex needs a project." */
  action: string;
  /** What follows that sentence: what the pick is used for. */
  explain: string;
  /** The project the ticket runs on today, marked and focused first. */
  current: string | null;
  /** Offer only these registered projects (a ticket several carry offers just
   *  those). Absent, the whole registry. */
  repos?: string[];
  /** The "make this the default" switch's words — whose default it becomes,
   *  and what that means. */
  defaultToggle: { label: string; hint: string };
  onPick: (repo: string, asDefault: boolean) => void;
  onCancel: () => void;
}) {
  const { data: registered = [] } = useRepos();
  const repos = only ? registered.filter((r) => only.includes(r.name)) : registered;
  const [asDefault, setAsDefault] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialRef = useRef<HTMLButtonElement>(null);
  useModalA11y({ open: true, onClose: onCancel, dialogRef, initialFocusRef: initialRef });

  // Focus lands on the current project, else the first row — the one Enter
  // would pick, so it is the one to look at.
  const initialIndex = Math.max(
    0,
    repos.findIndex((r) => r.name === current),
  );

  /** Arrows walk the rows; the ends clamp rather than wrap, like every other
   *  list in the app. Rows are buttons, so Enter and Space already click. */
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=option]"));
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    rows[next]?.focus();
  };

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[3px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-labelledby={TITLE_ID}
        className="relative flex w-[440px] max-w-full flex-col gap-3 rounded-xl border border-line-3 bg-panel p-4 shadow-2xl"
        style={{ animation: "toastIn .16s ease-out" }}
      >
        <div className="flex items-center gap-2">
          <BranchIcon size={13} className="flex-none text-muted-3" />
          <h2 id={TITLE_ID} className="text-[13px] font-medium text-fg">
            {title}
          </h2>
        </div>

        <p className="text-[12px] leading-[1.55] text-muted-2">
          {action} needs a project. {explain}
        </p>

        <div
          role="listbox"
          aria-label="Projects"
          onKeyDown={onListKeyDown}
          className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-lg border border-hairline bg-raised p-1"
        >
          {repos.length === 0 && (
            <div className="px-3 py-3 text-[11.5px] text-muted-3">
              No projects registered yet. Add one in Settings first.
            </div>
          )}
          {repos.map((repo, i) => {
            const selected = repo.name === current;
            return (
              <button
                key={repo.name}
                ref={i === initialIndex ? initialRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                title={repo.name}
                onClick={() => onPick(repo.name, asDefault)}
                onKeyDown={(e) => {
                  // Enter is handled here rather than left to the button's own
                  // click so a pick and the click can't both fire from one key.
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  onPick(repo.name, asDefault);
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
                style={selected ? accentActiveStyle() : undefined}
              >
                <RepoAvatar repo={repo.name} size={16} bordered={false} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-fg-2">
                    {shortRepoName(repo.name)}
                  </span>
                  {repo.path && (
                    <span className="block truncate font-mono text-[10.5px] text-muted-4">
                      {repo.path}
                    </span>
                  )}
                </span>
                {selected && <span className="flex-none text-[10px] text-muted-4">current</span>}
              </button>
            );
          })}
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-hairline bg-raised px-3 py-2.5">
          <span className="mt-px flex-none">
            <Toggle
              on={asDefault}
              onClick={() => setAsDefault((on) => !on)}
              ariaLabelledBy={DEFAULT_LABEL_ID}
            />
          </span>
          <span className="min-w-0">
            <span id={DEFAULT_LABEL_ID} className="block text-[12px] leading-4 text-fg-2">
              {defaultToggle.label}
            </span>
            <span className="block text-[10.5px] leading-[1.45] text-muted-4">
              {defaultToggle.hint}
            </span>
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-0.5">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
