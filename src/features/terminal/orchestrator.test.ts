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

    /** A surface holds one session per provider — the pair `terminal_sessions` is
     *  keyed by — so a ticket investigated by both agents is two panes, and
     *  re-entering either finds its own. */
    it("gives a surface one pane per provider, and reuses each", () => {
      const { result } = renderHook(() => useTerminalTabs());
      const investigate = (kind: "Claude" | "Codex") => ({
        title: `AK-1 (${kind})`,
        source: "triage" as const,
        refId: "triage:AK-1",
        agent: { kind, repo: "acme/app", termKey: "triage:AK-1" },
      });

      let codex = "";
      let claude = "";
      let again = "";
      act(() => {
        codex = result.current.ensure(investigate("Codex"));
        claude = result.current.ensure(investigate("Claude"));
        again = result.current.ensure(investigate("Codex"));
      });

      expect(codex).not.toBe(claude);
      expect(again).toBe(codex);
      expect(result.current.tabs).toHaveLength(2);
      // Both panes carry the surface key undecorated — it is the PTY's label and
      // the durable row's `term_key`, and the provider is the field beside it.
      expect(result.current.tabs.map((t) => t.refId)).toEqual(["triage:AK-1", "triage:AK-1"]);
    });

    /** The identity is the launch's own `term_key`, not a second argument that
     *  can drift from it: a decorated ref is what stopped the liveness join
     *  matching, and it is unrepresentable here. */
    it("keys an agent pane by the term_key it launched with, whatever ref it was passed", () => {
      const { result } = renderHook(() => useTerminalTabs());
      act(() => {
        result.current.ensure({
          title: "AK-1",
          source: "triage",
          refId: "triage:AK-1::codex",
          agent: { kind: "Codex", repo: "acme/app", termKey: "triage:AK-1" },
        });
      });
      expect(result.current.tabs[0].refId).toBe("triage:AK-1");
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

  describe("embed slot", () => {
    const host = (): HTMLElement => ({}) as HTMLElement;

    it("shows the newest claim", () => {
      const { result } = renderHook(() => useTerminalTabs());
      act(() => {
        result.current.attachEmbed({ host: host(), key: "a" });
      });
      expect(result.current.embed?.key).toBe("a");

      act(() => {
        result.current.attachEmbed({ host: host(), key: "b" });
      });
      expect(result.current.embed?.key).toBe("b");
    });

    // The F1 regression: releasing a claim used to blank the slot outright, so the
    // terminal the user was actually watching went dark and — its deps unchanged —
    // never re-registered.
    it("releasing the newest claim hands the slot back to the previous holder", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let releaseB = () => {};
      act(() => {
        result.current.attachEmbed({ host: host(), key: "a" });
      });
      act(() => {
        releaseB = result.current.attachEmbed({ host: host(), key: "b" });
      });

      act(() => releaseB());

      expect(result.current.embed?.key).toBe("a");
    });

    it("releasing a claim underneath the top one leaves the visible session alone", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let releaseA = () => {};
      act(() => {
        releaseA = result.current.attachEmbed({ host: host(), key: "a" });
      });
      act(() => {
        result.current.attachEmbed({ host: host(), key: "b" });
      });

      act(() => releaseA());

      expect(result.current.embed?.key).toBe("b");
    });

    it("releasing the last claim empties the slot", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let release = () => {};
      act(() => {
        release = result.current.attachEmbed({ host: host(), key: "a" });
      });

      act(() => release());

      expect(result.current.embed).toBeNull();
    });

    it("detachEmbeds drops every claim on a dead session, keeping the rest", () => {
      const { result } = renderHook(() => useTerminalTabs());
      act(() => {
        result.current.attachEmbed({ host: host(), key: "a" });
        result.current.attachEmbed({ host: host(), key: "b" });
        result.current.attachEmbed({ host: host(), key: "a" });
      });

      act(() => result.current.detachEmbeds("a"));

      expect(result.current.embed?.key).toBe("b");
    });

    it("releasing an already-detached claim is a no-op", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let releaseA = () => {};
      act(() => {
        releaseA = result.current.attachEmbed({ host: host(), key: "a" });
      });
      act(() => {
        result.current.attachEmbed({ host: host(), key: "b" });
      });
      act(() => result.current.detachEmbeds("a"));

      act(() => releaseA());

      expect(result.current.embed?.key).toBe("b");
    });
  });

  /** Since a pane only detaches on unmount, ending the process has to be said
   *  explicitly — and said while the handle is still registered. Getting this
   *  wrong leaks a shell on every closed tab. */
  describe("closing a tab ends its session", () => {
    const handle = () => {
      const calls = { writes: [] as string[], ended: 0 };
      return {
        calls,
        pane: {
          write: (d: string) => calls.writes.push(d),
          end: () => {
            calls.ended += 1;
          },
        },
      };
    };

    it("ends the pane's session before dropping the tab", () => {
      const { result } = renderHook(() => useTerminalTabs());
      const { calls, pane } = handle();
      let key = "";
      act(() => {
        key = result.current.open({ title: "one" });
      });
      act(() => {
        result.current.registerPane(key, pane);
      });

      act(() => result.current.close(key));

      expect(calls.ended).toBe(1);
      expect(result.current.tabs).toEqual([]);
    });

    it("closing a tab with no live pane is still just a removal", () => {
      const { result } = renderHook(() => useTerminalTabs());
      let key = "";
      act(() => {
        key = result.current.open({ title: "one" });
      });

      act(() => result.current.close(key));

      expect(result.current.tabs).toEqual([]);
    });

    it("routes typed input to the registered pane", () => {
      const { result } = renderHook(() => useTerminalTabs());
      const { calls, pane } = handle();
      let key = "";
      act(() => {
        key = result.current.open({ title: "one" });
      });
      act(() => {
        result.current.registerPane(key, pane);
      });

      expect(result.current.send(key, "hi")).toBe(true);
      expect(calls.writes).toEqual(["hi"]);
      expect(result.current.send("nope", "hi")).toBe(false);
    });

    /** A remounting pane registers its next handle before the previous one's
     *  cleanup runs, so an unregister must only drop its own. */
    it("an unregister only drops its own handle", () => {
      const { result } = renderHook(() => useTerminalTabs());
      const first = handle();
      const second = handle();
      let key = "";
      let releaseFirst = () => {};
      act(() => {
        key = result.current.open({ title: "one" });
      });
      act(() => {
        releaseFirst = result.current.registerPane(key, first.pane);
        result.current.registerPane(key, second.pane);
      });

      act(() => releaseFirst());

      expect(result.current.send(key, "hi")).toBe(true);
      expect(second.calls.writes).toEqual(["hi"]);
    });
  });
});
