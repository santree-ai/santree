/** The worktree's bottom status bar (VS Code-style): git state, a base-branch menu
 *  (divergence + pull-into-worktree + update-base-from-origin), and the per-worktree
 *  actions (open in editor, run setup, delete) plus the file-picker toggle. Lives at
 *  the bottom of the main content so it stays put regardless of the side panels. */
import { Fragment, useEffect, useState } from "react";

import type { Worktree } from "../../bindings";
import { BranchIcon, ChevronDownIcon, GearIcon, TrashIcon } from "../../components/icons";
import { ConfirmDialog, Dropdown, Spinner } from "../../components/primitives";
import {
  TREES_DEFAULT_EDITOR_KEY,
  useOpeners,
  useOpenInApp,
  usePullWorktree,
  useSetting,
  useUpdateBaseBranch,
} from "../../lib/queries";
import { toast } from "../../state/toast";
import { BASE_ID, useTrees } from "./model";
import { OpenerIcon } from "./openerIcons";

export function BottomBar({ worktree }: { worktree: Worktree }) {
  const { repo, rightCollapsed, toggleRightPanel } = useTrees();
  // The base-branch entry isn't a per-issue worktree: no PR / setup / delete, and
  // it can't pull-into-itself, so it shows just git state + open-in + files.
  const isBase = worktree.id === BASE_ID;

  return (
    <div className="flex h-7 flex-none items-center gap-1 border-t border-line bg-deep pr-1 pl-2 text-[11px] text-muted-2">
      <GitState worktree={worktree} />
      {!isBase && (
        <>
          <Divider />
          <BaseMenu repo={repo} worktree={worktree} />
        </>
      )}

      <div className="flex-1" />

      <OpenInMenu path={worktree.path} />
      <Divider />
      {!isBase && (
        <>
          <PrButton worktree={worktree} />
          <SetupButton worktree={worktree} />
          <DeleteButton worktree={worktree} />
          <Divider />
        </>
      )}
      <button
        type="button"
        onClick={toggleRightPanel}
        title={rightCollapsed ? "Show files (⌘L)" : "Hide files (⌘L)"}
        className="flex h-[22px] cursor-pointer items-center gap-1.5 rounded px-2 hover:bg-hover"
        style={{ color: rightCollapsed ? "var(--color-muted-2)" : "var(--accent)" }}
      >
        <PanelIcon />
        Files
      </button>
    </div>
  );
}

function Divider() {
  return <span className="mx-0.5 h-3.5 w-px flex-none bg-line-3" />;
}

/** "Create PR" — shown only when the branch is ahead of base and has no PR yet.
 *  Opens the create-PR dialog (push + GitHub API happen there). */
function PrButton({ worktree }: { worktree: Worktree }) {
  const { openPrDialog, prsByWorktree } = useTrees();
  const hasPr = (prsByWorktree.get(worktree.id) ?? []).length > 0;
  if (worktree.ahead === 0 || hasPr) return null;
  return (
    <button
      type="button"
      onClick={() => openPrDialog(worktree.id)}
      title="Create a pull request"
      className={ITEM}
    >
      <PrIcon />
      Create PR
    </button>
  );
}

function PrIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="4.5" cy="4" r="1.6" />
      <circle cx="4.5" cy="12" r="1.6" />
      <circle cx="11.5" cy="12" r="1.6" />
      <path d="M4.5 5.6v4.8" />
      <path d="M11.5 10.4V7.4A2.4 2.4 0 0 0 9.1 5H7" />
      <path d="M8.6 3.4 7 5l1.6 1.6" />
    </svg>
  );
}

const ITEM =
  "flex h-[22px] cursor-pointer items-center gap-1.5 rounded px-2 hover:bg-hover hover:text-fg-2";

function GitState({ worktree }: { worktree: Worktree }) {
  return (
    <span className="flex items-center gap-1.5 px-1 font-mono">
      {worktree.dirty ? (
        <span className="text-status-amber">● uncommitted</span>
      ) : (
        <span className="text-muted-4">✓ clean</span>
      )}
    </span>
  );
}

/** The base branch: divergence chip + a menu to pull it into the worktree or to
 *  fast-forward the local base from origin ("update master"). */
function BaseMenu({ repo, worktree }: { repo: string; worktree: Worktree }) {
  const { ahead, behind, baseBranch } = worktree;
  const { mutate: pull, isPending: pulling } = usePullWorktree(repo);
  const { mutate: updateBase, isPending: updating } = useUpdateBaseBranch(repo);
  const canPull = behind > 0;
  const busy = pulling || updating;

  return (
    <Dropdown
      placement="up"
      align="right"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          title={`${ahead} ahead of, ${behind} behind ${baseBranch}`}
          className={`${ITEM} font-mono`}
        >
          {busy ? <Spinner size={11} /> : <BranchIcon size={11} />}
          <span className="max-w-[120px] truncate">{baseBranch}</span>
          {ahead > 0 && <span className="text-status-green">↑{ahead}</span>}
          {behind > 0 && <span className="text-status-amber">↓{behind}</span>}
          <ChevronDownIcon size={10} />
        </button>
      )}
    >
      {(close) => (
        <>
          <button
            type="button"
            disabled={!canPull}
            onClick={() => {
              pull(worktree.id);
              close();
            }}
            className={MENU_ITEM}
          >
            <PullIcon />
            {canPull ? `Pull ${baseBranch} into worktree` : `Up to date with ${baseBranch}`}
          </button>
          <button
            type="button"
            onClick={() => {
              updateBase(worktree.id);
              close();
            }}
            className={MENU_ITEM}
            title={`Fast-forward the local ${baseBranch} branch from origin`}
          >
            <DownloadIcon />
            Update {baseBranch} from origin
          </button>
        </>
      )}
    </Dropdown>
  );
}

