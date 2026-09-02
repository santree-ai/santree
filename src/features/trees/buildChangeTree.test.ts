import { describe, expect, it } from "vitest";

import type { ChangedFile } from "../../bindings";
import {
  buildChangeTree,
  CHANGE_ROW_WINDOW,
  type ChangeTreeNode,
  changeSubtreeDirs,
  dirFlagsOf,
  filesUnder,
  windowRows,
} from "./changeTree";

/** Minimal ChangedFile for path-shape assertions (status/stats don't matter
 *  here) — except for the folder-flag suite, which is entirely about `status`
 *  and `staged`, so both are overridable. */
function file(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    oldPath: null,
    status: "Modified",
    staged: false,
    addLines: 0,
    delLines: 0,
    binary: false,
    ...over,
  };
}

/** Compact a node tree to `dir(name)[…]` / `name` strings for readable assertions. */
function shape(nodes: ChangeTreeNode[]): unknown {
  return nodes.map((n) =>
    n.kind === "file" ? n.name : { [`${n.name} (${n.path}, ${n.count})`]: shape(n.children) },
  );
}

describe("buildChangeTree", () => {
  it("collapses a single-child directory chain into one a/b/c row", () => {
    const tree = buildChangeTree([file("src/features/trees/deep/Foo.tsx")]);
    expect(shape(tree)).toEqual([
      { "src/features/trees/deep (src/features/trees/deep, 1)": ["Foo.tsx"] },
    ]);
  });

  it("stops collapsing where a directory branches", () => {
    const tree = buildChangeTree([file("src/a/one.ts"), file("src/b/two.ts")]);
    // `src` branches into a and b, so it is NOT merged with either child.
    expect(shape(tree)).toEqual([
      {
        "src (src, 2)": [{ "a (src/a, 1)": ["one.ts"] }, { "b (src/b, 1)": ["two.ts"] }],
      },
    ]);
  });

  it("does not absorb a directory whose only child is a file", () => {
    const tree = buildChangeTree([file("src/Foo.tsx")]);
    expect(shape(tree)).toEqual([{ "src (src, 1)": ["Foo.tsx"] }]);
  });

  it("sorts directories before files, each alphabetically", () => {
    const tree = buildChangeTree([file("z.txt"), file("a.txt"), file("dir/m.ts")]);
    expect(shape(tree)).toEqual([{ "dir (dir, 1)": ["m.ts"] }, "a.txt", "z.txt"]);
  });

  it("counts files across the whole collapsed subtree", () => {
    const tree = buildChangeTree([file("pkg/src/a.ts"), file("pkg/src/sub/b.ts")]);
    // `pkg/src` holds a.ts plus the `sub` dir; its count is 2.
    const top = tree[0];
    expect(top.kind === "dir" && top.name).toBe("pkg/src");
    expect(top.kind === "dir" && top.count).toBe(2);
  });
});

describe("filesUnder", () => {
  const files = [file("src/a.ts"), file("src/deep/b.ts"), file("src2/c.ts"), file("README.md")];

  it("matches files at any depth under the directory", () => {
    expect(filesUnder(files, "src").map((f) => f.path)).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });

  it("respects the path boundary — `src` never captures `src2/`", () => {
    expect(filesUnder(files, "src").some((f) => f.path.startsWith("src2"))).toBe(false);
  });

  it("works with a collapsed-chain path (the tree's full dir path)", () => {
    expect(filesUnder(files, "src/deep").map((f) => f.path)).toEqual(["src/deep/b.ts"]);
  });

  it("returns nothing for a directory with no changed files", () => {
    expect(filesUnder(files, "docs")).toEqual([]);
  });
});

/** The flags behind a folder row's two actions. These used to be read by
 *  rescanning the file list once per directory — O(dirs x files), which is what
 *  made the pane unusable during a merge conflict — so they are pinned against
 *  the answers that scan gave. */
