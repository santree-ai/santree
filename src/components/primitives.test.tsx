import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dropdown, Segmented, Tabs } from "./primitives";

function Menu() {
  return (
    <>
      <Dropdown
        trigger={(toggle) => (
          <button type="button" onClick={toggle}>
            Open menu
          </button>
        )}
      >
        {(close) => (
          <>
            <button type="button" onClick={close}>
              One
            </button>
            <button type="button" onClick={close}>
              Two
            </button>
          </>
        )}
      </Dropdown>
      <button type="button">Elsewhere</button>
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: "Open menu" });
const elsewhere = () => screen.getByRole("button", { name: "Elsewhere" });

describe("Dropdown focus management", () => {
  it("moves focus into the menu on open and back to the trigger on Escape", () => {
    render(<Menu />);
    fireEvent.click(trigger());

    expect(screen.getByRole("button", { name: "One" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Without the restore this lands on <body> — the whole point of the fix.
    expect(trigger()).toHaveFocus();
  });

  it("returns focus to the trigger after picking an item", () => {
    render(<Menu />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Two" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("leaves focus alone when the close already moved it elsewhere", () => {
    render(<Menu />);
    fireEvent.click(trigger());
    // What an outside click does in a browser: focus lands on the clicked control
    // before the dropdown's close re-renders. The restore must not yank it back.
    elsewhere().focus();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(elsewhere()).toHaveFocus();
  });

  it("roves between menu items with the arrow keys", () => {
    render(<Menu />);
    fireEvent.click(trigger());

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Two" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByRole("button", { name: "One" })).toHaveFocus();
  });
});

describe("Dropdown viewport placement", () => {
  it.each([
    { placement: "down" as const, y: 520, viewport: 600, top: 256, maxHeight: 508 },
    { placement: "up" as const, y: 30, viewport: 600, top: 64, maxHeight: 528 },
    { placement: "down" as const, y: 80, viewport: 200, top: 114, maxHeight: 78 },
  ])("fits a $placement menu at y=$y inside a $viewport px window", ({
    placement,
    y,
    viewport,
    top,
    maxHeight,
  }) => {
    vi.stubGlobal("innerHeight", viewport);
    vi.stubGlobal("innerWidth", 800);
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "menu"
          ? new DOMRect(0, 0, 288, 260)
          : new DOMRect(600, y, 180, 30);
      });
    try {
      render(
        <Dropdown
          placement={placement}
          trigger={(toggle) => (
            <button type="button" onClick={toggle}>
              Open menu
            </button>
          )}
        >
          {() => <button type="button">An issue</button>}
        </Dropdown>,
      );
      fireEvent.click(trigger());
      expect(screen.getByRole("menu")).toHaveStyle({
        top: `${top}px`,
        left: "504px",
        maxHeight: `${maxHeight}px`,
        overflowY: "auto",
      });
      // Growing the viewport lets a formerly constrained menu use the preferred side again.
      vi.stubGlobal("innerHeight", 900);
      fireEvent(window, new Event("resize"));
      if (placement === "down")
        expect(screen.getByRole("menu")).toHaveStyle({ top: `${y + 34}px` });
    } finally {
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

function Seg() {
  const [value, setValue] = useState("a");
  return (
    <Segmented
      options={[
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ]}
      value={value}
      onChange={setValue}
    />
  );
}

describe("Segmented (radiogroup)", () => {
  it("is one tab stop that arrows (wrapping) and Home/End move and check", () => {
    render(<Seg />);
    const radios = () => screen.getAllByRole("radio");
    expect(radios().map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: "ArrowRight" });

    expect(radios()[1]).toHaveFocus();
    expect(radios()[1]).toHaveAttribute("aria-checked", "true");
    expect(radios()[0]).toHaveAttribute("aria-checked", "false");
    expect(radios()[1]).toHaveAttribute("tabindex", "0");

    // Wrap backwards past the first option to the last.
    fireEvent.keyDown(radios()[1], { key: "ArrowLeft" });
    fireEvent.keyDown(radios()[0], { key: "ArrowLeft" });

    expect(radios()[2]).toHaveFocus();
    expect(radios()[2]).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(radios()[2], { key: "Home" });
    expect(radios()[0]).toHaveAttribute("aria-checked", "true");
  });
});

function TabBar() {
  const [value, setValue] = useState("one");
  return (
    <>
      <Tabs
        tabs={[
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
          { value: "three", label: "Three" },
        ]}
        value={value}
        onChange={setValue}
      />
      <input aria-label="rename" />
    </>
  );
}

describe("Tabs (tablist)", () => {
  it("moves focus with the arrow keys without activating the tab (manual activation)", () => {
    render(<TabBar />);
    const tabs = () => screen.getAllByRole("tab");
    // A single tab stop: only the selected tab is tabbable.
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });

    expect(tabs()[1]).toHaveFocus();
    // Focus moved; the selection didn't follow it (the panel would be a route or
    // a live terminal — arrowing past a tab must not switch to it).
    expect(tabs()[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.click(tabs()[1]);
    expect(tabs()[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs()[1]).toHaveAttribute("tabindex", "0");
  });

  it("wraps at both ends and honours Home/End", () => {
    render(<TabBar />);
    const tabs = () => screen.getAllByRole("tab");

    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "ArrowLeft" });
    expect(tabs()[2]).toHaveFocus();

    fireEvent.keyDown(tabs()[2], { key: "ArrowRight" });
    expect(tabs()[0]).toHaveFocus();

    fireEvent.keyDown(tabs()[0], { key: "End" });
    expect(tabs()[2]).toHaveFocus();
  });

  it("ignores arrow keys raised by a strip's other controls (e.g. an inline rename field)", () => {
    render(<TabBar />);
    const field = screen.getByLabelText("rename");
    field.focus();

    // A tab strip also holds close buttons and Trees' rename input; the roving
    // handler must not eat their arrow keys.
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });

    expect(field).toHaveFocus();
  });
});
