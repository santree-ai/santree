import { describe, expect, it } from "vitest";

import { trackerOf } from "./tracker";

describe("trackerOf", () => {
  it("names Jira only when the detail says so", () => {
    expect(trackerOf("Jira")).toBe("Jira");
    expect(trackerOf("Linear")).toBe("Linear");
  });

  it("reads a detail with no tracker name as Linear's", () => {
    expect(trackerOf(undefined)).toBe("Linear");
    expect(trackerOf(null)).toBe("Linear");
  });
});
