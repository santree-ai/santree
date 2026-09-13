import type { TicketProvider } from "../bindings";

/** A ticket detail's `trackerName` as the provider it names. A detail without
 *  one predates Jira, and every such detail was Linear's. */
export const trackerOf = (name: string | null | undefined): TicketProvider =>
  name === "Jira" ? "Jira" : "Linear";
