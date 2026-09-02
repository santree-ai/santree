/**
 * The file tree's one host-dependent decision: whether a file row leads
 * anywhere. Trees swaps its main area to the file; the Reviews rail has no
 * general file viewer to land a click in — and a row that looks pressable and
 * does nothing is worse than one that never claimed to be.
 *
 * Folding is not part of that: it is the pane's own state, so it works in both.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/queries", () => ({
  useWorktreeFiles: () => ({ data: ["src/a.ts", "README.md"] }),
  useWorktreeStatus: () => ({ data: [] }),
}));

import { AllFilesList, buildTree, subtreeDirs } from "./AllFilesList";

/** The row for `name`, whether or not it is a button. */
const row = (name: string) => screen.getByText(name);

describe("AllFilesList", () => {
  it("hands a file click to its host and folds directories itself", () => {
    const onOpen = vi.fn();
    render(<AllFilesList repo="acme/app" worktreeId="AK-1" selectedPath={null} onOpen={onOpen} />);

    fireEvent.click(row("README.md"));
    expect(onOpen).toHaveBeenCalledWith("README.md");

    expect(screen.queryByText("a.ts")).toBeNull();
    fireEvent.click(row("src"));
    fireEvent.click(row("a.ts"));
    expect(onOpen).toHaveBeenCalledWith("src/a.ts");
  });

  // The Reviews rail's wiring: no opener, so a file name is text.
  it("renders file names as text when the host has nowhere to show one", () => {
    render(<AllFilesList repo="acme/app" worktreeId="AK-1" selectedPath={null} />);

    expect(row("README.md").closest("button")).toBeNull();
    // …and the tree is still a tree: directories fold on the pane's own state.
    expect(row("src").closest("button")).not.toBeNull();
    fireEvent.click(row("src"));
    expect(screen.getByText("a.ts")).toBeTruthy();
  });
});

/** What a ⌘-click on a folder reaches — that folder's own subtree. Scoped
 *  rather than "every folder in the repo" because this list has no
 *  virtualization: one click would otherwise render a monorepo. */
describe("subtreeDirs", () => {
  const tree = buildTree(["src/a/one.ts", "src/a/deep/two.ts", "src/b/three.ts", "top.ts"]);

  it("lists every directory below the one clicked, and none beside it", () => {
    expect(subtreeDirs(tree, "src/a")).toEqual(["src/a/deep"]);
    expect([...subtreeDirs(tree, "src")].sort()).toEqual(["src/a", "src/a/deep", "src/b"]);
  });

  it("has nothing to reach from a leaf folder, a file, or an unknown path", () => {
    expect(subtreeDirs(tree, "src/b")).toEqual([]);
    expect(subtreeDirs(tree, "top.ts")).toEqual([]);
    expect(subtreeDirs(tree, "nope")).toEqual([]);
  });
});
