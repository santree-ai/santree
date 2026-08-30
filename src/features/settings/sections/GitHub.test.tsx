/**
 * Settings → Integrations → GitHub, specifically the in-place `gh auth login`.
 *
 * The terminal itself is out of scope (it has its own tests); what matters here
 * is the seam: which command santree seeds, and that the auth status is re-read
 * when the session ends so the badge flips without hunting for Refresh.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GithubStatus } from "../../../bindings";
import { queryKeys } from "../../../lib/queries";
import type { EmbeddedTerminalSpec } from "../../terminal/useEmbeddedTerminal";
import { GitHubSection } from "./GitHub";

let status: GithubStatus | undefined;

vi.mock("../../../lib/queries", async () => {
  // The real key, so the invalidation assertion tracks `queries.ts` rather than
  // a copy of it that could drift.
  const actual =
    await vi.importActual<typeof import("../../../lib/queries")>("../../../lib/queries");
  return {
    queryKeys: actual.queryKeys,
    useGithubStatus: () => ({ data: status, refetch: vi.fn(), isFetching: false }),
    useGithubApiBudget: () => ({ data: null }),
  };
});

// Both are leaf panels over their own hooks; neither is what this file is about.
vi.mock("../BinaryPathField", () => ({ BinaryPathField: () => <div>binary path field</div> }));
vi.mock("../ApiBudget", () => ({ ApiBudgetMeters: () => null }));

/** The spec the login terminal was mounted with, plus its exit callback. */
let embedded: { spec: EmbeddedTerminalSpec; onExited?: () => void } | null = null;

vi.mock("../../terminal/useEmbeddedTerminal", () => ({
  useEmbeddedTerminal: (opts: { spec: EmbeddedTerminalSpec; onExited?: () => void }) => {
    embedded = opts;
    return { hostRef: { current: null }, close: vi.fn() };
  },
}));

const signedOut: GithubStatus = {
  installed: true,
  detectedExec: "/opt/homebrew/bin/gh",
  version: "gh version 2.92.0",
  authenticated: false,
  account: "",
  name: "",
  host: "github.com",
};

/** Renders the pane over a real client, so the invalidation is observed on the
 *  cache the pane actually talks to. */
const renderPane = () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <GitHubSection />
    </QueryClientProvider>,
  );
  return invalidate;
};

const loginButton = () => screen.getByRole("button", { name: "Run gh auth login" });

describe("Settings → GitHub → gh auth login", () => {
  beforeEach(() => {
    status = signedOut;
    embedded = null;
  });

  it("offers the login button while gh is installed but signed out", () => {
    renderPane();
    expect(loginButton()).toBeInTheDocument();
    expect(screen.getByText("signed out")).toBeInTheDocument();
  });

  // Same as the agent panes: the command that signs you in is the command that
  // switches account, so it stays reachable once connected.
  it("still offers it once the session is authenticated", () => {
    status = { ...signedOut, authenticated: true, account: "octocat" };
    renderPane();
    expect(loginButton()).toBeInTheDocument();
    expect(screen.getByText("connected")).toBeInTheDocument();
  });

  it("offers nothing to run when gh is not installed at all", () => {
    status = { ...signedOut, installed: false, detectedExec: "", version: "" };
    renderPane();
    expect(screen.queryByRole("button", { name: "Run gh auth login" })).toBeNull();
  });

  it("keeps the manual Refresh control beside it", () => {
    renderPane();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("mounts the terminal on click, seeded with the resolved gh path", () => {
    renderPane();
    expect(embedded).toBeNull();

    fireEvent.click(loginButton());

    expect(embedded?.spec).toMatchObject({
      refId: "login:github",
      source: "shell",
      seed: "/opt/homebrew/bin/gh auth login",
    });
    // The header states what is actually running, path and all.
    expect(screen.getByText("/opt/homebrew/bin/gh auth login")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run gh auth login" })).toBeNull();
  });

  it("falls back to the bare command when nothing was detected", () => {
    status = { ...signedOut, detectedExec: "" };
    renderPane();
    fireEvent.click(loginButton());
    expect(embedded?.spec.seed).toBe("gh auth login");
  });

  it("quotes a resolved path that would otherwise split into two arguments", () => {
    status = { ...signedOut, detectedExec: "/Users/me/My Tools/gh" };
    renderPane();
    fireEvent.click(loginButton());
    expect(embedded?.spec.seed).toBe("'/Users/me/My Tools/gh' auth login");
  });

  it("re-reads the auth status when the session exits", () => {
    const invalidate = renderPane();
    fireEvent.click(loginButton());
    invalidate.mockClear();

    act(() => embedded?.onExited?.());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.githubStatus });
    // Back to the button: the pane never leaves a dead terminal behind.
    expect(loginButton()).toBeInTheDocument();
  });
});
