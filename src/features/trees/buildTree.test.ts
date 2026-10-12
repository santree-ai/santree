import { describe, expect, it } from "vitest";

import { buildTree, type TreeNode } from "./AllFilesList";

/** Compact a node tree to `dir(path)[…]` / `name` strings for readable assertions. */
function shape(nodes: TreeNode[]): unknown {
  return nodes.map((n) => (n.dir ? { [`${n.name} (${n.path})`]: shape(n.children) } : n.name));
}

describe("buildTree", () => {
  it("nests files under their directories, with full paths on every node", () => {
    // One node per directory, however many files sit under it.
    expect(shape(buildTree(["src/lib/a.ts", "src/b.ts", "src/c.ts", "README.md"]))).toEqual([
      {
        "src (src)": [{ "lib (src/lib)": ["a.ts"] }, "b.ts", "c.ts"],
      },
      "README.md",
    ]);
  });

  it("keeps a file and a directory of the same name apart", () => {
    // `dist` is both a file and a directory here — they must not collapse.
    expect(shape(buildTree(["dist/app.js", "dist"]))).toEqual([
      { "dist (dist)": ["app.js"] },
      "dist",
    ]);
  });

  it("sorts directories before files, each alphabetically", () => {
    expect(shape(buildTree(["z.txt", "a.txt", "zz/m.ts", "aa/m.ts"]))).toEqual([
      { "aa (aa)": ["m.ts"] },
      { "zz (zz)": ["m.ts"] },
      "a.txt",
      "z.txt",
    ]);
  });

  it("handles a wide directory (the case the O(1) child index exists for)", () => {
    const files = Array.from({ length: 5000 }, (_, i) => `node_modules/pkg-${i}/index.js`);
    const tree = buildTree(files);
    expect(tree[0].name).toBe("node_modules");
    expect(tree[0].children).toHaveLength(5000);
    // Sorted, and each package dir holds exactly its own file.
    expect(tree[0].children[0].name).toBe("pkg-0");
    expect(tree[0].children[0].children.map((c) => c.path)).toEqual([
      "node_modules/pkg-0/index.js",
    ]);
  });
});
