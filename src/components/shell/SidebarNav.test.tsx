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
  useTicketCount: () => 4,
}));

describe("SidebarNav", () => {
  /**
   * Reviews is per-project now — a row inside each project's section of the tree,
   * carrying that project's own count. One global entry could only ever show one
   * number for a registry-wide inbox, which is the question nobody was asking, so
   * it is gone from the nav entirely. This pins that it stays gone: a second entry
   * point would immediately be a second place to disagree about what needs you.
   */
  it("offers no global Reviews destination", () => {
    render(<SidebarNav />);
    expect(screen.queryByRole("button", { name: /reviews/i })).not.toBeInTheDocument();
  });

  /**
   * Triage is a section of the rail now (`TriageSection`): its queue is the list,
   * and a nav row that only counted it put a click between you and the tickets.
   * Pinned so it does not come back as a second entry point.
   */
  it("offers no Triage destination — the queue is its own sidebar section", () => {
    render(<SidebarNav />);
    expect(screen.queryByRole("button", { name: /triage/i })).not.toBeInTheDocument();
  });

  it("still offers the destinations that aren't per-project", () => {
    render(<SidebarNav />);
    expect(screen.getByRole("button", { name: /Search/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tickets/ })).toBeInTheDocument();
  });
});
