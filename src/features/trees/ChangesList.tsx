/** The git panel's lists: working-tree changes and untracked files (staging and
 *  discard, the latter behind a confirm dialog — it destroys uncommitted work),
 *  then the files the branch has already committed relative to its base,
 *  read-only. Each is a folding section with a count. Rows are memoized so an
 *  optimistic staging patch doesn't re-render the whole list; see
 *  {@link ChangeRow}/{@link ChangeFolderRow}.
 *
 *  Per-row actions live at the trailing edge and only exist on hover — out of
 *  flow, not merely transparent. A control that is invisible but still holds its
 *  column charges every row for something one row at a time can use, and in a
 *  240px panel that column is the file name's. */
import { memo, type ReactNode, useCallback, useMemo, useState } from "react";

import type { ChangedFile } from "../../bindings";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ListIcon,
  MinusIcon,
  PlusIcon,
  TrashIcon,
  TreeIcon,
  UndoIcon,
} from "../../components/icons";
import { ConfirmDialog, ListSkeleton } from "../../components/primitives";
import {
  TREES_CHANGES_VIEW_KEY,
  useSetSetting,
  useSetting,
  useStageAction,
} from "../../lib/queries";
import { accentActiveStyle } from "../../theme/colors";
import {
  buildChangeTree,
  CHANGE_ROW_WINDOW,
  type ChangeTreeNode,
  dirFlagsOf,
  filesUnder,
  STATUS_META,
  windowRows,
} from "./changeTree";
import { fileIconUrl, folderIconUrl } from "./fileIcons";
import { IndentGuides, ROW_MIN_H, TREE_GROUP } from "./IndentGuides";
import { useTrees } from "./model";

/** One shared empty list rather than a fresh `[]` per render: it is the identity
 *  the memos below key on, and a new array every time re-runs all of them. */
const NO_FILES: ChangedFile[] = [];

/** `files === undefined` means the worktree status hasn't loaded — distinct from
 *  `[]`, which means it loaded and there's nothing to commit. `committed` is the
 *  branch's merge-base diff, loaded separately (undefined until it lands). */
