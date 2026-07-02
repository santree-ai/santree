import { renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { useEdgeResize } from "./useEdgeResize";

// The handlers only touch `currentTarget.{set,release}PointerCapture`,
// `pointerId`, `clientX`, and `buttons`, so a minimal mock stands in for a
// real DOM pointer event and a real HTMLDivElement.
function mockTarget() {
  return { releasePointerCapture: vi.fn(), setPointerCapture: vi.fn() };
}

function fakeEvent(
  target: ReturnType<typeof mockTarget>,
  overrides: Partial<{ clientX: number; buttons: number }> = {},
) {
  return {
    currentTarget: target,
    pointerId: 1,
    clientX: 0,
    buttons: 1,
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

describe("useEdgeResize", () => {
  it("commits the live dragged width on pointercancel, same as pointerup", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useEdgeResize({
        cssVar: "--test-width",
        width: 200,
        min: 100,
        max: 400,
        edge: "right",
        onCommit,
      }),
    );

    const target = mockTarget();
    result.current.onPointerDown(fakeEvent(target, { clientX: 100 }));
    result.current.onPointerMove(fakeEvent(target, { clientX: 150 }));

    // A system gesture (or capture loss) fires pointercancel instead of
    // pointerup mid-drag — this must still commit the last dragged width, or
    // `dragging` sticks true and the panel snaps back to the stale committed
    // width on the next collapse/expand.
    result.current.onPointerCancel(fakeEvent(target));

    expect(onCommit).toHaveBeenCalledWith(250);
    expect(target.releasePointerCapture).toHaveBeenCalled();

    // A second cancel/up after the drag already ended must be a no-op.
    result.current.onPointerCancel(fakeEvent(target));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
