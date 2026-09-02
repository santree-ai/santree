import { describe, expect, it } from "vitest";

import { rankItems, scoreItem, tokenize } from "./paletteSearch";

const ORDER = ["Navigate", "Tickets", "Pull requests", "Worktrees"] as const;
const opts = { groupOrder: ORDER, perGroup: 8, perGroupIdle: 2, total: 50 };

const items = [
  { key: "nav", group: "Navigate", label: "Tickets" },
  { key: "t1", group: "Tickets", code: "AK-339", label: "Add baseline evals", meta: "WIRE" },
  { key: "t2", group: "Tickets", code: "AK-33", label: "Mentions AK-339 in passing" },
  { key: "t3", group: "Tickets", code: "AK-276", label: "Content identity preservation" },
  { key: "t4", group: "Tickets", code: "AK-373", label: "KB conflict/duplicate judge" },
  { key: "p1", group: "Pull requests", code: "#53957", label: "AK-276 re-ingest", meta: "canary" },
  { key: "w1", group: "Worktrees", code: "AK-276", label: "Content identity", meta: "feat/ak-276" },
];

describe("tokenize", () => {
  it("splits on whitespace and lowercases", () => {
    expect(tokenize("  KB  Dupes ")).toEqual(["kb", "dupes"]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("scoreItem", () => {
  it("ranks an exact id above a title that only contains it", () => {
    const [exact, mention] = [items[1], items[2]];
    expect(scoreItem(exact, ["ak-339"])).toBeGreaterThan(scoreItem(mention, ["ak-339"]));
  });

  it("matches an id typed without its dash", () => {
    expect(scoreItem(items[1], ["ak339"])).toBe(10);
    expect(scoreItem(items[3], ["ak2"])).toBe(8);
  });

  it("prefers a title that starts with the word over one that has it inside", () => {
    const starts = { label: "Content identity" };
    const inside = { label: "Preserve content identity" };
    const buried = { label: "Discontent" };
    expect(scoreItem(starts, ["content"])).toBeGreaterThan(scoreItem(inside, ["content"]));
    expect(scoreItem(inside, ["content"])).toBeGreaterThan(scoreItem(buried, ["content"]));
  });

  it("needs every token to land somewhere", () => {
    expect(scoreItem(items[4], ["kb", "judge"])).toBeGreaterThan(0);
    expect(scoreItem(items[4], ["kb", "nowhere"])).toBe(0);
  });

  it("finds a row by what sits behind it, as a last resort", () => {
    expect(scoreItem(items[5], ["canary"])).toBe(1);
    expect(scoreItem({ label: "x", keywords: "sam" }, ["sam"])).toBe(1);
  });
});

describe("rankItems", () => {
  it("shows a few of every group when nothing is typed, in group order", () => {
    expect(rankItems(items, "", opts).map((i) => i.key)).toEqual(["nav", "t1", "t2", "p1", "w1"]);
  });

  it("keeps groups in order and puts the best match first within each", () => {
    expect(rankItems(items, "AK-276", opts).map((i) => i.key)).toEqual(["t3", "p1", "w1"]);
    // The id wins its group even though the mention was listed first.
    expect(rankItems(items, "ak-339", opts).map((i) => i.key)).toEqual(["t1", "t2"]);
  });

  it("caps each group and the whole list", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      key: `t${i}`,
      group: "Tickets",
      label: `Ticket ${i}`,
    }));
    expect(rankItems(many, "ticket", { ...opts, perGroup: 3 })).toHaveLength(3);
    expect(rankItems(many, "ticket", { ...opts, total: 5 })).toHaveLength(5);
  });

  it("is empty when nothing matches", () => {
    expect(rankItems(items, "zzz", opts)).toEqual([]);
  });
});
