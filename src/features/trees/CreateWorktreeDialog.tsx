/**
 * "Create worktree" — the sidebar's manual way into a worktree, for work that
 * isn't a Linear ticket.
 *
 * Everything on it is one of two questions: **what does this worktree start
 * from**, and **what does it stack on**.
 *
 *  - *Project* is shown, not asked: you opened this from a project's header, so
 *    the answer is already given. Displaying it is what makes the modal legible
 *    out of context; making it a control would be a choice with one option.
 *  - *Source* is a ticket or a branch. Branch covers both halves of the same
 *    gesture — pick one that exists, or type a name that doesn't and create it —
 *    because to the user that is one search box, not two modes.
 *  - *Parent worktree* is santree's existing **stacked worktree**: the new tree's
 *    base becomes the parent's branch instead of the repo's default. No second
 *    notion of nesting, just the base (see `createArgsFor`).
 *
 * Failures that are knowable up front are disabled, not attempted: a branch git
 * already holds a worktree for, and a name `git check-ref-format` would refuse,
 * each carry their reason as the control's tooltip rather than arriving later as
 * a red toast. The ones that aren't knowable stay *here* — the dialog holds
 * itself open on an error so the name can be fixed where it was typed, which is
 * also why it doesn't close (or plant a "Creating…" placeholder) before the
 * create lands.
 *
 * Portaled to `document.body` above the terminal layer (z-index 30) — mounted in
 * place it would paint *behind* a running terminal.
 */
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentKind, Task, Worktree } from "../../bindings";
import { RepoAvatar } from "../../components/chrome/RepoAvatar";
import { BranchIcon, LinearLogo, SearchIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Button, Segmented, Spinner, useModalA11y } from "../../components/primitives";
import {
  useCreateWorktree,
  useRepoBranches,
  useResolvedSetting,
  useTasks,
  useWorktrees,
  WORK_AGENT_KEY,
} from "../../lib/queries";
import { shortRepoName } from "../../lib/repoName";
import { useLaunchGuard } from "../../lib/useLaunchGuard";
import { useApp, useAppUi } from "../../state/AppContext";
import { accentActiveStyle, alpha } from "../../theme/colors";
import { branchPickerRows, createArgsFor, type WorktreeChoice } from "./createWorktree";
import { NO_PROJECT } from "./model";

type SourceTab = "linear" | "branch";

/** Shared field label — the modal's rows read as one column of questions. */
const LABEL = "w-[110px] flex-none pt-1.5 text-[11px] font-medium text-muted-2";

/** Shared text-field chrome (both search boxes). */
const FIELD =
  "w-full rounded-lg border border-line-3 bg-input py-1.5 pr-2.5 pl-7 text-[12.5px] text-fg-2 outline-none placeholder:text-muted-4 focus:border-line-strong";

