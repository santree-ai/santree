/**
 * The Conversation view's store: reads folded into one journal (upsert by id,
 * `seq` order, reset, identity kept for what a read did not touch), and the hook
 * that hands each read the cursor the last one returned — starting over when the
 * tab's session is replaced.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

import type { ConversationItem, ConversationRead, ConversationTarget } from "../bindings";
import { conversationRead, SESSION } from "../test/conversationFixture";
import { applyRead } from "./conversationJournal";

const { read, changed } = vi.hoisted(() => ({
  read: vi.fn(),
  changed: new Set<(event: { payload: { sessionId: string } }) => void>(),
}));
vi.mock("../bindings", () => ({
  commands: { conversationRead: read },
  events: {
    conversationChanged: {
      listen: async (handler: (event: { payload: { sessionId: string } }) => void) => {
        changed.add(handler);
        return () => changed.delete(handler);
      },
    },
  },
}));

import { useConversation } from "./queries";

const ids = (items: readonly ConversationItem[]) => items.map((item) => item.id);

it("folds reads into one journal: by id, in seq order, keeping what a read didn't touch", () => {
  const first = applyRead(undefined, conversationRead({ reset: true, items: SESSION.slice(0, 9) }));
  expect(first.turns.map((t) => t.turn)).toEqual([0, 1]);

  // The failed command is recorded again (its result replaced), and turn 2 starts.
  const failed = SESSION[5];
  if (failed.body.kind !== "tool") throw new Error("the sixth item is the failed command");
  const rerun: ConversationItem = { ...failed, body: { ...failed.body, status: "Done" } };
  const second = applyRead(first, conversationRead({ items: [rerun, ...SESSION.slice(9)] }));
  expect(ids(second.items)).toEqual(ids(SESSION));
  expect(second.items[5]).toBe(rerun);
  expect(second.items[0]).toBe(first.items[0]);
  // Turn 0 didn't change, so it is the same group and a memoized turn skips it.
  expect(second.turns[0]).toBe(first.turns[0]);
  expect(second.turns[1]).not.toBe(first.turns[1]);
  // A read with nothing new changes nothing at all.
  expect(applyRead(second, conversationRead()).turns).toBe(second.turns);

  // An item handed back out of order is put back in its place.
  expect(
    ids(applyRead(undefined, conversationRead({ items: [SESSION[2], SESSION[1]] })).items),
  ).toEqual(["u-p1", "a-r1"]);
  // A reset is the whole conversation; a record no longer there holds nothing.
  expect(
    ids(applyRead(second, conversationRead({ reset: true, items: [SESSION[1]] })).items),
  ).toEqual(["u-p1"]);
  expect(applyRead(second, conversationRead({ availability: "NotFound" })).items).toEqual([]);
});

it("reads from the cursor it was handed, and starts over when the tab's session is replaced", async () => {
  const target: ConversationTarget = { kind: "tab", repo: "acme/web", termKey: "tree:a:tab:1" };
  const answer = (data: ConversationRead) => read.mockResolvedValueOnce({ status: "ok", data });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  answer(
    conversationRead({ reset: true, items: SESSION.slice(0, 9), cursor: { epoch: "e1", rev: 9 } }),
  );
  const { result, rerender } = renderHook(
    ({ follow }: { follow: string }) => useConversation(target, null, { followSession: follow }),
    { wrapper, initialProps: { follow: "session-1" } },
  );
  await waitFor(() => expect(result.current.data?.items).toHaveLength(9));
  expect(read).toHaveBeenLastCalledWith(target, null, null);

  // The record changed: read again, from where the last read left off.
  answer(conversationRead({ items: SESSION.slice(9), cursor: { epoch: "e1", rev: 17 } }));
  act(() => {
    for (const handler of changed) handler({ payload: { sessionId: "session-1" } });
  });
  await waitFor(() => expect(result.current.data?.items).toHaveLength(SESSION.length));
  expect(read).toHaveBeenLastCalledWith(target, null, { epoch: "e1", rev: 9 });

  // Another session's change is not this view's.
  const calls = read.mock.calls.length;
  act(() => {
    for (const handler of changed) handler({ payload: { sessionId: "session-9" } });
  });
  expect(read.mock.calls.length).toBe(calls);

  // `/clear` rebinds the tab: its hooks now name another session, and a delta
  // against the old record's cursor means nothing — so it is read whole.
  answer(conversationRead({ sessionId: "session-2", items: [SESSION[9]] }));
  answer(
    conversationRead({
      sessionId: "session-2",
      reset: true,
      items: [SESSION[1]],
      cursor: { epoch: "e2", rev: 1 },
    }),
  );
  rerender({ follow: "session-2" });
  await waitFor(() => expect(result.current.data?.sessionId).toBe("session-2"));
  expect(read).toHaveBeenLastCalledWith(target, null, null);
  expect(ids(result.current.data?.items ?? [])).toEqual(["u-p1"]);
});

// The backend watches a record only while a view reads it, and forgets one
// nobody has read for three minutes. A view open on an idle agent read only on
// change events, so after three quiet minutes it heard of none: the next quick
// turn never showed until the view was opened again.
it("re-reads an idle conversation once a minute, which keeps the backend watching it", async () => {
  vi.useFakeTimers();
  try {
    read.mockReset();
    read.mockResolvedValue({
      status: "ok",
      data: conversationRead({ cursor: { epoch: "e", rev: 1 } }),
    });
    const target: ConversationTarget = { kind: "tab", repo: "acme/web", termKey: "tree:a:tab:2" };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useConversation(target, null, { working: false }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(59_000));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(target, null, { epoch: "e", rev: 1 });
  } finally {
    vi.useRealTimers();
  }
});
