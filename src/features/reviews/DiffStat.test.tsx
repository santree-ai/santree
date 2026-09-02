import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DiffStat, diffStatLabel } from "./DiffStat";

describe("diffStatLabel", () => {
  it("spells out both totals, since +/− says nothing aloud", () => {
    expect(diffStatLabel(1602, 1)).toBe("1,602 additions and 1 deletion");
    expect(diffStatLabel(0, 0)).toBe("0 additions and 0 deletions");
  });
});

describe("DiffStat", () => {
  /** Read as one thing, not as four: "+1,602 −1" spoken literally is a plus
   *  sign, a number, a minus sign and another number. */
  it("labels the whole stat once", () => {
    render(<DiffStat additions={1602} deletions={1} />);

    const stat = screen.getByRole("img", { name: "1,602 additions and 1 deletion" });
    // Thousands separators are for the eye.
    expect(stat).toHaveTextContent("+1,602");
    expect(stat).toHaveTextContent("−1");
  });

  /** The five squares that used to trail the numbers are gone: at this size they
   *  said roughly what the numbers say exactly, on a strip already carrying three
   *  other counts. */
  it("draws nothing but the two totals", () => {
    const { container } = render(<DiffStat additions={40} deletions={0} />);
    expect(container.querySelectorAll("span > span")).toHaveLength(2);
  });
});
