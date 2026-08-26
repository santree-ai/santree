/**
 * The agent-tab state machine — the gate in front of every non-idempotent PTY
 * spawn in the app. Three things it must never get wrong:
 *
 *  - `preparing`: the PTY applies its seed *at session creation*, so a terminal
 *    mounted before the session (or any launch flag) has resolved spawns a bare
 *    shell and silently drops the launch.
 *  - `liveSeen`: the latch that stops a quit agent from being instantly resumed
 *    back into a restart loop.
 *  - the session cache: dropped on exit/resume, so a stale "fresh" verdict isn't
 *    replayed over a session that now has a transcript.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../../bindings";
import { TerminalsProvider, useTerminals } from "../terminal/TerminalsContext";
import { type AgentTabOptions, useAgentTab } from "./useAgentTab";

/** The data layer, dialled per test. `flagsFetched` is deliberately one switch:
 *  the hook must wait for *every* launch flag, so any one of them being unresolved
 *  has to hold the terminal. */
const backend = vi.hoisted(() => ({
  session: {
    type: "fresh",
    agentKind: "Claude",
    executable: "claude",
    sessionId: "s-1",
    remote: null,
  } as AgentSession | undefined,
  sessionFetching: false,
  flagsFetched: true,
  model: "opus" as string | null,
  effort: "high" as string | null,
  permissionMode: "acceptEdits" as string | null,
  chrome: true,
  remoteControl: true,
  /** Every `useAgentSession(…)` call, so a test can assert whether the hook is
   *  still asking the backend to resolve a (re)launch. */
  sessionCalls: [] as { allowFresh: boolean; enabled: boolean }[],
}));

vi.mock("../../lib/queries", () => ({
  CLAUDE_REMOTE_CONTROL_KEY: "claude_remote_control",
  CLAUDE_START_WITH_CHROME_KEY: "claude_start_with_chrome",
  WORK_AGENT_KEY: "work_agent",
  WORK_EFFORT_KEY: "work_effort",
  WORK_MODEL_KEY: "work_model",
  WORK_PERMISSION_MODE_KEY: "work_permission_mode",
  queryKeys: {
    agentSessionPrefix: (repo: string, termKey: string) => ["agent-session", repo, termKey],
  },
  useAgentSession: (
    _repo: string,
    _termKey: string,
    _cwd: string,
    allowFresh: boolean,
    _agent: string,
    enabled: boolean,
  ) => {
    backend.sessionCalls.push({ allowFresh, enabled });
    // A disabled query never runs, so it has nothing to hand back (the cache is
    // dropped on exit/resume) — that's what makes "no session ⇒ no seed" real.
    return {
      data: enabled ? backend.session : undefined,
      isFetching: enabled && backend.sessionFetching,
    };
  },
  useResolvedProviderSetting: (_repo: string, key: string) => ({
    data:
      key === "work_model"
        ? backend.model
        : key === "work_effort"
          ? backend.effort
          : backend.permissionMode,
    isFetched: backend.flagsFetched,
  }),
  useBoolSetting: () => ({ value: backend.chrome, isFetched: backend.flagsFetched }),
  useSetting: () => ({
    data: backend.remoteControl ? null : "false",
    isFetched: backend.flagsFetched,
  }),
  useClaudeHookSettings: () => ({ data: "/hooks.json", isFetched: backend.flagsFetched }),
  useClaudeHookSettingsNoGit: () => ({
    data: "/hooks-no-git.json",
    isFetched: backend.flagsFetched,
  }),
}));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ settings: { agents: [{ key: "Claude", exec: "" }] } }),
}));

const REF = "tree:AK-1";
const opts = (over: Partial<AgentTabOptions> = {}): AgentTabOptions => ({
  repo: "acme/app",
  refId: REF,
  cwd: "/wt/AK-1",
  agent: "Claude",
  allowFresh: true,
  ...over,
});

/** The hook plus the live terminal registry, so a test can spawn/kill the PTY
 *  session the tab is watching for. */
