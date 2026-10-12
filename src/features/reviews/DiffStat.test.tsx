import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DiffStat } from "./DiffStat";

describe("DiffStat", () => {
  /** Read as one thing, not as four: "+1,602 −1" spoken literally is a plus
   *  sign, a number, a minus sign and another number. */
  it("labels the whole stat once, spelling out both totals", () => {
    render(<DiffStat additions={1602} deletions={1} />);

    const stat = screen.getByRole("img", { name: "1,602 additions and 1 deletion" });
    // Thousands separators are for the eye.
    expect(stat).toHaveTextContent("+1,602");
    expect(stat).toHaveTextContent("−1");
  });
});
