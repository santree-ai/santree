import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrLabel, ReviewPr } from "../../bindings";
import { readableLabelColor } from "../../theme/colors";
import { PrLabels } from "./PrLabels";

// GitHub's default palette runs to both extremes: `ededed` is invisible on a light
// background, `0e1116` on a dark one.
const PALE: PrLabel = { name: "wontfix", color: "ededed", description: null };
const DARK: PrLabel = { name: "bug", color: "0e1116", description: null };

vi.mock("../../lib/queries", () => ({
  usePrDetail: () => ({ data: { labels: [PALE] } }),
  useRepoLabels: () => ({ data: [PALE, DARK] }),
  useSetPrLabels: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../theme/useResolvedTheme", () => ({ useResolvedTheme: () => "light" }));

const pr = { number: 483, repo: "acme/booking-agent" } as ReviewPr;

/** The picker row's leading color dot. */
function swatch(label: string): HTMLElement {
  const row = screen.getByRole("button", { name: label });
  const dot = row.querySelector("span");
  if (!dot) throw new Error(`no swatch on the ${label} row`);
  return dot as HTMLElement;
}

describe("PrLabels picker", () => {
  it("tints every swatch with the readable color, not the raw GitHub hex", () => {
    render(<PrLabels pr={pr} />);
    fireEvent.click(screen.getByTitle("Add or remove labels"));

    // In light mode a near-white label must be darkened, not painted as-is.
    expect(swatch("wontfix")).toHaveStyle({
      background: readableLabelColor(PALE.color, "light"),
    });
    expect(swatch("wontfix")).not.toHaveStyle({ background: "#ededed" });
    expect(swatch("bug")).toHaveStyle({ background: readableLabelColor(DARK.color, "light") });
  });
});
