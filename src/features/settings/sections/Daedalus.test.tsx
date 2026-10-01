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

import type {
  DaedalusLink,
  DaedalusMachine,
  DaedalusMachineSettings,
  DaedalusSettingAnswer,
  DaedalusSettingKey,
} from "../../../bindings";
import { readFailures, writeFailures } from "../../../lib/queryFailures";
import { DaedalusSection } from "./Daedalus";

/** What the live status answers, and what the next check settles on. */
let live: DaedalusLink = { kind: "AgentMissing" };
let checked: DaedalusLink = { kind: "AgentMissing" };
const healthCalls = vi.fn();
/** What the agent's socket answers for this Mac's settings, and to an ask. */
let machine: DaedalusMachine = { kind: "AgentMissing" };
let answer: (key: DaedalusSettingKey, value: boolean) => DaedalusSettingAnswer = () => ({
  kind: "Sent",
});
const setCalls = vi.fn();

vi.mock("../../../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../bindings")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      daedalusStatus: () => Promise.resolve(live),
      daedalusSettings: () => Promise.resolve({ status: "ok" as const, data: machine }),
      daedalusSetSetting: (key: DaedalusSettingKey, value: boolean) => {
        setCalls(key, value);
        return Promise.resolve({ status: "ok" as const, data: answer(key, value) });
      },
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
    setCalls.mockClear();
    machine = { kind: "AgentMissing" };
    answer = () => ({ kind: "Sent" });
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
      "santree is off for this Mac",
      "Daedalus keeps santree off for this Mac. Turning it on opens Daedalus in your browser, where an admin confirms it.",
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
    await screen.findByText("santree is off for this Mac");
    checked = CONNECTED;
    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    expect(await screen.findByText("Connected to s2-server")).toBeInTheDocument();
    await waitFor(() => expect(healthCalls).toHaveBeenCalledTimes(2));
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

const SETTINGS: DaedalusMachineSettings = {
  fingerprint: "f876:e2c7:1a0b:2c3d:8029",
  fingerprintShort: "f876:e2c7…8029",
  linked: true,
  awakeHold: true,
  claudeRemoteControl: true,
  santree: false,
  pending: [],
  failed: [],
  operator: "santiago",
  mayChange: true,
};

const ready = (patch: Partial<DaedalusMachineSettings> = {}): DaedalusMachine => ({
  kind: "Ready",
  settings: { ...SETTINGS, ...patch },
});

const thisMac = () => screen.getByRole("region", { name: "This Mac" });
const toggle = (name: string) => within(thisMac()).getByRole("switch", { name });

/** This Mac's settings, through the Daedalus agent's own socket: the box's
 *  values as switches, a change on its way, santree ON through the browser,
 *  and every refusal as a line on the card — never a toast. */
