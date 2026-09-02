/** The Files pane of the right panel: the full worktree file tree (not just
 *  changes), using Material file icons and tinting changed files by their git
 *  status (VS Code-style). Directories collapse by default (large repos).
 *
 *  Two hosts, so it takes its worktree as props rather than reading the Trees
 *  model: the worktree panel in Trees, and the Reviews rail once a PR has a
 *  local checkout. What differs between them is only where a click lands, which
 *  is what {@link AllFilesList.onOpen} is. */
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { ChevronDownIcon, ChevronRightIcon } from "../../components/icons";
import { ListSkeleton } from "../../components/primitives";
import { BULK_TOGGLE_HINT, isBulkToggle, toggleDisclosure } from "../../lib/disclosure";
import { useWorktreeFiles, useWorktreeStatus } from "../../lib/queries";
import { STATUS_META } from "./changeTree";
import { fileIconUrl, folderIconUrl } from "./fileIcons";
import { IndentGuides, ROW_MIN_H, TREE_GROUP } from "./IndentGuides";

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

/** Every directory at or under `path` — what a ⌘-click on that folder reaches.
 *  Exported for its test: "what's below" is the whole of the gesture's promise,
 *  and getting it wrong either does nothing or unfolds the repo. */
export function subtreeDirs(tree: TreeNode[], path: string): string[] {
  const out: string[] = [];
  const collect = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (!node.dir) continue;
      out.push(node.path);
      collect(node.children);
    }
  };
  const find = (nodes: TreeNode[]): TreeNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      // Only walk into the branch that can contain it — `a/b` lives under `a`.
      if (node.dir && path.startsWith(`${node.path}/`)) return find(node.children);
    }
    return null;
  };
  const root = find(tree);
  if (root?.dir) collect(root.children);
  return out;
}

export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  // `children` stays an array (the render walks it in order), so keep a lookup
  // index alongside it: scanning `children` per segment is quadratic in wide
  // directories, and this re-runs on every worktree-files refetch.
  const index = new Map<string, TreeNode>();
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    let path = "";
    parts.forEach((part, i) => {
      const dir = i < parts.length - 1;
      path = path ? `${path}/${part}` : part;
      const key = `${dir ? "d" : "f"}:${path}`;
      let child = index.get(key);
      if (!child) {
        child = { name: part, path, dir, children: [] };
        index.set(key, child);
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

export function AllFilesList({
  repo,
  worktreeId,
  selectedPath,
  onOpen,
}: {
  repo: string;
  worktreeId: string;
  /** The file the host is showing, marked as selected here. */
  selectedPath: string | null;
  /** Open a file. Optional, and absent is a real state: a host with nowhere to
   *  put a file's contents (the Reviews rail — its main area is the pull
   *  request) leaves it out, and file rows stop being buttons rather than
   *  becoming buttons that do nothing. Directories still fold either way; that
   *  is this pane's own state, not the host's. */
  onOpen?: (path: string) => void;
}) {
  // Undefined until the listing lands — rendered as a skeleton rather than an
  // empty tree, which would claim the worktree has no files. `status` keeps its
  // default: it only tints rows, so "not loaded yet" and "nothing changed" are
  // the same absence of tint.
  const { data: files } = useWorktreeFiles(repo, worktreeId);
  const { data: status = [] } = useWorktreeStatus(repo, worktreeId);
  const tree = useMemo(() => buildTree(files ?? []), [files]);
  // Changed files are tinted by their status (VS Code-style); map path → color.
  const changeColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of status) m.set(f.path, STATUS_META[f.status].color);
    return m;
  }, [status]);
  // Directories collapsed by default (large repos); expand on click.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Read at call time so `onActivate` below keeps one identity — the rows are
  // memoized on it, and a fresh callback per render would re-render all of them.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const toggle = useCallback(
    (path: string, bulk: boolean) =>
      setExpanded((prev) =>
        // The scope is this folder's own subtree, never the whole repo: "expand
        // everything below" in a monorepo is a click that unfolds tens of
        // thousands of rows into a list with no virtualization.
        toggleDisclosure(prev, path, bulk ? subtreeDirs(treeRef.current, path) : [], bulk),
      ),
    [],
  );

  // A single stable activate handler (toggle dir / open file) so the memoized
  // rows below don't get a fresh callback each render and lose their memo.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const onActivate = useCallback(
    (path: string, dir: boolean, bulk: boolean) =>
      dir ? toggle(path, bulk) : openRef.current?.(path),
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
    <div className={`${TREE_GROUP} min-h-0 flex-1 overflow-y-auto py-1`}>
      {files === undefined && <ListSkeleton rows={10} />}
      {files !== undefined && rows.length === 0 && (
        <div className="px-3 py-6 text-center text-[11.5px] text-muted-3">No files.</div>
      )}
      {rows.map((r) => (
        <TreeRow
          key={r.node.path}
          node={r.node}
          depth={r.depth}
          isOpen={r.isOpen}
          selected={r.node.path === selectedPath}
          tint={r.node.dir ? undefined : changeColor.get(r.node.path)}
          openable={!!onOpen}
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
  openable,
  onActivate,
}: {
  node: TreeNode;
  depth: number;
  isOpen: boolean;
  selected: boolean;
  tint: string | undefined;
  /** Whether a file row leads anywhere — see {@link AllFilesList.onOpen}. */
  openable: boolean;
  onActivate: (path: string, dir: boolean, bulk: boolean) => void;
}) {
  const icon = node.dir ? folderIconUrl(node.name, isOpen) : fileIconUrl(node.name);
  // A directory always acts (it folds); a file only where the host can show it.
  const acts = node.dir || openable;
  // No `gap` on the row: the guides have to sit flush against the arrow slot, or
  // every line lands beside the arrow it belongs under (see IndentGuides).
  const className = `selection-row flex w-full items-center ${ROW_MIN_H} pr-2 pl-1.5 text-[12px]`;
  const style = { color: tint ?? (node.dir ? "var(--color-fg-2)" : "var(--color-muted)") };
  const body = (
    <>
      <IndentGuides depth={depth} />
      {/* The real chevron, not a "▾" character — the guide lines run down the
          centre of this slot, and a text glyph sits wherever its font puts it. */}
      <span
        className="flex flex-none items-center justify-center text-muted-2"
        style={{ width: 14 }}
      >
        {node.dir ? isOpen ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} /> : null}
      </span>
      {icon ? (
        <img src={icon} alt="" className="ml-0.5 h-4 w-4 flex-none" draggable={false} />
      ) : (
        <span className="ml-0.5 h-4 w-4 flex-none" />
      )}
      <span className="ml-1.5 truncate">{node.name}</span>
    </>
  );

  // An inert row is a plain div, not a disabled button: nothing here becomes
  // clickable later, so a pressable-looking row would be promising something.
  return acts ? (
    <button
      type="button"
      onClick={(e) => onActivate(node.path, node.dir, isBulkToggle(e))}
      data-active={selected}
      title={node.dir ? `${node.path}\n${BULK_TOGGLE_HINT}` : node.path}
      className={`${className} cursor-pointer`}
      style={style}
    >
      {body}
    </button>
  ) : (
    <div data-active={selected} className={className} style={style}>
      {body}
    </div>
  );
});
