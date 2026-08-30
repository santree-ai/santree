/**
 * The changes list's loading contract: `undefined` (status not fetched yet) and
 * `[]` (fetched, nothing changed) must not render the same thing.
 *
 * The panel used to destructure `data: status = []`, so every worktree claimed
 * "No changes." until its git status landed — asserting a fact the app didn't
 * have yet. These pin the two states apart.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChangedFile } from "../../bindings";
import { ChangesList } from "./ChangesList";

vi.mock("./model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model")>()),
  useTrees: () => ({
    repo: "/repo",
    activeId: "AK-1",
    selectedFile: null,
    selectedFileScope: "working",
    selectFile: vi.fn(),
  }),
}));

// The list's data hooks and the commit box below it all reach for the query
// layer; this suite is only about which branch the list renders.
vi.mock("../../lib/queries", () => ({
  TREES_CHANGES_VIEW_KEY: "trees-changes-view",
  useSetting: () => ({ data: null }),
  useSetSetting: () => ({ mutate: vi.fn() }),
  useStageAction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

/** `status` is what the list splits on — tracked rows against the "Untracked
 *  files" section, and Discard against Delete — so it has to be overridable:
 *  pinning it to `Modified` made half of `ChangesList` unreachable from the one
 *  file that tests it. */
const file = (path: string, staged: boolean, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  oldPath: null,
  status: "Modified",
  staged,
  addLines: 1,
  delLines: 0,
  binary: false,
  ...over,
});

describe("ChangesList loading state", () => {
  it("shows a skeleton, not an empty state, while the status is unknown", () => {
    render(<ChangesList files={undefined} />);
    expect(screen.queryByText("No changes.")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows the empty state once the status and the branch are both known to be empty", () => {
    render(<ChangesList files={[]} committed={[]} />);
    expect(screen.getByText("No changes.")).toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).not.toBeInTheDocument();
  });

  /** The staged counter reads off real data, so it must stay hidden until there
   *  is some — "0/0 staged" next to a skeleton is the same false claim. */
  it("hides the staged counter while the status is unknown", () => {
    render(<ChangesList files={undefined} />);
    expect(screen.queryByText(/staged/)).not.toBeInTheDocument();
  });

  /** The branch list loads on its own; an empty working tree must not claim "No
   *  changes." while the committed files are still unknown. */
  it("keeps a skeleton for the branch list while only the status has landed", () => {
    render(<ChangesList files={[]} committed={undefined} />);
    expect(screen.queryByText("No changes.")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders the rows and the counter once files arrive", () => {
    render(<ChangesList files={[file("a.ts", true), file("b.ts", false)]} committed={[]} />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByText("1/2 staged")).toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).not.toBeInTheDocument();
  });

  /** A new file is not a change to an existing one: it gets its own section, and
   *  the destructive action on it deletes rather than discards. The split is on
   *  `status`, which the fixture pinned to `Modified` until now. */
  it("puts new files in their own section rather than among the changes", () => {
    render(
      <ChangesList
        files={[file("a.ts", true), file("new.ts", false, { status: "Untracked" })]}
        committed={[]}
      />,
    );
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("Untracked files")).toBeInTheDocument();
  });
});
