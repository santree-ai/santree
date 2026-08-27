/** The worktree's bottom status bar (VS Code-style): git state, a base-branch menu
 *  (divergence + pull-into-worktree + update-base-from-origin), push/pull, run
 *  setup, delete, and the file-picker toggle. Lives at the bottom of the main
 *  content so it stays put regardless of the side panels.
 *
 *  The two actions you reach for while *looking at* the worktree — Create PR and
 *  Open in… — ride in the worktree header instead, next to the title they act on;
 *  both are exported from here so the two bars can't drift apart. */
import { Fragment, useEffect, useRef, useState } from "react";

import type { Worktree } from "../../bindings";
import {
  BranchIcon,
  ChevronDownIcon,
  DownloadIcon,
  GearIcon,
  PanelIcon,
  PrIcon,
  PullIcon,
  PushIcon,
  TrashIcon,
} from "../../components/icons";
import { ConfirmDialog, Dropdown, MENU_ITEM, Spinner } from "../../components/primitives";
import {
  TREES_DEFAULT_EDITOR_KEY,
  useOpeners,
  useOpenInApp,
  usePullRemoteWorktree,
  usePullWorktree,
  usePushWorktree,
  useResolvedSetting,
} from "../../lib/queries";
import { useDigitShortcuts } from "../../lib/useKeyboardShortcuts";
import { CHROME } from "../../state/AppContext";
import { toast } from "../../state/toast";
import { BASE_ID, useTrees } from "./model";
import { OpenerIcon } from "./openerIcons";

export function BottomBar({ worktree }: { worktree: Worktree }) {
  const { repo, rightCollapsed, toggleRightPanel } = useTrees();
  // The base-branch entry isn't a per-issue worktree: no PR / setup / delete, and
  // it can't pull-into-itself, so it shows just git state + open-in + files.
  const isBase = worktree.id === BASE_ID;
  const showMore = useOverflowFade();

  // The row is a single fixed-height (`h-9`) line: items never wrap or shrink
  // (`whitespace-nowrap` + `flex-none` in ITEM), and anything past the edge is
  // reachable by scrolling horizontally rather than wrapping or spilling out. The
  // right-edge "…" fade appears only when there's more off-screen (`showMore`).
  return (
    <div className={`relative ${CHROME.statusBar} flex-none border-t border-line bg-deep`}>
      <div
        ref={showMore.ref}
        className="flex h-full items-center gap-1 overflow-x-auto overflow-y-hidden pr-1 pl-2 text-[11px] text-muted-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <GitState worktree={worktree} />
        {!isBase && (
          <>
            <Divider />
            <BaseSync repo={repo} worktree={worktree} />
          </>
        )}

        <div className="min-w-2 flex-1" />

        <PullRemoteButton worktree={worktree} />
        <PushButton worktree={worktree} />
        {!isBase && (
          <>
            <SetupButton worktree={worktree} />
            <DeleteButton worktree={worktree} />
            <Divider />
          </>
        )}
        <button
          type="button"
          onClick={toggleRightPanel}
          title={rightCollapsed ? "Show files (⌘L)" : "Hide files (⌘L)"}
          className="flex h-[22px] flex-none cursor-pointer items-center gap-1.5 rounded px-2 whitespace-nowrap hover:bg-hover"
          style={{ color: rightCollapsed ? "var(--color-muted-2)" : "var(--accent)" }}
        >
          <PanelIcon />
          Files
        </button>
      </div>
      {showMore.value && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-1.5 pl-8 text-muted-3"
          style={{ background: "linear-gradient(to left, var(--color-deep) 45%, transparent)" }}
        >
          …
        </div>
      )}
    </div>
  );
}

/** Tracks whether a horizontally-scrollable row has content off its right edge —
 *  drives the "…" fade. Recomputes on resize (ResizeObserver) and on scroll. */
function useOverflowFade() {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setValue(
        el.scrollWidth > el.clientWidth + 1 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      );
    update();
    // ResizeObserver catches width changes; MutationObserver catches actions
    // appearing/disappearing (Push/Pull/PR toggle on git state) — which change the
    // scroll width without resizing the box.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  return { ref, value };
}

function Divider() {
  return <span className="mx-0.5 h-3.5 w-px flex-none bg-line-3" />;
}

/** "Pull" — shown only when the branch's own remote has commits not yet local
 *  (PR-UI suggestions, "Update branch", a teammate's push). Fast-forwards from
 *  origin/<branch> when possible, else merges. Disabled (not hidden) when the pull
 *  would conflict, so the count is still visible but can't be applied automatically
 *  — the tooltip points to resolving it in the worktree. */
