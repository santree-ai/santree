/**
 * The embed slot is single-tenant, but several hosts can be mounted at once — a
 * visible worktree terminal, the triage Investigate pane, and the background
 * launcher, which needs a live PTY but must never be *shown*. These pin the
 * ordering rules that keeps them from blanking each other.
 */
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { TerminalTabs } from "./orchestrator";
import { TerminalsProvider, useTerminals } from "./TerminalsContext";
import { useEmbeddedTerminal } from "./useEmbeddedTerminal";

/** Renders the terminal registry's state so tests can assert on it, and leaks the
 *  registry itself so a test can kill a session the way the layer's `onExit` does. */
let registry: TerminalTabs;
function Probe() {
  const terminals = useTerminals();
  registry = terminals;
  const { tabs, embed } = terminals;
  const shown = tabs.find((t) => t.key === embed?.key);
  return (
    <>
      <div data-testid="sessions">{tabs.map((t) => t.refId).join(",")}</div>
      <div data-testid="shown">{shown?.refId ?? "none"}</div>
    </>
  );
}

/** A host that displays its session over the host element (the normal case). */
function VisibleTerminal({ refId, onExited }: { refId: string; onExited?: () => void }) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title: refId, source: "issue", refId },
    onExited,
  });
  return <div ref={hostRef} />;
}

/** The background launcher: a real session, deliberately not displayed. */
function DetachedTerminal({ refId }: { refId: string }) {
  useEmbeddedTerminal({
    spec: { title: refId, source: "issue", refId },
    attach: false,
  });
  return null;
}

const wrap = (children: ReactNode) =>
  render(
    <TerminalsProvider>
      {children}
      <Probe />
    </TerminalsProvider>,
  );

const sessions = () => screen.getByTestId("sessions").textContent;
const shown = () => screen.getByTestId("shown").textContent;

describe("useEmbeddedTerminal", () => {
  it("displays the session it hosts", () => {
    wrap(<VisibleTerminal refId="tree:A" />);

    expect(sessions()).toBe("tree:A");
    expect(shown()).toBe("tree:A");
  });

  // F1: the background launcher used to mount a WorktreeTerminal that claimed the
  // embed slot and dragged the layer to its off-screen rect, blanking whatever the
  // user was watching. It needs the session, never the slot.
  it("a detached launcher spawns its session without taking the slot from a visible terminal", () => {
    wrap(
      <>
        <VisibleTerminal refId="tree:A" />
        <DetachedTerminal refId="tree:B" />
      </>,
    );

    expect(sessions()).toBe("tree:A,tree:B");
    expect(shown()).toBe("tree:A");
  });

  // ...and unmounting it (the launch flag clears the moment the agent is seeded)
  // must leave the visible terminal displayed — the old teardown set the single slot
  // to null, and the visible host, its deps unchanged, never re-registered.
  it("unmounting a detached launcher leaves the visible terminal displayed", () => {
    const { rerender } = wrap(
      <>
        <VisibleTerminal refId="tree:A" />
        <DetachedTerminal refId="tree:B" />
      </>,
    );

    rerender(
      <TerminalsProvider>
        <VisibleTerminal refId="tree:A" />
        <Probe />
      </TerminalsProvider>,
    );

    expect(shown()).toBe("tree:A");
  });

  // The seen latch: a tab is absent on the very first render (it hasn't registered
  // yet), so absence only means "exited" once we've seen it present.
  describe("exit detection", () => {
    it("does not fire onExited on the first render, before the tab registers", () => {
      const onExited = vi.fn();
      wrap(<VisibleTerminal refId="tree:A" onExited={onExited} />);

      expect(onExited).not.toHaveBeenCalled();
    });

    it("fires onExited once when the session's tab disappears", () => {
      const onExited = vi.fn();
      wrap(<VisibleTerminal refId="tree:A" onExited={onExited} />);
      const key = registry.tabs[0].key;

      act(() => registry.close(key));

      expect(onExited).toHaveBeenCalledTimes(1);
    });

    it("does not re-fire onExited on later renders after the session is gone", () => {
      const onExited = vi.fn();
      const { rerender } = wrap(<VisibleTerminal refId="tree:A" onExited={onExited} />);
      const key = registry.tabs[0].key;
      act(() => registry.close(key));

      act(() => {
        registry.open({ title: "unrelated" });
      });
      rerender(
        <TerminalsProvider>
          <VisibleTerminal refId="tree:A" onExited={onExited} />
          <Probe />
        </TerminalsProvider>,
      );

      expect(onExited).toHaveBeenCalledTimes(1);
    });
  });

  it("hands the slot back to the terminal underneath when an overlapping host unmounts", () => {
    const { rerender } = wrap(
      <>
        <VisibleTerminal refId="tree:A" />
        <VisibleTerminal refId="triage:X" />
      </>,
    );
    expect(shown()).toBe("triage:X");

    rerender(
      <TerminalsProvider>
        <VisibleTerminal refId="tree:A" />
        <Probe />
      </TerminalsProvider>,
    );

    expect(shown()).toBe("tree:A");
  });
});
