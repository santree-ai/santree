import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeFocus } from "../../state/AppContext";
import { worktree as fxWorktree } from "../../test/fixtures";
import { ProjectSection, ProjectTree } from "./ProjectTree";
import {
  type LinearProjectNode,
  milestoneKey,
  type ProjectNode,
  type ProjectTreeModel,
  projectKey,
  repoKey,
  type WorktreeNode,
} from "./useProjectTree";

// The rows under the header stand up the query client and the app context; this
// file is about the header itself.
vi.mock("./WorktreeRow", () => ({ INDENT_PX: 14, WorktreeRow: () => null }));
vi.mock("../../features/trees/CreateWorktreeDialog", () => ({ CreateWorktreeDialog: () => null }));
vi.mock("../chrome/RepoAvatar", () => ({ RepoAvatar: () => null }));
vi.mock("../../features/agents/useOpenAgent", () => ({ useOpenAgent: () => vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

/** The two app-level values the tree reads, mutable so a test can hand it a
 *  focus request and re-render. Partial mocks throughout: every other export of
 *  these modules is still the real one, so nothing in the tree's import graph
 *  loses a binding it never asked to have stubbed. */
const ui = vi.hoisted(() => ({
  treeFocus: null as TreeFocus | null,
  requestTreeFocus: vi.fn(),
  openWorktree: null,
}));
const model = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../../state/AppContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/AppContext")>()),
  useApp: () => ({ activeRepo: "acme/app", setActiveRepo: vi.fn() }),
  useAppUi: () => ui,
}));
vi.mock("./useProjectTree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useProjectTree")>()),
  useProjectTree: () => model.current,
}));

function project(over: Partial<ProjectNode> = {}): ProjectNode {
  return {
    repo: "stoscanini/santree",
    label: "santree",
    base: null,
    linearProjects: [],
    showProjects: false,
    worktreeCount: 6,
    attention: { level: "idle", at: 0 },
    loading: false,
    ...over,
  };
}

function renderSection(over: Partial<ProjectNode> = {}) {
  return render(
    <ProjectSection
      project={project(over)}
      open
      isBandOpen={() => true}
      openWorktreeId={null}
      onToggle={vi.fn()}
      onToggleBand={vi.fn()}
      onSelectWorktree={vi.fn()}
      onOpenAgent={vi.fn()}
      onCreateWorktree={vi.fn()}
    />,
  );
}

/** The header's trailing count. */
function countSlot(container: HTMLElement): HTMLElement {
  return container.querySelector(".tabular-nums") as HTMLElement;
}

describe("ProjectSection header", () => {
  /** The count is hover-revealed, not hover-*rendered*. `opacity: 0` keeps the
   *  number in the accessibility tree, so a screen reader — which has no hover —
   *  still reaches it. */
  it("keeps the hover-only count in the DOM at rest", () => {
    const { container } = renderSection();
    const slot = countSlot(container);
    expect(slot).toBeInTheDocument();
    expect(slot).toHaveTextContent("6");
    expect(slot.className).toContain("opacity-0");
  });

  /** Hover and keyboard focus reveal the same thing: a control or a fact you can
   *  only reach with a pointer is unreachable from the keyboard. */
  it("reveals the count on hover and on keyboard focus alike", () => {
    const { container } = renderSection();
    const slot = countSlot(container);
    expect(slot.className).toContain("group-hover:opacity-100");
    expect(slot.className).toContain("group-focus-within:opacity-100");
  });

  /** The slot is reserved, not conditional: the row must not resize under the
   *  pointer that revealed it, nor when the read finally lands. This has bitten
   *  this rail three times — always as a control that occupied no space until it
   *  appeared. */
  it("reserves the count's slot while the read is still in flight", () => {
    const { container } = renderSection({ loading: true });
    const slot = countSlot(container);
    expect(slot).toBeInTheDocument();
    // No digits until the read lands — "0" beside skeleton rows is a claim —
    // but the width is already spoken for.
    expect(slot).toHaveTextContent("");
    expect(slot.className).toContain("min-w-[13px]");
  });

  /** The repo header carries no attention dot: the rows beneath it already say
   *  which worktree needs a human, and a second dot on the parent restated it
   *  while adding permanent colour to a rail that is open all day. Removed
   *  deliberately — this asserts it stays gone. */
  it("shows no attention dot on the repo header, even at needs-you", () => {
    renderSection({ attention: { level: "needs-you", at: 1 } });
    expect(screen.queryByRole("img", { name: "Needs you" })).not.toBeInTheDocument();
  });
});

/**
 * A worktree picked anywhere but here — Issues, the graph, the palette, a
 * session-history row — has to become *visible*, or the selection looks like it
 * did nothing. A click in the tree itself already is visible, and expanding on
 * top of it would move a rail the user is looking at for no reason.
 */
describe("ProjectTree reveals a selection made elsewhere", () => {
  const REPO = "acme/app";
  const row = (id: string): WorktreeNode => ({
    worktree: fxWorktree(id),
    depth: 0,
    primary: false,
    prs: [],
    task: null,
    agents: [],
    attention: { level: "idle", at: 0 },
  });
  const band = (
    key: string,
    milestones: LinearProjectNode["milestones"],
    showMilestones: boolean,
  ): LinearProjectNode => ({
    key,
    label: key,
    color: "#888",
    icon: null,
    targetDate: null,
    milestones,
    showMilestones,
    worktreeCount: 1,
  });

  /** The deepest shape: two project bands, one of them split across milestones. */
  const tree: ProjectTreeModel = {
    projects: [
      {
        ...project({ repo: REPO, label: "app", showProjects: true }),
        linearProjects: [
          band(
            "Core",
            [{ key: "m1", label: "M1", targetDate: null, worktrees: [row("AK-1")] }],
            true,
          ),
          band(
            "Infra",
            [{ key: "m2", label: "M2", targetDate: null, worktrees: [row("AK-3")] }],
            true,
          ),
        ],
      },
    ],
    loading: false,
    markSeen: vi.fn(),
  };

  /** Everything folded away, which is the state the bug was reported in. */
  function collapseAll() {
    localStorage.setItem(
      "santree.shell.projectTree.collapsed",
      JSON.stringify({
        [repoKey(REPO)]: true,
        [projectKey(REPO, "Core")]: true,
        [projectKey(REPO, "Infra")]: true,
        [milestoneKey(REPO, "Core", "m1")]: true,
        [milestoneKey(REPO, "Infra", "m2")]: true,
      }),
    );
  }

  beforeEach(() => {
    localStorage.clear();
    model.current = tree;
    ui.treeFocus = null;
  });

  it("expands every ancestor of a worktree selected from another view", () => {
    collapseAll();
    ui.treeFocus = { id: "AK-1", pane: "issue" };
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: "Collapse app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse project Core" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse milestone M1" })).toBeInTheDocument();
  });

  // Only expand. A fold elsewhere in the tree is the user's own curation and
  // this request has no business undoing it.
  it("leaves the bands it did not have to open exactly as it found them", () => {
    collapseAll();
    ui.treeFocus = { id: "AK-1", pane: "issue" };
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: "Expand project Infra" })).toBeInTheDocument();
  });

  // The sidebar's own click already put the row on screen; re-expanding its
  // parents would move the rail under the pointer that just clicked it.
  it("expands nothing for a selection made by clicking in the tree itself", () => {
    collapseAll();
    ui.treeFocus = { id: "AK-1", pane: "issue", fromSidebar: true };
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: "Expand app" })).toBeInTheDocument();
  });
});
