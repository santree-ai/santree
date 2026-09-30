import { describe, expect, it } from "vitest";

import type { DaedalusLink } from "../bindings";
import { agentOff, gitOff, OUT_OF_REACH, onDaedalus, runOff } from "./daedalusLink";

const connected: DaedalusLink = {
  kind: "Connected",
  hostname: "box",
  version: "0.1.0",
  projectsRoot: "/srv/projects",
  agent: null,
};
const down: DaedalusLink = { kind: "Unavailable", reason: "unreachable" };

describe("what a project can do from here", () => {
  it("runs a Daedalus project's terminals, setup and agents on the box", () => {
    expect(runOff(true, connected)).toBeUndefined();
    expect(gitOff(true, connected)).toBeUndefined();
    expect(agentOff(true, connected)).toBeUndefined();
    expect(agentOff(true, connected, "Codex", ["Claude", "Codex"])).toBeUndefined();
  });

  it("says which agent the box lacks, once the box has said", () => {
    expect(agentOff(true, connected, "Codex", ["Claude"])).toBe(
      "Codex isn't installed on Daedalus",
    );
    expect(agentOff(true, connected, "Claude", [])).toBe("Claude Code isn't installed on Daedalus");
    // Not asked yet (or couldn't be): the launch itself says so, if it must.
    expect(agentOff(true, connected, "Codex", null)).toBeUndefined();
    expect(agentOff(true, connected, "Codex")).toBeUndefined();
  });

  it("offers none of it while the box is out of reach", () => {
    expect(runOff(true, down)).toBe(OUT_OF_REACH);
    expect(gitOff(true, down)).toBe(OUT_OF_REACH);
    expect(agentOff(true, down)).toBe(OUT_OF_REACH);
    expect(agentOff(true, down, "Claude", ["Claude"])).toBe(OUT_OF_REACH);
  });

  it("leaves a project on this Mac alone", () => {
    expect(runOff(false, down)).toBeUndefined();
    expect(agentOff(false, down)).toBeUndefined();
    expect(agentOff(false, down, "Codex", [])).toBeUndefined();
  });
});

describe("onDaedalus", () => {
  const repos = [
    { location: "Daedalus", path: "/srv/projects/web" },
    { location: "Local", path: "/Users/me/app" },
  ];

  it("is true inside a Daedalus project's checkout, its worktrees included", () => {
    expect(onDaedalus(repos, "/srv/projects/web")).toBe(true);
    expect(onDaedalus(repos, "/srv/projects/web/.santree/worktrees/AK-1")).toBe(true);
  });

  it("is false for a local project, a sibling sharing a prefix, or nothing known", () => {
    expect(onDaedalus(repos, "/Users/me/app")).toBe(false);
    expect(onDaedalus(repos, "/srv/projects/webby")).toBe(false);
    expect(onDaedalus(repos, undefined)).toBe(false);
    expect(onDaedalus(undefined, "/srv/projects/web")).toBe(false);
  });
});
