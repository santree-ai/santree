import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnglishTutorSection } from "./EnglishTutor";

// Settings → English tutor is a leaf view over the settings/tutor hooks: mock the
// data layer so the pane renders without a Tauri backend.
let log: { path: string; text: string; entryCount: number; updatedAtMs: number | null } | undefined;
let analysis: { text: string; entryCount: number; createdAtMs: number } | null = null;
const analyze = vi.fn();

vi.mock("../../../lib/queries", () => ({
  ENGLISH_TUTOR_KEY: "english_tutor",
  useEnglishLog: () => ({ data: log, isLoading: false }),
  useEnglishAnalysis: () => ({ data: analysis }),
  useRunEnglishAnalysis: () => ({ mutate: analyze, isPending: false }),
  useSetSetting: () => ({ mutate: vi.fn() }),
  useSetting: () => ({ data: "false" }),
}));

vi.mock("../../../components/Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

const LOG = (entryCount: number) => ({
  path: "/home/u/.config/santree/english-practice-log.md",
  text: "## 2026-08-07\n- a -> b (reason)\n",
  entryCount,
  updatedAtMs: Date.now(),
});

describe("Settings → English tutor", () => {
  beforeEach(() => {
    log = LOG(12);
    analysis = null;
    analyze.mockClear();
  });

  it("won't offer to analyze an empty log", () => {
    log = LOG(0);
    render(<EnglishTutorSection />);

    // Spending a model call on a log with nothing in it can only produce an
    // invented answer, so the button is unavailable rather than merely unhelpful.
    expect(screen.getByRole("button", { name: /analyze/i })).toBeDisabled();
  });

  it("says how far the stored analysis has fallen behind the log", () => {
    log = LOG(30);
    analysis = { text: "Work on articles.", entryCount: 18, createdAtMs: Date.now() };
    render(<EnglishTutorSection />);

    // An analysis presented as current, when 12 corrections have landed since, is
    // the one failure mode that actively misleads — it's advice about old habits.
    expect(screen.getByText(/12 newer corrections since/)).toBeInTheDocument();
  });

  it("shows no staleness note when the analysis covers the whole log", () => {
    log = LOG(18);
    analysis = { text: "Work on articles.", entryCount: 18, createdAtMs: Date.now() };
    render(<EnglishTutorSection />);

    expect(screen.queryByText(/newer correction/)).not.toBeInTheDocument();
  });

  it("keeps the log read-only — the agent appends to it mid-turn", () => {
    render(<EnglishTutorSection />);

    // An editable box here would race an in-flight append and lose one of the two.
    const box = screen.getByRole("textbox", { name: /practice log/i });
    expect(box).toHaveAttribute("readonly");
  });
});
