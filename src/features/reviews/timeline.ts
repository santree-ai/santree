/**
 * A pull request's conversation, as entries.
 *
 * **The description is not one of them.** GitHub draws the body in a card that
 * looks like the comments under it, but it is the thing they are about: the
 * proposal, not a reply to it. Modelling it as the timeline's first entry made
 * "who said this, and when" uniform at the cost of the one distinction that
 * matters on the page — so the description gets its own block above
 * ({@link PrConversationPane}) and this is the discussion alone.
 *
 * Inline review threads are not here either: they belong to lines of code and
 * render in the diff.
 */
import type { PrComment } from "../../bindings";

export interface TimelineEntry {
  /** Stable within one PR's render. */
  key: string;
  author: string;
  authorAvatarUrl: string;
  /** Markdown, as authored. */
  body: string;
  /** ISO-8601. */
  createdAt: string;
  /** Whether GitHub classifies the author as a `Bot` actor. */
  isBot: boolean;
  /** How GitHub words the entry: "commented" or "reviewed". */
  verb: "commented" | "reviewed";
}

/** The top-level conversation, in the order the backend sorted it
 *  (chronological). */
export function timelineEntries(comments: PrComment[]): TimelineEntry[] {
  // A conversation comment has no id of its own in `PrComment`, so the key is
  // built from what does identify it: who, when, and its place in the list.
  return comments.map((c, i) => ({
    key: `${c.author}-${c.createdAt}-${i}`,
    author: c.author,
    authorAvatarUrl: c.authorAvatarUrl,
    body: c.body,
    createdAt: c.createdAt,
    isBot: c.isBot,
    verb: (c.kind === "Review" ? "reviewed" : "commented") as TimelineEntry["verb"],
  }));
}
