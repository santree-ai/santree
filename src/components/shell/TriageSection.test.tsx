/**
 * The sidebar's Triage section: the queue as rows, the rotation and the snoozed
 * lane as bands, and the one selection — which follows the route, as every
 * other selection in this rail does.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TriageSchedule, TriageTicket } from "../../bindings";
import { TRIAGE_GOOD_CITIZEN_KEY, type TriageQueue } from "../../lib/queries";
import { formatSnoozeLabel } from "../../lib/relativeTime";
import { agentEntry, triageTicket } from "../../test/fixtures";
import type { AgentNode } from "./useProjectTree";

/** The router state the section reads: where the app is, and which ticket the
 *  workspace has open. */
const route = vi.hoisted(() => ({
  pathname: "/trees",
  ticket: undefined as string | undefined,
  navigate: vi.fn(),
}));
const app = vi.hoisted(() => ({ triageEnabled: true }));
const data = vi.hoisted(() => ({
  queue: { active: [], snoozed: [], goodCitizen: false, loading: false } as TriageQueue,
  schedules: [] as TriageSchedule[],
  setSetting: vi.fn(),
  hover: vi.fn(),
  agentsByTicket: new Map<string, AgentNode[]>(),
  markSeen: vi.fn(),
  openAgent: vi.fn(),
  readOnly: false,
  snooze: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => route.navigate,
  // Runs the section's real selector against a fake location, so the "is this
  // row lit" rule is the one under test rather than a stub of it.
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: route.pathname, search: { ticket: route.ticket } } }),
}));
vi.mock("../../state/AppContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/AppContext")>()),
  useApp: () => ({ triageEnabled: app.triageEnabled }),
}));
vi.mock("../../lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queries")>()),
  // The repo whose org the queue is read from — resolved by the data layer, so
  // the section never has to pick a project itself.
  useTriageOrgRepo: () => "acme/app",
  useTriageQueue: () => data.queue,
  useTriageSchedule: () => ({ data: data.schedules }),
  useSetSetting: () => ({ mutate: data.setSetting }),
  usePrefetchOnHover: () => data.hover,
  // The row's menu: its Linear address, and the snooze write and its gate.
  useLinearIssueUrl: () => (id: string) => `https://linear.app/acme/issue/${id}`,
  useLinearReadOnly: () => data.readOnly,
  useTriageSnooze: () => ({ mutate: data.snooze }),
}));
vi.mock("./useProjectTree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useProjectTree")>()),
  useTicketAgents: () => ({ agentsByTicket: data.agentsByTicket, markSeen: data.markSeen }),
}));
vi.mock("../../features/agents/useOpenAgent", () => ({ useOpenAgent: () => data.openAgent }));

import { TriageSection } from "./TriageSection";

const HOUR = 60 * 60 * 1000;

const ticket = (id: string, over: Partial<TriageTicket> = {}) =>
  triageTicket(id, { title: `Fix ${id}`, ...over });

function queue(over: Partial<TriageQueue>) {
  data.queue = { active: [], snoozed: [], goodCitizen: false, loading: false, ...over };
}

function schedule(over: Partial<TriageSchedule> = {}): TriageSchedule {
  return {
    team: "SAN",
    scheduleName: "SAN triage",
    currentName: "Sam Ortiz",
    currentAvatarUrl: null,
    currentIsMe: false,
    // Local 4 PM hand-overs, the way Linear schedules them — and the shape that
    // once rendered a day short when the end was treated as an exclusive midnight.
    shifts: [
      {
        name: "Sam Ortiz",
        avatarUrl: null,
        startsAtMs: new Date(2026, 7, 27, 16).getTime(),
        endsAtMs: new Date(2026, 8, 3, 16).getTime(),
        isCurrent: true,
        isMe: false,
      },
      {
        name: "Ana Reyes",
        avatarUrl: null,
        startsAtMs: new Date(2026, 8, 3, 16).getTime(),
        endsAtMs: new Date(2026, 8, 10, 16).getTime(),
        isCurrent: false,
        isMe: true,
      },
    ],
    ...over,
  };
}

