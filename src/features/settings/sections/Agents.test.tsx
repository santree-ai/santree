import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import type { AgentVersionStatus } from "../../../bindings";
import { ClaudeAgentSection } from "./Agents";

const healthRefresh = vi.fn();
const authRefresh = vi.fn();
let health: AgentVersionStatus;
vi.mock("../../../state/AppContext", () => ({
  useApp: () => ({ settings: { agents: [{ key: "Claude", exec: "" }] }, setAgentExec: vi.fn() }),
}));
vi.mock("../../../lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/queries")>()),
  useAgents: () => ({ data: [{ key: "Claude", label: "Claude Code", short: "claude" }] }),
  useAgentAuth: () => ({
    data: { connected: true, account: "Saved account", loginCmd: "claude /login" },
    refetch: authRefresh,
  }),
  useAgentVersionStatus: () => ({ data: health, refetch: healthRefresh, isFetching: false }),
  useSetting: () => ({ data: null }),
  useBoolSetting: () => ({ value: false }),
  useClaudeGlobalCapture: () => ({ data: false }),
  useSetClaudeGlobalCapture: () => ({ mutate: vi.fn() }),
  useSetSetting: () => ({ mutate: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  health = {
    installed: null,
    latest: "2.1.285",
    updateAvailable: false,
    executable: "/broken/claude",
    error: "CLI --version failed (exit status: 126): Permission denied",
  };
});

it("does not treat saved account details as a working installation", () => {
  render(<ClaudeAgentSection />);
  expect(screen.getByText("Account found")).toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
  expect(screen.getByRole("button", { name: /Run claude/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(authRefresh).toHaveBeenCalledOnce();
  expect(healthRefresh).toHaveBeenCalledOnce();
});

it("keeps a working CLI ready when the version registry is unavailable", () => {
  health = { ...health, installed: "2.1.285", latest: null, error: null };
  render(<ClaudeAgentSection />);
  expect(screen.getByText("Ready")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Run claude/ })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
