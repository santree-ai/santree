/** The right-hand file picker: an All files / Changes browser. It only *picks* a
 *  file — clicking one swaps the main area to its diff/contents (see FileViewer).
 *  Resizable (drag the left edge) and collapsible (drag past the threshold or the
 *  bottom-bar "Files" toggle / ⌘L — it hides entirely when collapsed). The Changes
 *  tab also hosts staging + the commit box; the All-files tree uses Material file
 *  icons and tints changed files by status. */
import { memo, useCallback, useMemo, useRef, useState } from "react";

import type { ChangedFile, FileStatus } from "../../bindings";
import { ListIcon, TreeIcon } from "../../components/icons";
import { ConfirmDialog, EdgeResizeHandle, underlineTabStyle } from "../../components/primitives";
import {
  TREES_CHANGES_VIEW_KEY,
  useSetSetting,
  useSetting,
  useStageAction,
  useWorktreeFiles,
  useWorktreeStatus,
} from "../../lib/queries";
import { useEdgeResize } from "../../lib/useEdgeResize";
import { accentActiveStyle, alpha } from "../../theme/colors";
import { CommitBox } from "./CommitBox";
import { fileIconUrl, folderIconUrl } from "./fileIcons";
import { type FileTab, useTrees } from "./model";

const MIN_W = 240;
const MAX_W = 560;
const DEFAULT_W = 320;

const STATUS_META: Record<FileStatus, { letter: string; color: string }> = {
  Added: { letter: "A", color: "var(--color-status-green)" },
  Modified: { letter: "M", color: "var(--color-status-amber)" },
  Deleted: { letter: "D", color: "var(--color-status-red)" },
  Renamed: { letter: "R", color: "var(--color-status-blue)" },
  Untracked: { letter: "U", color: "var(--color-status-green)" },
};

export function FilePickerPanel() {
  const {
    repo,
    activeId,
    fileTab,
    setFileTab,
    rightCollapsed,
    rightWidth,
    setRightWidth,
    toggleRightPanel,
  } = useTrees();
  const { data: status = [] } = useWorktreeStatus(repo, activeId);

  const resize = useEdgeResize({
    cssVar: "--tree-right",
    width: rightWidth,
    min: MIN_W,
    max: MAX_W,
    edge: "left",
    onCommit: setRightWidth,
    collapse: { at: 190, resetTo: DEFAULT_W, onCollapse: toggleRightPanel },
  });

  // Fully hidden when collapsed — the bottom bar's "Files" button (⌘L) brings it
  // back, so there's no need for a leftover strip/arrow.
  if (rightCollapsed) return null;

  return (
    <div
      className="relative flex flex-none flex-col border-l border-line bg-deep"
      style={{ width: `var(--tree-right, ${DEFAULT_W}px)` }}
    >
      <EdgeResizeHandle edge="left" {...resize} />
      <div className="flex h-9 flex-none items-stretch border-b border-line">
        <FileTabButton tab="all" label="All files" active={fileTab} onClick={setFileTab} />
        <FileTabButton
          tab="changes"
          label={`Changes${status.length ? ` · ${status.length}` : ""}`}
          active={fileTab}
          onClick={setFileTab}
        />
      </div>

      {fileTab === "all" ? <AllFilesList /> : <ChangesList files={status} />}
    </div>
  );
}

function FileTabButton({
  tab,
  label,
  active,
  onClick,
}: {
  tab: FileTab;
  label: string;
  active: FileTab;
  onClick: (t: FileTab) => void;
}) {
  const on = active === tab;
  return (
    <button
      type="button"
      onClick={() => onClick(tab)}
      className="flex-1 cursor-pointer border-none text-[11.5px] font-medium"
      style={underlineTabStyle(on)}
    >
      {label}
    </button>
  );
}

// ── Changes list ─────────────────────────────────────────────────────────

/** A node in the changed-files tree: a file leaf, or a directory whose
 *  single-child chains are collapsed into one `a/b/c` row (`count` = files under it). */
export type ChangeTreeNode =
  | { kind: "file"; name: string; path: string; file: ChangedFile }
  | { kind: "dir"; name: string; path: string; count: number; children: ChangeTreeNode[] };

/** Build the changed-files tree, collapsing runs of single-child directories into
 *  one `a/b/c` row (the common case when a change sits deep in an otherwise
 *  untouched subtree). Dirs sort before files, both alphabetically. */
export function buildChangeTree(files: ChangedFile[]): ChangeTreeNode[] {
  interface Raw {
    dirs: Map<string, Raw>;
    files: ChangedFile[];
  }
  const root: Raw = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop(); // the file name; leaves only its directory chain
    let d = root;
    for (const part of parts) {
      let next = d.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        d.dirs.set(part, next);
      }
      d = next;
    }
    d.files.push(f);
  }

  const build = (raw: Raw, prefix: string): ChangeTreeNode[] => {
    const dirs: ChangeTreeNode[] = [];
    for (const [name, sub] of raw.dirs) {
      let display = name;
      let path = prefix ? `${prefix}/${name}` : name;
      let cur = sub;
      // Absorb a chain of lone sub-directories: `a` → `a/b` → `a/b/c`.
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const [childName, childRaw] = [...cur.dirs][0];
        display = `${display}/${childName}`;
        path = `${path}/${childName}`;
        cur = childRaw;
      }
      const children = build(cur, path);
      const count = children.reduce((n, c) => n + (c.kind === "file" ? 1 : c.count), 0);
      dirs.push({ kind: "dir", name: display, path, count, children });
    }
    const fileNodes: ChangeTreeNode[] = raw.files.map((f) => ({
      kind: "file",
      name: f.path.slice(f.path.lastIndexOf("/") + 1),
      path: f.path,
      file: f,
    }));
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    fileNodes.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...fileNodes];
  };
  return build(root, "");
}

