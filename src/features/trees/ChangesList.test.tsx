/**
 * The changes list's loading contract: `undefined` (status not fetched yet) and
 * `[]` (fetched, nothing changed) must not render the same thing.
 *
 * The panel used to destructure `data: status = []`, so every worktree claimed
 * "No changes." until its git status landed — asserting a fact the app didn't
 * have yet. These pin the two states apart.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangedFile } from "../../bindings";
import { ChangesList } from "./ChangesList";

/** The list under test with the host wiring every case here shares: which
 *  worktree it is about, and a place for a click to land. */
function List(props: Partial<ComponentProps<typeof ChangesList>>) {
  return (
    <ChangesList
      repo="/repo"
      worktreeId="AK-1"
      files={undefined}
      selectedPath={null}
      selectedScope="working"
      onOpen={vi.fn()}
      {...props}
    />
  );
}

// The list/tree choice is a persisted setting, so the mock has to be able to
// answer either way — the windowing has to hold in both layouts, and the tree is
// the one that renders folder rows on top of the files.
const settings = vi.hoisted(() => ({ view: null as string | null }));

// The list's data hooks and the commit box below it all reach for the query
// layer; this suite is only about which branch the list renders.
vi.mock("../../lib/queries", () => ({
  TREES_CHANGES_VIEW_KEY: "trees-changes-view",
  useSetting: () => ({ data: settings.view }),
  useSetSetting: () => ({ mutate: vi.fn() }),
  useStageAction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useRefreshWorktree: () => ({ refresh: vi.fn(), fetching: false }),
}));

beforeEach(() => {
  settings.view = null;
});

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
  /** The staged counter reads off real data too: "0/0 staged" next to a
   *  skeleton is the same false claim. */
  it("shows a skeleton, not an empty state or a counter, while the status is unknown", () => {
    render(<List files={undefined} />);
    expect(screen.queryByText("No changes.")).not.toBeInTheDocument();
    expect(screen.queryByText(/staged/)).not.toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows the empty state once the status and the branch are both known to be empty", () => {
    render(<List files={[]} committed={[]} />);
    expect(screen.getByText("No changes.")).toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).not.toBeInTheDocument();
  });

  /** The branch list loads on its own; an empty working tree must not claim "No
   *  changes." while the committed files are still unknown. */
  it("keeps a skeleton for the branch list while only the status has landed", () => {
    render(<List files={[]} committed={undefined} />);
    expect(screen.queryByText("No changes.")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  /** A new file is not a change to an existing one: it gets its own section, and
   *  the destructive action on it deletes rather than discards. */
  it("renders the rows, the counter, and new files in their own section once files arrive", () => {
    render(
      <List
        files={[
          file("a.ts", true),
          file("b.ts", false),
          file("new.ts", false, { status: "Untracked" }),
        ]}
        committed={[]}
      />,
    );
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("1/3 staged")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("Untracked files")).toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).not.toBeInTheDocument();
  });
});

/**
 * A merge conflict makes the branch diff thousands of files wide until
 * `git merge --continue` — a transient state that used to lock the pane up for
 * a second on every optimistic staging patch. Only a window of rows is drawn.
 * What must NOT change: the counts (they are the totals, not the window), and
 * anything at the pane's normal scale.
 */
describe("ChangesList windowing", () => {
  const many = (n: number, path: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => file(path(i), false));
  /** File rows carry `selection-row`; folder rows don't, so this counts files. */
  const fileRows = () => document.querySelectorAll(".selection-row").length;
  const showMore = () => screen.queryByText("Show more");

  it("caps a huge list and offers the rest behind one control", () => {
    render(<List files={many(2500, (i) => `src/f${i}.ts`)} committed={[]} />);
    expect(fileRows()).toBe(100);
    expect(showMore()).toBeInTheDocument();
    expect(screen.getByText("2,400 hidden")).toBeInTheDocument();
  });

  it("keeps the section header at the true total, and reveals the rest on click", () => {
    render(<List files={many(150, (i) => `src/f${i}.ts`)} committed={[]} />);
    // The only bare "150" on screen is the "Changes" header's count; the staged
    // counter renders as one "0/150 staged" string.
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(fileRows()).toBe(100);

    fireEvent.click(screen.getByText("Show more"));
    expect(fileRows()).toBe(150);
    expect(showMore()).not.toBeInTheDocument();
  });

  it("windows each section on its own, so a huge one can't hide a small one", () => {
    render(
      <List
        files={[
          ...many(150, (i) => `src/f${i}.ts`),
          file("new.ts", false, { status: "Untracked" }),
        ]}
        committed={[]}
      />,
    );
    expect(screen.getByText("new.ts")).toBeInTheDocument();
    expect(screen.getAllByText("Show more")).toHaveLength(1);
  });

  it("windows the tree layout too, counting its folder rows against the cap", () => {
    settings.view = "tree";
    render(<List files={many(150, (i) => `src/d${i % 10}/f${i}.ts`)} committed={[]} />);
    // 150 files + 11 folder rows, windowed to 100 drawn rows in total — so fewer
    // than 100 of them are files.
    expect(fileRows()).toBeLessThan(100);
    expect(showMore()).toBeInTheDocument();
    // Both the section header and the `src` folder row still say 150.
    expect(screen.getAllByText("150")).toHaveLength(2);
  });
});

/**
 * The list's one host-dependent decision, the same one {@link AllFilesList}
 * makes: a file name opens a diff where the host has somewhere to put one, and
 * is plain text where it hasn't. Staging and discard are not part of that — they
 * act on the checkout, so they hold in both rails.
 */
describe("ChangesList without a place to open a diff", () => {
  it("renders the file name as text rather than a dead button, but keeps staging", () => {
    render(<List files={[file("a.ts", false)]} committed={[]} onOpen={undefined} />);
    expect(screen.getByText("a.ts").closest("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Stage a.ts" })).toBeInTheDocument();
  });

  it("still opens the name where the host asked for it", () => {
    const onOpen = vi.fn();
    render(<List files={[file("a.ts", false)]} committed={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("a.ts"));
    expect(onOpen).toHaveBeenCalledWith("a.ts", "working");
  });
});
