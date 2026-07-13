/** The All-files tab of the file picker: the full worktree file tree (not just
 *  changes), using Material file icons and tinting changed files by their git
 *  status (VS Code-style). Directories collapse by default (large repos). */
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { useWorktreeFiles, useWorktreeStatus } from "../../lib/queries";
import { alpha } from "../../theme/colors";
import { STATUS_META } from "./changeTree";
import { fileIconUrl, folderIconUrl } from "./fileIcons";
import { IndentGuides } from "./IndentGuides";
import { useTrees } from "./model";

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
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

export function AllFilesList() {
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
      className="flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 pl-1.5 text-[12px] hover:bg-hover"
      style={{
        color: tint ?? (node.dir ? "var(--color-fg-2)" : "var(--color-muted)"),
        background: selected ? alpha(8) : undefined,
      }}
    >
      <IndentGuides depth={depth} />
      <span
        className="flex flex-none items-center justify-center text-[11px] text-muted-2"
        style={{ width: 14 }}
      >
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
