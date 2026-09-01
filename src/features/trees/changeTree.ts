/** Shared changed-file helpers: per-status letter/color metadata (used by both
 *  the Changes list and the All-files browser's status tint), the
 *  collapsed-folder tree builder behind the Changes tab's tree view, its
 *  per-folder action flags, and the row window both views render through. */
import type { ChangedFile, FileStatus } from "../../bindings";

export const STATUS_META: Record<FileStatus, { letter: string; color: string }> = {
  Added: { letter: "A", color: "var(--color-status-green)" },
  Modified: { letter: "M", color: "var(--color-status-amber)" },
  Deleted: { letter: "D", color: "var(--color-status-red)" },
  Renamed: { letter: "R", color: "var(--color-status-blue)" },
  Untracked: { letter: "U", color: "var(--color-status-green)" },
};

/** A node in the changed-files tree: a file leaf, or a directory whose
 *  single-child chains are collapsed into one `a/b/c` row (`count` = files under it). */
export type ChangeTreeNode =
  | { kind: "file"; name: string; path: string; file: ChangedFile }
  | { kind: "dir"; name: string; path: string; count: number; children: ChangeTreeNode[] };

/** Every changed file under `dir` — the payload for discarding a whole folder.
 *  Prefix-matched on the path boundary so `src` never captures `src2/…`. */
export function filesUnder(files: ChangedFile[], dir: string): ChangedFile[] {
  return files.filter((f) => f.path.startsWith(`${dir}/`));
}

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

/** What a folder row's actions have to say, from the files actually under it. */
export interface DirFlags {
  /** Everything under it is untracked, so discarding *deletes* — say so. */
  untracked: boolean;
  /** Every file under it is already staged, so the action is to take it back. */
  allStaged: boolean;
}

/** Per-directory action flags for the whole tree, keyed by the node's full path.
 *
 *  Folded bottom-up out of the tree instead of re-scanning the file list once per
 *  directory: that scan was O(dirs x files), which is free for a dozen changes
 *  and half a second of blocked UI for the few thousand a merge conflict leaves
 *  in this pane until `git merge --continue`. The tree is built from the
 *  section's own list, so a folder still answers only for the files listed
 *  beside it — an untracked file in the same folder but in the other section
 *  can't change what this row claims. */
export function dirFlagsOf(nodes: ChangeTreeNode[]): Map<string, DirFlags> {
  const out = new Map<string, DirFlags>();
  // Returns the subtree's own tallies so a parent folds its children in without
  // walking them a second time.
  const walk = (list: ChangeTreeNode[]) => {
    let count = 0;
    let untracked = 0;
    let staged = 0;
    for (const node of list) {
      if (node.kind === "file") {
        count += 1;
        if (node.file.status === "Untracked") untracked += 1;
        if (node.file.staged) staged += 1;
        continue;
      }
      const sub = walk(node.children);
      // A folder that holds nothing must not claim to be untracked *and* fully
      // staged — the vacuous-truth trap the old `every` calls guarded against.
      out.set(node.path, {
        untracked: sub.count > 0 && sub.untracked === sub.count,
        allStaged: sub.count > 0 && sub.staged === sub.count,
      });
      count += sub.count;
      untracked += sub.untracked;
      staged += sub.staged;
    }
    return { count, untracked, staged };
  };
  walk(nodes);
  return out;
}

/** How many rows a changes section renders before it stops and puts the rest
 *  behind a click. Comfortably past the normal scale (a few dozen files), so a
 *  list at that size never sees the affordance at all. */
export const CHANGE_ROW_WINDOW = 100;

/** Cut a row list down to the window, reporting how many it left out.
 *
 *  A merge conflict makes the diff against the base thousands of files wide for
 *  as long as the conflict lasts, and rendering all of them is a second of
 *  blocked UI for rows nobody scrolls to. Under the limit the input array comes
 *  back as-is (same reference, no button) — this must be invisible at the sizes
 *  the pane normally sees. Counts shown elsewhere stay the true totals; this
 *  windows what is rendered, never what is reported. */
export function windowRows<T>(rows: T[], limit: number): { shown: T[]; hidden: number } {
  if (rows.length <= limit) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, limit), hidden: rows.length - limit };
}