describe("dirFlagsOf", () => {
  const flagsFor = (files: ChangedFile[]) => dirFlagsOf(buildChangeTree(files));

  it("marks a folder untracked only when every file under it is", () => {
    const flags = flagsFor([
      file("new/a.ts", { status: "Untracked" }),
      file("new/b.ts", { status: "Untracked" }),
      file("mixed/a.ts", { status: "Untracked" }),
      file("mixed/b.ts"),
    ]);
    expect(flags.get("new")?.untracked).toBe(true);
    expect(flags.get("mixed")?.untracked).toBe(false);
  });

  it("marks a folder fully staged only when every file under it is", () => {
    const flags = flagsFor([
      file("all/a.ts", { staged: true }),
      file("all/b.ts", { staged: true }),
      file("some/a.ts", { staged: true }),
      file("some/b.ts"),
    ]);
    expect(flags.get("all")?.allStaged).toBe(true);
    expect(flags.get("some")?.allStaged).toBe(false);
  });

  it("folds nested subtrees into the ancestor's flags", () => {
    // The parent's answer has to cover `deep/`, not just the file beside it.
    const flags = flagsFor([
      file("pkg/a.ts", { staged: true }),
      file("pkg/deep/b.ts", { staged: false }),
    ]);
    expect(flags.get("pkg/deep")?.allStaged).toBe(false);
    expect(flags.get("pkg")?.allStaged).toBe(false);
  });

  it("keys the flags by the collapsed-chain path the folder row renders", () => {
    const flags = flagsFor([file("a/b/c/one.ts", { status: "Untracked" })]);
    expect([...flags.keys()]).toEqual(["a/b/c"]);
    expect(flags.get("a/b/c")).toEqual({ untracked: true, allStaged: false });
  });
});

/** What the Changes pane actually draws. A merge conflict makes this list
 *  thousands of rows wide; the window is what keeps the pane responsive, and it
 *  must stay invisible at the sizes the pane normally sees. */
describe("windowRows", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("leaves a list under the limit untouched, down to its identity", () => {
    const input = rows(40);
    const { shown, hidden } = windowRows(input, CHANGE_ROW_WINDOW);
    // Same array, not a copy: it is what the memoized rows are keyed on.
    expect(shown).toBe(input);
    expect(hidden).toBe(0);
  });

  it("does not window a list that exactly fills the limit", () => {
    expect(windowRows(rows(CHANGE_ROW_WINDOW), CHANGE_ROW_WINDOW).hidden).toBe(0);
  });

  it("keeps the leading rows in order and reports the true remainder", () => {
    const { shown, hidden } = windowRows(rows(3000), CHANGE_ROW_WINDOW);
    expect(shown).toHaveLength(CHANGE_ROW_WINDOW);
    expect(shown[0]).toBe(0);
    expect(shown.at(-1)).toBe(CHANGE_ROW_WINDOW - 1);
    // The count behind "Show more" is the whole remainder, never a page of it.
    expect(hidden).toBe(3000 - CHANGE_ROW_WINDOW);
  });

  it("reaches the end of a huge list in a handful of doublings", () => {
    let limit = CHANGE_ROW_WINDOW;
    let clicks = 0;
    while (windowRows(rows(3000), limit).hidden > 0) {
      limit *= 2;
      clicks += 1;
    }
    expect(clicks).toBeLessThanOrEqual(5);
  });
});

/** What a ⌘-click on a folder reaches — that folder's own subtree, never the
 *  whole list. The scope feeds the one rule in `lib/disclosure`; getting it
 *  wrong either does nothing or unfolds a monorepo in a single click. */
describe("changeSubtreeDirs", () => {
  const tree = buildChangeTree([
    file("src/a/one.ts"),
    file("src/a/deep/two.ts"),
    file("src/b/three.ts"),
    file("top.ts"),
  ]);

  it("lists every directory below the one clicked, and none beside it", () => {
    expect(changeSubtreeDirs(tree, "src/a")).toEqual(["src/a/deep"]);
    expect([...changeSubtreeDirs(tree, "src")].sort()).toEqual(["src/a", "src/a/deep", "src/b"]);
  });

  it("has nothing to reach from a leaf folder, a file, or an unknown path", () => {
    expect(changeSubtreeDirs(tree, "src/b")).toEqual([]);
    expect(changeSubtreeDirs(tree, "top.ts")).toEqual([]);
    expect(changeSubtreeDirs(tree, "nope")).toEqual([]);
  });
});
