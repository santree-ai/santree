import { describe, expect, it } from "vitest";

import { normalizeLinearMarkdown } from "./Markdown";

const NBSP = String.fromCharCode(160);

describe("normalizeLinearMarkdown", () => {
  it("leaves well-formed markdown alone", () => {
    const md = "# Title\n\n**Bold** and *italic* and `code`.\n\n- a\n- b\n";
    expect(normalizeLinearMarkdown(md)).toBe(md);
  });

  it("replaces the non-breaking spaces Linear's editor emits", () => {
    expect(normalizeLinearMarkdown(`Steps${NBSP}to${NBSP}repro`)).toBe("Steps to repro");
  });

  // The headline case: Linear writes `**Description: **`, which CommonMark refuses to
  // bold because the closing delimiter is preceded by whitespace.
  it("moves whitespace out of bold delimiters so the run actually closes", () => {
    expect(normalizeLinearMarkdown("**Description: **rest")).toBe("**Description:** rest");
    expect(normalizeLinearMarkdown(`**Description:${NBSP}**rest`)).toBe("**Description:** rest");
  });

  // The whitespace is moved *outside* the delimiters, so it can double up against
  // spacing that was already there. That's inert: markdown collapses runs of spaces,
  // and `remarkBreaks` already turns every newline into a <br>, so even a trailing
  // double space can't sneak in a hard break. Pinned so the doubling stays a known
  // cosmetic artifact of the source rather than a surprise.
  it("moves leading whitespace out too, keeping the text in place", () => {
    expect(normalizeLinearMarkdown("a ** bold ** b")).toBe("a  **bold**  b");
  });

  it("drops a line that is nothing but a stray `**`", () => {
    expect(normalizeLinearMarkdown("before\n**\nafter")).toBe("before\n\nafter");
    expect(normalizeLinearMarkdown("before\n  **  \nafter")).toBe("before\n\nafter");
  });

  it("normalizes every bold run on a line, not just the first", () => {
    expect(normalizeLinearMarkdown("**one ** and **two **")).toBe("**one**  and **two** ");
  });

  // A bold run can't span a newline in CommonMark, so the normalizer must not stitch
  // two unrelated `**` pairs across lines into one.
  it("does not merge bold delimiters across a line break", () => {
    expect(normalizeLinearMarkdown("**a\nb**")).toBe("**a\nb**");
  });

  it("leaves an unpaired `**` inside a line alone", () => {
    expect(normalizeLinearMarkdown("2 ** 3 = 8")).toBe("2 ** 3 = 8");
  });
});
