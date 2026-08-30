import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionTitle,
  resetSessionTitles,
  sessionTitles,
  setSessionTitle,
  subscribeSessionTitles,
} from "./sessionTitles";

beforeEach(() => {
  resetSessionTitles();
});

/** How many snapshots the store publishes while `run` executes. */
function publishes(run: () => void): number {
  let n = 0;
  const stop = subscribeSessionTitles(() => {
    n += 1;
  });
  try {
    run();
  } finally {
    stop();
  }
  return n;
}

describe("sessionTitles", () => {
  it("records a pane's title under its label", () => {
    setSessionTitle("tree:AK-1", "◐ Fix the flaky suite");
    expect(sessionTitles().get("tree:AK-1")).toBe("◐ Fix the flaky suite");
  });

  it("keeps panes apart", () => {
    setSessionTitle("tree:AK-1", "◐ one");
    setSessionTitle("tree:AK-2", "✳ two");
    expect([...sessionTitles().entries()]).toEqual([
      ["tree:AK-1", "◐ one"],
      ["tree:AK-2", "✳ two"],
    ]);
  });

  it("publishes nothing for a spinner frame", () => {
    // Codex rewrites its title ~10×/second while it runs, and every frame means
    // the same thing. Waking the sidebar tree for each of them would re-render
    // thirty rows to change nothing anyone can see.
    setSessionTitle("tree:AK-1", "⠋ santree-app");
    const before = sessionTitles();
    const n = publishes(() => {
      for (const frame of ["⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
        setSessionTitle("tree:AK-1", `${frame} santree-app`);
      }
    });
    expect(n).toBe(0);
    expect(sessionTitles()).toBe(before);
  });

  it("publishes once when the meaning changes", () => {
    setSessionTitle("tree:AK-1", "⠋ santree-app");
    const n = publishes(() => setSessionTitle("tree:AK-1", "✳ santree-app"));
    expect(n).toBe(1);
    expect(sessionTitles().get("tree:AK-1")).toBe("✳ santree-app");
  });

  it("forgets a pane's title when its PTY goes away", () => {
    // A title outliving its process would report "working" forever, with
    // nothing left running that could ever correct it.
    setSessionTitle("tree:AK-1", "◐ Fix the flaky suite");
    const n = publishes(() => clearSessionTitle("tree:AK-1"));
    expect(n).toBe(1);
    expect(sessionTitles().has("tree:AK-1")).toBe(false);
  });

  it("says nothing when asked to clear a pane it never had", () => {
    expect(publishes(() => clearSessionTitle("tree:AK-9"))).toBe(0);
  });

  it("re-publishes a repeated title after its pane was cleared", () => {
    // The coalescing above must not swallow the first title of a pane torn down
    // and reopened at the same label with the same status.
    setSessionTitle("tree:AK-1", "◐ working");
    clearSessionTitle("tree:AK-1");
    setSessionTitle("tree:AK-1", "◐ working");
    expect(sessionTitles().get("tree:AK-1")).toBe("◐ working");
  });
});
