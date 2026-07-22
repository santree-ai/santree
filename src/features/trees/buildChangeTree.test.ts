import { describe, expect, it } from "vitest";

import type { ChangedFile } from "../../bindings";
import { buildChangeTree, type ChangeTreeNode, filesUnder } from "./changeTree";

/** Minimal ChangedFile for path-shape assertions (status/stats don't matter here). */
function file(path: string): ChangedFile {
  return {
    path,
    oldPath: null,
    status: "Modified",
    staged: false,
    addLines: 0,
    delLines: 0,
    binary: false,
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
