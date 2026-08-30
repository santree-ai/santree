/**
 * The context menu's contract, which no other gate can see: it must open where
 * the pointer is, stay inside the viewport, be reachable without a pointer at
 * all, and close once an item has run.
 *
 * The keyboard path is the one most likely to rot — a right-click menu works
 * fine in manual testing while being completely unreachable from the keyboard,
 * which is exactly the regression this pins.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextMenu, type ContextMenuItem } from "./primitives";

const menu = () => screen.queryByRole("menu");

function items(run = vi.fn()): ContextMenuItem[] {
  return [
    { kind: "heading", key: "h", label: "Open in" },
    { kind: "action", key: "zed", label: "Zed", run },
    { kind: "rule", key: "r" },
    { kind: "action", key: "delete", label: "Delete", danger: true, run },
  ];
}

function open(rows = items()) {
  render(
    <ContextMenu items={rows}>
      <button type="button">A worktree</button>
    </ContextMenu>,
  );
  return screen.getByText("A worktree");
}

describe("ContextMenu", () => {
  it("stays closed until the region is right-clicked", () => {
    open();
    expect(menu()).toBeNull();
    fireEvent.contextMenu(screen.getByText("A worktree"), { clientX: 40, clientY: 60 });
    expect(menu()).not.toBeNull();
  });

  it("renders actions as menu items, and headings and rules as neither", () => {
    open();
    fireEvent.contextMenu(screen.getByText("A worktree"));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Zed", "Delete"]);
    // The heading is present as text but is not something you can land on.
    expect(screen.getByText("Open in").getAttribute("role")).toBeNull();
  });

  it("opens from the keyboard too — Shift-F10 and the ContextMenu key", () => {
    const target = open();
    fireEvent.keyDown(target, { key: "F10", shiftKey: true });
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu()).toBeNull();

    fireEvent.keyDown(target, { key: "ContextMenu" });
    expect(menu()).not.toBeNull();
  });

  it("ignores keys that aren't the menu key", () => {
    const target = open();
    fireEvent.keyDown(target, { key: "F10" });
    fireEvent.keyDown(target, { key: "a" });
    expect(menu()).toBeNull();
  });

  it("runs the item and closes", () => {
    const run = vi.fn();
    const target = open(items(run));
    fireEvent.contextMenu(target);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(run).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it("closes on a press outside itself", () => {
    const target = open();
    fireEvent.contextMenu(target);
    fireEvent.pointerDown(document.body);
    expect(menu()).toBeNull();
  });

  it("keeps the menu on screen when opened against the viewport's edge", () => {
    const target = open();
    // jsdom reports every box as 0×0, so the clamp reduces to "never past the
    // far edge, never negative" — which is the half that regresses.
    fireEvent.contextMenu(target, { clientX: window.innerWidth + 500, clientY: -40 });
    const style = (menu() as HTMLElement).style;
    expect(Number.parseFloat(style.left)).toBeLessThanOrEqual(window.innerWidth);
    expect(Number.parseFloat(style.top)).toBeGreaterThanOrEqual(0);
  });
});
