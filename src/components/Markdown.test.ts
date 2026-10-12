import { describe, expect, it } from "vitest";

import { normalizeLinearMarkdown } from "./Markdown";

const NBSP = String.fromCharCode(160);

describe("normalizeLinearMarkdown", () => {
  it("leaves well-formed markdown and unpaired or cross-line `**` alone", () => {
    for (const md of [
      "# Title\n\n**Bold** and *italic* and `code`.\n\n- a\n- b\n",
      // A bold run can't span a newline in CommonMark; don't stitch two pairs together.
      "**a\nb**",
      "2 ** 3 = 8",
    ]) {
      expect(normalizeLinearMarkdown(md)).toBe(md);
    }
  });

  it("replaces the non-breaking spaces Linear's editor emits", () => {
    expect(normalizeLinearMarkdown(`Steps${NBSP}to${NBSP}repro`)).toBe("Steps to repro");
  });

  // The headline case: Linear writes `**Description: **`, which CommonMark refuses to
  // bold because the closing delimiter is preceded by whitespace. The whitespace moves
  // *outside* the delimiters, so it can double up against existing spacing — inert,
  // since markdown collapses runs of spaces.
  it("moves whitespace out of every bold run's delimiters so the run actually closes", () => {
    expect(normalizeLinearMarkdown("**Description: **rest")).toBe("**Description:** rest");
    expect(normalizeLinearMarkdown(`**Description:${NBSP}**rest`)).toBe("**Description:** rest");
    expect(normalizeLinearMarkdown("a ** bold ** b")).toBe("a  **bold**  b");
    expect(normalizeLinearMarkdown("**one ** and **two **")).toBe("**one**  and **two** ");
  });

  it("drops a line that is nothing but a stray `**`", () => {
    expect(normalizeLinearMarkdown("before\n**\nafter")).toBe("before\n\nafter");
    expect(normalizeLinearMarkdown("before\n  **  \nafter")).toBe("before\n\nafter");
  });
});
