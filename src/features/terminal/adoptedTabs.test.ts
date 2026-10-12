import { describe, expect, test } from "vitest";

import type { AdoptedSession } from "../../bindings";
import { adoptedMap, adoptedTabSpec, repoOfCwd, sourceOfTermKey } from "./adoptedTabs";
import { paneAddress } from "./paneAddress";

const repos = [
  { name: "acme/web", path: "/Users/me/web" },
  { name: "acme/web-extras", path: "/Users/me/web-extras" },
  { name: "box/api", path: "/srv/projects/api" },
  { name: "ghost", path: null },
];

const session = (over: Partial<AdoptedSession>): AdoptedSession => ({
  id: 1,
  label: "tree:AK-1",
  agentKind: null,
  cwd: "/Users/me/web/.santree/worktrees/AK-1",
  command: "",
  ...over,
});

test("sourceOfTermKey matches the source each launch site opens its pane under", () => {
  expect(sourceOfTermKey("tree:AK-1")).toBe("issue");
  expect(sourceOfTermKey("tree:AK-1:tab:t1")).toBe("issue");
  expect(sourceOfTermKey("triage:AK-1")).toBe("triage");
  expect(sourceOfTermKey("triage:AK-1:tab:t1")).toBe("triage");
  expect(sourceOfTermKey("ai-review:acme/web#7")).toBe("review");
  expect(sourceOfTermKey("review:acme/web#7")).toBe("review");
  // Anything else names no surface, so it gets no tab.
  expect(sourceOfTermKey("settings:login")).toBeNull();
  expect(sourceOfTermKey("")).toBeNull();
});

test("repoOfCwd finds the deepest project a directory sits in, component-wise", () => {
  expect(repoOfCwd(repos, "/Users/me/web")).toBe("acme/web");
  expect(repoOfCwd(repos, "/Users/me/web/.santree/worktrees/AK-1")).toBe("acme/web");
  // A sibling that merely shares a prefix is not it.
  expect(repoOfCwd(repos, "/Users/me/web-extras/x")).toBe("acme/web-extras");
  expect(repoOfCwd(repos, "/srv/projects/api/.santree/worktrees/B-2")).toBe("box/api");
  expect(repoOfCwd(repos, "/elsewhere")).toBeNull();
  expect(repoOfCwd(repos, null)).toBeNull();
});

describe("adoptedTabSpec", () => {
  test("a shell needs no project: surface, directory and nothing else", () => {
    expect(adoptedTabSpec(session({ label: "tree:AK-1:tab:t1" }), repos)).toEqual({
      title: "AK-1",
      cwd: "/Users/me/web/.santree/worktrees/AK-1",
      source: "issue",
      refId: "tree:AK-1:tab:t1",
    });
  });

  test("an agent carries its whole identity, with the project found from its directory", () => {
    const spec = adoptedTabSpec(session({ agentKind: "Codex" }), repos);
    expect(spec).toMatchObject({
      source: "issue",
      refId: "tree:AK-1",
      agent: { kind: "Codex", repo: "acme/web", termKey: "tree:AK-1" },
    });
    // No seed and no command: the process is already running.
    expect(spec?.seed).toBeUndefined();
    expect(spec?.command).toBeUndefined();
  });

  test("an agent whose project cannot be named waits for its own view", () => {
    // A partial identity could file it under the wrong project; its view's
    // `ensure` will find it by address when opened.
    expect(adoptedTabSpec(session({ agentKind: "Claude", cwd: "/elsewhere" }), repos)).toBeNull();
    expect(adoptedTabSpec(session({ agentKind: "Claude", cwd: null }), repos)).toBeNull();
  });
});

describe("adoptedMap", () => {
  test("keys by label and provider, so two providers on one surface keep their own", () => {
    const map = adoptedMap([
      session({ id: 5, label: "ai-review:acme/web#7", agentKind: "Claude" }),
      session({ id: 6, label: "ai-review:acme/web#7", agentKind: "Codex" }),
      session({ id: 7, label: "tree:AK-1" }),
    ]);
    expect(map.get(paneAddress("ai-review:acme/web#7", "Claude"))).toBe(5);
    expect(map.get(paneAddress("ai-review:acme/web#7", "Codex"))).toBe(6);
    expect(map.get(paneAddress("tree:AK-1"))).toBe(7);
  });
});