function mount(initial: AgentTabOptions = opts()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const removeQueries = vi.spyOn(qc, "removeQueries");
  const view = renderHook(
    ({ o }: { o: AgentTabOptions }) => ({ tab: useAgentTab(o), terminals: useTerminals() }),
    {
      initialProps: { o: initial },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>
          <TerminalsProvider>{children}</TerminalsProvider>
        </QueryClientProvider>
      ),
    },
  );

  const spawn = () =>
    act(() => {
      view.result.current.terminals.open({ title: REF, source: "issue", refId: REF });
    });
  const kill = () =>
    act(() => {
      const { tabs, close } = view.result.current.terminals;
      const live = tabs.find((t) => t.refId === REF);
      if (live) close(live.key);
    });
  /** Whether the hook is still asking the backend to resolve a (re)launch. */
  const resolving = () => backend.sessionCalls.at(-1)?.enabled;
  return { ...view, removeQueries, spawn, kill, resolving, tab: () => view.result.current.tab };
}

beforeEach(() => {
  backend.session = {
    type: "fresh",
    agentKind: "Claude",
    executable: "claude",
    sessionId: "s-1",
    remote: null,
  };
  backend.sessionFetching = false;
  backend.flagsFetched = true;
  backend.model = "opus";
  backend.effort = "high";
  backend.permissionMode = "acceptEdits";
  backend.chrome = true;
  backend.remoteControl = true;
  backend.sessionCalls = [];
});

