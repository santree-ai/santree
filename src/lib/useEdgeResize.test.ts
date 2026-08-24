import { renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { useEdgeResize } from "./useEdgeResize";

// The handlers only touch `currentTarget.{set,release}PointerCapture`,
// `pointerId`, `clientX`, `button`, and `buttons`, so a minimal mock stands in
// for a real DOM pointer event and a real HTMLDivElement.
function mockTarget() {
  return { releasePointerCapture: vi.fn(), setPointerCapture: vi.fn() };
}

function fakeEvent(
  target: ReturnType<typeof mockTarget>,
  overrides: Partial<{ clientX: number; button: number; buttons: number }> = {},
) {
  return {
    currentTarget: target,
    pointerId: 1,
    clientX: 0,
    button: 0,
    buttons: 1,
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

const setup = (onCommit: (w: number) => void, target?: HTMLElement) =>
  renderHook(() =>
    useEdgeResize({
      cssVar: "--test-width",
      target: target ? { current: target } : undefined,
      width: 200,
      min: 100,
      max: 400,
      edge: "right",
      onCommit,
    }),
  );

describe("useEdgeResize", () => {
  it("keeps live layout writes inside the supplied resize scope", () => {
    const scope = document.createElement("div");
    document.documentElement.style.removeProperty("--test-width");
    const { result } = setup(vi.fn(), scope);
    const target = mockTarget();

    result.current.onPointerDown(fakeEvent(target, { clientX: 100 }));
    result.current.onPointerMove(fakeEvent(target, { clientX: 150 }));
    result.current.onPointerUp(fakeEvent(target));

    expect(scope.style.getPropertyValue("--test-width")).toBe("250px");
    expect(document.documentElement.style.getPropertyValue("--test-width")).toBe("");
  });

  it("commits the live dragged width on pointercancel, same as pointerup", () => {
    const onCommit = vi.fn();
    const { result } = setup(onCommit);

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

  it("ignores a non-primary button", () => {
    const onCommit = vi.fn();
    const { result } = setup(onCommit);

    // A right-click must not capture the pointer or arm a drag — otherwise the
    // handle stays "dragging" for as long as the context menu is up.
    const target = mockTarget();
    result.current.onPointerDown(fakeEvent(target, { clientX: 100, button: 2, buttons: 2 }));
    expect(target.setPointerCapture).not.toHaveBeenCalled();

    result.current.onPointerMove(fakeEvent(target, { clientX: 150 }));
    result.current.onPointerUp(fakeEvent(target));
    expect(onCommit).not.toHaveBeenCalled();
  });
});