function ChangesList({ files }: { files: ChangedFile[] }) {
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
              onToggle={() => onToggle(f)}
              onOpen={() => selectFile(f.path)}
              onDiscard={() => setDiscarding(f)}
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
            count={node.count}
            depth={depth}
            open={!collapsed.has(node.path)}
            onToggle={() => toggleDir(node.path)}
          />
        ) : (
          <ChangeRow
            key={node.path}
            file={node.file}
            depth={depth}
            showDir={false}
            selected={node.path === selectedFile}
            onToggle={() => onToggle(node.file)}
            onOpen={() => onOpen(node.path)}
            onDiscard={() => onDiscard(node.file)}
          />
        ),
      )}
    </>
  );
}

/** A collapsed-folder row in the changes tree (its `a/b/c` chain + a file count). */
const ChangeFolderRow = memo(function ChangeFolderRow({
  name,
  count,
  depth,
  open,
  onToggle,
}: {
  name: string;
  count: number;
  depth: number;
  open: boolean;
  onToggle: () => void;
}) {
  const leaf = name.slice(name.lastIndexOf("/") + 1);
  const icon = folderIconUrl(leaf, open);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2.5 text-left hover:bg-hover"
      style={{ paddingLeft: 10 + depth * 13 }}
    >
      <span className="flex-none text-[8px] text-muted-4" style={{ width: 7 }}>
        {open ? "▾" : "▸"}
      </span>
      {icon ? <img src={icon} alt="" className="h-4 w-4 flex-none" draggable={false} /> : null}
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">{name}</span>
      <span className="flex-none font-mono text-[9.5px] text-muted-4">{count}</span>
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
  onToggle: () => void;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  const meta = STATUS_META[f.status];
  const dir = f.path.includes("/") ? `${f.path.slice(0, f.path.lastIndexOf("/"))}/` : "";
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  const icon = fileIconUrl(name);
  return (
    <div
      className="group flex items-center gap-2 py-[3px] pr-2.5 hover:bg-hover"
      style={{ paddingLeft: 10 + depth * 13, background: selected ? alpha(8) : undefined }}
    >
      <input
        type="checkbox"
        checked={f.staged}
        onChange={onToggle}
        className="h-3 w-3 flex-none cursor-pointer accent-[var(--accent)]"
      />
      <button
        type="button"
        onClick={onOpen}
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
        onClick={onDiscard}
        title="Discard changes"
        className="flex-none cursor-pointer text-[12px] text-muted-4 opacity-0 group-hover:opacity-100 hover:text-status-red"
      >
        ⟲
      </button>
    </div>
  );
});

// ── All-files browser ──────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.dir === !isFile);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), dir: !isFile, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function AllFilesList() {
  const { repo, activeId, selectFile, selectedFile } = useTrees();
  const { data: files = [] } = useWorktreeFiles(repo, activeId);
  const { data: status = [] } = useWorktreeStatus(repo, activeId);
  const tree = useMemo(() => buildTree(files), [files]);
  // Changed files are tinted by their status (VS Code-style); map path → color.
  const changeColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of status) m.set(f.path, STATUS_META[f.status].color);
    return m;
  }, [status]);
  // Directories collapsed by default (large repos); expand on click.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback(
    (path: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    [],
  );

  // A single stable activate handler (toggle dir / open file) so the memoized
  // rows below don't get a fresh callback each render and lose their memo.
  const selectRef = useRef(selectFile);
  selectRef.current = selectFile;
  const onActivate = useCallback(
    (path: string, dir: boolean) => (dir ? toggle(path) : selectRef.current(path)),
    [toggle],
  );

  // Flatten the visible tree to plain descriptors (cheap); `TreeRow` is memoized
  // so unchanged rows skip re-rendering even though this walk re-runs.
  const rows = useMemo(() => {
    const out: { node: TreeNode; depth: number; isOpen: boolean }[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        const isOpen = expanded.has(node.path);
        out.push({ node, depth, isOpen });
        if (node.dir && isOpen) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, expanded]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      {rows.map((r) => (
        <TreeRow
          key={r.node.path}
          node={r.node}
          depth={r.depth}
          isOpen={r.isOpen}
          selected={r.node.path === selectedFile}
          tint={r.node.dir ? undefined : changeColor.get(r.node.path)}
          onActivate={onActivate}
        />
      ))}
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  isOpen,
  selected,
  tint,
  onActivate,
}: {
  node: TreeNode;
  depth: number;
  isOpen: boolean;
  selected: boolean;
  tint: string | undefined;
  onActivate: (path: string, dir: boolean) => void;
}) {
  const icon = node.dir ? folderIconUrl(node.name, isOpen) : fileIconUrl(node.name);
  return (
    <button
      type="button"
      onClick={() => onActivate(node.path, node.dir)}
      className="flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-[12px] hover:bg-hover"
      style={{
        paddingLeft: 8 + depth * 13,
        color: tint ?? (node.dir ? "var(--color-fg-2)" : "var(--color-muted)"),
        background: selected ? alpha(8) : undefined,
      }}
    >
      <span className="flex-none text-[8px] text-muted-4" style={{ width: 7 }}>
        {node.dir ? (isOpen ? "▾" : "▸") : ""}
      </span>
      {icon ? (
        <img src={icon} alt="" className="h-4 w-4 flex-none" draggable={false} />
      ) : (
        <span className="h-4 w-4 flex-none" />
      )}
      <span className="truncate">{node.name}</span>
    </button>
  );
});
