/**
 * One control, five sources. What has to hold for all of them: the row it writes
 * carries a minted id, the icon variant never changes size (a hover control that
 * occupies nothing at rest resizes the card under the pointer), and a click that
 * is still in flight can't be sent twice.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AddReviewWorkItem } from "../../lib/queries";

const spies = vi.hoisted(() => ({ add: vi.fn(), pending: false }));

vi.mock("../../lib/queries", () => ({
  useAddReviewWorkItem: () => ({ mutate: spies.add, isPending: spies.pending }),
}));

import { QueueAction } from "./QueueAction";

const ITEM: Omit<AddReviewWorkItem, "id"> = {
  body: "Fix failing check: test (ubuntu-latest)",
  source: "check",
  sourceId: "test (ubuntu-latest)",
  path: null,
  line: null,
  startLine: null,
  onRight: null,
};

beforeEach(() => {
  spies.add.mockClear();
  spies.pending = false;
});

describe("QueueAction · button variant", () => {
  it("writes the caller's item with an id it mints itself", () => {
    render(<QueueAction prRepo="acme/api" number={7} item={ITEM} queued={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Add to queue/ }));

    expect(spies.add).toHaveBeenCalledTimes(1);
    const row = spies.add.mock.calls[0][0];
    expect(row).toMatchObject(ITEM);
    // The client owns the id so the optimistic patch and the persisted row are
    // the same row, not two.
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
  });

  it("reads as already queued, and does nothing more, once the source is on the list", () => {
    render(<QueueAction prRepo="acme/api" number={7} item={ITEM} queued />);
    const button = screen.getByRole("button", { name: /In queue/ });

    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(spies.add).not.toHaveBeenCalled();
  });

  // Adding is one round-trip; a second click while it is open would write a
  // duplicate row with a different id, which nothing later de-duplicates.
  it("won't queue twice while the first write is in flight", () => {
    spies.pending = true;
    render(<QueueAction prRepo="acme/api" number={7} item={ITEM} queued={false} />);

    expect(screen.getByRole("button", { name: /Add to queue/ })).toBeDisabled();
  });
});

describe("QueueAction · icon variant", () => {
  it("keeps its size whether or not it is queued, so hovering can't reflow the card", () => {
    const { rerender } = render(
      <QueueAction
        variant="icon"
        prRepo="acme/api"
        number={7}
        item={ITEM}
        queued={false}
        label="Queue this comment"
        queuedLabel="Already in the queue"
      />,
    );
    const resting = screen.getByRole("button", { name: "Queue this comment" });
    // Reserved, not conjured: present before any pointer goes near it, and only
    // its opacity is doing the hiding. `hidden` would take it back out of flow.
    expect(resting.className).toContain("size-4");
    expect(resting.className).toContain("opacity-0");
    expect(resting.className).not.toContain("hidden");

    rerender(
      <QueueAction
        variant="icon"
        prRepo="acme/api"
        number={7}
        item={ITEM}
        queued
        label="Queue this comment"
        queuedLabel="Already in the queue"
      />,
    );
    // Queued is state, not an affordance: same box, but it stays visible.
    const queued = screen.getByRole("button", { name: "Already in the queue" });
    expect(queued.className).toContain("size-4");
    expect(queued.className).not.toContain("opacity-0");
    expect(queued).toBeDisabled();
  });

  it("writes the same row the labelled variant does", () => {
    render(<QueueAction variant="icon" prRepo="acme/api" number={7} item={ITEM} queued={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    expect(spies.add).toHaveBeenCalledWith(expect.objectContaining(ITEM));
  });
});
