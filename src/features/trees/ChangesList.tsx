/** The Changes tab of the file picker: a flat list or collapsed-folder tree of
 *  working-tree changes, with staging (checkbox / stage-all) and discard (behind
 *  a confirm dialog — discard is destructive), plus the commit box below the
 *  list. Rows are memoized so an optimistic staging patch doesn't re-render the
 *  whole list; see {@link ChangeRow}/{@link ChangeFolderRow}. */
import { memo, useCallback, useMemo, useState } from "react";

import type { ChangedFile } from "../../bindings";
import { ListIcon, TreeIcon } from "../../components/icons";
import { ConfirmDialog } from "../../components/primitives";
import {
  TREES_CHANGES_VIEW_KEY,
  useSetSetting,
  useSetting,
  useStageAction,
} from "../../lib/queries";
import { accentActiveStyle, alpha } from "../../theme/colors";
import { CommitBox } from "./CommitBox";
import { buildChangeTree, type ChangeTreeNode, STATUS_META } from "./changeTree";
import { fileIconUrl, folderIconUrl } from "./fileIcons";
import { IndentGuides } from "./IndentGuides";
import { useTrees } from "./model";

export function ChangesList({ files }: { files: ChangedFile[] }) {
  const { repo, activeId, selectedFile, selectFile } = useTrees();
  const { mutate: act, mutateAsync: actAsync } = useStageAction(repo, activeId);
  const stagedCount = files.filter((f) => f.staged).length;
  const allStaged = files.length > 0 && stagedCount === files.length;
  // The file pending a discard confirmation (discard is destructive — uncommitted
  // work is unrecoverable — so it asks first, like the worktree delete).
  const [discarding, setDiscarding] = useState<ChangedFile | null>(null);

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

  return (
    <>
      {files.length > 0 && (
        <div className="flex flex-none items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
          <span className="font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
            {stagedCount}/{files.length} staged
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

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {files.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-muted-3">No changes.</div>
        ) : tree ? (
          <ChangesTree
            files={files}
            selectedFile={selectedFile}
            onToggle={onToggle}
            onOpen={selectFile}
            onDiscard={setDiscarding}
          />
        ) : (
          files.map((f) => (
            <ChangeRow
              key={f.path}
              file={f}
              selected={f.path === selectedFile}
              onToggle={onToggle}
              onOpen={selectFile}
              onDiscard={setDiscarding}
            />
          ))
        )}
      </div>

      {/* Keyed per worktree so each gets its own persisted-draft instance. */}
      <CommitBox key={activeId} stagedCount={stagedCount} totalCount={files.length} />

      <ConfirmDialog
        open={discarding !== null}
        danger
        title="Discard changes"
        confirmLabel="Discard"
        busyLabel="Discarding…"
        message={
          <>
            Discard your uncommitted changes to{" "}
            <span className="font-mono text-fg-2">{discarding?.path}</span>? This can't be undone.
          </>
        }
        onConfirm={async () => {
          if (!discarding) return;
          await actAsync({
            action: "discard",
            path: discarding.path,
            untracked: discarding.status === "Untracked",
          });
        }}
        onClose={() => setDiscarding(null)}
      />
    </>
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
  selectedFile,
  onToggle,
  onOpen,
  onDiscard,
}: {
  files: ChangedFile[];
  selectedFile: string | null;
  onToggle: (f: ChangedFile) => void;
  onOpen: (path: string) => void;
  onDiscard: (f: ChangedFile) => void;
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

  return (
    <>
      {rows.map(({ node, depth }) =>
        node.kind === "dir" ? (
          <ChangeFolderRow
            key={node.path}
            name={node.name}
            path={node.path}
            count={node.count}
            depth={depth}
            open={!collapsed.has(node.path)}
            onToggle={toggleDir}
          />
        ) : (
          <ChangeRow
            key={node.path}
            file={node.file}
            depth={depth}
            showDir={false}
            selected={node.path === selectedFile}
            onToggle={onToggle}
            onOpen={onOpen}
            onDiscard={onDiscard}
          />
        ),
      )}
    </>
  );
}

/** A collapsed-folder row in the changes tree (its `a/b/c` chain + a file count). */
const ChangeFolderRow = memo(function ChangeFolderRow({
  name,
  path,
  count,
  depth,
  open,
  onToggle,
}: {
  name: string;
  path: string;
  count: number;
  depth: number;
  open: boolean;
  onToggle: (path: string) => void;
}) {
  const leaf = name.slice(name.lastIndexOf("/") + 1);
  const icon = folderIconUrl(leaf, open);
  return (
    <button
      type="button"
      onClick={() => onToggle(path)}
      className="flex w-full cursor-pointer items-center py-[3px] pr-2.5 pl-1.5 text-left hover:bg-hover"
    >
      <IndentGuides depth={depth} />
      <span
        className="flex flex-none items-center justify-center text-[11px] text-muted-2"
        style={{ width: 14 }}
      >
        {open ? "▾" : "▸"}
      </span>
      {icon ? (
        <img src={icon} alt="" className="ml-0.5 h-4 w-4 flex-none" draggable={false} />
      ) : null}
      <span className="ml-1.5 min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">
        {name}
      </span>
      <span className="ml-1.5 flex-none font-mono text-[9.5px] text-muted-4">{count}</span>
    </button>
  );
});

/** One file row in the Changes browser (flat list or tree). Memoized so staging/
 *  selecting one file doesn't re-render every other row (the list re-renders on each
 *  optimistic patch). In tree mode it's indented and drops the dir suffix. */
const ChangeRow = memo(function ChangeRow({
  file: f,
  selected,
  depth = 0,
  showDir = true,
  onToggle,
  onOpen,
  onDiscard,
}: {
  file: ChangedFile;
  selected: boolean;
  /** Indent level when rendered inside the tree (0 in the flat list). */
  depth?: number;
  /** Show the trailing directory path (flat list only — the tree implies it). */
  showDir?: boolean;
  onToggle: (f: ChangedFile) => void;
  onOpen: (path: string) => void;
  onDiscard: (f: ChangedFile) => void;
}) {
  const meta = STATUS_META[f.status];
  const dir = f.path.includes("/") ? `${f.path.slice(0, f.path.lastIndexOf("/"))}/` : "";
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  const icon = fileIconUrl(name);
  return (
    <div
      className="group flex items-center gap-2 py-[3px] pr-2.5 pl-1.5 hover:bg-hover"
      style={{ background: selected ? alpha(8) : undefined }}
    >
      <IndentGuides depth={depth} />
      <input
        type="checkbox"
        checked={f.staged}
        onChange={() => onToggle(f)}
        className="h-3 w-3 flex-none cursor-pointer accent-[var(--accent)]"
      />
      <button
        type="button"
        onClick={() => onOpen(f.path)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
      >
        {icon ? <img src={icon} alt="" className="h-4 w-4 flex-none" draggable={false} /> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3">
          {name}
          {showDir && dir && <span className="text-muted-4"> {dir}</span>}
        </span>
        <span className="flex-none font-mono text-[9.5px] text-muted-4">
          +{f.addLines} −{f.delLines}
        </span>
        <span
          className="flex-none font-mono text-[10px] font-semibold"
          style={{ color: meta.color }}
          title={f.status}
        >
          {meta.letter}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDiscard(f)}
        title="Discard changes"
        className="flex-none cursor-pointer text-[12px] text-muted-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-status-red"
      >
        ⟲
      </button>
    </div>
  );
});
