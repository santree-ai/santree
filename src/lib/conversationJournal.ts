/**
 * The Conversation view's journal as the frontend holds it: every
 * `conversation_read` so far, folded together.
 *
 * A read returns only what was created or changed after the reader's cursor
 * (`crates/core/src/conversation`), so the deltas are applied here: `reset`
 * drops everything held, an item replaces the held one with the same id, and
 * the list stays in `seq` order. Pure, so the folding is tested without a
 * backend; `useConversation` in `queries.ts` is the hook that drives it.
 *
 * Identity is part of the contract. An item a read did not touch keeps its
 * object, and a turn whose items did not change keeps its group, so a view that
 * memoizes per turn and per item re-renders only what the read changed: an
 * append to the live turn must not re-render a thousand finished ones.
 */
import type { ConversationItem, ConversationRead } from "../bindings";

/** One user turn's items, in `seq` order. */
export interface TurnGroup {
  turn: number;
  items: readonly ConversationItem[];
}

/** Everything held of one conversation, as of the latest read. */
export interface ConversationJournal extends Omit<ConversationRead, "items" | "reset"> {
  /** Every item, ordered by `seq`. */
  items: readonly ConversationItem[];
  /** The same items grouped by turn, in turn order. */
  turns: readonly TurnGroup[];
}

/** Fold one read into what is held. `prev` is undefined before the first. A
 *  read with no record to draw (`NoSession`, `NotFound`, `Remote`) holds
 *  nothing, whatever it says about resetting. */
export function applyRead(
  prev: ConversationJournal | undefined,
  read: ConversationRead,
): ConversationJournal {
  const held = read.reset || read.availability !== "Ready" ? undefined : prev;
  const base = held?.items ?? [];
  const items = read.items.length === 0 ? base : upsert(base, read.items);
  return {
    availability: read.availability,
    agent: read.agent,
    sessionId: read.sessionId,
    cursor: read.cursor,
    meta: read.meta,
    items,
    turns: held && items === held.items ? held.turns : groupTurns(items, held?.turns ?? []),
  };
}

/** `base` with `incoming` applied: replaced by id, appended when new, and put
 *  back in `seq` order should a read ever hand one back out of it. */
function upsert(
  base: readonly ConversationItem[],
  incoming: readonly ConversationItem[],
): ConversationItem[] {
  const at = new Map<string, number>();
  base.forEach((item, i) => {
    at.set(item.id, i);
  });
  const next = base.slice();
  for (const item of incoming) {
    const i = at.get(item.id);
    if (i === undefined) {
      at.set(item.id, next.length);
      next.push(item);
    } else {
      next[i] = item;
    }
  }
  for (let i = 1; i < next.length; i++) {
    if (next[i - 1].seq > next[i].seq) return next.sort((a, b) => a.seq - b.seq);
  }
  return next;
}

/** Items grouped by `turn`, keeping a previous group whenever its items are the
 *  same objects as before. */
export function groupTurns(
  items: readonly ConversationItem[],
  prev: readonly TurnGroup[],
): TurnGroup[] {
  const order: number[] = [];
  const byTurn = new Map<number, ConversationItem[]>();
  for (const item of items) {
    let group = byTurn.get(item.turn);
    if (!group) {
      group = [];
      byTurn.set(item.turn, group);
      order.push(item.turn);
    }
    group.push(item);
  }
  const old = new Map(prev.map((g) => [g.turn, g]));
  return order
    .sort((a, b) => a - b)
    .map((turn) => {
      const next = byTurn.get(turn) as ConversationItem[];
      const was = old.get(turn);
      return was && sameItems(was.items, next) ? was : { turn, items: next };
    });
}

function sameItems(a: readonly ConversationItem[], b: readonly ConversationItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
