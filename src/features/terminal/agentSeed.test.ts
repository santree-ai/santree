import { describe, expect, it } from "vitest";

import type { AgentSession } from "../../bindings";
import { agentProvider } from "./agentProvider";
import {
  type AgentLaunchConfig,
  agentSessionSeed,
  resumeInvocation,
  shellQuote,
} from "./agentSeed";

const fresh: Extract<AgentSession, { type: "fresh" }> = {
  type: "fresh",
  agentKind: "Claude",
  executable: "claude",
  sessionId: "sess-1",
  launchFlags: "",
};
const resume: Extract<AgentSession, { type: "resume" }> = {
  type: "resume",
  agentKind: "Claude",
  executable: "claude",
  sessionId: "sess-1",
  launchFlags: "",
};

describe("agentSessionSeed", () => {
  it("returns undefined for a plain shell (or no session)", () => {
    expect(agentSessionSeed({ type: "shell" }, { prompt: "hi" })).toBeUndefined();
    expect(agentSessionSeed(undefined, { prompt: "hi" })).toBeUndefined();
  });

  /** Codex launches as the plain CLI. It used to attach to a santree-owned
   *  `codex app-server` via `resume --remote <socket> <thread>`, which enforces
   *  one writer per thread — a relaunch while the previous process still held
   *  the lock failed with "already has an active writer" and left a bare shell.
   *  A fresh launch therefore carries NO id: Codex has no launch-time id flag,
   *  mints its own, and reports it back through the `SessionStart` hook. */
  it("starts Codex as the plain CLI, with no id and no socket", () => {
    const seed = agentSessionSeed(
      {
        type: "fresh",
        agentKind: "Codex",
        executable: "/custom/codex",
        sessionId: null,
        launchFlags: "",
      },
      { prompt: "inspect this" },
    );
    expect(seed).toBe("exec '/custom/codex' 'inspect this'");
    expect(seed).not.toContain("--remote");
  });

  it("resumes Codex by thread id, without a socket", () => {
    expect(
      agentSessionSeed(
        {
          type: "resume",
          agentKind: "Codex",
          executable: "/custom/codex",
          sessionId: "thread-1",
          launchFlags: "",
        },
        {},
      ),
    ).toBe("exec '/custom/codex' resume 'thread-1'");
  });

  /** The hook injection and the trust bypass travel together. Codex silently
   *  skips an untrusted hook — no error, no warning — so injecting without the
   *  bypass would look exactly like "hooks don't work", and passing the bypass
   *  with nothing to inject would widen trust for no reason. */
  it("pairs Codex's hook injection with the trust bypass", () => {
    const seed = agentSessionSeed(
      { type: "resume", agentKind: "Codex", executable: "codex", sessionId: "t1", launchFlags: "" },
      { hookFlag: "-c 'hooks.SessionStart=[]'", repo: "acme/app", termKey: "tree:AK-1" },
    );
    expect(seed).toContain("--dangerously-bypass-hook-trust -c 'hooks.SessionStart=[]'");
    expect(seed).toContain("SANTREE_TERM_KEY='tree:AK-1'");
  });

  it("never passes the trust bypass with no hooks to inject", () => {
    const seed = agentSessionSeed(
      { type: "resume", agentKind: "Codex", executable: "codex", sessionId: "t1", launchFlags: "" },
      {},
    );
    expect(seed).not.toContain("--dangerously-bypass-hook-trust");
  });

  /** Codex's sandbox, approval policy and review tools are resolved backend-side
   *  (`codex_config.rs`) and ride on the session, precisely so that no call site
   *  has to remember them. They apply on a resume too: a resumed AI review that
   *  dropped `--sandbox read-only` would come back with write access, and one
   *  that dropped its MCP server would come back with nowhere to record a
   *  finding. */
  it("carries the session's own launch flags on both fresh and resume", () => {
    const launchFlags =
      "--sandbox read-only --ask-for-approval never " +
      "-c 'mcp_servers.santree-review={command=\"/app/santree-hook\",required=true}'";
    expect(
      agentSessionSeed(
        {
          type: "fresh",
          agentKind: "Codex",
          executable: "codex",
          sessionId: null,
          launchFlags,
        },
        { prompt: "review it", hookFlag: "-c 'hooks.SessionStart=[]'" },
      ),
    ).toBe(
      "exec 'codex' --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[]' " +
        `${launchFlags} 'review it'`,
    );
    expect(
      agentSessionSeed(
        {
          type: "resume",
          agentKind: "Codex",
          executable: "codex",
          sessionId: "t1",
          launchFlags,
        },
        {},
      ),
    ).toBe(`exec 'codex' ${launchFlags} resume 't1'`);
  });

  /** The Work surface resolves to no flags at all — santree leaves the user's own
   *  Codex sandbox alone there — and that must not leave a stray space behind. */
  it("stays a clean command line when a session has no launch flags", () => {
    expect(
      agentSessionSeed(
        {
          type: "fresh",
          agentKind: "Codex",
          executable: "codex",
          sessionId: null,
          launchFlags: "",
        },
        {},
      ),
    ).toBe("exec 'codex'");
  });

  /** Claude's launch line comes from its own spec and the typed config; the
   *  field exists on every session but is only ever filled for Codex. */
  it("ignores launch flags on a Claude session", () => {
    expect(agentSessionSeed({ ...fresh, launchFlags: "--sandbox read-only" }, {})).toBe(
      "exec 'claude' --session-id 'sess-1'",
    );
  });

  it("starts a fresh session with a reserved id and the prompt", () => {
    expect(agentSessionSeed(fresh, { prompt: "Work on AK-1" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'Work on AK-1'",
    );
  });

  it("starts a fresh session with no trailing prompt when none is given (a manual Claude tab)", () => {
    expect(agentSessionSeed(fresh, {})).toBe("exec 'claude' --session-id 'sess-1'");
    expect(agentSessionSeed(fresh, { model: "opus" })).toBe(
      "exec 'claude' --model 'opus' --session-id 'sess-1'",
    );
  });

  it("resumes an on-disk session", () => {
    expect(agentSessionSeed(resume, { prompt: "unused" })).toBe("exec 'claude' --resume 'sess-1'");
  });

  it("names the session for Remote Control on both fresh and resume", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", remoteControl: "AK-165" })).toBe(
      "exec 'claude' --remote-control 'AK-165' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(resume, { prompt: "go", remoteControl: "AK-165" })).toBe(
      "exec 'claude' --remote-control 'AK-165' --resume 'sess-1'",
    );
  });

  it("places model + effort after remote-control, before the session id", () => {
    expect(
      agentSessionSeed(fresh, {
        prompt: "go",
        model: "opus",
        effort: "high",
        remoteControl: "AK-9",
      }),
    ).toBe(
      "exec 'claude' --remote-control 'AK-9' --model 'opus' --effort 'high' --session-id 'sess-1' 'go'",
    );
  });

  it("places --settings after remote-control, and applies it on both fresh and resume", () => {
    const hookFlag = "--settings '/data/claude-hooks.json'";
    expect(
      agentSessionSeed(fresh, {
        prompt: "go",
        hookFlag,
        model: "opus",
        remoteControl: "AK-9",
      }),
    ).toBe(
      "exec 'claude' --remote-control 'AK-9' --settings '/data/claude-hooks.json' --model 'opus' --session-id 'sess-1' 'go'",
    );
    // Unlike model/effort, --settings IS injected on resume — session-state hooks
    // should fire on resumed sessions too.
    expect(agentSessionSeed(resume, { hookFlag })).toBe(
      "exec 'claude' --settings '/data/claude-hooks.json' --resume 'sess-1'",
    );
  });

  it("adds --mcp-config on both fresh and resume, right after --settings", () => {
    const mcpConfigPath = "/data/mcp/acme-web-42.mcp.json";
    const hookFlag = "--settings '/data/claude-hooks-ai-review.json'";
    expect(agentSessionSeed(fresh, { prompt: "go", hookFlag, mcpConfigPath })).toBe(
      "exec 'claude' --settings '/data/claude-hooks-ai-review.json' --mcp-config '/data/mcp/acme-web-42.mcp.json' --session-id 'sess-1' 'go'",
    );
    // A resumed AI review still needs its tools, or it has nowhere to write.
    expect(agentSessionSeed(resume, { hookFlag, mcpConfigPath })).toBe(
      "exec 'claude' --settings '/data/claude-hooks-ai-review.json' --mcp-config '/data/mcp/acme-web-42.mcp.json' --resume 'sess-1'",
    );
  });

  it("adds --chrome on both fresh and resume, and omits it when off", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", chrome: true, remoteControl: "AK-9" })).toBe(
      "exec 'claude' --remote-control 'AK-9' --chrome --session-id 'sess-1' 'go'",
    );
    // A launch-time capability, so it applies on resume too.
    expect(agentSessionSeed(resume, { chrome: true })).toBe(
      "exec 'claude' --chrome --resume 'sess-1'",
    );
    // Off (or unset) ⇒ no flag.
    expect(agentSessionSeed(fresh, { prompt: "go", chrome: false })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
  });

  it("adds --permission-mode on both fresh and resume, and omits it when empty", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", permissionMode: "plan" })).toBe(
      "exec 'claude' --permission-mode 'plan' --session-id 'sess-1' 'go'",
    );
    // A startup mode, so it applies on restart (resume) too.
    expect(agentSessionSeed(resume, { permissionMode: "acceptEdits" })).toBe(
      "exec 'claude' --permission-mode 'acceptEdits' --resume 'sess-1'",
    );
    // Empty ("Default") ⇒ no flag.
    expect(agentSessionSeed(fresh, { prompt: "go", permissionMode: "" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
  });

  it("omits model/effort on a resume (the session keeps its own)", () => {
    expect(
      agentSessionSeed(resume, {
        prompt: "go",
        model: "opus",
        effort: "high",
      }),
    ).toBe("exec 'claude' --resume 'sess-1'");
  });

  it("exports the terminal identity via `env` on both fresh and resume (for /clear reconcile)", () => {
    // Both repo + termKey ⇒ an `env NAME=value …` prefix Claude's SessionStart hook
    // reads to adopt a new (e.g. post-/clear) session id for this exact terminal.
    expect(agentSessionSeed(fresh, { prompt: "go", repo: "acme", termKey: "triage:AK-1" })).toBe(
      "exec env SANTREE_REPO='acme' SANTREE_TERM_KEY='triage:AK-1' 'claude' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(resume, { repo: "acme", termKey: "tree:AK-1" })).toBe(
      "exec env SANTREE_REPO='acme' SANTREE_TERM_KEY='tree:AK-1' 'claude' --resume 'sess-1'",
    );
  });

  it("omits the env prefix unless both repo and termKey are given", () => {
    expect(agentSessionSeed(fresh, { prompt: "go", repo: "acme" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
    expect(agentSessionSeed(fresh, { prompt: "go", termKey: "triage:AK-1" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'go'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("don't fail")).toBe("'don'\\''t fail'");
  });

  it("strips C0 control bytes so ticket content can't escape the quoted seed", () => {
    // \x15 is kill-line, \r is accept-line in most shell line editors — both must
    // be gone before this reaches the PTY, quoting alone doesn't stop them.
    expect(shellQuote("safe\x15rm -rf ~\rdone")).toBe("'saferm -rf ~done'");
  });

  it("strips C1 control codes (8-bit CSI/DCS/OSC introducers) from ticket text", () => {
    // A terminal in 8-bit-control mode reads these as escape-sequence introducers,
    // so quoting alone wouldn't contain them: \u009b = CSI, \u0090 = DCS, \u009d = OSC.
    expect(shellQuote("Fix \u009b2J the \u0090payload\u009c thing")).toBe(
      "'Fix 2J the payload thing'",
    );
    expect(agentSessionSeed(fresh, { prompt: "AK-1: \u009d0;pwned\u0007 title" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'AK-1: 0;pwned title'",
    );
  });

  it("folds embedded newlines to a space instead of breaking the quoted seed", () => {
    expect(shellQuote("line one\nline two")).toBe("'line one line two'");
  });

  it("escapes an embedded single quote in the prompt within the full seed command", () => {
    // Real ticket titles contain apostrophes — this exercises shellQuote's
    // escaping as part of the full agentSessionSeed output, not in isolation.
    expect(agentSessionSeed(fresh, { prompt: "Work on AK-1: don't fail" })).toBe(
      "exec 'claude' --session-id 'sess-1' 'Work on AK-1: don'\\''t fail'",
    );
  });
});

/**
 * The four call sites that open an agent terminal — the worktree tab, the
 * investigation pane, the triage batch and the AI review — each used to
 * assemble Claude's flags themselves, and they had already diverged: two gated
 * model/effort on `cliLaunchOptions`, two on `resolvedAgent === agentKind`, and
 * only two ever passed `--mcp-config`. Now each passes typed configuration and
 * the provider spells it, so the combinations that varied are pinned here once.
 */
describe("the launch line each call site used to assemble", () => {
  const seed = (config: AgentLaunchConfig) =>
    agentSessionSeed(
      { ...fresh, executable: "/opt/claude" },
      {
        repo: "acme/app",
        termKey: "tree:AK-1",
        configuredFor: "Claude",
        ...config,
      },
    );
  const env = "exec env SANTREE_REPO='acme/app' SANTREE_TERM_KEY='tree:AK-1' '/opt/claude'";

  it("Trees work tab: hooks, chrome, permission mode, model, effort", () => {
    expect(
      seed({
        hookFlag: "--settings '/data/claude-hooks.json'",
        chrome: true,
        permissionMode: "acceptEdits",
        model: "opus",
        effort: "high",
        remoteControl: "AK-1",
      }),
    ).toBe(
      `${env} --remote-control 'AK-1' --settings '/data/claude-hooks.json' --chrome ` +
        "--permission-mode 'acceptEdits' --model 'opus' --effort 'high' --session-id 'sess-1'",
    );
  });

  it("Fix-CI tab: the commit/push-denying settings file plus a source-scoped MCP config", () => {
    expect(
      seed({
        hookFlag: "--settings '/data/claude-hooks-no-git.json'",
        mcpConfigPath: "/data/mcp/acme-web.mcp.json",
      }),
    ).toBe(
      `${env} --settings '/data/claude-hooks-no-git.json' ` +
        "--mcp-config '/data/mcp/acme-web.mcp.json' --session-id 'sess-1'",
    );
  });

  it("AI review: its own restricted settings and tool server, and no Remote Control name", () => {
    const line = seed({
      hookFlag: "--settings '/data/claude-hooks-ai-review.json'",
      mcpConfigPath: "/data/mcp/acme-web-42.mcp.json",
      model: "sonnet",
      permissionMode: "plan",
      prompt: "Read /tmp/review.md and follow the instructions inside.",
    });
    expect(line).toBe(
      `${env} --settings '/data/claude-hooks-ai-review.json' ` +
        "--mcp-config '/data/mcp/acme-web-42.mcp.json' --permission-mode 'plan' " +
        "--model 'sonnet' --session-id 'sess-1' " +
        "'Read /tmp/review.md and follow the instructions inside.'",
    );
    expect(line).not.toContain("--remote-control");
  });

  /** Settings are per provider. A surface configured for one whose stored
   *  session turns out to run the other must not hand the first one's model
   *  name to the second one's CLI — two of the four sites checked this, two
   *  did not. */
  it("drops per-provider settings when the session runs a different provider", () => {
    expect(
      agentSessionSeed(fresh, {
        configuredFor: "Codex",
        model: "gpt-5-codex",
        effort: "high",
        permissionMode: "acceptEdits",
        hookFlag: "--settings '/data/claude-hooks.json'",
      }),
    ).toBe("exec 'claude' --settings '/data/claude-hooks.json' --session-id 'sess-1'");
    // Without `configuredFor` there is nothing to disagree with.
    expect(agentSessionSeed(fresh, { model: "opus" })).toBe(
      "exec 'claude' --model 'opus' --session-id 'sess-1'",
    );
  });

  /** Codex takes none of them: its model, effort, sandbox and tool server are
   *  resolved backend-side and ride on the session. Passing Claude's would be a
   *  launch failure, not a no-op. */
  it("never leaks a Claude-shaped flag onto a Codex launch", () => {
    const line = agentSessionSeed(
      { type: "fresh", agentKind: "Codex", executable: "codex", sessionId: null, launchFlags: "" },
      {
        configuredFor: "Codex",
        model: "gpt-5-codex",
        effort: "high",
        permissionMode: "acceptEdits",
        chrome: true,
        remoteControl: "AK-1",
        mcpConfigPath: "/data/mcp/acme.mcp.json",
      },
    );
    expect(line).toBe("exec 'codex'");
  });

  it("omits a flag whose value is blank or whitespace-only", () => {
    expect(seed({ model: "", effort: "   ", permissionMode: null, remoteControl: "" })).toBe(
      `${env} --session-id 'sess-1'`,
    );
  });
});

/**
 * The seed the PTY runs and the line the Session-history row copies are the
 * same invocation with different wrappers. Written twice they drift — a
 * comparator with this exact duplication already resumes one of its agents by
 * session id in one spelling and by transcript path in the other, held together
 * by a comment. Both now come from the provider's one `launch.resume`.
 */
describe("resumeInvocation agrees with the seeded resume", () => {
  it.each([
    ["Claude", "claude"],
    ["Codex", "codex"],
  ] as const)("%s", (kind, bin) => {
    // A thread id is whatever a rollout's `session_meta.id` says — an arbitrary
    // string read off disk, so the copied line has to quote it too. It did not.
    const sessionId = "don't 'stop'";
    const copied = resumeInvocation(kind, sessionId);
    expect(copied?.startsWith(`${bin} `)).toBe(true);
    const invocation = copied?.slice(bin.length + 1);
    expect(invocation).toContain(shellQuote(sessionId));

    const seeded = agentSessionSeed({
      type: "resume",
      agentKind: kind,
      executable: `/opt/${bin}`,
      sessionId,
      launchFlags: "",
    });
    expect(seeded).toBe(`exec '/opt/${bin}' ${invocation}`);
  });

  it("prefixes a cd when the command is going into somebody else's terminal", () => {
    // Claude looks a conversation up under the directory it ran in, so the copied
    // line is wrong without this; a PTY session gets its cwd from the spawn.
    expect(resumeInvocation("Claude", "sess-1", "/w/it's here")).toBe(
      "cd '/w/it'\\''s here' && claude --resume 'sess-1'",
    );
  });

  it("has nothing to offer for a provider santree cannot resume", () => {
    expect(resumeInvocation("Cursor", "abc")).toBeNull();
    expect(agentProvider("Cursor").launch).toBeNull();
  });
});
