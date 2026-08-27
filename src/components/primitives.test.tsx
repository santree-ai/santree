import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Dropdown, Segmented, Tabs, TerminalActivity } from "./primitives";

describe("TerminalActivity", () => {
  it("announces the task and renders the braille spinner", () => {
    const { container } = render(<TerminalActivity label="Loading diff…" />);

    expect(screen.getByRole("status", { name: "Loading diff…" })).toBeInTheDocument();
    expect(container.querySelector(".terminal-activity")).toBeInTheDocument();
  });
});

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
  it("is a single tab stop — only the checked option is tabbable", () => {
    render(<Seg />);
    const [a, b, c] = screen.getAllByRole("radio");

    expect(a).toHaveAttribute("tabindex", "0");
    expect(b).toHaveAttribute("tabindex", "-1");
    expect(c).toHaveAttribute("tabindex", "-1");
  });

  it("checks and focuses the next option on ArrowRight, wrapping on ArrowLeft", () => {
    render(<Seg />);
    const radios = () => screen.getAllByRole("radio");

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
  });

  it("jumps to the first/last option with Home/End", () => {
    render(<Seg />);
    const radios = () => screen.getAllByRole("radio");

    fireEvent.keyDown(radios()[0], { key: "End" });
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
  it("is a single tab stop — only the selected tab is tabbable", () => {
    render(<TabBar />);
    const [one, two, three] = screen.getAllByRole("tab");

    expect(one).toHaveAttribute("aria-selected", "true");
    expect(one).toHaveAttribute("tabindex", "0");
    expect(two).toHaveAttribute("tabindex", "-1");
    expect(three).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus with the arrow keys without activating the tab (manual activation)", () => {
    render(<TabBar />);
    const tabs = () => screen.getAllByRole("tab");

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
