/**
 * The shell both right-hand panels stand on. What is pinned here is what the two
 * hosts are entitled to assume about it: collapsed means *gone* (not hidden in
 * place, which is how the panel's own toggle went missing once), and the strip
 * says which pane is showing in a way a screen reader and a keyboard can both
 * follow.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidePanel } from "./SidePanel";

const TABS = [
  { tab: "issue" as const, label: "Issue", icon: <span /> },
  { tab: "aiWork" as const, label: "AI work queue", icon: <span />, dot: "var(--accent)" },
];

function mount(over: Partial<Parameters<typeof SidePanel<"issue" | "aiWork">>[0]> = {}) {
  return render(
    <SidePanel
      tabs={TABS}
      active="issue"
      onSelect={vi.fn()}
      collapsed={false}
      onToggle={vi.fn()}
      width={400}
      onWidth={vi.fn()}
      cssVar="--test-panel"
      min={300}
      max={720}
      resetTo={400}
      ariaLabel="Test panel"
      {...over}
    >
      <div>body</div>
    </SidePanel>,
  );
}

describe("SidePanel", () => {
  // Not `hidden`, not a leftover strip: the host puts the control that brings it
  // back somewhere its own layout keeps visible, and a panel that still occupied
  // the row would leave two of them.
  it("renders nothing at all while collapsed", () => {
    const { container } = mount({ collapsed: true });
    expect(container).toBeEmptyDOMElement();
  });

  it("marks the showing pane as the selected tab, and only that one", () => {
    mount({ active: "aiWork" });
    expect(screen.getByRole("tab", { name: "AI work queue" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Issue" })).toHaveAttribute("aria-selected", "false");
  });

  // A roving tabindex: the strip is one Tab stop, and the arrows move within it.
  it("makes the strip a single tab stop, entered at the selected pane", () => {
    mount({ active: "aiWork" });
    expect(screen.getByRole("tab", { name: "AI work queue" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Issue" })).toHaveAttribute("tabindex", "-1");
  });

  it("asks its host to switch panes rather than switching one itself", () => {
    const onSelect = vi.fn();
    mount({ onSelect });
    fireEvent.click(screen.getByRole("tab", { name: "AI work queue" }));
    expect(onSelect).toHaveBeenCalledWith("aiWork");
  });

  // A stored width predates the strip it is stored for: a panel that grew a pane
  // has a higher minimum than the number on disk, and nothing re-clamps it until
  // the user drags.
  it("opens clamped to its own bounds, whatever was persisted", () => {
    const { container } = mount({ width: 120 });
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue("--test-panel"),
    ).toBe("300px");
  });
});
