import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnglishTutorSection } from "./EnglishTutor";

// Settings → English tutor is a leaf view over the settings/tutor hooks: mock the
// data layer so the pane renders without a Tauri backend.
type Day = { date: string; entries: { original: string; correction: string; reason: string }[] };
let log:
  | { path: string; days: Day[]; entryCount: number; unparsed: number; updatedAtMs: number | null }
  | undefined;
let analysis: {
  text: string;
  entryCount: number;
  scope: string;
  createdAtMs: number;
} | null = null;
const analyze = vi.fn();

vi.mock("../../../lib/queries", () => ({
  ENGLISH_TUTOR_KEY: "english_tutor",
  useEnglishLog: () => ({ data: log, isLoading: false }),
  useEnglishAnalysis: () => ({ data: analysis }),
  useRunEnglishAnalysis: () => ({ mutate: analyze, isPending: false, variables: undefined }),
  useSetSetting: () => ({ mutate: vi.fn() }),
  useSetting: () => ({ data: "false" }),
}));

vi.mock("../../../components/Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

const day = (date: string, n: number): Day => ({
  date,
  entries: Array.from({ length: n }, (_, i) => ({
    original: `orig-${date}-${i}`,
    correction: `corr-${date}-${i}`,
    reason: `reason-${i}`,
  })),
});

/** The collapsible day headers, in DOM order. They're the only buttons carrying
 *  `aria-expanded`, which separates them from the toggle and the scope buttons. */
const dayHeaders = () =>
  screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"));

const makeLog = (days: Day[]) => ({
  path: "/home/u/.config/santree/english-practice-log.md",
  days,
  entryCount: days.reduce((n, d) => n + d.entries.length, 0),
  unparsed: 0,
  updatedAtMs: Date.now(),
});

describe("Settings → English tutor", () => {
  beforeEach(() => {
    log = makeLog([day("2026-07-29", 2), day("2026-07-30", 3)]);
    analysis = null;
    analyze.mockClear();
  });

  it("lists days newest-first with the newest expanded", () => {
    render(<EnglishTutorSection />);

    // The backend ships chronological order; the pane must reverse it, or you land
    // on May when you opened the panel to see today.
    const headers = dayHeaders();
    expect(within(headers[0]).getByText("2026-07-30")).toBeInTheDocument();
    expect(headers[0]).toHaveAttribute("aria-expanded", "true");
    expect(headers[1]).toHaveAttribute("aria-expanded", "false");

    // Newest day's entries are visible; the collapsed day's are not.
    expect(screen.getByText("corr-2026-07-30-0")).toBeInTheDocument();
    expect(screen.queryByText("corr-2026-07-29-0")).not.toBeInTheDocument();
  });

  it("expands a collapsed day on click", () => {
    render(<EnglishTutorSection />);
    const headers = dayHeaders();

    fireEvent.click(headers[1]);

    expect(screen.getByText("corr-2026-07-29-0")).toBeInTheDocument();
    expect(screen.getByText("orig-2026-07-29-0")).toBeInTheDocument();
  });

  it("renders the ISO date as a local calendar day, not a UTC-shifted one", () => {
    log = makeLog([day("2026-07-30", 1)]);
    render(<EnglishTutorSection />);

    // `new Date("2026-07-30")` is UTC midnight, which formats as the 29th anywhere
    // west of Greenwich — so the header would read "Wed, Jul 29" beside an ISO
    // label saying 2026-07-30. Asserting the absence of "29" catches exactly that.
    // (Only load-bearing in a negative-offset timezone, which is where the bug
    // exists at all; harmless elsewhere.)
    const header = dayHeaders()[0];
    expect(header.textContent).toMatch(/30/);
    expect(header.textContent).not.toMatch(/29/);
  });

  it("fires the analysis with the scope of the button pressed", () => {
    render(<EnglishTutorSection />);

    fireEvent.click(screen.getByRole("button", { name: /last 7 days/i }));
    expect(analyze).toHaveBeenCalledWith("LastWeek");

    fireEvent.click(screen.getByRole("button", { name: /since last/i }));
    expect(analyze).toHaveBeenCalledWith("SinceLast");
  });

  it("won't offer to analyze an empty log", () => {
    log = makeLog([]);
    render(<EnglishTutorSection />);

    // Spending a model call on a log with nothing in it can only produce an
    // invented answer, so every window is unavailable rather than merely unhelpful.
    for (const name of [/last 7 days/i, /last 30 days/i, /since last/i, /everything/i]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("says which window the stored analysis covered, and how far behind it is", () => {
    log = makeLog([day("2026-07-30", 30)]);
    analysis = {
      text: "Work on articles.",
      entryCount: 18,
      scope: "LastMonth",
      createdAtMs: Date.now(),
    };
    render(<EnglishTutorSection />);

    // Advice from 30 days reads very differently from advice from the whole log,
    // and advice that's 12 corrections stale shouldn't look current.
    expect(screen.getByText(/Covering last 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/12 newer corrections since/)).toBeInTheDocument();
  });

  it("surfaces lines the parser couldn't read instead of hiding them", () => {
    log = { ...makeLog([day("2026-07-30", 2)]), unparsed: 3 };
    render(<EnglishTutorSection />);

    // A parser that silently drops entries is worse than none — the count has to
    // be visible, or the log looks shorter than the file actually is.
    expect(screen.getByText(/3 lines in the file couldn't be read/)).toBeInTheDocument();
  });
});