const card = (id: string) => document.querySelector(`[data-ticket-id="${id}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  // The folds persist; one test's collapse must not be the next one's start.
  localStorage.clear();
  route.pathname = "/trees";
  route.ticket = undefined;
  app.triageEnabled = true;
  data.schedules = [];
  data.agentsByTicket = new Map();
  data.readOnly = false;
  queue({});
});

describe("TriageSection", () => {
  it("draws nothing while triage is off", () => {
    app.triageEnabled = false;
    queue({ active: [ticket("AK-1")] });
    const { container } = render(<TriageSection />);
    expect(container).toBeEmptyDOMElement();
  });

  /** The header's scope menu *is* the "be a good citizen" setting — the one
   *  control for it now that Settings no longer carries a copy. The trigger
   *  names the current scope; the menu marks it and offers the other. */
  it("writes the good-citizen setting from the header's scope menu", () => {
    queue({ goodCitizen: false });
    render(<TriageSection />);

    fireEvent.click(screen.getByRole("button", { name: "Triage scope: Mine" }));
    expect(screen.getByRole("menuitemradio", { name: /^Mine/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: /^All/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("menuitemradio", { name: /^All/ }));
    expect(data.setSetting).toHaveBeenCalledWith({
      scope: "app",
      key: TRIAGE_GOOD_CITIZEN_KEY,
      value: "true",
    });
    // A pick closes the menu.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Triage scope: Mine" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Mine/ }));
    expect(data.setSetting).toHaveBeenLastCalledWith({
      scope: "app",
      key: TRIAGE_GOOD_CITIZEN_KEY,
      value: null,
    });
  });

  it("lists each active ticket with its id, title and SLA clock", () => {
    queue({ active: [ticket("AK-1", { slaBreachMs: Date.now() + 3 * HOUR + 60_000 })] });
    render(<TriageSection />);

    expect(screen.getByText("AK-1")).toBeInTheDocument();
    expect(screen.getByText("Fix AK-1")).toBeInTheDocument();
    expect(screen.getByText("SLA in 3h")).toBeInTheDocument();
  });

  it("counts the active queue on the header, not the snoozed lane", () => {
    queue({ active: [ticket("AK-1"), ticket("AK-2")], snoozed: [ticket("AK-9")] });
    render(<TriageSection />);
    const count = screen.getByText("2");
    // Reference in the Reviews band's own muted register — not a tinted pill,
    // which read as an alarm on a rail that is open all day.
    expect(count.className).toContain("text-muted-4");
    expect(count.className).not.toMatch(/rounded-full|bg-\[/);
    // A bare number is not a fact; the noun rides along for a screen reader.
    expect(count).toHaveTextContent("2 in the queue");
  });

  /** The queue is a section of the rail, not a widget in it: it scrolls with the
   *  sidebar, and folding is how you stop seeing it. A capped viewport of its own
   *  is what it used to have. */
  it("scrolls with the sidebar rather than inside a viewport of its own", () => {
    queue({ active: [ticket("AK-1")] });
    const { container } = render(<TriageSection />);
    expect(container.querySelector("[class*='overflow-y']")).toBeNull();
    expect(container.querySelector("[class*='max-h-']")).toBeNull();
  });

  /** Selection follows the route and nothing else: the row lights while the
   *  workspace shows that ticket, and goes out the moment you are elsewhere. */
  it("lights the row of the ticket the route names, only while on Triage", () => {
    queue({ active: [ticket("AK-1"), ticket("AK-2")] });
    route.pathname = "/triage";
    route.ticket = "AK-2";
    const { rerender } = render(<TriageSection />);

    expect(card("AK-2")).toHaveAttribute("data-active", "true");
    expect(card("AK-1")).toHaveAttribute("data-active", "false");

    route.pathname = "/trees";
    rerender(<TriageSection />);
    expect(card("AK-2")).toHaveAttribute("data-active", "false");
  });

  it("opens a ticket by navigating to it, and warms its detail on hover", () => {
    queue({ active: [ticket("AK-1")] });
    render(<TriageSection />);

    const open = screen.getByRole("button", { name: "Open AK-1" });
    fireEvent.mouseEnter(open);
    expect(data.hover).toHaveBeenCalledWith("AK-1");

    fireEvent.click(open);
    expect(route.navigate).toHaveBeenCalledWith({ to: "/triage", search: { ticket: "AK-1" } });
  });

  /** A parked ticket is parked so it stops taking the queue's room: the lane
   *  starts folded, and inside it the row wears its wake date, not an SLA. */
  it("folds the snoozed lane by default and lists its tickets with their wake date", () => {
    const wake = Date.now() + 3 * 24 * HOUR;
    queue({
      active: [ticket("AK-1")],
      snoozed: [ticket("AK-9", { snoozedUntilMs: wake, slaBreachMs: Date.now() + HOUR })],
    });
    render(<TriageSection />);

    const lane = screen.getByRole("button", { name: "Expand snoozed tickets" });
    expect(lane).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("AK-9")).toBeNull();

    fireEvent.click(lane);
    expect(screen.getByText("AK-9")).toBeInTheDocument();
    expect(screen.getByText(formatSnoozeLabel(wake))).toBeInTheDocument();
    expect(screen.queryByText(/SLA in/)).toBeNull();
  });

  it("draws no snoozed lane when nothing is snoozed", () => {
    queue({ active: [ticket("AK-1")] });
    render(<TriageSection />);
    expect(screen.queryByRole("button", { name: /snoozed tickets/ })).toBeNull();
  });

  /** "We haven't looked yet" is not "nothing in triage": the cold load shows
   *  placeholder rows rather than asserting an empty queue. */
  it("shows skeleton rows while the queue loads, never the empty state", () => {
    queue({ loading: true });
    const { container } = render(<TriageSection />);

    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("Nothing in triage")).toBeNull();
  });

  it("says so once the queue has resolved to nothing", () => {
    queue({});
    render(<TriageSection />);
    expect(screen.getByText("Nothing in triage")).toBeInTheDocument();
  });

  it("folds the whole section from its header", () => {
    queue({ active: [ticket("AK-1")] });
    render(<TriageSection />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse triage" }));
    expect(screen.queryByText("AK-1")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand triage" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  /** A team tag on every row says nothing until there are two teams to tell
   *  apart. */
  it("tags rows with their team only when the queue spans more than one", () => {
    queue({ active: [ticket("AK-1", { team: "SAN" })] });
    const { rerender } = render(<TriageSection />);
    expect(screen.queryByText("SAN")).toBeNull();

    queue({ active: [ticket("AK-1", { team: "SAN" }), ticket("MS-2", { team: "MSG" })] });
    rerender(<TriageSection />);
    expect(screen.getByText("SAN")).toBeInTheDocument();
    expect(screen.getByText("MSG")).toBeInTheDocument();
  });

  /** An investigation hangs under its ticket the way a worktree's agents hang
   *  under the worktree, and opening it acknowledges the row first — the same
   *  path the project tree takes. */
  it("hangs a ticket's investigations under it and opens them acknowledged", () => {
    const entry = agentEntry({
      sessionId: "s1",
      bucket: "working",
      agentKind: "Codex",
      termKey: "triage:AK-1",
      purpose: "Investigation",
      message: "Reading the login handler",
    });
    data.agentsByTicket = new Map([
      ["AK-1", [{ entry, unseen: false, attention: { level: "working", at: 1, source: "hook" } }]],
    ]);
    queue({ active: [ticket("AK-1")] });
    render(<TriageSection />);

    const row = screen.getByRole("button", { name: /Reading the login handler/ });
    fireEvent.click(row);
    expect(data.markSeen).toHaveBeenCalledWith(entry);
    expect(data.openAgent).toHaveBeenCalledWith(entry);
  });

  describe("the rotation", () => {
    it("names who has it, and 'You' when it is you", () => {
      data.schedules = [schedule()];
      const { rerender } = render(<TriageSection />);
      expect(screen.getByText("Sam Ortiz")).toBeInTheDocument();

      data.schedules = [schedule({ currentIsMe: true })];
      rerender(<TriageSection />);
      expect(screen.getByText("You")).toBeInTheDocument();
    });

    it("says an uncovered rotation is uncovered rather than inventing a name", () => {
      data.schedules = [schedule({ currentName: null, currentAvatarUrl: null })];
      render(<TriageSection />);
      expect(screen.getByText("uncovered")).toBeInTheDocument();
    });

    /** The row keeps who and until when; the rest of the schedule is a dialog,
     *  not seven more rows in the rail. */
    it("shows the hand-off date, and opens the whole schedule in a dialog", () => {
      data.schedules = [schedule()];
      render(<TriageSection />);

      expect(screen.getByText("Aug 27 – Sep 3")).toBeInTheDocument();
      expect(screen.queryByText("Sep 3 – Sep 10")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Show the SAN triage rotation" }));
      const dialog = screen.getByRole("dialog", { name: "Sam Ortiz is on triage" });
      expect(dialog).toHaveTextContent("SAN triage");
      expect(dialog).toHaveTextContent("Sep 3 – Sep 10");
      // Your own shift says so when it isn't the current one; the current one
      // is marked as such.
      expect(screen.getByText(/Ana Reyes/)).toHaveTextContent("(you)");
      expect(screen.getByText("now")).toBeInTheDocument();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("names the team only when more than one rotation is on screen", () => {
      data.schedules = [schedule()];
      const { rerender } = render(<TriageSection />);
      expect(screen.queryByText("SAN")).toBeNull();

      data.schedules = [schedule(), schedule({ team: "MSG", scheduleName: "MSG triage" })];
      rerender(<TriageSection />);
      expect(screen.getByText("SAN")).toBeInTheDocument();
      expect(screen.getByText("MSG")).toBeInTheDocument();
    });
  });

  /** A ticket's right-click menu: its Linear rows, then the snooze — a Linear
   *  write, so disabled with the read-only hint when the org can't be written
   *  to, and reversed on a row that is already parked. */
  describe("the ticket menu", () => {
    const rows = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

    it("snoozes until tomorrow morning, or for a week", () => {
      queue({ active: [ticket("AK-1")] });
      render(<TriageSection />);
      fireEvent.contextMenu(card("AK-1") as HTMLElement);
      expect(rows()).toEqual([
        "Open in Linear",
        "Copy ticket id",
        "Copy link",
        "Snooze until tomorrow",
        "Snooze for a week",
      ]);

      fireEvent.click(screen.getByRole("menuitem", { name: "Snooze until tomorrow" }));
      expect(data.snooze).toHaveBeenCalledOnce();
      const { ticketId, untilMs } = data.snooze.mock.calls[0][0];
      expect(ticketId).toBe("AK-1");
      const wake = new Date(untilMs);
      expect(wake.getHours()).toBe(9);
      expect(untilMs).toBeGreaterThan(Date.now());
      expect(untilMs - Date.now()).toBeLessThan(2 * 24 * HOUR);
    });

    it("wakes a snoozed ticket instead", () => {
      queue({ snoozed: [ticket("AK-2", { snoozedUntilMs: Date.now() + 3 * HOUR })] });
      render(<TriageSection />);
      fireEvent.click(screen.getByRole("button", { name: "Expand snoozed tickets" }));
      fireEvent.contextMenu(card("AK-2") as HTMLElement);
      expect(rows()).toContain("Wake up now");
      expect(rows()).not.toContain("Snooze for a week");

      fireEvent.click(screen.getByRole("menuitem", { name: "Wake up now" }));
      expect(data.snooze).toHaveBeenCalledWith({ ticketId: "AK-2", untilMs: null });
    });

    it("keeps the snooze rows but disables them on a read-only org", () => {
      data.readOnly = true;
      queue({ active: [ticket("AK-1")] });
      render(<TriageSection />);
      fireEvent.contextMenu(card("AK-1") as HTMLElement);
      const snooze = screen.getByRole("menuitem", { name: "Snooze for a week" });
      expect(snooze).toBeDisabled();
      expect(snooze).toHaveAttribute("title", expect.stringMatching(/read-only/i));
      expect(screen.getByRole("menuitem", { name: "Copy ticket id" })).toBeEnabled();
    });
  });
});
