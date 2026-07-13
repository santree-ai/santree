import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useTerminalTabs } from "./orchestrator";

describe("useTerminalTabs", () => {
  describe("open", () => {
    it("opens and focuses a new tab, returning its key", () => {
      const { result } = renderHook(() => useTerminalTabs());

      let key = "";
      act(() => {
        key = result.current.open({ title: "shell" });
      });

      expect(result.current.tabs.map((t) => t.key)).toEqual([key]);
      expect(result.current.activeKey).toBe(key);
    });

    it("opening a second tab focuses it, leaving the first tab in place", () => {
      const { result } = renderHook(() => useTerminalTabs());

      let first = "";
      let second = "";
      act(() => {
        first = result.current.open({ title: "one" });
      });
      act(() => {
        second = result.current.open({ title: "two" });
      });

      expect(result.current.tabs.map((t) => t.key)).toEqual([first, second]);
      expect(result.current.activeKey).toBe(second);
    });
  });

  describe("ensure", () => {
    it("dedupes by (source, refId): two calls for the same ref return the same key and create only one tab", () => {
      const { result } = renderHook(() => useTerminalTabs());

      let key1 = "";
      let key2 = "";
      // Both calls happen inside the same act() — no render/flush in between —
      // to exercise the same race a StrictMode double-invoke (or two effects
      // firing back-to-back before React re-renders) would hit: `ensure` must
      // mutate `tabsRef` eagerly so the second call sees the first call's tab
      // even though `tabs` state hasn't re-rendered yet (see orchestrator.ts).
      act(() => {
        key1 = result.current.ensure({ title: "Issue AK-1", source: "issue", refId: "AK-1" });
        key2 = result.current.ensure({ title: "Issue AK-1", source: "issue", refId: "AK-1" });
      });

      expect(key1).toBe(key2);
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].refId).toBe("AK-1");
    });

    it("treats the same refId under a different source as a distinct session", () => {
      const { result } = renderHook(() => useTerminalTabs());

      act(() => {
        result.current.ensure({ title: "Issue", source: "issue", refId: "AK-1" });
      });
      act(() => {
        result.current.ensure({ title: "Triage", source: "triage", refId: "AK-1" });
      });

      expect(result.current.tabs).toHaveLength(2);
    });

    it("does not steal focus from the active tab when it creates a new session (embeds shouldn't yank the Terminal tab bar)", () => {
      const { result } = renderHook(() => useTerminalTabs());
      act(() => {
        result.current.open({ title: "shell" });
      });
      const activeBefore = result.current.activeKey;

      act(() => {
        result.current.ensure({ title: "Issue AK-1", source: "issue", refId: "AK-1" });
      });

      expect(result.current.activeKey).toBe(activeBefore);
    });
  });

  describe("close", () => {
    it("closing the active (last) tab falls back to the previous tab", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let t0 = "";
      let t1 = "";
      let t2 = "";
      act(() => {
        t0 = result.current.open({ title: "0" });
      });
      act(() => {
        t1 = result.current.open({ title: "1" });
      });
      act(() => {
        t2 = result.current.open({ title: "2" });
      });
      expect(result.current.activeKey).toBe(t2);

      act(() => result.current.close(t2));

      expect(result.current.tabs.map((t) => t.key)).toEqual([t0, t1]);
      expect(result.current.activeKey).toBe(t1);
    });

    it("closing the active middle tab falls back to the tab before it, not the one after", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let t0 = "";
      let t1 = "";
      let t2 = "";
      act(() => {
        t0 = result.current.open({ title: "0" });
      });
      act(() => {
        t1 = result.current.open({ title: "1" });
      });
      act(() => {
        t2 = result.current.open({ title: "2" });
      });
      act(() => result.current.setActiveKey(t1));

      act(() => result.current.close(t1));

      expect(result.current.tabs.map((t) => t.key)).toEqual([t0, t2]);
      expect(result.current.activeKey).toBe(t0);
    });

    it("closing a non-active tab leaves activeKey unchanged", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let t0 = "";
      let t1 = "";
      act(() => {
        t0 = result.current.open({ title: "0" });
      });
      act(() => {
        t1 = result.current.open({ title: "1" });
      });
      expect(result.current.activeKey).toBe(t1);

      act(() => result.current.close(t0));

      expect(result.current.tabs.map((t) => t.key)).toEqual([t1]);
      expect(result.current.activeKey).toBe(t1);
    });

    it("closes every tab of a batch issued in one tick (the sidebar's close-all-for-a-ticket)", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let t0 = "";
      let t1 = "";
      let t2 = "";
      act(() => {
        t0 = result.current.open({ title: "0" });
        t1 = result.current.open({ title: "1" });
        t2 = result.current.open({ title: "2" });
      });

      // No render in between, so each close must see the previous one's result.
      act(() => {
        result.current.close(t0);
        result.current.close(t1);
      });

      expect(result.current.tabs.map((t) => t.key)).toEqual([t2]);
      expect(result.current.activeKey).toBe(t2);
    });

    it("closing an unknown key is a no-op", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let t0 = "";
      act(() => {
        t0 = result.current.open({ title: "0" });
      });

      act(() => result.current.close("term-does-not-exist"));

      expect(result.current.tabs.map((t) => t.key)).toEqual([t0]);
      expect(result.current.activeKey).toBe(t0);
    });

    it("closing the only remaining tab leaves activeKey null", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let t0 = "";
      act(() => {
        t0 = result.current.open({ title: "0" });
      });

      act(() => result.current.close(t0));

      expect(result.current.tabs).toHaveLength(0);
      expect(result.current.activeKey).toBeNull();
    });
  });
});
