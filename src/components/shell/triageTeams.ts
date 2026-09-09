/**
 * The Triage section's shape: one group per team, each a rotation card with
 * the team's tickets under it.
 *
 * The two reads land separately — the queue and the schedules are different
 * commands on one shared scope — so the grouping is built from both sides:
 * every schedule is a group whether or not it has tickets yet, and a ticket
 * whose team has no schedule (the other read still in flight, or a ticket
 * assigned since the scope was cached) gets a group of its own, named by its
 * key. A ticket with no team at all goes last, under no name. Pure, so the
 * rule is testable without the section.
 */
import type { TriageSchedule, TriageTicket } from "../../bindings";

export interface TriageTeamGroup {
  /** The team's key — `""` for the tickets that name no team. */
  key: string;
  /** The team's name from its schedule, else its key. */
  name: string;
  /** The team's rotation card, when the schedule read has it. */
  schedule: TriageSchedule | null;
  active: TriageTicket[];
  snoozed: TriageTicket[];
}

export function groupTriageByTeam(
  active: TriageTicket[],
  snoozed: TriageTicket[],
  schedules: TriageSchedule[],
): TriageTeamGroup[] {
  // Schedules first, in the backend's order: the rotations the viewer is in,
  // then the teams holding a ticket of theirs.
  const groups = new Map<string, TriageTeamGroup>();
  for (const schedule of schedules) {
    if (groups.has(schedule.teamKey)) continue;
    groups.set(schedule.teamKey, {
      key: schedule.teamKey,
      name: schedule.team,
      schedule,
      active: [],
      snoozed: [],
    });
  }
  const groupFor = (ticket: TriageTicket) => {
    const key = ticket.team ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { key, name: key, schedule: null, active: [], snoozed: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const ticket of active) groupFor(ticket).active.push(ticket);
  for (const ticket of snoozed) groupFor(ticket).snoozed.push(ticket);

  // The nameless group, if any, last — a card-less team still names itself.
  const nameless = groups.get("");
  if (nameless) {
    groups.delete("");
    groups.set("", nameless);
  }
  return [...groups.values()];
}
