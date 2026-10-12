import { describe, expect, it } from "vitest";

import type { TriageSchedule } from "../../bindings";
import { triageTicket } from "../../test/fixtures";
import { groupTriageByTeam } from "./triageTeams";

function schedule(teamKey: string, team: string): TriageSchedule {
  return {
    team,
    teamKey,
    scheduleName: `${team} on-call`,
    currentName: null,
    currentAvatarUrl: null,
    currentIsMe: false,
    shifts: [],
  };
}

describe("groupTriageByTeam", () => {
  // A rotation with nothing in it is still a rotation: its card stays.
  it("hangs each ticket under its team's schedule, schedules in the backend's order, empty ones kept", () => {
    const groups = groupTriageByTeam(
      [triageTicket("MS-1", { team: "MSG" }), triageTicket("AK-1", { team: "AK" })],
      [triageTicket("AK-9", { team: "AK" })],
      [schedule("AK", "App"), schedule("MSG", "Messaging"), schedule("OPS", "Ops")],
    );
    expect(groups.map((g) => [g.key, g.name])).toEqual([
      ["AK", "App"],
      ["MSG", "Messaging"],
      ["OPS", "Ops"],
    ]);
    expect(groups[2].active).toEqual([]);
    expect(groups[0].active.map((t) => t.id)).toEqual(["AK-1"]);
    expect(groups[0].snoozed.map((t) => t.id)).toEqual(["AK-9"]);
    expect(groups[1].active.map((t) => t.id)).toEqual(["MS-1"]);
    expect(groups[1].schedule?.scheduleName).toBe("Messaging on-call");
  });

  /** The schedule read can land after the queue's, or miss a team a ticket was
   *  just assigned from: the ticket still has a group, named by its key. */
  it("gives a ticket whose team has no schedule a card-less group named by its key", () => {
    const groups = groupTriageByTeam(
      [triageTicket("AK-1", { team: "AK" }), triageTicket("OP-2", { team: "OPS" })],
      [],
      [schedule("AK", "App")],
    );
    expect(groups.map((g) => [g.key, g.name, g.schedule === null])).toEqual([
      ["AK", "App", false],
      ["OPS", "OPS", true],
    ]);
  });

  it("puts tickets with no team last, under no name", () => {
    const groups = groupTriageByTeam(
      [triageTicket("X-1", { team: null }), triageTicket("AK-1", { team: "AK" })],
      [],
      [],
    );
    expect(groups.map((g) => g.key)).toEqual(["AK", ""]);
    expect(groups[1].name).toBe("");
    expect(groups[1].active.map((t) => t.id)).toEqual(["X-1"]);
  });
});
