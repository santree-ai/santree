/**
 * Settings → Integrations → Daedalus.
 *
 * The data layer is real and the bridge is stubbed, so these run the actual
 * hooks over the app's own failure policy (`lib/queryFailures`): the point of
 * the unreachable case is that being away from home comes back as a *value*,
 * which the pane renders as a hint, and never as a failed read that would toast.
 */
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaedalusConfig, DaedalusHealth, DaedalusReach, DaemonReach } from "../../../bindings";
import { readFailures, writeFailures } from "../../../lib/queryFailures";
import { DaedalusSection } from "./Daedalus";

let reach: DaedalusReach = { kind: "NotConfigured" };
let config: DaedalusConfig | null = null;
let daemon: DaemonReach = { kind: "NotConfigured" };
const API_404 = "This Daedalus doesn't serve santree's API yet. Update Daedalus.";
/** Today's expected state: the API isn't served yet, ssh works, and
 *  santree-remote isn't on the server. */
const today: DaedalusHealth = {
  api: { kind: "Unreachable", reason: API_404 },
  ssh: { kind: "Ok", target: "santiago@s2.example.org" },
  daemon: { kind: "NotInstalled" },
  checkedAt: new Date().toISOString(),
};
let health: DaedalusHealth = today;

vi.mock("../../../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../bindings")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...actual,
    commands: {
      ...actual.commands,
      daedalusStatus: () => ok(reach),
      daedalusConfig: () => ok(config),
      daedalusWorkspaces: () => ok({ reach, generatedAt: null, workspaces: [] }),
      daedalusHealth: () => ok(health),
      daedalusDaemonStatus: () => ok(daemon),
    },
  };
});

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("../../../state/toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

const renderPane = () => {
  const client = new QueryClient({
    queryCache: new QueryCache(readFailures),
    mutationCache: new MutationCache(writeFailures),
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DaedalusSection />
    </QueryClientProvider>,
  );
};

const saved: DaedalusConfig = {
  url: "https://daedalus.test",
  sshUser: null,
  sshHost: null,
  sshPort: null,
  projectsRoot: null,
  identityFile: null,
  hasToken: true,
  fetchedAt: null,
};

describe("Settings → Daedalus", () => {
  beforeEach(() => {
    reach = { kind: "NotConfigured" };
    config = null;
    daemon = { kind: "NotConfigured" };
    health = today;
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  it("asks for a URL and token when nothing is configured", async () => {
    renderPane();
    expect(await screen.findByText(/Not configured\./)).toBeInTheDocument();
    expect(screen.getByLabelText("Daedalus URL")).toHaveValue("");
    expect(screen.getByLabelText("API token")).toBeInTheDocument();
    // Nothing to connect with yet, and nothing to disconnect from.
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run check" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Health check" })).toBeNull();
  });

  it("checks each stage, and says ssh works but santree-remote isn't there", async () => {
    config = saved;
    reach = { kind: "ApiUnreachable", reason: API_404 };
    // The live link can't help: santree-remote was never installed.
    daemon = { kind: "Unreachable", reason: "santree-remote not found on the server" };
    renderPane();

    const block = await screen.findByRole("region", { name: "Health check" });
    const rows = await within(block).findAllByRole("listitem");
    await waitFor(() => expect(rows[1]).toHaveTextContent("santiago@s2.example.org"));
    expect(rows.map((row) => row.textContent)).toEqual([
      `Daedalus API${API_404}`,
      "SSH accesssantiago@s2.example.org",
      "santree-remote on DaedalusNot installed on Daedalus yet.",
    ]);
    expect(within(rows[0]).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(within(rows[1]).getByRole("img", { name: "OK" })).toBeInTheDocument();
    expect(within(rows[2]).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(within(block).getByRole("button", { name: "Run check" })).toBeEnabled();
    // The saved connection is still there to change.
    await waitFor(() => expect(screen.getByLabelText("Daedalus URL")).toHaveValue(saved.url));
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();

    // Every outcome is a state on the page, never a toast.
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("follows the live link once santree-remote is installed", async () => {
    config = saved;
    reach = { kind: "ApiReachable" };
    health = {
      ...today,
      api: { kind: "Ok" },
      daemon: { kind: "NotRunning", reason: "ssh: santree-remote: no daemon socket" },
    };
    daemon = { kind: "Connected", version: "0.1.0" };
    renderPane();
    expect(await screen.findByText("Connected · santree-remote 0.1.0")).toBeInTheDocument();
    expect(screen.getByText("Reachable")).toBeInTheDocument();
  });

  it("offers santree's own VPN only as a disabled, work-in-progress switch", async () => {
    renderPane();
    const vpn = await screen.findByRole("switch", { name: "Connect through santree's own VPN" });
    expect(vpn).toBeDisabled();
    expect(vpn).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("WIP")).toBeInTheDocument();
    expect(screen.getByText(/home network or through your system VPN/)).toBeInTheDocument();
  });

  it("shows the connection Daedalus reported, read-only", async () => {
    config = {
      ...saved,
      sshUser: "me",
      sshHost: "s2.example.org",
      sshPort: 2222,
      projectsRoot: "/srv/projects",
      fetchedAt: new Date().toISOString(),
    };
    reach = { kind: "ApiReachable" };
    renderPane();
    expect(await screen.findByText("s2.example.org")).toBeInTheDocument();
    expect(screen.getByText("me")).toBeInTheDocument();
    expect(screen.getByText("2222")).toBeInTheDocument();
    expect(screen.getByText("/srv/projects")).toBeInTheDocument();
    // The URL and the identity file are the only things the user types here
    // (the token is a password field); the ssh details are Daedalus's.
    await waitFor(() => expect(screen.getByLabelText("Daedalus URL")).toHaveValue(saved.url));
    expect(screen.getAllByRole("textbox")).toEqual([
      screen.getByLabelText("Daedalus URL"),
      screen.getByLabelText("Identity file"),
    ]);
  });
});
