import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidebarNav } from "./SidebarNav";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useRouterState: () => "/trees",
}));
vi.mock("../../state/AppContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/AppContext")>()),
  useAppUi: () => ({ toggleCommandPalette: vi.fn() }),
}));
vi.mock("../../lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queries")>()),
  useWorkScopeRepo: () => "acme/app",
  useTicketProvider: () => "Linear",
  useTicketCount: () => 4,
}));

describe("SidebarNav", () => {
  /**
   * Reviews is per-project (a row in each project's section of the tree) and
   * Triage is its own rail section (`TriageSection`). A global nav entry for
   * either would be a second place to disagree about what needs you, so this
   * pins that they stay gone while the destinations that aren't per-project stay.
   */
  it("offers Search and Tickets, but no global Reviews or Triage destination", () => {
    render(<SidebarNav />);
    expect(screen.queryByRole("button", { name: /reviews/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /triage/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Search/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tickets/ })).toBeInTheDocument();
  });
});