describe("Settings → Daedalus → This Mac", () => {
  beforeEach(() => {
    live = CONNECTED;
    checked = CONNECTED;
    setCalls.mockClear();
    toastError.mockClear();
    answer = () => ({ kind: "Sent" });
  });

  it("shows the three settings as the box keeps them, with this Mac's key", async () => {
    machine = ready();
    renderPane();
    await screen.findByRole("region", { name: "This Mac" });
    expect(toggle("Keep awake")).toHaveAttribute("aria-checked", "true");
    expect(toggle("Claude Remote Control")).toHaveAttribute("aria-checked", "true");
    expect(toggle("santree on the box")).toHaveAttribute("aria-checked", "false");
    expect(within(thisMac()).getByText("f876:e2c7…8029")).toBeInTheDocument();
    for (const name of ["Keep awake", "Claude Remote Control", "santree on the box"]) {
      expect(toggle(name)).toBeEnabled();
    }
  });

  it("asks the box and shows the change on its way until it lands", async () => {
    machine = ready();
    answer = (key, value) => {
      machine = ready({ pending: [{ key, want: value, via: "Box" }] });
      return { kind: "Sent" };
    };
    renderPane();
    await screen.findByRole("region", { name: "This Mac" });
    fireEvent.click(toggle("Keep awake"));
    await waitFor(() => expect(setCalls).toHaveBeenCalledWith("AwakeHold", false));
    expect(await within(thisMac()).findByText("Sending to Daedalus…")).toBeInTheDocument();
    expect(toggle("Keep awake")).toHaveAttribute("aria-checked", "false");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("turns santree on through the browser and waits for the admin's OK", async () => {
    machine = ready();
    answer = () => {
      machine = ready({ pending: [{ key: "Santree", want: true, via: "Browser" }] });
      return { kind: "Opened", url: "https://daedalus-app.example.test/settings" };
    };
    renderPane();
    await screen.findByRole("region", { name: "This Mac" });
    fireEvent.click(toggle("santree on the box"));
    await waitFor(() => expect(setCalls).toHaveBeenCalledWith("Santree", true));
    expect(
      await within(thisMac()).findByText(/Waiting for your OK in the browser/),
    ).toBeInTheDocument();
    // Still off until an admin confirms; "Open again" asks for the page again.
    expect(toggle("santree on the box")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(within(thisMac()).getByRole("button", { name: "Open again" }));
    await waitFor(() => expect(setCalls).toHaveBeenCalledTimes(2));
    expect(setCalls).toHaveBeenLastCalledWith("Santree", true);
  });

  it("shows why a change didn't take, in the agent's words", async () => {
    machine = ready({
      failed: [{ key: "ClaudeRemoteControl", want: false, why: "Daedalus is not listening" }],
    });
    renderPane();
    expect(
      await within(await screen.findByRole("region", { name: "This Mac" })).findByText(
        "Not changed: Daedalus is not listening",
      ),
    ).toBeInTheDocument();
  });

  it("shows a refusal the agent didn't record beside its switch", async () => {
    machine = ready();
    answer = () => ({ kind: "Refused", reason: "turn santree on in Settings › Machines" });
    renderPane();
    await screen.findByRole("region", { name: "This Mac" });
    fireEvent.click(toggle("santree on the box"));
    expect(
      await within(thisMac()).findByText("Not changed: turn santree on in Settings › Machines"),
    ).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("is read-only, with the reason, for anyone but the operator", async () => {
    machine = ready({ mayChange: false });
    renderPane();
    expect(
      await screen.findByText("Only santiago can change these on this Mac."),
    ).toBeInTheDocument();
    for (const name of ["Keep awake", "Claude Remote Control", "santree on the box"]) {
      expect(toggle(name)).toBeDisabled();
    }
  });

  it("needs the box for every change but santree ON", async () => {
    machine = ready({ linked: false });
    renderPane();
    expect(await screen.findByText(/isn't connected to it right now/)).toBeInTheDocument();
    expect(toggle("Keep awake")).toBeDisabled();
    expect(toggle("Claude Remote Control")).toBeDisabled();
    expect(toggle("santree on the box")).toBeEnabled();
  });

  it("asks for an agent update when the agent predates its settings", async () => {
    machine = { kind: "AgentOutdated" };
    renderPane();
    expect(
      await screen.findByText("Update the Daedalus agent to change this Mac's settings here."),
    ).toBeInTheDocument();
    expect(within(thisMac()).queryAllByRole("switch")).toEqual([]);
  });

  it("offers to turn santree on when Daedalus keeps it off", async () => {
    live = { kind: "SantreeOff" };
    checked = { kind: "SantreeOff" };
    machine = ready();
    answer = () => ({ kind: "Opened", url: "https://daedalus-app.example.test/settings" });
    renderPane();
    const region = await screen.findByRole("region", { name: "Connection" });
    fireEvent.click(
      await within(region).findByRole("button", { name: "Turn on santree for this Mac…" }),
    );
    await waitFor(() => expect(setCalls).toHaveBeenCalledWith("Santree", true));
    expect(
      await within(region).findByText(
        /Confirm in the browser. It asks for the start of this Mac's key: f876:e2c7…8029/,
      ),
    ).toBeInTheDocument();
  });
});