export function CreateWorktreeDialog({ repo, onClose }: { repo: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { settings } = useApp();
  const { requestTreeFocus } = useAppUi();

  const [tab, setTab] = useState<SourceTab>("linear");
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<WorktreeChoice | null>(null);
  // The source results float over the fields below rather than sitting in the
  // flow: an always-open list reserves its height whether or not anyone is
  // choosing, which pushed Parent worktree and the buttons down the dialog.
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: tasks = [], isLoading: tasksLoading } = useTasks(repo);
  const { data: branches = [], isLoading: branchesLoading } = useRepoBranches(
    repo,
    tab === "branch",
  );
  const { data: worktrees = [] } = useWorktrees(repo);
  const { data: workAgent } = useResolvedSetting(repo, WORK_AGENT_KEY);
  const { mutate: create, isPending } = useCreateWorktree({ silent: true });
  const guard = useLaunchGuard();

  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useModalA11y({ open: true, busy: isPending, onClose, dialogRef, initialFocusRef: searchRef });

  // A ticket whose worktree already exists would only re-open that worktree, so
  // it stays listed — with its reason — rather than silently missing.
  const started = useMemo(() => new Set(worktrees.map((w) => w.id)), [worktrees]);
  const ticketRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter(
      (t) => t.id.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle),
    );
  }, [tasks, query]);
  const branchRows = useMemo(() => branchPickerRows(branches, query), [branches, query]);

  const parent = worktrees.find((w) => w.id === parentId) ?? null;
  const args = choice ? createArgsFor(choice, parent?.branch ?? null) : null;

  const onCreate = () => {
    if (!args || isPending || !guard.take()) return;
    setError(null);
    const agent = (workAgent as AgentKind | null) ?? settings?.defaultAgent ?? "Claude";
    create(
      { ...args, repo, agent },
      {
        onSuccess: (wt) => {
          navigate({ to: "/trees", search: { project: repo, tree: wt.id } });
          requestTreeFocus(repo, wt.id);
          onClose();
        },
        onError: (e) => {
          guard.release();
          setError(e instanceof Error ? e.message : String(e));
        },
      },
    );
  };

  const switchTab = (next: SourceTab) => {
    setTab(next);
    setQuery("");
    setChoice(null);
  };

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => !isPending && onClose()}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[3px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-label="Create worktree"
        className="relative flex w-[540px] max-w-full flex-col rounded-xl border border-line-3 bg-panel p-4 shadow-2xl"
        style={{ animation: "toastIn .16s ease-out" }}
      >
        <div className="text-[13px] font-semibold text-fg-bright">Create worktree</div>

        {/* Given, not asked: you opened this from this project's header. */}
        <div className="mt-3.5 flex items-start">
          <span className={LABEL}>Project</span>
          <div className="flex min-w-0 flex-1 items-center gap-2 pt-1">
            <RepoAvatar repo={repo} size={16} bordered={false} />
            <span className="truncate text-[12.5px] text-fg-2">{shortRepoName(repo)}</span>
          </div>
        </div>

        <div className="mt-3 flex items-start">
          <span className={LABEL}>Source</span>
          <div className="min-w-0 flex-1">
            <Segmented
              className="w-[220px]"
              value={tab}
              onChange={switchTab}
              options={[
                { value: "linear", label: "Linear", icon: <LinearLogo size={11} /> },
                { value: "branch", label: "Branch", icon: <BranchIcon size={11} /> },
              ]}
            />
            <div ref={sourceRef} className="relative mt-2">
              <div className="relative">
                <SearchIcon
                  size={12}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-4"
                />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSourceOpen(true);
                  }}
                  // Opened by the user, not by the autofocus this dialog does on
                  // mount: focus alone would greet them with the very list that
                  // is supposed to stay out of the way until they ask for it.
                  onClick={() => setSourceOpen(true)}
                  // Escape closes the *list* first and only reaches the modal
                  // once it is shut — otherwise dismissing the suggestions
                  // throws away everything the user typed along with them.
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && sourceOpen) {
                      e.stopPropagation();
                      setSourceOpen(false);
                    }
                  }}
                  // Close only when focus leaves the whole control — the rows
                  // keep focus in the field (`keepFocus`), so a pointer pick
                  // must not read as leaving.
                  onBlur={(e) => {
                    if (!sourceRef.current?.contains(e.relatedTarget as Node | null)) {
                      setSourceOpen(false);
                    }
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={sourceOpen}
                  aria-controls="create-worktree-source-list"
                  aria-label={tab === "linear" ? "Search tickets" : "Search or name a branch"}
                  placeholder={tab === "linear" ? "Search tickets…" : "Search or name a branch…"}
                  className={FIELD}
                />
              </div>
              {sourceOpen && (
                <div
                  id="create-worktree-source-list"
                  role="listbox"
                  className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-line-3 bg-popover px-1 py-1 shadow-xl"
                >
                  {tab === "linear" ? (
                    <TicketRows
                      rows={ticketRows}
                      loading={tasksLoading}
                      started={started}
                      choice={choice}
                      onPick={setChoice}
                    />
                  ) : (
                    <BranchRows
                      rows={branchRows}
                      loading={branchesLoading}
                      choice={choice}
                      onPick={setChoice}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-start">
          <span className={LABEL}>Parent worktree</span>
          <div className="min-w-0 flex-1">
            <ParentPicker worktrees={worktrees} value={parent} onChange={setParentId} />
          </div>
        </div>

        {error && (
          <div
            className="selectable mt-3 rounded-md px-2.5 py-1.5 text-[11px] leading-[1.45]"
            style={{
              color: "var(--color-status-red)",
              background: alpha(10, "var(--color-status-red)"),
              border: `1px solid ${alpha(30, "var(--color-status-red)")}`,
            }}
          >
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onCreate}
            disabled={!args || isPending}
            title={args ? undefined : "Pick a ticket or a branch first"}
          >
            {isPending ? (
              <>
                <Spinner size={11} color="var(--on-accent)" /> Creating…
              </>
            ) : (
              "Create worktree"
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One row in either picker. A disabled row keeps its place and carries the
 *  reason — a failure that is knowable up front is explained, not hidden. */
function Row({
  selected,
  disabled,
  hint,
  keepFocus = false,
  onPick,
  children,
}: {
  selected: boolean;
  /** Why this row can't be picked; renders it disabled with this as the tooltip. */
  disabled?: string | null;
  /** Tooltip for a row that *is* pickable. */
  hint?: string;
  /** Don't take focus off whatever has it (see {@link ParentPicker}). */
  keepFocus?: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
      disabled={!!disabled}
      title={disabled ?? hint}
      aria-pressed={selected}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors enabled:hover:bg-hover disabled:cursor-default disabled:opacity-45"
      style={selected ? accentActiveStyle() : undefined}
    >
      {children}
    </button>
  );
}

function TicketRows({
  rows,
  loading,
  started,
  choice,
  onPick,
}: {
  rows: Task[];
  loading: boolean;
  started: Set<string>;
  choice: WorktreeChoice | null;
  onPick: (choice: WorktreeChoice) => void;
}) {
  if (loading) return <Hint>Loading tickets…</Hint>;
  if (rows.length === 0) return <Hint>No tickets match.</Hint>;
  return (
    <div className="px-1">
      {rows.map((t) => (
        <Row
          keepFocus
          key={t.id}
          selected={choice?.kind === "ticket" && choice.id === t.id}
          disabled={started.has(t.id) ? "This ticket already has a worktree" : null}
          onPick={() =>
            onPick({
              kind: "ticket",
              id: t.id,
              title: t.title,
              project: t.project === NO_PROJECT ? null : t.project,
            })
          }
        >
          <span className="flex-none font-mono text-[10.5px] text-muted-3">{t.id}</span>
          <MarkdownTitle className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">
            {t.title}
          </MarkdownTitle>
        </Row>
      ))}
    </div>
  );
}

function BranchRows({
  rows,
  loading,
  choice,
  onPick,
}: {
  rows: ReturnType<typeof branchPickerRows>;
  loading: boolean;
  choice: WorktreeChoice | null;
  onPick: (choice: WorktreeChoice) => void;
}) {
  const { available, taken, create } = rows;
  if (loading) return <Hint>Loading branches…</Hint>;
  if (!create && available.length === 0 && taken.length === 0)
    return <Hint>No branches yet — type a name to create one.</Hint>;
  return (
    <div className="px-1">
      {create && (
        <Row
          keepFocus
          selected={choice?.kind === "new" && choice.branch === create.name}
          disabled={create.reason}
          onPick={() => onPick({ kind: "new", branch: create.name })}
        >
          <BranchIcon size={11} className="flex-none text-muted-4" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">
            Create new branch <span className="font-mono text-[11.5px]">{create.name}</span>
          </span>
        </Row>
      )}
      {available.map((b) => (
        <Row
          keepFocus
          key={b.name}
          selected={choice?.kind === "existing" && choice.branch === b.name}
          hint={b.remoteOnly ? "On origin only — checking it out tracks it locally" : undefined}
          onPick={() => onPick({ kind: "existing", branch: b.name })}
        >
          <BranchIcon size={11} className="flex-none text-muted-4" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3">
            {b.name}
          </span>
          {b.remoteOnly && <span className="flex-none text-[10px] text-muted-4">origin</span>}
        </Row>
      ))}
      {taken.map((b) => (
        <Row
          keepFocus
          key={b.name}
          selected={false}
          disabled="Already checked out in a worktree"
          onPick={() => {}}
        >
          <BranchIcon size={11} className="flex-none text-muted-4" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3">
            {b.name}
          </span>
          <span className="flex-none text-[10px] text-muted-4">in use</span>
        </Row>
      ))}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div className="px-3 py-3 text-[11.5px] text-muted-3">{children}</div>;
}

/**
 * The parent-worktree selector: a filter box over the repo's worktrees, with
 * "No parent" (branch off the repo's default) first and selected by default.
 * Picking one makes the new tree *stacked* on it — its base becomes that
 * worktree's branch.
 */
function ParentPicker({
  worktrees,
  value,
  onChange,
}: {
  worktrees: Worktree[];
  value: Worktree | null;
  onChange: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const matches = worktrees.filter(
    (w) =>
      !needle ||
      w.id.toLowerCase().includes(needle) ||
      w.title.toLowerCase().includes(needle) ||
      w.branch.toLowerCase().includes(needle),
  );

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  // Closed, the field shows the current selection, not a query — so opening it
  // also clears whatever the last filter was, and the box starts as an empty
  // search over every worktree.
  const openList = () => {
    if (open) return;
    setQuery("");
    setOpen(true);
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <SearchIcon
          size={12}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-4"
        />
        <input
          value={open ? query : value ? value.title || value.id : "No parent"}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          // Opened by the user, not by focus — same rule as the source field
          // above. Focus-to-open meant the modal greeted the user with this
          // list dropped over the fields it sits under.
          onClick={openList}
          // Escape closes the *list* first and only reaches the modal once it
          // is shut, so dismissing the suggestions doesn't discard the dialog.
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          // Close only when focus leaves the whole control: tabbing onto a row
          // must not dismiss the row being tabbed to. The rows themselves never
          // take focus (`keepFocus`), so a pointer pick keeps the field active.
          onBlur={(e) => {
            if (!boxRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="create-worktree-parent-list"
          aria-label="Parent worktree"
          placeholder="No parent"
          className={FIELD}
        />
      </div>
      {open && (
        <div
          id="create-worktree-parent-list"
          role="listbox"
          className="absolute z-10 mt-1 max-h-44 w-full overflow-y-auto rounded-lg border border-line-3 bg-popover px-1 py-1 shadow-xl"
        >
          <Row keepFocus selected={value === null} onPick={() => pick(null)}>
            <span className="text-[12.5px] text-fg-3">No parent</span>
            <span className="ml-auto flex-none text-[10.5px] text-muted-4">repo default</span>
          </Row>
          {matches.map((w) => {
            // What you pick by is the worktree's name; the branch is how you
            // tell two similar ones apart. So the name leads in the ticket
            // rows' own weight and the branch trails, capped and truncated —
            // uncapped, a long ref took the row and squeezed the name to a
            // letter.
            const name = w.title || w.id;
            return (
              <Row
                keepFocus
                key={w.id}
                selected={value?.id === w.id}
                hint={name === w.branch ? name : `${name}\n${w.branch}`}
                onPick={() => pick(w.id)}
              >
                <MarkdownTitle className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">
                  {name}
                </MarkdownTitle>
                {/* A branch-sourced worktree is named after its branch; printing
                    it twice is noise, not detail. */}
                {name !== w.branch && (
                  <span className="max-w-[45%] flex-none truncate font-mono text-[10.5px] text-muted-4">
                    {w.branch}
                  </span>
                )}
              </Row>
            );
          })}
          {matches.length === 0 && <Hint>No worktrees match.</Hint>}
        </div>
      )}
    </div>
  );
}
