/**
 * The rail's Daedalus section: absent until the link is up or Daedalus holds a
 * project, the home server's projects under their own header, and greyed with
 * one line of what to do while the link is down — never a toast.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaedalusLink, Repo } from "../../bindings";

const state = vi.hoisted(() => ({
  repos: undefined as Repo[] | undefined,
  link: undefined as DaedalusLink | undefined,
  navigate: vi.fn(),
  /** The props the section handed its tree on the last render. */
  tree: null as { location: string; emptyLabel: string; actionsDisabled?: string } | null,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("../../lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queries")>()),
  useRepos: () => ({ data: state.repos }),
  useDaedalusStatus: () => ({ data: state.link }),
}));
// The tree is its own component with its own test; here it is only what the
// section hands it.
vi.mock("./ProjectTree", () => ({
  ProjectTree: (props: NonNullable<typeof state.tree>) => {
    state.tree = props;
    return <div data-testid="daedalus-tree" />;
  },
}));
vi.mock("./DaedalusProjectsDialog", () => ({
  DaedalusProjectsDialog: () => <div role="dialog" aria-label="Add from Daedalus" />,
}));

import { DaedalusSection } from "./DaedalusSection";

const CONNECTED: DaedalusLink = {
  kind: "Connected",
  hostname: "s2-server",
  version: "0.4.0",
  projectsRoot: "/home/santiago/projects",
  agent: "0.22.0",
};

const repo = (name: string, location: Repo["location"]) => ({ name, location }) as Repo;

/** The header's label, by its own words. */
const header = () => screen.queryByText("Daedalus");

beforeEach(() => {
  state.repos = [repo("acme/app", "Local")];
  state.link = CONNECTED;
  state.navigate.mockClear();
  state.tree = null;
});

describe("DaedalusSection visibility", () => {
  /** A Mac without the agent, and no Daedalus project: nothing to say. */
  it("draws nothing without a link and without a Daedalus project", () => {
    state.link = { kind: "AgentMissing" };
    const { container } = render(<DaedalusSection />);
    expect(container).toBeEmptyDOMElement();
  });

  /** Unknown is not "linked": a cold start doesn't flash the section in. */
  it("draws nothing while the status read is in flight and no project is known", () => {
    state.link = undefined;
    const { container } = render(<DaedalusSection />);
    expect(container).toBeEmptyDOMElement();
  });

  /** Linked, nothing added: the header and the tree's quiet line pointing at "+". */
  it("draws the header over an empty tree once the link is up", () => {
    render(<DaedalusSection />);
    expect(header()).toBeInTheDocument();
    expect(state.tree).toMatchObject({
      location: "Daedalus",
      emptyLabel: "No projects yet. Add one with +",
    });
    expect(state.tree?.actionsDisabled).toBe("Coming soon for Daedalus projects");
  });

  /** A registered Daedalus project keeps its section whatever the link says. */
  it("stays while a Daedalus project is registered, linked or not", () => {
    state.link = { kind: "AgentMissing" };
    state.repos = [repo("home/web", "Daedalus")];
    render(<DaedalusSection />);
    expect(header()).toBeInTheDocument();
    expect(screen.getByTestId("daedalus-tree")).toBeInTheDocument();
  });
});

describe("DaedalusSection link", () => {
  beforeEach(() => {
    state.repos = [repo("home/web", "Daedalus")];
  });

  /** Out of reach is normal: the section greys, says what to do in one line
   *  linked to Settings → Daedalus, and the rows stay with their actions off. */
  it("greys out with the agent's reason and a link to Settings when unavailable", () => {
    state.link = { kind: "Unavailable", reason: "the session host did not answer" };
    render(<DaedalusSection />);

    expect(header()).toHaveClass("opacity-60");
    expect(screen.getByTestId("daedalus-tree").parentElement).toHaveClass("opacity-60");
    expect(state.tree?.actionsDisabled).toBe("Unavailable until santree can reach Daedalus");

    const hint = screen.getByRole("button", { name: /Can't reach Daedalus/ });
    expect(hint).toHaveAttribute("title", "the session host did not answer");
    // The hint is the one thing still asking to be read, so it isn't dimmed.
    expect(hint).not.toHaveClass("opacity-60");
    fireEvent.click(hint);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "daedalus" },
    });
  });

  it.each([
    [{ kind: "AgentMissing" }, "Install the Daedalus agent on this Mac"],
    [{ kind: "AgentOutdated" }, "Update the Daedalus agent on this Mac"],
    [{ kind: "SantreeOff" }, "Turn on santree for this Mac in Daedalus › Settings › Machines"],
    [{ kind: "HostKeyChanged", reason: "another key" }, "Daedalus's session host key changed"],
  ] as [DaedalusLink, string][])("says what to do about %o", (link, hint) => {
    state.link = link;
    render(<DaedalusSection />);
    expect(
      screen.getByRole("button", { name: `${hint}. Open Settings, Daedalus` }),
    ).toHaveTextContent(hint);
    expect(state.tree?.actionsDisabled).toBe("Unavailable until santree can reach Daedalus");
  });

  /** An unknown is not a no, and a retry in flight is not a failure: the
   *  section draws at full strength rather than flashing grey. */
  it.each([
    undefined,
    { kind: "Connecting" } as DaedalusLink,
  ])("draws at full strength while the link is %o", (link) => {
    state.link = link;
    render(<DaedalusSection />);
    expect(header()).not.toHaveClass("opacity-60");
    // Reachable, so the reason nothing runs there is only that nothing does yet.
    expect(state.tree?.actionsDisabled).toBe("Coming soon for Daedalus projects");
    expect(screen.queryByRole("button", { name: /Settings/ })).toBeNull();
  });

  it("draws no hint while connected", () => {
    render(<DaedalusSection />);
    expect(screen.queryByRole("button", { name: /Settings/ })).toBeNull();
  });
});

describe("DaedalusSection add", () => {
  it("opens the Daedalus projects dialog from the header's +", () => {
    render(<DaedalusSection />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add from Daedalus" }));
    expect(screen.getByRole("dialog", { name: "Add from Daedalus" })).toBeInTheDocument();
  });

  /** With the link down, "+" still opens the dialog: it shows the state itself. */
  it("keeps the + working while the link is down", () => {
    state.repos = [repo("home/web", "Daedalus")];
    state.link = { kind: "SantreeOff" };
    render(<DaedalusSection />);
    expect(screen.getByRole("button", { name: "Add from Daedalus" })).toBeEnabled();
  });
});
