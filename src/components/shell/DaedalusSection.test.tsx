/**
 * The rail's Daedalus section: absent until Daedalus is set up or holds a
 * project, the home server's projects under their own header, and greyed with
 * one line of what to do while the server is out of reach — never a toast.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaedalusConfig, DaedalusReach, Repo } from "../../bindings";

const state = vi.hoisted(() => ({
  repos: undefined as Repo[] | undefined,
  config: undefined as DaedalusConfig | null | undefined,
  reach: undefined as DaedalusReach | undefined,
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
  useDaedalusConfig: () => ({ data: state.config }),
  useDaedalusStatus: () => ({ data: state.reach }),
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

const CONFIG: DaedalusConfig = {
  url: "https://daedalus.home",
  sshUser: "santiago",
  sshHost: "s2.example.org",
  sshPort: 22,
  projectsRoot: "/home/santiago/projects",
  identityFile: null,
  hasToken: true,
  fetchedAt: null,
};

const repo = (name: string, location: Repo["location"]) => ({ name, location }) as Repo;

/** The header's label, by its own words. */
const header = () => screen.queryByText("Daedalus");

beforeEach(() => {
  state.repos = [repo("acme/app", "Local")];
  state.config = CONFIG;
  state.reach = { kind: "ApiReachable" };
  state.navigate.mockClear();
  state.tree = null;
});

describe("DaedalusSection visibility", () => {
  /** An integration you never set up has nothing to say in the rail. */
  it("draws nothing when Daedalus isn't set up and holds no project", () => {
    state.config = null;
    state.reach = { kind: "NotConfigured" };
    const { container } = render(<DaedalusSection />);
    expect(container).toBeEmptyDOMElement();
  });

  /** Unknown is not "not set up": a cold start doesn't flash the section in. */
  it("draws nothing while the config read is in flight and no project is known", () => {
    state.config = undefined;
    const { container } = render(<DaedalusSection />);
    expect(container).toBeEmptyDOMElement();
  });

  /** Set up, nothing added: the header and the tree's quiet line pointing at "+". */
  it("draws the header over an empty tree once Daedalus is set up", () => {
    render(<DaedalusSection />);
    expect(header()).toBeInTheDocument();
    expect(state.tree).toMatchObject({
      location: "Daedalus",
      emptyLabel: "No projects yet. Add one with +",
    });
    expect(state.tree?.actionsDisabled).toBeUndefined();
  });

  /** A registered Daedalus project keeps its section even after the connection
   *  is forgotten — the projects stay, so their section does. */
  it("stays while a Daedalus project is registered, set up or not", () => {
    state.config = null;
    state.reach = { kind: "NotConfigured" };
    state.repos = [repo("home/web", "Daedalus")];
    render(<DaedalusSection />);
    expect(header()).toBeInTheDocument();
    expect(screen.getByTestId("daedalus-tree")).toBeInTheDocument();
  });
});

describe("DaedalusSection reach", () => {
  beforeEach(() => {
    state.repos = [repo("home/web", "Daedalus")];
  });

  /** Away from home is normal: the section greys, says what to do in one line
   *  linked to Settings → Daedalus, and the rows stay with their actions off. */
  it("greys out with a hint to Settings when the API can't be reached", () => {
    state.reach = { kind: "ApiUnreachable", reason: "timed out" };
    render(<DaedalusSection />);

    expect(header()).toHaveClass("opacity-60");
    expect(screen.getByTestId("daedalus-tree").parentElement).toHaveClass("opacity-60");
    expect(state.tree?.actionsDisabled).toBe("Unavailable until santree can reach Daedalus");

    const hint = screen.getByRole("button", { name: /Connect to your home network or VPN/ });
    expect(hint).toHaveTextContent("Connect to your home network or VPN");
    // The hint is the one thing still asking to be read, so it isn't dimmed.
    expect(hint).not.toHaveClass("opacity-60");
    fireEvent.click(hint);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "daedalus" },
    });
  });

  it("says the token was refused, rather than to find a network, on Unauthorized", () => {
    state.reach = { kind: "Unauthorized" };
    render(<DaedalusSection />);
    expect(screen.getByRole("button", { name: /Daedalus refused the token/ })).toBeInTheDocument();
    expect(state.tree?.actionsDisabled).toBeDefined();
  });

  /** An unknown is not a no: until the status read answers, the section draws
   *  as reachable rather than flashing grey at a server that is there. */
  it("draws at full strength while the status read is in flight", () => {
    state.reach = undefined;
    render(<DaedalusSection />);
    expect(header()).not.toHaveClass("opacity-60");
    expect(state.tree?.actionsDisabled).toBeUndefined();
    expect(screen.queryByRole("button", { name: /Settings/ })).toBeNull();
  });

  it("draws no hint while Daedalus answers", () => {
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

  /** Out of reach, "+" still opens the dialog: it shows the reach itself. */
  it("keeps the + working while Daedalus is out of reach", () => {
    state.reach = { kind: "ApiUnreachable", reason: "timed out" };
    render(<DaedalusSection />);
    expect(screen.getByRole("button", { name: "Add from Daedalus" })).toBeEnabled();
  });
});