export function ChangesList({
  files,
  committed,
}: {
  files: ChangedFile[] | undefined;
  committed?: ChangedFile[] | undefined;
}) {
  const { repo, activeId, selectedFile, selectedFileScope, selectFile } = useTrees();
  const { mutate: act, mutateAsync: actAsync } = useStageAction(repo, activeId);
  const loading = files === undefined;
  const list = files ?? NO_FILES;
  // One pass for the split and the counter: during a merge conflict this list is
  // thousands of files long and re-arrives on every optimistic staging patch.
  const { tracked, untracked, stagedCount } = useMemo(() => {
    const t: ChangedFile[] = [];
    const u: ChangedFile[] = [];
    let staged = 0;
    for (const f of list) {
      (f.status === "Untracked" ? u : t).push(f);
      if (f.staged) staged += 1;
    }
    return { tracked: t, untracked: u, stagedCount: staged };
  }, [list]);
  const allStaged = list.length > 0 && stagedCount === list.length;
  // The file or folder pending a discard confirmation (discard is destructive —
  // uncommitted work is unrecoverable — so it asks first, like the worktree
  // delete). Only the path is stored; the affected files are derived from the
  // live list at render/confirm time, so a refetch while the dialog is open
  // can't discard against a stale snapshot.
  const [discarding, setDiscarding] = useState<{ path: string; isDir: boolean } | null>(null);
  const discardFile = useCallback(
    (f: ChangedFile) => setDiscarding({ path: f.path, isDir: false }),
    [],
  );
  const discardDir = useCallback((path: string) => setDiscarding({ path, isDir: true }), []);
  const discardTargets = useMemo(() => {
    if (!discarding) return [];
    if (discarding.isDir) return filesUnder(list, discarding.path);
    return list.filter((f) => f.path === discarding.path);
  }, [discarding, list]);
  const discardingUntracked =
    discardTargets.length > 0 && discardTargets.every((f) => f.status === "Untracked");

  // List vs collapsed-folder tree, persisted app-wide (default list).
  const viewSetting = useSetting("app", TREES_CHANGES_VIEW_KEY);
  const { mutate: setSetting } = useSetSetting();
  const tree = viewSetting.data === "tree";
  const setTree = (on: boolean) =>
    setSetting({ scope: "app", key: TREES_CHANGES_VIEW_KEY, value: on ? "tree" : null });

  const onToggle = useCallback(
    (f: ChangedFile) => act({ action: f.staged ? "unstage" : "stage", path: f.path }),
    [act],
  );
  // One `git add <dir>` rather than a call per file: it is git's own meaning of
  // "stage this folder", it takes a single index lock instead of N, and the
  // optimistic patch already moves every listed file beneath the path.
  const onStageDir = useCallback(
    (path: string, staged: boolean) => act({ action: staged ? "stage" : "unstage", path }),
    [act],
  );
  const openWorking = useCallback((path: string) => selectFile(path, "working"), [selectFile]);
  const openBranch = useCallback((path: string) => selectFile(path, "branch"), [selectFile]);
  const workingSelected = selectedFileScope === "working" ? selectedFile : null;
  const branchSelected = selectedFileScope === "branch" ? selectedFile : null;

  const nothing =
    !loading && list.length === 0 && committed !== undefined && committed.length === 0;

  return (
    <>
      {!loading && list.length > 0 && (
        <div className="flex flex-none items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
          <span className="font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
            {stagedCount}/{list.length} staged
          </span>
          <div className="flex items-center gap-1.5">
            <ViewToggle tree={tree} onChange={setTree} />
            <button
              type="button"
              onClick={() => act({ action: allStaged ? "unstageAll" : "stageAll" })}
              className="cursor-pointer rounded-[5px] border border-line-3 bg-input px-2 py-0.5 text-[10.5px] text-muted-2 hover:border-line-strong hover:text-fg-2"
            >
              {allStaged ? "Unstage all" : "Stage all"}
            </button>
          </div>
        </div>
      )}

      <div className={`${TREE_GROUP} min-h-0 flex-1 overflow-y-auto py-1`}>
        {loading ? (
          <ListSkeleton rows={7} />
        ) : nothing ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-muted-3">No changes.</div>
        ) : (
          <>
            {tracked.length > 0 && (
              <Section label="Changes" count={tracked.length}>
                <FileRows
                  files={tracked}
                  tree={tree}
                  selectedFile={workingSelected}
                  onToggle={onToggle}
                  onOpen={openWorking}
                  onDiscard={discardFile}
                  onDiscardDir={discardDir}
                  onStageDir={onStageDir}
                />
              </Section>
            )}
            {untracked.length > 0 && (
              <Section label="Untracked files" count={untracked.length}>
                <FileRows
                  files={untracked}
                  tree={tree}
                  selectedFile={workingSelected}
                  onToggle={onToggle}
                  onOpen={openWorking}
                  onDiscard={discardFile}
                  onDiscardDir={discardDir}
                  onStageDir={onStageDir}
                />
              </Section>
            )}
            {committed === undefined ? (
              <ListSkeleton rows={3} />
            ) : (
              committed.length > 0 && (
                <Section label="Committed on branch" count={committed.length}>
                  <FileRows
                    files={committed}
                    tree={tree}
                    readOnly
                    selectedFile={branchSelected}
                    onOpen={openBranch}
                  />
                </Section>
              )
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={discarding !== null}
        danger
        // Discarding an untracked file has no HEAD to restore it to — it deletes.
        // The dialog has to say which of the two irreversible things this is.
        title={discardingUntracked ? "Delete new files" : "Discard changes"}
        confirmLabel={discardingUntracked ? "Delete" : "Discard"}
        busyLabel={discardingUntracked ? "Deleting…" : "Discarding…"}
        message={
          discarding?.isDir ? (
            <>
              {discardingUntracked ? "Delete" : "Discard your uncommitted changes to"}{" "}
              {discardTargets.length === 1 ? (
                `the 1 ${discardingUntracked ? "new" : "changed"} file`
              ) : (
                <>
                  the {discardTargets.length} {discardingUntracked ? "new" : "changed"} files
                </>
              )}{" "}
              under <span className="font-mono text-fg-2">{discarding.path}/</span>? This can't be
              undone.
            </>
          ) : (
            <>
              {discardingUntracked ? "Delete" : "Discard your uncommitted changes to"}{" "}
              <span className="font-mono text-fg-2">{discarding?.path}</span>? This can't be undone.
            </>
          )
        }
        onConfirm={async () => {
          // Sequential on purpose: each discard is its own validated git call, and
          // a failure stops the run with the untouched remainder intact (the
          // dialog stays open showing the error).
          for (const f of discardTargets) {
            await actAsync({
              action: "discard",
              path: f.path,
              untracked: f.status === "Untracked",
            });
          }
        }}
        onClose={() => setDiscarding(null)}
      />
    </>
  );
}

/** A folding section of the panel: an uppercase label with a count. Open by
 *  default — these lists are short, and the fold is for getting one out of the
 *  way, not for hiding it. */
function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="pb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 pt-2 pb-1 text-left font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase hover:text-fg-2"
      >
        <Chevron size={9} className="flex-none" />
        <span>{label}</span>
        <span className="text-muted-5">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

/** One section's rows, in the flat or the collapsed-folder layout. `readOnly`
 *  drops staging and discard — the committed list is a record, not a queue.
 *
 *  Only the first window of rows is rendered, and "Show more" doubles it: a
 *  merge conflict puts thousands of files in this pane, and rendering all of
 *  them costs a second of blocked UI for rows nobody scrolls to — while a
 *  handful of clicks still reaches the end of the list for anyone who wants it.
 *  The window is on what is *drawn* only; every count in the pane (the section
 *  header, a folder's tally, the staged counter) stays the true total. */
function FileRows({
  files,
  tree,
  readOnly = false,
  selectedFile,
  onToggle,
  onOpen,
  onDiscard,
  onDiscardDir,
  onStageDir,
}: {
  files: ChangedFile[];
  tree: boolean;
  readOnly?: boolean;
  selectedFile: string | null;
  onToggle?: (f: ChangedFile) => void;
  onOpen: (path: string) => void;
  onDiscard?: (f: ChangedFile) => void;
  onDiscardDir?: (path: string) => void;
  onStageDir?: (path: string, staged: boolean) => void;
}) {
  const [limit, setLimit] = useState(CHANGE_ROW_WINDOW);
  const showMore = useCallback(() => setLimit((n) => n * 2), []);

  if (tree) {
    return (
      <ChangesTree
        files={files}
        readOnly={readOnly}
        selectedFile={selectedFile}
        limit={limit}
        onShowMore={showMore}
        onToggle={onToggle}
        onOpen={onOpen}
        onDiscard={onDiscard}
        onDiscardDir={onDiscardDir}
        onStageDir={onStageDir}
      />
    );
  }
  const { shown, hidden } = windowRows(files, limit);
  return (
    <>
      {shown.map((f) => (
        <ChangeRow
          key={f.path}
          file={f}
          readOnly={readOnly}
          selected={f.path === selectedFile}
          onToggle={onToggle}
          onOpen={onOpen}
          onDiscard={onDiscard}
        />
      ))}
      {hidden > 0 && <ShowMoreRow hidden={hidden} onClick={showMore} />}
    </>
  );
}

/** The tail of a windowed section: what the click does on the left, what it is
 *  holding back on the right — the same label/count shape as a section header,
 *  so the number reads as a fact about the list rather than as part of the
 *  button's promise (one click reveals the next window, not all of them). */
function ShowMoreRow({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 ${ROW_MIN_H} px-2.5 text-left font-mono text-[10.5px] text-muted-3 hover:bg-hover hover:text-fg-2`}
    >
      <span>Show more</span>
      <span className="ml-auto flex-none tabular-nums text-muted-5">
        {hidden.toLocaleString()} hidden
      </span>
    </button>
  );
}

/** Segmented list/tree toggle for the changes browser. */
function ViewToggle({ tree, onChange }: { tree: boolean; onChange: (tree: boolean) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {(
        [
          [false, "List", ListIcon],
          [true, "Tree", TreeIcon],
        ] as const
      ).map(([on, label, Icon]) => (
        <button
          key={label}
          type="button"
          onClick={() => onChange(on)}
          title={`${label} view`}
          aria-pressed={tree === on}
          className="flex cursor-pointer items-center rounded-[5px] border px-1.5 py-1"
          style={
            tree === on
              ? accentActiveStyle()
              : { borderColor: "transparent", color: "var(--color-muted-3)" }
          }
        >
          <Icon size={12} />
        </button>
      ))}
    </div>
  );
}

/** The changes tree: collapsed-folder dirs (toggle to expand) + file rows that keep
 *  the full stage/discard/diff affordances of the flat list. Expanded by default
 *  (changes are few); `collapsed` tracks the dirs the user has folded. */
function ChangesTree({
  files,
  readOnly = false,
  selectedFile,
  limit,
  onShowMore,
  onToggle,
  onOpen,
  onDiscard,
  onDiscardDir,
  onStageDir,
}: {
  files: ChangedFile[];
  readOnly?: boolean;
  selectedFile: string | null;
  /** How many *visible* rows to draw — folder rows included, since they are what
   *  the tree costs as much as its files. */
  limit: number;
  onShowMore: () => void;
  onToggle?: (f: ChangedFile) => void;
  onOpen: (path: string) => void;
  onDiscard?: (f: ChangedFile) => void;
  onDiscardDir?: (path: string) => void;
  onStageDir?: (path: string, staged: boolean) => void;
}) {
  const tree = useMemo(() => buildChangeTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleDir = useCallback(
    (path: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    [],
  );

  // What each folder's actions have to say, from the files actually under it: a
  // folder of untracked files can only be *deleted*, and one that is already
  // fully staged offers to take that back.
  const dirFlags = useMemo(() => dirFlagsOf(tree), [tree]);

  const rows = useMemo(() => {
    const out: { node: ChangeTreeNode; depth: number }[] = [];
    const walk = (nodes: ChangeTreeNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ node, depth });
        if (node.kind === "dir" && !collapsed.has(node.path)) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, collapsed]);
  const { shown, hidden } = windowRows(rows, limit);

  return (
    <>
      {shown.map(({ node, depth }) =>
        node.kind === "dir" ? (
          <ChangeFolderRow
            key={node.path}
            name={node.name}
            path={node.path}
            count={node.count}
            depth={depth}
            open={!collapsed.has(node.path)}
            untracked={dirFlags.get(node.path)?.untracked}
            allStaged={dirFlags.get(node.path)?.allStaged}
            onToggle={toggleDir}
            onStage={readOnly ? undefined : onStageDir}
            onDiscard={readOnly ? undefined : onDiscardDir}
          />
        ) : (
          <ChangeRow
            key={node.path}
            file={node.file}
            readOnly={readOnly}
            depth={depth}
            showDir={false}
            selected={node.path === selectedFile}
            onToggle={onToggle}
            onOpen={onOpen}
            onDiscard={onDiscard}
          />
        ),
      )}
      {hidden > 0 && <ShowMoreRow hidden={hidden} onClick={onShowMore} />}
    </>
  );
}

/** The hover-only action cluster at a row's trailing edge.
 *
 *  Absolutely positioned and opaque: it covers the diff counts rather than
 *  pushing them aside, so the row's resting layout never budges and the actions
 *  are where the pointer already is. `focus-within` keeps it reachable by
 *  keyboard, where there is no hover to trigger it. */
function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="absolute inset-y-0 right-0 flex items-center pr-1.5 pl-4 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <span className="flex items-stretch overflow-hidden rounded-md border border-line-2 bg-raised-2">
        {children}
      </span>
    </span>
  );
}

const ROW_ACTION =
  "flex h-[18px] w-6 cursor-pointer items-center justify-center text-muted-2 transition-colors hover:bg-hover hover:text-fg-2";

/** A collapsed-folder row in the changes tree (its `a/b/c` chain + a file count),
 *  with a hover-revealed discard for everything under it. The row is a wrapper
 *  div (not one big button) so the discard control isn't nested inside the
 *  expand/collapse button. */
const ChangeFolderRow = memo(function ChangeFolderRow({
  name,
  path,
  count,
  depth,
  open,
  untracked,
  allStaged,
  onToggle,
  onStage,
  onDiscard,
}: {
  name: string;
  path: string;
  count: number;
  depth: number;
  open: boolean;
  /** Everything under it is untracked, so discarding *deletes* — say so. */
  untracked?: boolean;
  /** Every file under it is already staged, so the action is to take it back. */
  allStaged?: boolean;
  onToggle: (path: string) => void;
  /** Stage (or unstage) everything under it. Absent for a read-only section. */
  onStage?: (path: string, staged: boolean) => void;
  /** Absent for a read-only section (nothing to discard). */
  onDiscard?: (path: string) => void;
}) {
  const leaf = name.slice(name.lastIndexOf("/") + 1);
  const icon = folderIconUrl(leaf, open);
  return (
    <div className={`group relative flex items-center ${ROW_MIN_H} pr-2.5 pl-1.5 hover:bg-hover`}>
      <IndentGuides depth={depth} />
      <button
        type="button"
        onClick={() => onToggle(path)}
        className="flex min-w-0 flex-1 cursor-pointer items-center text-left"
      >
        {/* The real chevron, not a "▾" character: the guide lines are drawn down
            the centre of this slot, and a text glyph sits wherever its font puts
            it inside the box — which is what left the lines beside the arrows
            they belong under rather than beneath them. */}
        <span
          className="flex flex-none items-center justify-center text-muted-2"
          style={{ width: 14 }}
        >
          {open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}
        </span>
        {icon ? (
          <img src={icon} alt="" className="ml-0.5 h-4 w-4 flex-none" draggable={false} />
        ) : null}
        <span className="ml-1.5 min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">
          {name}
        </span>
        <span className="ml-1.5 flex-none font-mono text-[9.5px] text-muted-4">{count}</span>
      </button>
      {(onDiscard || onStage) && (
        <RowActions>
          {onDiscard && (
            <button
              type="button"
              onClick={() => onDiscard(path)}
              aria-label={`${untracked ? "Delete" : "Discard changes under"} ${path}/`}
              title={
                untracked ? `Delete the new files under ${path}/` : `Discard changes under ${path}/`
              }
              className={`${ROW_ACTION} hover:!text-status-red`}
            >
              {untracked ? <TrashIcon size={12} /> : <UndoIcon size={12} />}
            </button>
          )}
          {onStage && (
            <button
              type="button"
              onClick={() => onStage(path, !allStaged)}
              aria-label={`${allStaged ? "Unstage" : "Stage"} everything under ${path}/`}
              title={allStaged ? "Unstage this folder" : "Stage this folder"}
              className={ROW_ACTION}
            >
              {allStaged ? <MinusIcon size={12} /> : <PlusIcon size={12} />}
            </button>
          )}
        </RowActions>
      )}
    </div>
  );
});

/** One file row in the Changes browser (flat list or tree). Memoized so staging/
 *  selecting one file doesn't re-render every other row (the list re-renders on each
 *  optimistic patch). In tree mode it's indented and drops the dir suffix.
 *  `readOnly` (the committed list) has neither staging nor discard.
 *
 *  Staging has no checkbox. A column of them charges every row the same width
 *  forever to say one bit that only the hover actions can change — so the bit
 *  moves into the slot a folder's disclosure arrow already occupies at this
 *  depth, which the row needs for alignment either way, and the control that
 *  flips it joins discard at the trailing edge. */
const ChangeRow = memo(function ChangeRow({
  file: f,
  selected,
  readOnly = false,
  depth = 0,
  showDir = true,
  onToggle,
  onOpen,
  onDiscard,
}: {
  file: ChangedFile;
  selected: boolean;
  readOnly?: boolean;
  /** Indent level when rendered inside the tree (0 in the flat list). */
  depth?: number;
  /** Show the trailing directory path (flat list only — the tree implies it). */
  showDir?: boolean;
  onToggle?: (f: ChangedFile) => void;
  onOpen: (path: string) => void;
  onDiscard?: (f: ChangedFile) => void;
}) {
  const meta = STATUS_META[f.status];
  const dir = f.path.includes("/") ? `${f.path.slice(0, f.path.lastIndexOf("/"))}/` : "";
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  const icon = fileIconUrl(name);
  const staged = !readOnly && f.staged;
  const isUntracked = f.status === "Untracked";
  return (
    <div
      data-active={selected}
      className={`selection-row group relative flex items-center ${ROW_MIN_H} pr-2.5 pl-1.5`}
    >
      <IndentGuides depth={depth} />
      {/* The slot a folder's arrow occupies at this depth — kept empty so names
          line up under their folder, and carrying the staged mark when there is
          one. */}
      <span
        className="flex flex-none items-center justify-center text-[10px] leading-none"
        style={{ width: 14, color: "var(--accent)" }}
        title={staged ? "Staged" : undefined}
      >
        {staged ? "✓" : ""}
      </span>
      <button
        type="button"
        onClick={() => onOpen(f.path)}
        className="ml-0.5 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
      >
        {icon ? <img src={icon} alt="" className="h-4 w-4 flex-none" draggable={false} /> : null}
        {/* The name stays neutral. Status is already said twice at the trailing
            edge — in the counts and in the letter — and a list where every row's
            text is a different hue reads as a warning, not as files. */}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3">
          {name}
          {showDir && dir && <span className="text-muted-4"> {dir}</span>}
        </span>
        {/* A zero side is not a fact worth a column: "+91 −0" reads as two
            numbers where there is one. */}
        <span className="flex flex-none gap-1 font-mono text-[9.5px] tabular-nums">
          {f.addLines > 0 && <span className="text-status-green">+{f.addLines}</span>}
          {f.delLines > 0 && <span className="text-status-red">−{f.delLines}</span>}
        </span>
        <span
          className="flex-none font-mono text-[10px] font-semibold"
          style={{ color: meta.color }}
          title={f.status}
        >
          {meta.letter}
        </span>
      </button>
      {!readOnly && (onDiscard || onToggle) && (
        <RowActions>
          {onDiscard && (
            <button
              type="button"
              onClick={() => onDiscard(f)}
              aria-label={`${isUntracked ? "Delete" : "Discard changes to"} ${f.path}`}
              // Discarding an untracked file deletes it — there is no HEAD to
              // restore. The icon has to say which of the two this is.
              title={isUntracked ? "Delete this new file" : "Discard changes"}
              className={`${ROW_ACTION} hover:!text-status-red`}
            >
              {isUntracked ? <TrashIcon size={12} /> : <UndoIcon size={12} />}
            </button>
          )}
          {onToggle && (
            <button
              type="button"
              onClick={() => onToggle(f)}
              aria-label={`${staged ? "Unstage" : "Stage"} ${f.path}`}
              title={staged ? "Unstage" : "Stage"}
              className={ROW_ACTION}
            >
              {staged ? <MinusIcon size={12} /> : <PlusIcon size={12} />}
            </button>
          )}
        </RowActions>
      )}
    </div>
  );
});
