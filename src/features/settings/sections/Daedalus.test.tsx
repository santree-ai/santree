/**
 * Settings → Integrations → Daedalus.
 *
 * The data layer is real and the bridge is stubbed, so these run the actual
 * hooks over the app's own failure policy (`lib/queryFailures`): the point is
 * that every state of the link — no agent, santree off, out of reach — comes
 * back as a *value* the pane renders as what to do, never as a failed read
 * that would toast. There is nothing to configure: no field, no form.
 */
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaedalusLink } from "../../../bindings";
import { readFailures, writeFailures } from "../../../lib/queryFailures";
import { DaedalusSection } from "./Daedalus";

/** What the live status answers, and what the next check settles on. */
let live: DaedalusLink = { kind: "AgentMissing" };
let checked: DaedalusLink = { kind: "AgentMissing" };
const healthCalls = vi.fn();

vi.mock("../../../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../bindings")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      daedalusStatus: () => Promise.resolve(live),
      daedalusHealth: () => {
        healthCalls();
        live = checked;
        return Promise.resolve({
          status: "ok" as const,
          data: { link: checked, checkedAt: new Date().toISOString() },
        });
      },
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

const CONNECTED: DaedalusLink = {
  kind: "Connected",
  hostname: "s2-server",
  version: "0.4.0",
  projectsRoot: "/home/santiago/projects",
  agent: "0.22.0",
};

const region = () => screen.getByRole("region", { name: "Connection" });

describe("Settings → Daedalus", () => {
  beforeEach(() => {
    live = { kind: "AgentMissing" };
    checked = { kind: "AgentMissing" };
    healthCalls.mockClear();
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  it("asks for the agent when there is none, with nothing to fill in", async () => {
    renderPane();
    expect(await screen.findByText("Install the Daedalus agent on this Mac")).toBeInTheDocument();
    expect(within(region()).getByRole("img", { name: "Not connected" })).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(healthCalls).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: "AgentOutdated" }, "Update the Daedalus agent on this Mac", null],
    [
      { kind: "SantreeOff" },
      "Turn on santree for this Mac in Daedalus › Settings › Machines",
      null,
    ],
    [
      { kind: "Unavailable", reason: "the box has not approved this machine yet" },
      "Can't reach Daedalus",
      "the box has not approved this machine yet",
    ],
    [
      { kind: "HostKeyChanged", reason: "the session host proved another key" },
      "Daedalus's session host key changed",
      "the session host proved another key",
    ],
  ] as [
    DaedalusLink,
    string,
    string | null,
  ][])("names %o and what to do", async (link, title, detail) => {
    live = link;
    checked = link;
    renderPane();
    expect(await screen.findByText(title)).toBeInTheDocument();
    if (detail) expect(screen.getByText(detail)).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows the box, the host and the agent once connected", async () => {
    live = CONNECTED;
    checked = CONNECTED;
    renderPane();
    expect(await screen.findByText("Connected to s2-server")).toBeInTheDocument();
    expect(screen.getByText("0.4.0")).toBeInTheDocument();
    expect(screen.getByText("0.22.0")).toBeInTheDocument();
    expect(screen.getByText("/home/santiago/projects")).toBeInTheDocument();
    expect(within(region()).getByRole("img", { name: "OK" })).toBeInTheDocument();
  });

  /** Turned on in Daedalus since: "Run check" tries now rather than waiting
   *  out the backoff, and the card follows. */
  it("runs a fresh check on demand", async () => {
    live = { kind: "SantreeOff" };
    checked = { kind: "SantreeOff" };
    renderPane();
    await screen.findByText(/Turn on santree/);
    checked = CONNECTED;
    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    expect(await screen.findByText("Connected to s2-server")).toBeInTheDocument();
    await waitFor(() => expect(healthCalls).toHaveBeenCalledTimes(2));
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
