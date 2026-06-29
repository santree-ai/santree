/** The right-hand file picker: an All files / Changes browser. It only *picks* a
 *  file — clicking one swaps the main area to its diff/contents (see FileViewer).
 *  Resizable (drag the left edge) and collapsible (drag past the threshold or the
 *  bottom-bar "Files" toggle / ⌘L — it hides entirely when collapsed). The Changes
 *  tab also hosts staging + the commit box; the All-files tree uses Material file
 *  icons and tints changed files by status. */
import { memo, useCallback, useMemo, useRef, useState } from "react";

import type { ChangedFile, FileStatus } from "../../bindings";
import { ConfirmDialog, underlineTabStyle } from "../../components/primitives";
import { useStageAction, useWorktreeFiles, useWorktreeStatus } from "../../lib/queries";
import { useEdgeResize } from "../../lib/useEdgeResize";
import { alpha } from "../../theme/colors";
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
      <div
        {...resize}
        className="absolute top-0 left-[-3px] z-20 h-full w-1.5 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
        aria-hidden
      />
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

function ChangesList({ files }: { files: ChangedFile[] }) {
  const { repo, activeId, selectedFile, selectFile } = useTrees();
  const { mutate: act, mutateAsync: actAsync } = useStageAction(repo, activeId);
  const stagedCount = files.filter((f) => f.staged).length;
  const allStaged = files.length > 0 && stagedCount === files.length;
  // The file pending a discard confirmation (discard is destructive — uncommitted
  // work is unrecoverable — so it asks first, like the worktree delete).
  const [discarding, setDiscarding] = useState<ChangedFile | null>(null);

  return (
    <>
      {files.length > 0 && (
        <div className="flex flex-none items-center justify-between border-b border-line px-2.5 py-1.5">
          <span className="font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
            {stagedCount}/{files.length} staged
          </span>
          <button
            type="button"
            onClick={() => act({ action: allStaged ? "unstageAll" : "stageAll" })}
            className="cursor-pointer rounded-[5px] border border-line-3 bg-input px-2 py-0.5 text-[10.5px] text-muted-2 hover:border-line-strong hover:text-fg-2"
          >
            {allStaged ? "Unstage all" : "Stage all"}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {files.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-muted-3">No changes.</div>
        ) : (
          files.map((f) => (
            <ChangeRow
              key={f.path}
              file={f}
              selected={f.path === selectedFile}
              onToggle={() => act({ action: f.staged ? "unstage" : "stage", path: f.path })}
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

/** One row in the Changes list. Memoized so staging/selecting one file doesn't
 *  re-render every other row (the list re-renders on each optimistic patch). */
const ChangeRow = memo(function ChangeRow({
  file: f,
  selected,
  onToggle,
  onOpen,
  onDiscard,
}: {
  file: ChangedFile;
  selected: boolean;
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
      className="group flex items-center gap-2 px-2.5 py-[3px] hover:bg-hover"
      style={selected ? { background: alpha(8) } : undefined}
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
          {dir && <span className="text-muted-4"> {dir}</span>}
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