function PullRemoteButton({ worktree }: { worktree: Worktree }) {
  const { repo } = useTrees();
  const { mutate: pullRemote, isPending } = usePullRemoteWorktree(repo);
  const n = worktree.remoteBehind;
  if (n === 0) return null;
  const commits = `${n} commit${n === 1 ? "" : "s"}`;
  const conflict = worktree.pullConflict;
  return (
    <button
      type="button"
      onClick={() => pullRemote(worktree.id)}
      disabled={isPending || conflict}
      title={
        conflict
          ? `Pulling ${commits} would conflict with your local changes. Resolve it in the worktree (open Terminal → git merge origin/${worktree.branch})`
          : `Pull ${commits} from origin/${worktree.branch}`
      }
      className={`${ITEM} disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
    >
      {isPending ? <Spinner size={11} /> : <DownloadIcon size={12} />}
      Pull {n}
    </button>
  );
}

/** "Push" — shown only when the branch has commits not yet on its remote. Pushes
 *  to origin (setting upstream); the count resets once the worktree list refetches. */
function PushButton({ worktree }: { worktree: Worktree }) {
  const { repo, suggestPr } = useTrees();
  const { mutate: push, isPending } = usePushWorktree(repo);
  const isBase = worktree.id === BASE_ID;
  const n = worktree.unpushed;
  if (n === 0) return null;
  return (
    <button
      type="button"
      onClick={() =>
        push(worktree.id, isBase ? undefined : { onSuccess: () => suggestPr(worktree.id) })
      }
      disabled={isPending}
      title={`Push ${n} commit${n === 1 ? "" : "s"} to origin`}
      className={ITEM}
    >
      {isPending ? <Spinner size={11} /> : <PushIcon size={12} />}
      Push {n}
    </button>
  );
}

/** "Create PR" — shown only when the branch is ahead of base and has no PR yet.
 *  Opens the create-PR dialog (push + GitHub API happen there). Rendered by the
 *  worktree header. */
export function PrButton({ worktree }: { worktree: Worktree }) {
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

export const ITEM =
  "flex h-[22px] flex-none cursor-pointer items-center gap-1.5 rounded px-2 whitespace-nowrap hover:bg-hover hover:text-fg-2";

function GitState({ worktree }: { worktree: Worktree }) {
  return (
    <span className="flex flex-none items-center gap-1.5 px-1 font-mono whitespace-nowrap">
      {worktree.dirty ? (
        <span className="text-status-amber">● uncommitted</span>
      ) : (
        <span className="text-muted-4">✓ clean</span>
      )}
    </span>
  );
}

/** The base branch: its divergence summary, and one click to pull it into this
 *  worktree. The base here is whatever this worktree branched off — the repo's
 *  main branch for a top-level worktree, the parent worktree's branch for a
 *  stacked one — so the same button restacks either kind.
 *
 *  Syncing the *local base branch itself* from origin is a repo-level action, not
 *  a per-worktree one (it never touches the worktree), so it lives on the sidebar's
 *  base entry instead of being a second item in a menu here. */
function BaseSync({ repo, worktree }: { repo: string; worktree: Worktree }) {
  const { ahead, behind, baseBranch } = worktree;
  const { mutate: pull, isPending: pulling } = usePullWorktree(repo);
  const canPull = behind > 0;

  return (
    <button
      type="button"
      disabled={!canPull || pulling}
      onClick={() => pull(worktree.id)}
      title={
        canPull
          ? `Pull ${baseBranch} into this worktree (${behind} behind, ${ahead} ahead)`
          : `Up to date with ${baseBranch}${ahead > 0 ? ` (${ahead} ahead)` : ""}`
      }
      className={`${ITEM} font-mono disabled:cursor-default disabled:hover:bg-transparent`}
    >
      {pulling ? <Spinner size={11} /> : canPull ? <PullIcon /> : <BranchIcon size={11} />}
      <span className="max-w-[120px] truncate">{baseBranch}</span>
      {ahead > 0 && <span className="text-status-green">↑{ahead}</span>}
      {behind > 0 && <span className="text-status-amber">↓{behind}</span>}
    </button>
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

export function OpenInMenu({
  path,
  placement = "up",
}: {
  path: string;
  /** Which way the menu opens — "down" when the button rides in a header. */
  placement?: "up" | "down";
}) {
  const { repo } = useTrees();
  const { data: openers = [] } = useOpeners();
  const { mutate: openIn } = useOpenInApp();
  // Repo override first, app default second — Settings → Work offers both.
  const { data: defaultSetting } = useResolvedSetting(repo, TREES_DEFAULT_EDITOR_KEY);

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
      placement={placement}
      align="right"
      trigger={(toggle) => (
        <div className="flex flex-none items-stretch">
          <button
            type="button"
            onClick={() => openIn({ path, opener: defaultKey })}
            title={`Open in ${defaultLabel}`}
            className="flex h-[22px] cursor-pointer items-center gap-1.5 rounded-l px-2 whitespace-nowrap hover:bg-hover"
          >
            <OpenerIcon openerKey={defaultKey} size={14} />
            Open in
          </button>
          <button
            type="button"
            onClick={toggle}
            title="Open in…"
            className="flex h-[22px] w-5 flex-none cursor-pointer items-center justify-center rounded-r hover:bg-hover"
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
  useDigitShortcuts(
    items.map((item) => () => {
      item.run();
      close();
    }),
  );

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