describe("useAgentTab", () => {
  describe("the liveSeen latch", () => {
    it("a tab that has never run is not 'ended' — it just hasn't started", () => {
      const t = mount();

      expect(t.tab().live).toBe(false);
      expect(t.tab().ended).toBe(false);
      // …and it resolves a launch, because there's no live PTY to attach to.
      expect(t.resolving()).toBe(true);
    });

    it("attaches to a live session instead of resolving a second launch for it", () => {
      const t = mount();
      t.spawn();

      expect(t.tab().live).toBe(true);
      expect(t.tab().ended).toBe(false);
      expect(t.resolving()).toBe(false);
    });

    // Quitting the agent kills the PTY, so the session vanishes from the registry.
    // Without the latch the tab reads "no live session ⇒ resolve a launch" again,
    // re-seeds, and the agent the user just quit comes straight back — the restart
    // loop. `ended` (latched) is what turns that into the resume placeholder.
    it("does not re-resolve a launch after the agent exits (no restart loop)", () => {
      const t = mount();
      t.spawn();
      t.kill();

      expect(t.tab().live).toBe(false);
      expect(t.tab().ended).toBe(true);
      expect(t.resolving()).toBe(false);

      // Still latched on a later render — nothing re-arms it on its own.
      t.rerender({ o: opts() });
      expect(t.tab().ended).toBe(true);
      expect(t.resolving()).toBe(false);
    });

    it("resume() clears the latch and drops the stale session resolution", () => {
      const t = mount();
      t.spawn();
      t.kill();

      act(() => t.tab().resume());

      expect(t.tab().ended).toBe(false);
      expect(t.resolving()).toBe(true);
      expect(t.removeQueries).toHaveBeenCalledWith({
        queryKey: ["agent-session", "acme/app", REF],
      });
    });

    // The process can die while the pane is unmounted, so the cached resolution may
    // predate the exit: replaying it would `--session-id` a session whose transcript
    // now exists (or start fresh where a resume is now correct).
    it("onExited drops the cached session resolution", () => {
      const t = mount();

      act(() => t.tab().onExited());

      expect(t.removeQueries).toHaveBeenCalledWith({
        queryKey: ["agent-session", "acme/app", REF],
      });
    });

    it("a shell tab is never 'ended' and never resolves a session", () => {
      const t = mount(opts({ shellOnly: true, agent: null }));
      t.spawn();
      t.kill();

      expect(t.tab().ended).toBe(false);
      expect(t.tab().preparing).toBe(false);
      expect(t.tab().seed).toBeUndefined();
      expect(t.resolving()).toBe(false);
    });
  });

  describe("preparing (the hold gate in front of the PTY spawn)", () => {
    it("holds the terminal while the session is still resolving", () => {
      backend.sessionFetching = true;
      const t = mount();

      expect(t.tab().preparing).toBe(true);
    });

    // The seed command is built ONCE and applied at session creation, so a flag that
    // arrives after the spawn is silently dropped: a Fix-CI tab that launches before
    // `--settings` resolves runs without the commit/push-denying guardrail it exists
    // to enforce. Every flag must be *fetched*, not merely truthy — a boolean setting
    // reads `false` both when it's off and when it hasn't loaded.
    it("holds the terminal until every launch flag has resolved, not just the session", () => {
      backend.flagsFetched = false;
      const t = mount();

      expect(t.tab().preparing).toBe(true);

      act(() => {
        backend.flagsFetched = true;
      });
      t.rerender({ o: opts() });
      expect(t.tab().preparing).toBe(false);
    });

    it("still holds when a flag is unresolved but happens to read as its 'off' value", () => {
      backend.flagsFetched = false;
      backend.chrome = false;
      backend.model = null;
      backend.effort = null;
      backend.permissionMode = null;
      const t = mount();

      expect(t.tab().preparing).toBe(true);
    });

    it("doesn't wait on Claude's flags for another agent", () => {
      backend.flagsFetched = false;
      backend.session = {
        type: "fresh",
        agentKind: "Codex",
        executable: "/opt/codex",
        sessionId: "thread-1",
        remote: "unix:///tmp/codex.sock",
      };
      const t = mount(opts({ agent: "Codex" }));

      expect(t.tab().preparing).toBe(false);
    });

    it("honours the caller's own hold (an input of its own is still in flight)", () => {
      const t = mount(opts({ hold: true }));

      expect(t.tab().preparing).toBe(true);
      // …and it withholds the session resolution too, so the seed is built from a
      // fetch taken once the caller is actually ready.
      expect(t.resolving()).toBe(false);
    });

    it("stops preparing once a live session exists (nothing left to seed)", () => {
      backend.sessionFetching = true;
      const t = mount();
      t.spawn();

      expect(t.tab().preparing).toBe(false);
    });
  });

  describe("the seed", () => {
    it("carries every resolved launch flag on a fresh Claude start", () => {
      const t = mount();

      expect(t.tab().seed).toBe(
        "exec env SANTREE_REPO='acme/app' SANTREE_TERM_KEY='tree:AK-1' 'claude' --settings '/hooks.json' --chrome --permission-mode 'acceptEdits' --model 'opus' --effort 'high' --session-id 's-1'",
      );
    });

    it("launches a Fix-CI tab with the commit/push-denying settings file", () => {
      const t = mount(opts({ noGit: true }));

      expect(t.tab().seed).toContain("--settings '/hooks-no-git.json'");
      expect(t.tab().seed).not.toContain("/hooks.json'");
    });

    // Claude-only flags: another agent's CLI would just fail to launch on them.
    it("omits Remote Control when it is disabled in Claude settings", () => {
      backend.remoteControl = false;
      const t = mount(opts({ remoteControl: "AK-1" }));

      expect(t.tab().seed).not.toContain("--remote-control");
    });

    it("passes no Claude-only flags to another agent", () => {
      backend.session = {
        type: "fresh",
        agentKind: "Codex",
        executable: "/opt/codex",
        sessionId: "s-1",
        remote: "unix:///tmp/codex.sock",
      };
      const t = mount(opts({ agent: "Codex", remoteControl: "AK-1" }));
      const seed = t.tab().seed ?? "";

      expect(seed).toContain("resume --remote 'unix:///tmp/codex.sock'");
      for (const flag of ["--model", "--effort", "--settings", "--chrome", "--permission-mode"]) {
        expect(seed).not.toContain(flag);
      }
      expect(seed).not.toContain("--remote-control");
    });

    it("resumes an on-disk session instead of minting a new one", () => {
      backend.session = {
        type: "resume",
        agentKind: "Claude",
        executable: "claude",
        sessionId: "s-old",
        remote: null,
      };
      const t = mount();

      expect(t.tab().seed).toContain("--resume 's-old'");
      expect(t.tab().seed).not.toContain("--session-id");
    });
  });
});
