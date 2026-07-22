/** Shared changed-file helpers: per-status letter/color metadata (used by both
 *  the Changes list and the All-files browser's status tint) and the
 *  collapsed-folder tree builder behind the Changes tab's tree view. */
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