function SetupButton({ worktree }: { worktree: Worktree }) {
  const { runSetup } = useTrees();
  return (
    <button
      type="button"
      onClick={() => runSetup(worktree.id)}
      title="Run .santree/init.sh and watch its logs"
      className={ITEM}
    >
      <GearIcon size={12} />
      {worktree.setupRan ? "Re-run setup" : "Run setup"}
    </button>
  );
}

function DeleteButton({ worktree }: { worktree: Worktree }) {
  const { deleteWorktree } = useTrees();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Delete this worktree and its branch"
        className={`${ITEM} hover:!text-status-red`}
      >
        <TrashIcon size={12} />
        Delete
      </button>
      <ConfirmDialog
        open={open}
        danger
        title="Delete worktree"
        confirmLabel="Delete"
        message={
          <>
            Delete the worktree for <span className="font-mono text-fg-2">{worktree.id}</span> and
            its branch <span className="font-mono text-fg-2">{worktree.branch}</span>? Any
            uncommitted changes will be lost.
          </>
        }
        // Optimistic + background: fire and close immediately — the card vanishes
        // now; the git removal runs in the background (rolls back + toasts on error).
        onConfirm={() => {
          deleteWorktree(worktree.id);
          return Promise.resolve();
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

// ── Open in… split button ────────────────────────────────────────────────────

function OpenInMenu({ path }: { path: string }) {
  const { data: openers = [] } = useOpeners();
  const { mutate: openIn } = useOpenInApp();
  const { data: defaultSetting } = useSetting("app", TREES_DEFAULT_EDITOR_KEY);

  // Left half opens the configured default editor (falling back to the first
  // installed editor, else Finder); the chevron opens the full menu.
  const firstEditor = openers.find(
    (o) => o.available && o.key !== "finder" && o.key !== "terminal",
  )?.key;
  const defaultKey = defaultSetting || firstEditor || "finder";
  const defaultLabel = openers.find((o) => o.key === defaultKey)?.label ?? "editor";

  // The full menu in display order: each installed app, then Copy path. Rows are
  // numbered 1..N and selectable by pressing that digit while the menu is open.
  const items: MenuItem[] = [
    ...openers
      .filter((o) => o.available)
      .map((o) => ({
        key: o.key,
        label: o.label,
        run: () => openIn({ path, opener: o.key }),
      })),
    {
      key: "copyPath",
      label: "Copy path",
      run: () => {
        void navigator.clipboard.writeText(path);
        toast.success("Path copied.");
      },
    },
  ];

  return (
    <Dropdown
      placement="up"
      align="right"
      trigger={(toggle) => (
        <div className="flex items-stretch">
          <button
            type="button"
            onClick={() => openIn({ path, opener: defaultKey })}
            title={`Open in ${defaultLabel}`}
            className="flex h-[22px] cursor-pointer items-center gap-1.5 rounded-l px-2 hover:bg-hover"
          >
            <OpenerIcon openerKey={defaultKey} size={14} />
            Open in
          </button>
          <button
            type="button"
            onClick={toggle}
            title="Open in…"
            className="flex h-[22px] w-5 cursor-pointer items-center justify-center rounded-r hover:bg-hover"
          >
            <ChevronDownIcon size={10} />
          </button>
        </div>
      )}
    >
      {(close) => <OpenInMenuItems items={items} close={close} />}
    </Dropdown>
  );
}

type MenuItem = { key: string; label: string; run: () => void };

/** The opener menu rows. Mounted only while the menu is open, so its digit-key
 *  listener (1..N selects a row) is live exactly when the menu is visible. */
function OpenInMenuItems({ items, close }: { items: MenuItem[]; close: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > items.length) return;
      e.preventDefault();
      items[n - 1].run();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, close]);

  return (
    <>
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {item.key === "copyPath" && <div className="my-1 border-t border-line" />}
          <button
            type="button"
            onClick={() => {
              item.run();
              close();
            }}
            className={MENU_ITEM}
          >
            <span className="flex-none text-muted-2">
              <OpenerIcon openerKey={item.key} />
            </span>
            {item.label}
            <span className="ml-auto text-[11px] text-muted-4 tabular-nums">{i + 1}</span>
          </button>
        </Fragment>
      ))}
    </>
  );
}

const MENU_ITEM =
  "flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-fg-3 hover:bg-hover disabled:cursor-default disabled:text-muted-4";

// ── Icons ────────────────────────────────────────────────────────────────────

function PanelIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="10" y1="3" x2="10" y2="13" />
    </svg>
  );
}

function PullIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 2.5v7M5 6.5 8 9.5l3-3M3.5 13h9" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 2v8M4.8 7 8 10.2 11.2 7M3 13h10" />
    </svg>
  );
}
