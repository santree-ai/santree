/**
 * The picker's contract: rows are the registered projects by mark and short
 * name, a click or Enter picks the one under focus, the arrows walk the list,
 * Escape cancels, and the default switch rides along with the pick.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  repos: [
    { name: "acme/app", path: "/src/app" },
    { name: "acme/web", path: "/src/web" },
  ],
}));
vi.mock("../lib/queries", () => ({ useRepos: () => ({ data: registry.repos }) }));

import { ProjectPickerDialog } from "./ProjectPickerDialog";

const onPick = vi.fn();
const onCancel = vi.fn();

function open(current: string | null = null) {
  render(
    <ProjectPickerDialog
      title="Attach a project"
      action="Investigating with Codex"
      explain="It runs on the project's main checkout. No worktree is created."
      current={current}
      defaultToggle={{
        label: "Use as the default for triage",
        hint: "Every ticket without a pick of its own runs here. Off: only this ticket.",
      }}
      onPick={onPick}
      onCancel={onCancel}
    />,
  );
}

const row = (name: RegExp) => screen.getByRole("option", { name });

describe("ProjectPickerDialog", () => {
  beforeEach(() => {
    onPick.mockClear();
    onCancel.mockClear();
  });

  it("names the action and lists the projects by short name, with their paths", () => {
    open();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /Investigating with Codex needs a project/,
    );
    expect(screen.getAllByRole("option").map((r) => r.textContent)).toEqual([
      "app/src/app",
      "web/src/web",
    ]);
  });

  it("marks and focuses the project the ticket already runs on", () => {
    open("acme/web");
    expect(row(/web/)).toHaveAttribute("aria-selected", "true");
    expect(row(/web/)).toHaveFocus();
    expect(row(/app/)).toHaveAttribute("aria-selected", "false");
  });

  it("focuses the first row when nothing is current", () => {
    open();
    expect(row(/app/)).toHaveFocus();
  });

  it("Enter picks the focused row, without the default", () => {
    open("acme/web");
    fireEvent.keyDown(row(/web/), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("acme/web", false);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("a click picks that row", () => {
    open();
    fireEvent.click(row(/web/));
    expect(onPick).toHaveBeenCalledWith("acme/web", false);
  });

  it("the arrows walk the list and clamp at the ends", () => {
    open();
    const list = screen.getByRole("listbox", { name: "Projects" });
    expect(row(/app/)).toHaveFocus();

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(row(/web/)).toHaveFocus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(row(/web/)).toHaveFocus();
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(row(/app/)).toHaveFocus();
  });

  it("Escape cancels", () => {
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  /** Off by default: an answer to "this ticket needs a project" is not yet a
   *  decision about every other ticket. */
  it("the switch makes the pick the default, and starts off", () => {
    open();
    const toggle = screen.getByRole("switch", { name: "Use as the default for triage" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(row(/app/));
    expect(onPick).toHaveBeenCalledWith("acme/app", true);
  });
});
